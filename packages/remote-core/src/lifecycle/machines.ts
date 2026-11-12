/**
 * The lifecycle of every chat's machine, from first lease to destroy, with no
 * opinion on what runs there: the chat → machine registry in kv, idle stops,
 * a destroy queue with retries, adoption, the unused-machine TTL, and the
 * reconcile / shutdown hooks. What is machine-specific — stopping one,
 * destroying one, proving it is the chat's — is a {@link MachineProvider}.
 *
 * Bringing a machine up is the caller's: {@link MachineLifecycle.lease} runs
 * it, serialised with every stop and destroy for that chat, and hands back
 * what the caller needs to reach it. That suits a plugin that hands the
 * machine to someone else to run things on (proxmox-terminal 0.2, through
 * remote-host's `machines@1`). It is RemoteChats' lifecycle, split out:
 * RemoteChats keeps its own copy for proxmox-terminal 0.1 until 0.2 replaces
 * it, so 0.1's bundle does not change under its live containers.
 *
 * Everything that has to outlive this process is in kv, and a sweep (at load,
 * then every minute) acts on what is due. So nothing depends on a timer or a
 * hook having fired in THIS process:
 * - `chat:<chatId>`: the chat's machine (the provider's ref), its idle
 *   deadline, when it was last used, and whatever else the caller keeps there
 *   ({@link MachineLifecycle.patch}). Writes merge: a field this file does not
 *   know about survives every idle stop and lease.
 * - `destroy:<key>`: a destroy that has not succeeded yet, written BEFORE the
 *   first attempt and retried with backoff.
 * - `instance`: this Dispatch instance's id, which the provider tags its
 *   machines with.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@dispatch/plugin-sdk";
import { errText, withDeadline } from "./deadline.js";

/** Why core is shutting the plugin down (the timed `onShutdown` hook). */
export type ShutdownReason = "restart" | "stop" | "disable" | "uninstall";

/**
 * What a provider stores to name a chat's machine, e.g. `{ vmid, hostname }`.
 * Flat: its fields are spread into the kv records.
 */
export type MachineRef = Record<string, unknown>;

