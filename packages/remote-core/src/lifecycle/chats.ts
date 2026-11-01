/**
 * Every chat's remote machine, from first spawn to destroy, for a terminal
 * backend: the chat → machine registry, spawning a synced shell there, and a
 * cleanup lifecycle that survives a Dispatch restart.
 *
 * What is machine-specific — making one, starting it, stopping it, destroying
 * it, proving it is the chat's — is a {@link Provider}. Everything else is
 * here.
 *
 * Everything that has to outlive this process is in kv, and a sweep (at load,
 * then every minute) acts on what is due. So nothing depends on a timer or a
 * hook having fired in THIS process:
 * - `chat:<chatId>`: the chat's machine (the provider's ref), its idle
 *   deadline and when a terminal last used it.
 * - `destroy:<key>`: a destroy that has not succeeded yet, written BEFORE the
 *   first attempt and retried with backoff.
 * - `instance`: this Dispatch instance's id, which the provider tags its
 *   machines with.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, TerminalBackendHandle, TerminalSpawnInfo } from "@dispatch/plugin-sdk";
import { PortWatch } from "../ports/watch.js";
import type { SshConnection } from "../ssh/connection.js";
import { RemoteCheckouts } from "../sync/remote-repo.js";
import { remotePathFor, repoInfo } from "../sync/snapshot.js";
import { errText, withDeadline } from "./deadline.js";

/** Why core is shutting the plugin down (the timed `onShutdown` hook). */
export type ShutdownReason = "restart" | "stop" | "disable" | "uninstall";

/**
 * What a provider stores to name a chat's machine, e.g. `{ vmid, hostname }`.
 * Flat: its fields are spread into the kv records.
 */
export type MachineRef = Record<string, unknown>;

/** `chat:<chatId>` in kv. */
export type ChatRecord<R extends MachineRef> = R & {
  createdAt: number;
  /**
   * When the idle stop is due (epoch ms). Kept here and not only in a timer:
   * an in-memory setTimeout dies with every Dispatch restart, and the machine
   * it was meant to stop runs until someone notices.
   */
  idleDeadline?: number;
  /** Last spawn. A machine unused for `destroyUnusedDays` is destroyed. */
  lastUsedAt?: number;
};

/**
 * `destroy:<key>` in kv: a destroy that has not succeeded yet. Written BEFORE
 * the first attempt, so a crash mid-destroy is retried too. Core fires
 * onChatDeleted without waiting on older versions, so an outage at that moment
 * used to leak the machine for good.
 */
export type PendingDestroy<R extends MachineRef> = R & {
  chatId: string;
  attempts: number;
  nextAt: number;
  lastError?: string;
};

/** The machine-specific half of a backend. */
export interface Provider<R extends MachineRef> {
  /** False until the plugin is set up enough for a machine to exist (an API URL, say). Sweeps do nothing until then. */
  configured(): boolean;
  /** The machine a stored `chat:` or `destroy:` record names, or undefined if it names none. */
  refOf(record: Record<string, unknown>): R | undefined;
  /** The machine's key in `destroy:<key>`. Unique per machine. */
  keyOf(ref: R): string;
  /** The machine in a log line, e.g. `container 9002`. */
  name(ref: R): string;
  /**
   * Make sure the chat's machine exists and runs, and return an open SSH
   * connection to it. `chat.ref` is the machine the chat had, if any. A
   * provider that makes a new machine calls `chat.remember(ref)` the moment it
   * exists, so a failure after that still cleans it up.
   */
  bringUp(chat: { chatId: string; ref?: R; remember(ref: R): Promise<void> }, signal: AbortSignal): Promise<SshConnection>;
  /** Stop the chat's machine because the chat went idle. Leaves alone a machine that is no longer the chat's. */
  stop(chatId: string, ref: R): Promise<void>;
  /**
   * Destroy the chat's machine. Resolve once it is gone, or when it can't be
   * proved to be the chat's (never destroy what isn't ours). Reject to have
   * the attempt retried with backoff.
   */
  destroy(chatId: string, ref: R, opts: { timeoutMs?: number }): Promise<void>;
  /** Dispatch is stopping or the plugin is being disabled: start a stop, without waiting for it. */
  release?(chatId: string, ref: R, reason: "stop" | "disable"): Promise<void>;
  /** Machines tagged with `instance` whose keys are not in `known`, each with the chat it belongs to. */
  discover?(instance: string, known: ReadonlySet<string>): Promise<Array<{ chatId: string; ref: R }>>;
  /** Throw if the provider is unusable (credentials missing, say). Called before shutdown work. */
  preflight?(): Promise<void>;
}

export interface RemoteChatsOptions<R extends MachineRef> {
  /** The backend id: what forwarded ports are published under, and `DISPATCH_TERMINAL` in each shell. */
  backendId: string;
  /** Names the plugin on a terminal's stderr, e.g. `proxmox-terminal`. */
  label: string;
  provider: Provider<R>;
  /** `ctx.kv`. Without it nothing survives a restart, and sweeps do nothing. */
  kv?: PluginContext["kv"];
  log: PluginContext["log"];
  /** `ctx.terminals.publishPort` for this backend. */
  publishPort: (port: { chatId: string; remotePort: number; url: string }) => () => void;
  /** Read live, at every use. */
  policy: () => {
    /** Stop a machine this long after its chat goes idle. Negative: never. */
    idleStopMinutes: number;
    /** Destroy a machine no terminal has used for this long. 0: never. */
    destroyUnusedDays: number;
    /** Where checkouts go on the machine. */
    workDir: string;
  };
}

/** Live state per chat. */
export interface ChatState<R extends MachineRef> {
  chatId: string;
  /** The chat's machine, once it has one. */
  ref?: R;
  conn?: SshConnection;
  /** In flight while the machine is being made / started / connected. */
  ready?: Promise<void>;
  /** The chat's checkouts on the machine. They outlive a dropped connection, as the machine's disk does. */
  checkouts: RemoteCheckouts;
  ports: PortWatch;
  /** Live shells, so a stop/destroy can end them. */
  shells: Set<TerminalBackendHandle>;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleDeadline?: number;
  lastUsedAt?: number;
  /**
   * Bumped by every spawn. A stop decided under an older generation is
   * dropped, so an idle stop (or the boot sweep) that lost a race with a new
   * command never stops the machine out from under it.
   */
  generation: number;
  /** Serialises bring-up, stop and destroy for this chat's machine. */
  opChain: Promise<unknown>;
}

const SWEEP_MS = 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

export class RemoteChats<R extends MachineRef> {
  private readonly chats = new Map<string, ChatState<R>>();
  private readonly provider: Provider<R>;
  private readonly log: PluginContext["log"];
  private instance?: Promise<string>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweepChain: Promise<void> = Promise.resolve();
  private readonly destroying = new Map<string, Promise<void>>();

  constructor(private readonly opts: RemoteChatsOptions<R>) {
    this.provider = opts.provider;
    this.log = opts.log;
  }

  /** The chat's live state in this process, if any. */
  peek(chatId: string): Readonly<ChatState<R>> | undefined {
    return this.chats.get(chatId);
  }

  /* --------------------------------------------------------------- spawn */

  /**
   * A shell on the chat's machine, in the remote twin of `info.cwd`, with the
   * local worktree synced in before it starts and before every command.
   */
  async spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle> {
    const st = await this.stateFor(info.chatId);
    st.generation++;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = undefined;
    st.idleDeadline = undefined;
    st.lastUsedAt = Date.now();
    await this.ensureReady(st, info.signal as AbortSignal);
    await this.persist(st);
    const local = await repoInfo(info.cwd);
    const repo = await st.checkouts.ensure(local.root, local);
    await st.checkouts.sync(local.root);
    const conn = st.conn!;
    const handle = await conn.shell(remotePathFor(local.root, info.cwd, repo.remote), {
      TERM: "dumb",
      FORCE_COLOR: "0",
      DISPATCH_TERMINAL: this.opts.backendId,
    });
    st.shells.add(handle);
    handle.on("exit", () => st.shells.delete(handle));
    st.ports.start();
    return st.checkouts.syncBeforeEachCommand(local.root, handle);
  }

  /* --------------------------------------------------------- chat state */