/** `chat:<chatId>` in kv. Callers may keep more fields in it; they are merged, never dropped. */
export type ChatRecord<R extends MachineRef> = R & {
  createdAt: number;
  /**
   * When the idle stop is due (epoch ms). Kept here and not only in a timer:
   * an in-memory setTimeout dies with every Dispatch restart, and the machine
   * it was meant to stop runs until someone notices.
   */
  idleDeadline?: number;
  /** Last lease (or {@link MachineLifecycle.touch}). A machine unused for `destroyUnusedDays` is destroyed. */
  lastUsedAt?: number;
  /** The caller's own fields ({@link MachineLifecycle.patch}). */
  [field: string]: unknown;
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

/** The machine-specific half of the lifecycle: everything but bringing a machine up. */
export interface MachineProvider<R extends MachineRef> {
  /** False until the plugin is set up enough for a machine to exist (an API URL, say). Sweeps do nothing until then. */
  configured(): boolean;
  /** The machine a stored `chat:` or `destroy:` record names, or undefined if it names none. */
  refOf(record: Record<string, unknown>): R | undefined;
  /** The machine's key in `destroy:<key>`. Unique per machine. */
  keyOf(ref: R): string;
  /** The machine in a log line, e.g. `container 9002`. */
  name(ref: R): string;
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

/** What a lease's bring-up is handed. */
export interface LeaseChat<R extends MachineRef> {
  chatId: string;
  /** The machine the chat had, if any. */
  ref?: R;
  /** The chat's whole kv record as stored, caller fields included. */
  record?: ChatRecord<R>;
  /**
   * Call the moment a new machine exists, so a failure after that still
   * cleans it up. A ref naming a different machine starts a fresh record:
   * fields kept for the old machine do not carry over.
   */
  remember(ref: R): Promise<void>;
}

/** Why the lifecycle is letting go of a chat's machine; see {@link MachineLifecycleOptions.detach}. */
export type DetachReason = "stop" | "destroy" | "close";

export interface MachineLifecycleOptions<R extends MachineRef> {
  provider: MachineProvider<R>;
  /** `ctx.kv`. Without it nothing survives a restart, and sweeps do nothing. */
  kv?: PluginContext["kv"];
  log: PluginContext["log"];
  /** Read live, at every use. */
  policy: () => {
    /** Stop a machine this long after its chat goes idle. Negative: never. */
    idleStopMinutes: number;
    /** Destroy a machine no one has used for this long. 0: never. */
    destroyUnusedDays: number;
  };
  /**
   * Is something running on the chat's machine right now (a shell, a
   * command)? A busy machine is never TTL-destroyed, and never stopped by the
   * boot sweep. A lease in flight counts as busy without asking. Default: no.
   */
  busy?: (chatId: string) => boolean;
  /**
   * The lifecycle is about to stop the chat's machine, destroy it, or close
   * everything (shutdown, dispose): end what this process holds on it —
   * connections, shells, forwards. Errors are logged and ignored.
   */
  detach?: (chatId: string, why: DetachReason) => void | Promise<void>;
  /**
   * May the unused-machine TTL destroy this record's machine? A record it
   * refuses is kept, however long it goes unused; it still goes when its chat
   * is deleted. Default: yes.
   */
  mayExpire?: (record: ChatRecord<R>) => boolean;
  /**
   * Once per instance, at the first reconcile: a `destroy:` row whose chat
   * still exists is turned back into that chat's `chat:` record instead of
   * being destroyed — for rows queued by an older version under rules that
   * no longer hold. Until that reconcile has run, the sweep attempts no
   * pending destroy (a chat's own delete still does). `marker` is the kv key
   * that records it was done.
   */
  reviveLiveDestroys?: { marker: string };
}

/** Live lifecycle state per chat. */
interface LifeState<R extends MachineRef> {
  chatId: string;
  ref?: R;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleDeadline?: number;
  lastUsedAt?: number;
  /**
   * Bumped by every lease (and by forgetting the chat). A stop decided under
   * an older generation is dropped, so an idle stop (or the boot sweep) that
   * lost a race with a new lease never stops the machine out from under it.
   */
  generation: number;
  /** Leases running now. Each counts as busy. */
  leasing: number;
  /** Leased by this process: its machine is not a crash leftover, whatever the boot sweep sees. */
  leased: boolean;
  /** Serialises bring-up, stop and destroy for this chat's machine. */
  opChain: Promise<unknown>;
  /** Serialises writes of `chat:<id>`, so a merge never loses a concurrent one. */
  writeChain: Promise<unknown>;
}

const SWEEP_MS = 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

export class MachineLifecycle<R extends MachineRef> {
  private readonly chats = new Map<string, LifeState<R>>();
  private readonly provider: MachineProvider<R>;
  private readonly log: PluginContext["log"];
  private instance?: Promise<string>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweepChain: Promise<void> = Promise.resolve();
  private readonly destroying = new Map<string, Promise<void>>();
  /** Set once the revive pass is known done (or not asked for). */
  private revived: boolean;

  constructor(private readonly opts: MachineLifecycleOptions<R>) {
    this.provider = opts.provider;
    this.log = opts.log;
    this.revived = !opts.reviveLiveDestroys;
  }

  /** The chat's machine, as this process knows it. */
  refOf(chatId: string): R | undefined {
    return this.chats.get(chatId)?.ref;
  }

  /** The chat's stored record, caller fields included. */
  async record(chatId: string): Promise<ChatRecord<R> | undefined> {
    return this.opts.kv?.get<ChatRecord<R>>(`chat:${chatId}`);
  }

  /* --------------------------------------------------------------- lease */

  /**
   * The chat is about to use its machine: bump its generation (so a stop
   * decided before now is dropped), clear any idle deadline, mark it used,
   * then run `up` — after any stop or destroy already in flight for the chat,
   * and before any decided later. `up` brings the machine up (or finds it
   * already up) and returns whatever the caller needs to reach it. The chat
   * counts as busy until `up` settles.
   */
  async lease<T>(chatId: string, up: (chat: LeaseChat<R>) => Promise<T>): Promise<T> {
    const st = await this.stateFor(chatId);
    st.generation++;
    st.leased = true;
    st.leasing++;
    try {
      if (st.idleTimer) clearTimeout(st.idleTimer);
      st.idleTimer = undefined;
      st.idleDeadline = undefined;
      st.lastUsedAt = Date.now();
      const out = await this.serial(st, async () =>
        up({
          chatId,
          ref: st.ref,
          record: await this.record(chatId),
          remember: async (ref) => {
            st.ref = ref;
            await this.persist(st);
          },
        }),
      );
      await this.persist(st);
      return out;
    } finally {
      st.leasing--;
    }
  }

  /** The chat used its machine (a command ran): restart its unused clock. */
  async touch(chatId: string): Promise<void> {
    const st = this.chats.get(chatId);
    if (!st?.ref) return;
    st.lastUsedAt = Date.now();
    await this.persist(st);
  }

  /**
   * Merge `fields` into the chat's stored record. Only while the record names
   * `ref` (when given): a write meant for a machine the chat no longer has is
   * dropped. Resolves false when nothing was written.
   */
  async patch(chatId: string, fields: Record<string, unknown>, ref?: R): Promise<boolean> {
    const kv = this.opts.kv;
    const st = this.chats.get(chatId) ?? ((await this.record(chatId)) ? await this.stateFor(chatId) : undefined);
    if (!kv || !st?.ref) return false;
    return this.write(st, async () => {
      const prev = await kv.get<ChatRecord<R>>(`chat:${chatId}`);
      if (!prev || !this.sameMachine(prev, st.ref!)) return false;
      if (ref && !this.sameMachine(prev, ref)) return false;
      await kv.set(`chat:${chatId}`, { ...prev, ...fields });
      return true;
    });
  }

  /* --------------------------------------------------------- chat state */

  private async stateFor(chatId: string): Promise<LifeState<R>> {
    let st = this.chats.get(chatId);
    if (st) return st;
    const rec = await this.record(chatId);
    // Another await (a concurrent lease, or the boot sweep) may have made it meanwhile.
    const raced = this.chats.get(chatId);
    if (raced) return raced;
    st = {
      chatId,
      ref: rec ? this.provider.refOf(rec) : undefined,
      idleDeadline: rec?.idleDeadline,
      lastUsedAt: rec?.lastUsedAt,
      generation: 0,
      leasing: 0,
      leased: false,
      opChain: Promise.resolve(),
      writeChain: Promise.resolve(),
    };
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

  private sameMachine(rec: Record<string, unknown>, ref: R): boolean {
    const had = this.provider.refOf(rec);
    return !!had && this.provider.keyOf(had) === this.provider.keyOf(ref);
  }

  /**
   * Write the chat's record back to kv (only once it has a machine), merged
   * over what is stored: fields other code keeps there survive. A record for
   * a different machine is replaced, not merged.
   */
  private persist(st: LifeState<R>): Promise<void> {
    const kv = this.opts.kv;
    if (!st.ref || !kv) return Promise.resolve();
    return this.write(st, async () => {
      const ref = st.ref;
      if (!ref) return;
      const stored = await kv.get<ChatRecord<R>>(`chat:${st.chatId}`);
      const prev = stored && this.sameMachine(stored, ref) ? stored : undefined;
      await kv.set(`chat:${st.chatId}`, {
        ...prev,
        ...ref,
        createdAt: prev?.createdAt ?? Date.now(),
        idleDeadline: st.idleDeadline,
        lastUsedAt: st.lastUsedAt,
      } satisfies ChatRecord<R>);
    });
  }

  private write<T>(st: LifeState<R>, fn: () => Promise<T>): Promise<T> {
    const run = st.writeChain.then(fn);
    st.writeChain = run.catch(() => {});
    return run;
  }

  /** Run one machine operation for a chat, after any already in flight. */
  private serial<T>(st: LifeState<R>, fn: () => Promise<T>): Promise<T> {
    const run = st.opChain.then(fn);
    st.opChain = run.catch(() => {});
    return run;
  }

  private busy(st: LifeState<R>): boolean {
    if (st.leasing > 0) return true;
    try {
      return this.opts.busy?.(st.chatId) ?? false;
    } catch (err) {
      // Not knowing is not "idle": a wrong "idle" destroys a machine in use.
      this.log.warn(`busy check for chat ${st.chatId}: ${errText(err)}`);
      return true;
    }
  }

  private async detach(st: LifeState<R>, why: DetachReason): Promise<void> {
    try {
      await this.opts.detach?.(st.chatId, why);
    } catch (err) {
      this.log.warn(`letting go of chat ${st.chatId}'s machine (${why}): ${errText(err)}`);
    }
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
   * - `boot`: a running machine with no idle deadline, not busy and not leased
   *   by this process, is one whose chat was busy when Dispatch died without a
   *   clean shutdown — nothing will ever fire onChatIdle for it again, so stop
   *   it now.
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
    if (opts.liveChats && !this.revived) await this.reviveLiveDestroys(opts.liveChats);
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
      // Rows from before the revive pass wait for it: some may be live chats'.
      else if (this.revived && p.nextAt <= now) await this.attemptDestroy(p).catch(() => {});
    }

    const policy = this.opts.policy();
    const unusedMs = policy.destroyUnusedDays > 0 ? policy.destroyUnusedDays * 86_400_000 : 0;
    for (const st of [...this.chats.values()]) {
      if (!st.ref) continue;
      const busy = this.busy(st);
      if (opts.liveChats && !opts.liveChats.has(st.chatId)) {
        await this.enqueueDestroy(st, "its chat no longer exists").catch(() => {});
      } else if (unusedMs && !busy && (st.lastUsedAt ?? now) < now - unusedMs && (await this.mayExpire(st))) {
        // The chat may live on but stopped using this backend — switched back
        // to local, or (with per-terminal locations) just never picks it. The
        // machine only holds installs and build output, so a later lease
        // making a new one costs a reinstall, not work.
        await this.enqueueDestroy(st, `unused for ${policy.destroyUnusedDays} days`).catch(() => {});
      } else if (st.idleDeadline !== undefined && st.idleDeadline <= now) {
        await this.stopIdle(st, st.generation).catch((err: unknown) => this.log.warn(`stopping ${this.provider.name(st.ref!)}: ${errText(err)}`));
      } else if (st.idleDeadline !== undefined) {
        this.armIdleTimer(st);
      } else if (opts.boot && !busy && !st.leased) {
        await this.stopIdle(st, st.generation).catch((err: unknown) => this.log.warn(`stopping ${this.provider.name(st.ref!)}: ${errText(err)}`));
      }
    }
  }

  private async mayExpire(st: LifeState<R>): Promise<boolean> {
    if (!this.opts.mayExpire) return true;
    const rec = await this.record(st.chatId);
    return !!rec && this.opts.mayExpire(rec);
  }

  /** See {@link MachineLifecycleOptions.reviveLiveDestroys}. */
  private async reviveLiveDestroys(live: ReadonlySet<string>): Promise<void> {
    const kv = this.opts.kv!;
    const marker = this.opts.reviveLiveDestroys!.marker;
    if (await kv.get(marker)) {
      this.revived = true;
      return;
    }
    for (const key of await kv.list("destroy:")) {
      const p = await kv.get<PendingDestroy<R>>(key);
      const ref = p ? this.provider.refOf(p) : undefined;
      if (!p || !ref || !live.has(p.chatId)) continue;
      const st = await this.stateFor(p.chatId);
      if (st.ref && !this.sameMachine(st.ref, ref)) {
        // The chat has another machine: this row was a stray, queued with the
        // chat's real machine already recorded. It goes as queued.
        continue;
      }
      this.log.info(`keeping ${this.provider.name(ref)} for chat ${p.chatId}: its destroy was queued by an older version and the chat still exists`);
      st.ref = ref;
      st.lastUsedAt = Date.now();
      await this.persist(st);
      await kv.delete(key);
    }
    await kv.set(marker, true);
    this.revived = true;
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
      const st = this.chats.get(chatId) ?? ((await this.record(chatId)) ? await this.stateFor(chatId) : undefined);
      if (!st?.ref) return;
      const minutes = this.opts.policy().idleStopMinutes;
      if (minutes < 0) return;
      const gen = st.generation;
      st.idleDeadline = Date.now() + minutes * 60_000;
      await this.persist(st);
      // A lease while that write was in flight un-idled the chat.
      if (st.generation === gen) this.armIdleTimer(st, gen);
    })().catch((err: unknown) => this.log.warn(`idle for chat ${chatId}: ${errText(err)}`));
  }

  /** The timer is only the fast path; the minute sweep stops anything the timer missed. */
  private armIdleTimer(st: LifeState<R>, gen = st.generation): void {
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
   * Stop the chat's machine, unless a lease has happened since the stop was
   * decided (`gen`). The next lease starts it again. Detaches first.
   */
  private stopIdle(st: LifeState<R>, gen: number): Promise<void> {
    return this.serial(st, async () => {
      if (st.generation !== gen || !st.ref) return;
      await this.detach(st, "stop");
      // Detaching may have yielded to a lease that queued behind us; it
      // bumped the generation, and the machine is about to be in use.
      if (st.generation !== gen) return;
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
    else await this.forget(st, "destroy");
    // A retry from core after an earlier failure: the record is all that is left.
    for (const p of pending) await this.attemptDestroy(p);
  }

  /** Forget the chat's machine and destroy it: pending in kv first, then one attempt now. */
  private async enqueueDestroy(st: LifeState<R>, why: string): Promise<void> {
    const ref = st.ref!;
    const p: PendingDestroy<R> = { chatId: st.chatId, ...ref, attempts: 0, nextAt: 0 };
    this.log.info(`destroying ${this.provider.name(ref)} (chat ${p.chatId}): ${why}`);
    await this.recordDestroy(p);
    await this.forget(st, "destroy");
    await this.write(st, async () => this.opts.kv?.delete(`chat:${st.chatId}`));
    await this.attemptDestroy(p);
  }

  private async forget(st: LifeState<R>, why: DetachReason): Promise<void> {
    st.generation++;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = undefined;
    if (this.chats.get(st.chatId) === st) this.chats.delete(st.chatId);
    await this.detach(st, why);
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
   *   back. Chats leased here get an idle deadline written down, so one whose
   *   chat never comes back is still stopped by the boot sweep in time.
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
    await this.closeAll();
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
   * A chat leased in this process with no idle deadline may be busy now, and
   * nothing will fire onChatIdle for it after the restart. Give it one, so
   * the boot sweep leaves it running for a normal idle period — reusable if
   * the chat comes back — rather than treating it like a crash's leftovers.
   */
  private async noteDeadlines(): Promise<void> {
    const minutes = this.opts.policy().idleStopMinutes;
    if (minutes < 0) return;
    for (const st of this.chats.values()) {
      if (!st.ref || st.idleDeadline !== undefined || !st.leased) continue;
      st.idleDeadline = Date.now() + minutes * 60_000;
      await this.persist(st);
    }
  }

  private async closeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const st of this.chats.values()) {
      if (st.idleTimer) clearTimeout(st.idleTimer);
      st.idleTimer = undefined;
      await this.detach(st, "close");
    }
  }

  /**
   * Plugin switched off, or Dispatch shutting down on a core without
   * onShutdown: let go of everything, leave machines as they are. The idle
   * deadlines written here are what lets the next load stop them on time.
   */
  async dispose(): Promise<void> {
    await this.noteDeadlines().catch(() => {});
    await this.closeAll();
    this.chats.clear();
  }
}