  private async stateFor(chatId: string): Promise<ChatState<R>> {
    let st = this.chats.get(chatId);
    if (st) return st;
    const rec = await this.opts.kv?.get<ChatRecord<R>>(`chat:${chatId}`);
    // Another await (a concurrent spawn, or the boot sweep) may have made it meanwhile.
    const raced = this.chats.get(chatId);
    if (raced) return raced;
    const fresh: ChatState<R> = {
      chatId,
      ref: rec ? this.provider.refOf(rec) : undefined,
      checkouts: new RemoteCheckouts({
        conn: () => fresh.conn,
        workDir: () => this.opts.policy().workDir,
        label: this.opts.label,
      }),
      ports: new PortWatch({
        conn: () => fresh.conn,
        publish: (p) => this.opts.publishPort({ chatId, ...p }),
        log: this.log,
        chatId,
        host: () => (fresh.ref ? this.provider.name(fresh.ref) : chatId),
      }),
      shells: new Set(),
      idleDeadline: rec?.idleDeadline,
      lastUsedAt: rec?.lastUsedAt,
      generation: 0,
      opChain: Promise.resolve(),
    };
    st = fresh;
    this.chats.set(chatId, st);
    // A record from before lastUsedAt existed: start its unused clock now, not
    // at createdAt, or the first sweep after an update would destroy a machine
    // its chat is still using.
    if (rec && rec.lastUsedAt === undefined) {
      st.lastUsedAt = Date.now();
      await this.persist(st);
    }
    return st;
  }

  /** Write the chat's record back to kv (only once it has a machine). */
  private async persist(st: ChatState<R>): Promise<void> {
    const kv = this.opts.kv;
    if (!st.ref || !kv) return;
    const prev = await kv.get<ChatRecord<R>>(`chat:${st.chatId}`);
    await kv.set(`chat:${st.chatId}`, {
      ...st.ref,
      createdAt: prev?.createdAt ?? Date.now(),
      idleDeadline: st.idleDeadline,
      lastUsedAt: st.lastUsedAt,
    } satisfies ChatRecord<R>);
  }

  /** Run one machine operation for a chat, after any already in flight. */
  private serial<T>(st: ChatState<R>, fn: () => Promise<T>): Promise<T> {
    const run = st.opChain.then(fn);
    st.opChain = run.catch(() => {});
    return run;
  }

  /** Make sure the chat's machine exists, is running, and has an open SSH connection. */
  private ensureReady(st: ChatState<R>, signal: AbortSignal): Promise<void> {
    if (st.conn?.isOpen) return Promise.resolve();
    if (!st.ready) {
      st.ready = this.serial(st, () => (st.conn?.isOpen ? Promise.resolve() : this.bringUp(st, signal))).finally(() => {
        st.ready = undefined;
      });
    }
    return st.ready;
  }

  private async bringUp(st: ChatState<R>, signal: AbortSignal): Promise<void> {
    const conn = await this.provider.bringUp(
      {
        chatId: st.chatId,
        ref: st.ref,
        remember: async (ref) => {
          st.ref = ref;
          await this.persist(st);
        },
      },
      signal,
    );
    conn.on("close", () => {
      if (st.conn === conn) this.dropConnection(st);
    });
    st.conn = conn;
  }

  private dropConnection(st: ChatState<R>): void {
    st.ports.stop();
    for (const h of [...st.shells]) h.kill();
    st.shells.clear();
    st.conn?.close();
    st.conn = undefined;
    // Not the checkouts: they survive a stop on the machine's disk, and so
    // does what was last synced into them.
  }

  /* ----------------------------------------------------------- lifecycle */

  /**
   * This instance's id, minted once into kv. Stable and dev Dispatch share
   * config/ (so the same settings, and the same machines) but not data/, so
   * each has its own kv and its own id. The provider tags every machine with
   * it, and adoption and orphan-destroys only touch machines carrying THIS id:
   * the other instance's are never ours to touch.
   */
  instanceId(): Promise<string> {
    this.instance ??= (async () => {
      const have = await this.opts.kv?.get<string>("instance");
      if (have) return have;
      const id = randomUUID().replace(/-/g, "").slice(0, 12);
      await this.opts.kv?.set("instance", id);
      return id;
    })();
    return this.instance;
  }

  /**
   * Called once from activate. Recovers what a restart lost — the chat →
   * machine map from kv and the provider, the idle stops that were due, the
   * destroys that failed — then keeps sweeping. Never throws: the provider may
   * be down, and the next sweep tries again.
   */
  start(): Promise<void> {
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
      this.sweepTimer.unref?.();
    }
    return this.sweep({ adopt: true, boot: true });
  }

  /**
   * One pass over everything this instance owns. Passes queue behind each
   * other, so a reconcile arriving mid-sweep runs after it rather than racing.
   *
   * - `adopt`: also ask the provider for machines tagged with this instance's
   *   id that kv has no record of, and take them back.
   * - `boot`: a running machine with no live shell and no idle deadline is one
   *   whose chat was busy when Dispatch died without a clean shutdown —
   *   nothing will ever fire onChatIdle for it again, so stop it now.
   * - `liveChats`: every chat that still exists. A machine for any other chat
   *   is destroyed.
   */
  sweep(opts: { adopt?: boolean; boot?: boolean; liveChats?: ReadonlySet<string> } = {}): Promise<void> {
    const run = this.sweepChain.then(() => this.sweepOnce(opts));
    this.sweepChain = run.catch(() => {});
    return run.catch((err: unknown) => this.log.warn(`cleanup sweep: ${errText(err)}`));
  }

  private async sweepOnce(opts: { adopt?: boolean; boot?: boolean; liveChats?: ReadonlySet<string> }): Promise<void> {
    const kv = this.opts.kv;
    if (!this.provider.configured() || !kv) return; // not configured yet: nothing can exist
    for (const key of await kv.list("chat:")) await this.stateFor(key.slice("chat:".length));
    // Adoption failing (the provider down, a permission missing) must not cost
    // the idle stops and retries below.
    if (opts.adopt) await this.adopt().catch((err: unknown) => this.log.warn(`re-adopting machines: ${errText(err)}`));
    const now = Date.now();

    for (const key of await kv.list("destroy:")) {
      const p = await kv.get<PendingDestroy<R>>(key);
      if (!p) continue;
      // A record naming no machine can never be destroyed; drop it rather
      // than fail every sweep on it.
      if (!this.provider.refOf(p)) await kv.delete(key);
      else if (p.nextAt <= now) await this.attemptDestroy(p).catch(() => {});
    }

    const policy = this.opts.policy();
    const unusedMs = policy.destroyUnusedDays > 0 ? policy.destroyUnusedDays * 86_400_000 : 0;
    for (const st of [...this.chats.values()]) {
      if (!st.ref) continue;
      const busy = st.shells.size > 0 || !!st.ready;
      if (opts.liveChats && !opts.liveChats.has(st.chatId)) {
        await this.enqueueDestroy(st, "its chat no longer exists").catch(() => {});
      } else if (unusedMs && !busy && (st.lastUsedAt ?? now) < now - unusedMs) {
        // The chat may live on but stopped using this backend — switched back
        // to local, or (with per-terminal locations) just never picks it. The
        // machine only holds installs and build output, so a later spawn
        // making a new one costs a reinstall, not work.
        await this.enqueueDestroy(st, `unused for ${policy.destroyUnusedDays} days`).catch(() => {});
      } else if (st.idleDeadline !== undefined && st.idleDeadline <= now) {
        await this.stopIdle(st, st.generation).catch((err: unknown) => this.log.warn(`stopping ${this.provider.name(st.ref!)}: ${errText(err)}`));
      } else if (st.idleDeadline !== undefined) {
        this.armIdleTimer(st);
      } else if (opts.boot && !busy && !st.conn) {
        await this.stopIdle(st, st.generation).catch((err: unknown) => this.log.warn(`stopping ${this.provider.name(st.ref!)}: ${errText(err)}`));
      }
    }
  }

  /** Take back machines tagged with this instance whose kv record was lost. */
  private async adopt(): Promise<void> {
    if (!this.provider.discover) return;
    const ours = await this.instanceId();
    const known = new Set<string>();
    for (const st of this.chats.values()) if (st.ref) known.add(this.provider.keyOf(st.ref));
    for (const key of (await this.opts.kv?.list("destroy:")) ?? []) known.add(key.slice("destroy:".length));
    for (const { chatId, ref } of await this.provider.discover(ours, known)) {
      const st = await this.stateFor(chatId);
      if (st.ref && this.provider.keyOf(st.ref) !== this.provider.keyOf(ref)) {
        // The chat already has another machine: this one is a stray.
        await this.recordDestroy({ chatId, ...ref, attempts: 0, nextAt: 0 });
        continue;
      }
      this.log.info(`re-adopting ${this.provider.name(ref)} for chat ${chatId} (its kv record was lost)`);
      st.ref = ref;
      st.lastUsedAt ??= Date.now();
      await this.persist(st);
    }
  }

  onChatIdle({ chatId }: { chatId: string }): Promise<void> {
    return (async () => {
      const st = this.chats.get(chatId) ?? ((await this.opts.kv?.get(`chat:${chatId}`)) ? await this.stateFor(chatId) : undefined);
      if (!st?.ref) return;
      const minutes = this.opts.policy().idleStopMinutes;
      if (minutes < 0) return;
      const gen = st.generation;
      st.idleDeadline = Date.now() + minutes * 60_000;
      await this.persist(st);
      // A spawn while that write was in flight un-idled the chat.
      if (st.generation === gen) this.armIdleTimer(st, gen);
    })().catch((err: unknown) => this.log.warn(`idle for chat ${chatId}: ${errText(err)}`));
  }

  /** The timer is only the fast path; the minute sweep stops anything the timer missed. */
  private armIdleTimer(st: ChatState<R>, gen = st.generation): void {
    if (st.idleDeadline === undefined) return;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => {
      st.idleTimer = undefined;
      void this.stopIdle(st, gen).catch((err: unknown) =>
        this.log.warn(`stopping ${st.ref ? this.provider.name(st.ref) : st.chatId} failed: ${errText(err)}`),
      );
    }, Math.max(0, st.idleDeadline - Date.now()));
    st.idleTimer.unref?.();
  }

  /**
   * Stop the chat's machine, unless a spawn has happened since the stop was
   * decided (`gen`). The next spawn starts it again. Ends its shells first.
   */
  private stopIdle(st: ChatState<R>, gen: number): Promise<void> {
    return this.serial(st, async () => {
      if (st.generation !== gen || !st.ref) return;
      this.dropConnection(st);
      await this.provider.stop(st.chatId, st.ref);
      st.idleDeadline = undefined;
      await this.persist(st);
    });
  }

  /**
   * Destroy the chat's machine. Resolves only once it is gone (or was never
   * made); REJECTS when it could not be destroyed, so a core that retries
   * chat cleanup knows to. Either way the attempt is recorded and the sweep
   * keeps retrying with backoff, so an older core that does not wait on this
   * loses nothing either.
   */
  async onChatDeleted({ chatId }: { chatId: string }): Promise<void> {
    const pending = await this.pendingFor(chatId);
    const st = await this.stateFor(chatId);
    if (st.ref) await this.enqueueDestroy(st, "its chat was deleted");
    else this.forget(st);
    // A retry from core after an earlier failure: the record is all that is left.
    for (const p of pending) await this.attemptDestroy(p);
  }

  /** Forget the chat's machine and destroy it: pending in kv first, then one attempt now. */
  private async enqueueDestroy(st: ChatState<R>, why: string): Promise<void> {
    const ref = st.ref!;
    const p: PendingDestroy<R> = { chatId: st.chatId, ...ref, attempts: 0, nextAt: 0 };
    this.log.info(`destroying ${this.provider.name(ref)} (chat ${p.chatId}): ${why}`);
    await this.recordDestroy(p);
    this.forget(st);
    await this.opts.kv?.delete(`chat:${st.chatId}`);
    await this.attemptDestroy(p);
  }

  private forget(st: ChatState<R>): void {
    st.generation++;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = undefined;
    this.dropConnection(st);
    if (this.chats.get(st.chatId) === st) this.chats.delete(st.chatId);
  }

  private keyOfPending(p: PendingDestroy<R>): string {
    return this.provider.keyOf(this.provider.refOf(p)!);
  }

  private async recordDestroy(p: PendingDestroy<R>): Promise<void> {
    await this.opts.kv?.set(`destroy:${this.keyOfPending(p)}`, p);
  }

  private async pendingFor(chatId: string): Promise<PendingDestroy<R>[]> {
    const kv = this.opts.kv;
    if (!kv) return [];
    const out: PendingDestroy<R>[] = [];
    for (const key of await kv.list("destroy:")) {
      const p = await kv.get<PendingDestroy<R>>(key);
      if (p?.chatId === chatId && this.provider.refOf(p)) out.push(p);
    }
    return out;
  }

  /** One destroy attempt for a pending record; on failure, back off and rethrow. */
  private attemptDestroy(p: PendingDestroy<R>, opts: { timeoutMs?: number } = {}): Promise<void> {
    const ref = this.provider.refOf(p)!;
    const key = this.provider.keyOf(ref);
    const inflight = this.destroying.get(key);
    if (inflight) return inflight;
    const run = (async () => {
      try {
        await this.provider.destroy(p.chatId, ref, opts);
        await this.opts.kv?.delete(`destroy:${key}`);
      } catch (err) {
        p.attempts++;
        p.nextAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (p.attempts - 1));
        p.lastError = errText(err);
        await this.recordDestroy(p).catch(() => {});
        this.log.warn(
          `destroying ${this.provider.name(ref)} (chat ${p.chatId}) failed, attempt ${p.attempts}; ` +
            `retrying after ${new Date(p.nextAt).toISOString()}: ${p.lastError}`,
        );
        throw err;
      }
    })().finally(() => this.destroying.delete(key));
    this.destroying.set(key, run);
    return run;
  }

  /**
   * Startup reconcile (core's module hook): `chats` is every chat that
   * exists, archived included. A machine for any other chat is destroyed;
   * idle ones are stopped.
   */
  reconcile({ chats }: { chats: Iterable<string | { id: string }> }): Promise<void> {
    const ids = new Set<string>();
    for (const c of chats) ids.add(typeof c === "string" ? c : c.id);
    return this.sweep({ adopt: true, boot: true, liveChats: ids });
  }

  /**
   * Timed shutdown (core hook).
   * - `restart`: leave machines running — they are reused when Dispatch is
   *   back. Busy chats get an idle deadline written down, so one whose chat
   *   never comes back is still stopped by the boot sweep in time.
   * - `stop` / `disable`: nothing will manage the machines for a while, so
   *   ask the provider to stop each one, without waiting for it to finish.
   * - `uninstall`: destroy every machine this instance made, waiting as long
   *   as the deadline allows. Whatever is left is logged by key.
   */
  async onShutdown(e: { reason: ShutdownReason; deadline?: number; signal?: AbortSignal }): Promise<void> {
    const left = () => (e.deadline ? Math.max(1_000, e.deadline - Date.now()) : 60_000);
    await this.noteDeadlines().catch(() => {});
    if (e.reason === "restart") return this.closeAll();
    const kv = this.opts.kv;
    if (!this.provider.configured() || !kv) return this.closeAll();
    for (const key of await kv.list("chat:")) await this.stateFor(key.slice("chat:".length)).catch(() => undefined);
    const chats = [...this.chats.values()].filter((st) => st.ref);
    this.closeAll();
    await this.provider.preflight?.();
    if (e.reason === "uninstall") {
      await this.adopt().catch(() => {});
      for (const st of [...this.chats.values()]) {
        if (st.ref) await this.recordDestroy({ chatId: st.chatId, ...st.ref, attempts: 0, nextAt: 0 });
      }
      this.chats.clear();
      const pending: PendingDestroy<R>[] = [];
      for (const key of await kv.list("destroy:")) {
        const p = await kv.get<PendingDestroy<R>>(key);
        if (p && this.provider.refOf(p)) pending.push(p);
      }
      const results = await withDeadline(
        Promise.allSettled(pending.map((p) => this.attemptDestroy(p, { timeoutMs: left() }))),
        left(),
        e.signal,
      );
      const failed = pending.filter((_, i) => results?.[i]?.status !== "fulfilled").map((p) => this.keyOfPending(p));
      if (failed.length) this.log.warn(`uninstall: could not destroy ${failed.join(", ")} in time; remove them by hand`);
      for (const key of await kv.list("chat:")) await kv.delete(key);
      return;
    }
    // stop / disable: start the stops, don't wait for them.
    const release = this.provider.release?.bind(this.provider);
    if (!release) return;
    const reason = e.reason;
    await withDeadline(Promise.allSettled(chats.map((st) => release(st.chatId, st.ref!, reason))), left(), e.signal);
  }

  /**
   * A chat busy at shutdown has no idle deadline, and nothing will fire
   * onChatIdle for it after the restart. Give it one now, so the boot sweep
   * leaves it running for a normal idle period — reusable if the chat comes
   * back — rather than treating it like a crash's leftovers.
   */
  private async noteDeadlines(): Promise<void> {
    const minutes = this.opts.policy().idleStopMinutes;
    if (minutes < 0) return;
    for (const st of this.chats.values()) {
      if (!st.ref || st.idleDeadline !== undefined || !st.conn) continue;
      st.idleDeadline = Date.now() + minutes * 60_000;
      await this.persist(st);
    }
  }

  private closeAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const st of this.chats.values()) {
      if (st.idleTimer) clearTimeout(st.idleTimer);
      st.idleTimer = undefined;
      this.dropConnection(st);
    }
  }

  /**
   * Plugin switched off, or Dispatch shutting down on a core without
   * onShutdown: close connections, leave machines as they are. The idle
   * deadlines written here are what lets the next load stop them on time.
   */
  async dispose(): Promise<void> {
    await this.noteDeadlines().catch(() => {});
    this.closeAll();
    this.chats.clear();
  }
}
