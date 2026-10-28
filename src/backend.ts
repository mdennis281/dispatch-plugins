/**
 * The Proxmox terminal backend: one LXC per chat, linked-cloned from a
 * template the first time the chat opens a terminal, stopped when the chat
 * goes idle, destroyed when the chat is deleted.
 *
 * The container holds its OWN git checkout of the chat's code. Before every
 * command, the chat's local worktree is snapshotted (see snapshot.ts) and
 * pushed over SSH as a git pack, then checked out there. So the agent edits
 * locally and never pushes to GitHub to test, no GitHub token goes near the
 * container, and ignored directories (node_modules, build output) stay put
 * on the container between commands. Losing the container loses only those:
 * the real copy of the code is on the Dispatch host.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  PluginContext,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalSpawnInfo,
} from "@dispatch/plugin-sdk";
import { Proxmox, ProxmoxError, sleep } from "./proxmox.js";
import { localHas, pack, remotePathFor, repoInfo, snapshot } from "./snapshot.js";
import { SshConnection, sq } from "./ssh.js";
import type { Settings } from "./settings.js";

export const BACKEND_ID = "proxmox";

/** What survives a restart, per chat, in the plugin's kv (`chat:<chatId>`). */
interface ChatRecord {
  vmid: number;
  hostname: string;
  createdAt: number;
  /**
   * When the idle stop is due (epoch ms). Kept here and not only in a timer:
   * an in-memory setTimeout died with every Dispatch restart, and the
   * container it was meant to stop ran until someone noticed.
   */
  idleDeadline?: number;
  /** Last spawn. A clone unused for `destroyUnusedDays` is destroyed. */
  lastUsedAt?: number;
}

/**
 * A destroy that has not succeeded yet (`destroy:<chatId>`). Written BEFORE the
 * first attempt, so a crash mid-destroy is retried too. Core fires
 * onChatDeleted without waiting on older versions, so a Proxmox outage at that
 * moment used to leak the container for good.
 */
interface PendingDestroy {
  chatId: string;
  vmid: number;
  hostname: string;
  attempts: number;
  nextAt: number;
  lastError?: string;
}

/** Why core is shutting the plugin down (the timed `onShutdown` hook). */
export type ShutdownReason = "restart" | "stop" | "disable" | "uninstall";

const SWEEP_MS = 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
/** Under core's 60 s onChatDeleted timeout, so a slow destroy is ours to report, not a timeout. */
const DESTROY_WAIT_MS = 45_000;

/** Live state per chat. */
interface ChatState {
  chatId: string;
  vmid: number;
  hostname: string;
  conn?: SshConnection;
  ip?: string;
  /** In flight while the container is being made / started / connected. */
  ready?: Promise<void>;
  /** Per local repo root: where it lives on the container, and what was last checked out. */
  repos: Map<string, { remote: string; lastSynced?: string; seeded?: Promise<void> }>;
  /** Serialises syncs: several shells in one chat share one checkout. */
  syncChain: Promise<unknown>;
  idleTimer?: ReturnType<typeof setTimeout>;
  portTimer?: ReturnType<typeof setInterval>;
  forwards: Map<number, { close: () => void; withdraw: () => void }>;
  /** Live shells, so a stop/destroy can end them. */
  shells: Set<TerminalBackendHandle>;
  idleDeadline?: number;
  lastUsedAt?: number;
  /**
   * Bumped by every spawn. A stop decided under an older generation is
   * dropped, so an idle stop (or the boot sweep) that lost a race with a new
   * command never stops the container out from under it.
   */
  generation: number;
  /** Serialises bring-up, stop and destroy for this chat's container. */
  opChain: Promise<unknown>;
}

export interface BackendDeps {
  ctx: PluginContext;
  /** Where each chat's vmid is remembered across restarts (`ctx.kv`). */
  kv?: PluginContext["kv"];
  settings: () => Settings;
  /** The Proxmox API token, `USER@REALM!ID=SECRET`. */
  token: () => Promise<string | undefined>;
  /** SSH credentials for the containers. */
  sshAuth: () => Promise<{ privateKey?: string; password?: string }>;
  /** Injectable for tests. */
  proxmox?: (s: Settings, token: string) => Proxmox;
  connect?: (host: string, user: string, auth: { privateKey?: string; password?: string }) => SshConnection;
}

export class ProxmoxTerminalBackend implements TerminalBackend {
  readonly id = BACKEND_ID;
  readonly label: string;
  readonly shell = "bash" as const;
  private readonly chats = new Map<string, ChatState>();
  private readonly log;

  constructor(private readonly deps: BackendDeps) {
    this.label = "Proxmox container";
    this.log = deps.ctx.log;
  }

  get spawnTimeoutMs(): number {
    return Math.max(30, this.deps.settings().spawnTimeoutSeconds) * 1_000;
  }

  /* ------------------------------------------------------------------ api */

  private async api(): Promise<Proxmox> {
    const s = this.deps.settings();
    if (!s.apiUrl) throw new Error("the proxmox-terminal plugin has no API URL set (Settings → Plugins → Proxmox terminal)");
    const token = await this.deps.token();
    if (!token) throw new Error("the PROXMOX_TERMINAL_API_TOKEN secret is not set");
    return this.deps.proxmox
      ? this.deps.proxmox(s, token)
      : new Proxmox({ apiUrl: s.apiUrl, token, caCert: s.caCert, insecureTls: s.insecureTls });
  }

  /* --------------------------------------------------------------- spawn */

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
    const repo = await this.ensureRepo(st, local.root, local);
    await this.sync(st, local.root);
    const conn = st.conn!;
    const handle = await conn.shell(remotePathFor(local.root, info.cwd, repo.remote), {
      TERM: "dumb",
      FORCE_COLOR: "0",
      DISPATCH_TERMINAL: "proxmox",
    });
    st.shells.add(handle);
    handle.on("exit", () => st.shells.delete(handle));
    this.startPortWatch(st);
    return this.syncBeforeEachCommand(st, local.root, handle);
  }

  agentNote({ chatId }: { chatId: string }): string {
    const st = this.chats.get(chatId);
    const where = st ? `container ${st.hostname} (vmid ${st.vmid})` : "a per-chat Proxmox container";
    const workDir = this.deps.settings().workDir;
    return [
      `- Your terminal runs on ${where}: Debian Linux with its own git checkout of this repo under ${workDir}/.`,
      `- Edit files LOCALLY as usual. Before every terminal command Dispatch snapshots your local worktree — committed, ` +
        `uncommitted and untracked files alike — and checks it out on the container. Never push to GitHub to get a change ` +
        `over, and don't edit files inside the container: the next command overwrites tracked files there.`,
      `- Ignored directories (node_modules, dist, build output) are NOT synced; the container keeps its own. A Windows-built ` +
        `node_modules is useless on Linux, so run the install (e.g. \`pnpm install\`) in the terminal once per container, ` +
        `and again when dependencies change.`,
      `- There is no GitHub token on the container, by design. Do git work locally.`,
      `- The container stops when the chat goes idle (the next command restarts it) and is destroyed when the chat is ` +
        `deleted. Only installs and build output are lost; your code lives on the Dispatch host.`,
    ].join("\n");
  }

  /* ------------------------------------------------------- container state */

  private async stateFor(chatId: string): Promise<ChatState> {
    let st = this.chats.get(chatId);
    if (st) return st;
    const rec = await this.deps.kv?.get<ChatRecord>(`chat:${chatId}`);
    // Another await (a concurrent spawn, or the boot sweep) may have made it meanwhile.
    const raced = this.chats.get(chatId);
    if (raced) return raced;
    st = {
      chatId,
      vmid: rec?.vmid ?? 0,
      hostname: rec?.hostname ?? hostnameFor(chatId),
      repos: new Map(),
      syncChain: Promise.resolve(),
      forwards: new Map(),
      shells: new Set(),
      idleDeadline: rec?.idleDeadline,
      lastUsedAt: rec?.lastUsedAt,
      generation: 0,
      opChain: Promise.resolve(),
    };
    this.chats.set(chatId, st);
    // A record from before lastUsedAt existed: start its unused clock now, not
    // at createdAt, or the first sweep after an update would destroy a clone
    // its chat is still using.
    if (rec && rec.lastUsedAt === undefined) {
      st.lastUsedAt = Date.now();
      await this.persist(st);
    }
    return st;
  }

  /** Write the chat's record back to kv (only once it has a container). */
  private async persist(st: ChatState): Promise<void> {
    if (!st.vmid || !this.deps.kv) return;
    const prev = await this.deps.kv.get<ChatRecord>(`chat:${st.chatId}`);
    await this.deps.kv.set(`chat:${st.chatId}`, {
      vmid: st.vmid,
      hostname: st.hostname,
      createdAt: prev?.createdAt ?? Date.now(),
      idleDeadline: st.idleDeadline,
      lastUsedAt: st.lastUsedAt,
    } satisfies ChatRecord);
  }

  /** Run one container operation for a chat, after any already in flight. */
  private serial<T>(st: ChatState, fn: () => Promise<T>): Promise<T> {
    const run = st.opChain.then(fn);
    st.opChain = run.catch(() => {});
    return run;
  }

  /** Make sure the chat's container exists, is running, and has an open SSH connection. */
  private ensureReady(st: ChatState, signal: AbortSignal): Promise<void> {
    if (st.conn?.isOpen) return Promise.resolve();
    if (!st.ready) {
      st.ready = this.serial(st, () => (st.conn?.isOpen ? Promise.resolve() : this.bringUp(st, signal))).finally(() => {
        st.ready = undefined;
      });
    }
    return st.ready;
  }

  private async bringUp(st: ChatState, signal: AbortSignal): Promise<void> {
    const s = this.deps.settings();
    const api = await this.api();
    let status = st.vmid ? await api.status(s.node, st.vmid) : undefined;
    // A remembered vmid whose container was destroyed behind our back may
    // since have gone to another chat (or the other Dispatch instance sharing
    // the pool). Starting and syncing into THAT would be the worst outcome here.
    if (status && (await this.ownership(api, s, st.vmid, st.chatId)) !== "ours") {
      this.log.warn(`vmid ${st.vmid} no longer holds chat ${st.chatId}'s container; making a new one`);
      status = undefined;
    }
    if (!status) {
      st.vmid = await this.cloneFor(api, s, st, signal);
      status = "stopped";
    }
    if (status !== "running") {
      this.log.info(`starting container ${st.vmid} for chat ${st.chatId}`);
      const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${st.vmid}/status/start`);
      await api.waitTask(s.node, upid, 60_000, signal);
    }
    st.ip = await this.waitForIp(api, s.node, st.vmid, signal);
    const auth = await this.deps.sshAuth();
    if (!auth.privateKey && !auth.password) {
      throw new Error("no SSH credentials: set the sshKeyPath setting, or the PROXMOX_TERMINAL_SSH_KEY / _SSH_PASSWORD secret");
    }
    const conn = this.deps.connect
      ? this.deps.connect(st.ip, s.sshUser, auth)
      : new SshConnection({ host: st.ip, username: s.sshUser, ...auth });
    await conn.connect(60_000, signal);
    conn.on("close", () => {
      if (st.conn === conn) this.dropConnection(st);
    });
    st.conn = conn;
  }

  /** Linked-clone the template into a free vmid, size it, and remember it. */
  private async cloneFor(api: Proxmox, s: Settings, st: ChatState, signal: AbortSignal): Promise<number> {
    // Best effort: a vmid held outside the pool still fails the clone with
    // "already exists", and the loop moves on.
    const taken = new Set(await this.poolVmids(api, s).catch(() => []));
    let lastErr: unknown;
    for (let vmid = s.vmidStart; vmid <= s.vmidEnd; vmid++) {
      if (taken.has(vmid) || vmid === s.templateVmid) continue;
      try {
        this.log.info(`cloning template ${s.templateVmid} → ${vmid} (${st.hostname}) for chat ${st.chatId}`);
        const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${s.templateVmid}/clone`, {
          newid: vmid,
          hostname: st.hostname,
          pool: s.pool,
          description: describe(st.chatId, await this.instanceId()),
        });
        await api.waitTask(s.node, upid, 180_000, signal);
      } catch (err) {
        lastErr = err;
        // Someone else holds this id (outside our pool, or a concurrent clone):
        // try the next one. Anything else is a real failure.
        if (err instanceof ProxmoxError && /already exists|in use|exists/i.test(err.message)) continue;
        throw err;
      }
      await api.call("PUT", `/nodes/${s.node}/lxc/${vmid}/config`, {
        cores: s.cores,
        memory: s.memory,
        net0: `name=eth0,bridge=${s.bridge},ip=dhcp,type=veth`,
        tags: "dispatch-terminal",
      });
      st.vmid = vmid;
      await this.persist(st);
      return vmid;
    }
    throw new Error(
      `no free vmid in ${s.vmidStart}-${s.vmidEnd}` + (lastErr instanceof Error ? ` (last error: ${lastErr.message})` : ""),
    );
  }

  private async waitForIp(api: Proxmox, node: string, vmid: number, signal: AbortSignal): Promise<string> {
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const ip = await api.ipv4(node, vmid).catch(() => undefined);
      if (ip) return ip;
      await sleep(1_000, signal);
    }
    throw new Error(`container ${vmid} got no IPv4 address within 60s (is DHCP serving the ${this.deps.settings().bridge} bridge?)`);
  }

  /* ---------------------------------------------------------------- code */

  /**
   * The container's copy of a local repo: seeded once, from GitHub when the
   * repo's origin is a public GitHub repo (shallow, so the first pack is just
   * the local delta), otherwise an empty repo the first pack fills.
   */
  private ensureRepo(
    st: ChatState,
    root: string,
    local: { branch?: string; originUrl?: string },
  ): Promise<{ remote: string }> {
    const existing = st.repos.get(root);
    if (existing?.seeded) return existing.seeded.then(() => existing);
    const remote = `${this.deps.settings().workDir}/${safeName(basename(root))}`;
    const entry: { remote: string; lastSynced?: string; seeded?: Promise<void> } = { remote };
    st.repos.set(root, entry);
    entry.seeded = (async () => {
      const conn = st.conn!;
      const has = (await conn.exec(`test -d ${sq(remote)}/.git && echo yes`)).stdout.trim() === "yes";
      if (has) return;
      const https = githubHttps(local.originUrl);
      if (https) {
        const branchArg = local.branch ? `--branch ${sq(local.branch)} ` : "";
        const r = await conn.exec(
          `mkdir -p ${sq(this.deps.settings().workDir)} && GIT_TERMINAL_PROMPT=0 git clone -q --depth 50 --single-branch ${branchArg}${sq(https)} ${sq(remote)}`,
          { timeoutMs: 300_000 },
        );
        // A branch that exists only locally (or a private repo) can't come from
        // GitHub: fall back to the default branch, then to an empty repo.
        if (r.code !== 0 && local.branch) {
          await conn.exec(`rm -rf ${sq(remote)}`);
          await conn.exec(`GIT_TERMINAL_PROMPT=0 git clone -q --depth 50 ${sq(https)} ${sq(remote)}`, { timeoutMs: 300_000 });
        }
      }
      await conn.run(`mkdir -p ${sq(remote)} && cd ${sq(remote)} && (test -d .git || git init -q)`);
    })().catch((err: unknown) => {
      st.repos.delete(root);
      throw err;
    });
    return entry.seeded.then(() => entry);
  }

  /**
   * Bring the container's checkout to the local worktree's current state.
   * Cheap when nothing changed: the snapshot sha is stable, and an unchanged
   * one is a no-op.
   */
  private sync(st: ChatState, root: string): Promise<void> {
    const run = st.syncChain.then(async () => {
      const entry = st.repos.get(root);
      const conn = st.conn;
      if (!entry || !conn?.isOpen) return;
      const snap = await snapshot(root);
      if (snap === entry.lastSynced) return;
      const remote = sq(entry.remote);
      // Everything the container already has, as candidate exclusions — any
      // of it the local repo also has keeps the pack down to the delta.
      const refs = await conn.exec(`cd ${remote} && git for-each-ref --format='%(objectname)' && git rev-parse -q --verify HEAD`);
      const exclude = await localHas(root, [...new Set(refs.stdout.split(/\s+/).filter(Boolean))]);
      const r = await conn.exec(`cd ${remote} && git index-pack --stdin >/dev/null`, {
        stdin: async (ch) => {
          await pack(root, snap, exclude, ch);
        },
        timeoutMs: 600_000,
      });
      if (r.code !== 0) throw new Error(`index-pack on the container failed: ${r.stderr.trim()}`);
      await conn.run(`cd ${remote} && git update-ref refs/dispatch/snapshot ${snap} && git checkout -q --force --detach ${snap}`);
      entry.lastSynced = snap;
    });
    st.syncChain = run.catch(() => {});
    return run;
  }

  /**
   * Re-sync before every command. Dispatch writes each command and then its
   * sentinel probe as two writes; the probe (`__cm_ec=…`) needs no sync. Writes
   * stay in order on one promise chain. A failed sync is said ON the terminal's
   * stderr and the command still runs, against the last good snapshot — a
   * silent stale checkout would be worse than a visible one.
   */
  private syncBeforeEachCommand(st: ChatState, root: string, h: TerminalBackendHandle): TerminalBackendHandle {
    let chain: Promise<unknown> = Promise.resolve();
    const stderr = h.stderr as unknown as { emit(e: "data", s: string): void };
    const write = (chunk: string): void => {
      const isProbe = chunk.startsWith("__cm_ec=");
      chain = chain.then(async () => {
        if (!isProbe) {
          await this.sync(st, root).catch((err: unknown) => {
            stderr.emit(
              "data",
              `[proxmox-terminal] could not sync your local changes (${err instanceof Error ? err.message : String(err)}); ` +
                `this command runs against the last synced snapshot.\n`,
            );
          });
        }
        h.stdin.write(chunk);
      });
    };
    return {
      stdin: { write, end: () => void chain.then(() => h.stdin.end?.()), on: (e, l) => h.stdin.on?.(e, l) },
      stdout: h.stdout,
      stderr: h.stderr,
      kill: (sig) => h.kill(sig),
      on: ((e: "exit" | "error", l: (arg: never) => void) => h.on(e as "exit", l as (c: number | null) => void)) as TerminalBackendHandle["on"],
      cwd: h.cwd,
    };
  }

  /* --------------------------------------------------------------- ports */

  /**
   * Forward whatever the container is listening on, while it has shells.
   * Polled, because a dev server announces its port on its own schedule and
   * the agent should not have to ask.
   */
  private startPortWatch(st: ChatState): void {
    if (st.portTimer) return;
    const tick = async () => {
      const conn = st.conn;
      if (!conn?.isOpen) return;
      const r = await conn.exec("ss -Htln 2>/dev/null", { timeoutMs: 10_000 }).catch(() => undefined);
      if (!r || r.code !== 0) return;
      const ports = parseListeners(r.stdout);
      for (const [port, host] of ports) {
        if (st.forwards.has(port)) continue;
        try {
          const fwd = await conn.forward(port, host);
          const withdraw = this.deps.ctx.terminals!.publishPort(BACKEND_ID, {
            chatId: st.chatId,
            remotePort: port,
            url: `http://127.0.0.1:${fwd.localPort}`,
          });
          st.forwards.set(port, { close: fwd.close, withdraw });
          this.log.info(`forwarding ${st.hostname}:${port} → 127.0.0.1:${fwd.localPort}`);
        } catch (err) {
          this.log.warn(`could not forward port ${port} for chat ${st.chatId}: ${String(err)}`);
        }
      }
      for (const [port, f] of st.forwards) {
        if (!ports.has(port)) {
          f.withdraw();
          f.close();
          st.forwards.delete(port);
        }
      }
    };
    st.portTimer = setInterval(() => void tick(), 3_000);
    st.portTimer.unref?.();
    void tick();
  }

  private dropConnection(st: ChatState): void {
    if (st.portTimer) clearInterval(st.portTimer);
    st.portTimer = undefined;
    for (const f of st.forwards.values()) {
      f.withdraw();
      f.close();
    }
    st.forwards.clear();
    for (const h of [...st.shells]) h.kill();
    st.shells.clear();
    st.conn?.close();
    st.conn = undefined;
    // Not `repos`: the checkout on the container survives a stop, and so does
    // what was last synced into it.
  }

  /* ----------------------------------------------------------- lifecycle */
  //
  // Everything below survives a Dispatch restart through kv: the idle
  // deadline, the chat → vmid map, and destroys that have not succeeded yet.
  // A sweep (at load, then every minute) acts on what is due, so nothing here
  // depends on a timer or a hook having fired in THIS process.

  private instance?: Promise<string>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweepChain: Promise<void> = Promise.resolve();
  private readonly destroying = new Map<number, Promise<void>>();

  /**
   * This instance's id, minted once into kv. Stable and dev Dispatch share
   * config/ — so the same settings and the same Proxmox pool — but not data/,
   * so each has its own kv and its own id. Every clone's description carries
   * it, and the sweeps only adopt or destroy clones that carry THIS id: the
   * other instance's containers are never ours to touch.
   */
  instanceId(): Promise<string> {
    this.instance ??= (async () => {
      const have = await this.deps.kv?.get<string>("instance");
      if (have) return have;
      const id = randomUUID().replace(/-/g, "").slice(0, 12);
      await this.deps.kv?.set("instance", id);
      return id;
    })();
    return this.instance;
  }

  /**
   * Called once from activate. Recovers what a restart lost — the chat → vmid
   * map from kv and the pool, the idle stops that were due, the destroys that
   * failed — then keeps sweeping. Never throws: Proxmox may be down, and the
   * next sweep tries again.
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
   * - `adopt`: also read the pool, and take back any clone tagged with this
   *   instance's id that kv has no record of.
   * - `boot`: a running container with no live shell and no idle deadline is
   *   one whose chat was busy when Dispatch died without a clean shutdown —
   *   nothing will ever fire onChatIdle for it again, so stop it now.
   * - `liveChats`: every chat that still exists. A clone for any other chat is
   *   destroyed.
   */
  sweep(opts: { adopt?: boolean; boot?: boolean; liveChats?: ReadonlySet<string> } = {}): Promise<void> {
    const run = this.sweepChain.then(() => this.sweepOnce(opts));
    this.sweepChain = run.catch(() => {});
    return run.catch((err: unknown) => this.log.warn(`cleanup sweep: ${errText(err)}`));
  }

  private async sweepOnce(opts: { adopt?: boolean; boot?: boolean; liveChats?: ReadonlySet<string> }): Promise<void> {
    const s = this.deps.settings();
    const kv = this.deps.kv;
    if (!s.apiUrl || !kv) return; // not configured yet: nothing can exist
    for (const key of await kv.list("chat:")) await this.stateFor(key.slice("chat:".length));
    // Adoption failing (Proxmox down, a permission missing) must not cost the
    // idle stops and retries below — the first live run lost its boot sweep so.
    if (opts.adopt) await this.adopt().catch((err: unknown) => this.log.warn(`re-adopting containers: ${errText(err)}`));
    const now = Date.now();

    for (const key of await kv.list("destroy:")) {
      const p = await kv.get<PendingDestroy>(key);
      if (p && p.nextAt <= now) await this.attemptDestroy(p).catch(() => {});
    }

    const unusedMs = s.destroyUnusedDays > 0 ? s.destroyUnusedDays * 86_400_000 : 0;
    for (const st of [...this.chats.values()]) {
      if (!st.vmid) continue;
      const busy = st.shells.size > 0 || !!st.ready;
      if (opts.liveChats && !opts.liveChats.has(st.chatId)) {
        await this.enqueueDestroy(st, "its chat no longer exists").catch(() => {});
      } else if (unusedMs && !busy && (st.lastUsedAt ?? now) < now - unusedMs) {
        // The chat may live on but stopped using this backend — switched back
        // to local, or (with per-terminal locations) just never picks it. The
        // container only holds installs and build output, so a later spawn
        // re-cloning costs a reinstall, not work.
        await this.enqueueDestroy(st, `unused for ${s.destroyUnusedDays} days`).catch(() => {});
      } else if (st.idleDeadline !== undefined && st.idleDeadline <= now) {
        await this.stopIdle(st, st.generation).catch((err: unknown) => this.log.warn(`stopping ${st.vmid}: ${errText(err)}`));
      } else if (st.idleDeadline !== undefined) {
        this.armIdleTimer(st);
      } else if (opts.boot && !busy && !st.conn) {
        await this.stopIdle(st, st.generation).catch((err: unknown) => this.log.warn(`stopping ${st.vmid}: ${errText(err)}`));
      }
    }
  }

  /** Take back clones in the pool tagged with this instance whose kv record was lost. */
  private async adopt(): Promise<void> {
    const s = this.deps.settings();
    const api = await this.api();
    const ours = await this.instanceId();
    const known = new Set([...this.chats.values()].map((st) => st.vmid));
    for (const key of (await this.deps.kv?.list("destroy:")) ?? []) known.add(Number(key.slice("destroy:".length)));
    for (const vmid of await this.poolVmids(api, s)) {
      if (known.has(vmid) || !inRange(s, vmid)) continue;
      const cfg = await this.config(api, s, vmid).catch(() => undefined);
      if (!cfg || Number(cfg.template) === 1) continue;
      const d = parseDescription(cfg.description);
      if (d.instance !== ours || !d.chatId) continue;
      const st = await this.stateFor(d.chatId);
      if (st.vmid && st.vmid !== vmid) {
        // The chat already has another container: this one is a stray.
        await this.recordDestroy({ chatId: d.chatId, vmid, hostname: cfg.hostname ?? "", attempts: 0, nextAt: 0 });
        continue;
      }
      this.log.info(`re-adopting container ${vmid} for chat ${d.chatId} (its kv record was lost)`);
      st.vmid = vmid;
      st.hostname = cfg.hostname ?? st.hostname;
      st.lastUsedAt ??= Date.now();
      await this.persist(st);
    }
  }

  onChatIdle({ chatId }: { chatId: string }): Promise<void> {
    return (async () => {
      const st = this.chats.get(chatId) ?? (await this.deps.kv?.get<ChatRecord>(`chat:${chatId}`) ? await this.stateFor(chatId) : undefined);
      if (!st?.vmid) return;
      const minutes = this.deps.settings().idleStopMinutes;
      if (minutes < 0) return;
      const gen = st.generation;
      st.idleDeadline = Date.now() + minutes * 60_000;
      await this.persist(st);
      // A spawn while that write was in flight un-idled the chat.
      if (st.generation === gen) this.armIdleTimer(st, gen);
    })().catch((err: unknown) => this.log.warn(`idle for chat ${chatId}: ${errText(err)}`));
  }

  /** The timer is only the fast path; the minute sweep stops anything the timer missed. */
  private armIdleTimer(st: ChatState, gen = st.generation): void {
    if (st.idleDeadline === undefined) return;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => {
      st.idleTimer = undefined;
      void this.stopIdle(st, gen).catch((err: unknown) => this.log.warn(`stopping ${st.vmid} failed: ${errText(err)}`));
    }, Math.max(0, st.idleDeadline - Date.now()));
    st.idleTimer.unref?.();
  }

  /**
   * Stop the chat's container, unless a spawn has happened since the stop was
   * decided (`gen`). The next spawn starts it again.
   */
  private stopIdle(st: ChatState, gen: number): Promise<void> {
    return this.serial(st, async () => {
      if (st.generation !== gen || !st.vmid) return;
      await this.stop(st);
      st.idleDeadline = undefined;
      await this.persist(st);
    });
  }

  /** Stop a chat's container. Ends its shells; checks the vmid is still this chat's first. */
  async stop(st: ChatState): Promise<void> {
    this.dropConnection(st);
    const s = this.deps.settings();
    const api = await this.api();
    if ((await api.status(s.node, st.vmid)) !== "running") return;
    if ((await this.ownership(api, s, st.vmid, st.chatId)) !== "ours") return;
    this.log.info(`stopping idle container ${st.vmid} (chat ${st.chatId})`);
    const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${st.vmid}/status/shutdown`, { timeout: 30, forceStop: 1 });
    await api.waitTask(s.node, upid, 90_000);
  }

  /**
   * Destroy the chat's container. Resolves only once it is gone (or was never
   * made); REJECTS when it could not be destroyed, so a core that retries
   * chat cleanup knows to. Either way the attempt is recorded and the sweep
   * keeps retrying with backoff, so an older core that does not wait on this
   * loses nothing either.
   */
  async onChatDeleted({ chatId }: { chatId: string }): Promise<void> {
    const pending = await this.pendingFor(chatId);
    const st = await this.stateFor(chatId);
    if (st.vmid) await this.enqueueDestroy(st, "its chat was deleted");
    else this.forget(st);
    // A retry from core after an earlier failure: the record is all that is left.
    for (const p of pending) await this.attemptDestroy(p);
  }

  /** Forget the chat's container and destroy it: pending in kv first, then one attempt now. */
  private async enqueueDestroy(st: ChatState, why: string): Promise<void> {
    const p: PendingDestroy = { chatId: st.chatId, vmid: st.vmid, hostname: st.hostname, attempts: 0, nextAt: 0 };
    this.log.info(`destroying container ${p.vmid} (chat ${p.chatId}): ${why}`);
    await this.recordDestroy(p);
    this.forget(st);
    await this.deps.kv?.delete(`chat:${st.chatId}`);
    await this.attemptDestroy(p);
  }

  private forget(st: ChatState): void {
    st.generation++;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = undefined;
    this.dropConnection(st);
    if (this.chats.get(st.chatId) === st) this.chats.delete(st.chatId);
  }

  private async recordDestroy(p: PendingDestroy): Promise<void> {
    await this.deps.kv?.set(`destroy:${p.vmid}`, p);
  }

  private async pendingFor(chatId: string): Promise<PendingDestroy[]> {
    const kv = this.deps.kv;
    if (!kv) return [];
    const out: PendingDestroy[] = [];
    for (const key of await kv.list("destroy:")) {
      const p = await kv.get<PendingDestroy>(key);
      if (p?.chatId === chatId) out.push(p);
    }
    return out;
  }

  /** One destroy attempt for a pending record; on failure, back off and rethrow. */
  private attemptDestroy(p: PendingDestroy, opts: { timeoutMs?: number } = {}): Promise<void> {
    const inflight = this.destroying.get(p.vmid);
    if (inflight) return inflight;
    const run = (async () => {
      try {
        await this.destroyVm(p.vmid, p.chatId, opts);
        await this.deps.kv?.delete(`destroy:${p.vmid}`);
      } catch (err) {
        p.attempts++;
        p.nextAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (p.attempts - 1));
        p.lastError = errText(err);
        await this.recordDestroy(p).catch(() => {});
        this.log.warn(
          `destroying container ${p.vmid} (chat ${p.chatId}) failed, attempt ${p.attempts}; ` +
            `retrying after ${new Date(p.nextAt).toISOString()}: ${p.lastError}`,
        );
        throw err;
      }
    })().finally(() => this.destroying.delete(p.vmid));
    this.destroying.set(p.vmid, run);
    return run;
  }

  /**
   * Stop and destroy one container — only after checking it is a clone in the
   * configured range, not a template, and (by its description) the chat's.
   * Anything else is treated as already gone: never destroy what we can't
   * prove is ours.
   */
  private async destroyVm(vmid: number, chatId: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    const s = this.deps.settings();
    const api = await this.api();
    const own = await this.ownership(api, s, vmid, chatId);
    if (own === "gone") return;
    if (own === "not-ours") {
      this.log.warn(`not destroying ${vmid}: it is not chat ${chatId}'s clone (outside ${s.vmidStart}-${s.vmidEnd}, a template, or another chat's)`);
      return;
    }
    // One task, not stop-then-destroy: core gives onChatDeleted 60 s and
    // onShutdown 5 s, and `force` destroys a running container in one go.
    const upid = await api.call<string>("DELETE", `/nodes/${s.node}/lxc/${vmid}`, {
      purge: 1,
      "destroy-unreferenced-disks": 1,
      force: 1,
    });
    await api.waitTask(s.node, upid, opts.timeoutMs ?? DESTROY_WAIT_MS);
    this.log.info(`destroyed container ${vmid} (chat ${chatId})`);
  }

  private async config(api: Proxmox, s: Settings, vmid: number): Promise<LxcConfig | undefined> {
    try {
      return await api.call<LxcConfig>("GET", `/nodes/${s.node}/lxc/${vmid}/config`);
    } catch (err) {
      if (err instanceof ProxmoxError && GONE.test(err.message)) return undefined;
      throw err;
    }
  }

  private async ownership(api: Proxmox, s: Settings, vmid: number, chatId: string): Promise<"ours" | "gone" | "not-ours"> {
    if (!inRange(s, vmid)) return "not-ours";
    const cfg = await this.config(api, s, vmid);
    if (!cfg) return "gone";
    if (Number(cfg.template) === 1) return "not-ours";
    const d = parseDescription(cfg.description);
    if (d.chatId) return d.chatId === chatId ? "ours" : "not-ours";
    // A description someone edited away: fall back to the hostname we gave it.
    return cfg.hostname === hostnameFor(chatId) ? "ours" : "not-ours";
  }

  /**
   * The pool's containers, from `/cluster/resources` rather than `/pools/<id>`:
   * the latter needs Pool.Audit, which the setup's DispatchTerminal role does
   * not grant (a live run got 403), while every pool member is listed here to
   * a token holding VM.Audit on the pool.
   */
  private async poolVmids(api: Proxmox, s: Settings): Promise<number[]> {
    const all = await api.call<Array<{ vmid?: number; type?: string; pool?: string }>>("GET", "/cluster/resources", { type: "vm" });
    return (all ?? [])
      .filter((m) => m.pool === s.pool && m.type === "lxc")
      .map((m) => m.vmid)
      .filter((v): v is number => typeof v === "number");
  }

  /**
   * Startup reconcile (core's module hook, forwarded by server.ts): `chats`
   * is every chat that exists, archived included. A
   * clone for any other chat is destroyed; idle ones are stopped.
   */
  reconcile({ chats }: { chats: Iterable<string | { id: string }> }): Promise<void> {
    const ids = new Set<string>();
    for (const c of chats) ids.add(typeof c === "string" ? c : c.id);
    return this.sweep({ adopt: true, boot: true, liveChats: ids });
  }

  /**
   * Timed shutdown (core hook).
   * - `restart`: leave containers running — they are reused when Dispatch is
   *   back. Busy chats get an idle deadline written down, so one whose chat
   *   never comes back is still stopped by the boot sweep in time.
   * - `stop` / `disable`: nothing will manage the containers for a while, so
   *   ask Proxmox to shut each one down, without waiting for it to finish.
   * - `uninstall`: destroy every clone this instance made, waiting as long as
   *   the deadline allows. Whatever is left is logged by vmid.
   */
  async onShutdown(e: { reason: ShutdownReason; deadline?: number; signal?: AbortSignal }): Promise<void> {
    const left = () => (e.deadline ? Math.max(1_000, e.deadline - Date.now()) : 60_000);
    await this.noteDeadlines().catch(() => {});
    if (e.reason === "restart") return this.closeAll();
    const s = this.deps.settings();
    if (!s.apiUrl || !this.deps.kv) return this.closeAll();
    for (const key of await this.deps.kv.list("chat:")) await this.stateFor(key.slice("chat:".length)).catch(() => undefined);
    const chats = [...this.chats.values()].filter((st) => st.vmid);
    this.closeAll();
    const api = await this.api();
    if (e.reason === "uninstall") {
      await this.adopt().catch(() => {});
      for (const st of [...this.chats.values()]) if (st.vmid) await this.recordDestroy({ chatId: st.chatId, vmid: st.vmid, hostname: st.hostname, attempts: 0, nextAt: 0 });
      this.chats.clear();
      const pending: PendingDestroy[] = [];
      for (const key of await this.deps.kv.list("destroy:")) {
        const p = await this.deps.kv.get<PendingDestroy>(key);
        if (p) pending.push(p);
      }
      const results = await withDeadline(
        Promise.allSettled(pending.map((p) => this.attemptDestroy(p, { timeoutMs: left() }))),
        left(),
        e.signal,
      );
      const failed = pending.filter((_, i) => results?.[i]?.status !== "fulfilled").map((p) => p.vmid);
      if (failed.length) this.log.warn(`uninstall: could not destroy ${failed.join(", ")} in time; remove them by hand`);
      for (const key of await this.deps.kv.list("chat:")) await this.deps.kv.delete(key);
      return;
    }
    // stop / disable: start the shutdowns, don't wait for the tasks.
    await withDeadline(
      Promise.allSettled(
        chats.map(async (st) => {
          if ((await api.status(s.node, st.vmid)) !== "running") return;
          if ((await this.ownership(api, s, st.vmid, st.chatId)) !== "ours") return;
          this.log.info(`shutting down container ${st.vmid} (chat ${st.chatId}): Dispatch is ${e.reason === "stop" ? "stopping" : "disabling the plugin"}`);
          await api.call("POST", `/nodes/${s.node}/lxc/${st.vmid}/status/shutdown`, { timeout: 30, forceStop: 1 });
        }),
      ),
      left(),
      e.signal,
    );
  }

  /**
   * A chat busy at shutdown has no idle deadline, and nothing will fire
   * onChatIdle for it after the restart. Give it one now, so the boot sweep
   * leaves it running for a normal idle period — reusable if the chat comes
   * back — rather than treating it like a crash's leftovers.
   */
  private async noteDeadlines(): Promise<void> {
    const minutes = this.deps.settings().idleStopMinutes;
    if (minutes < 0) return;
    for (const st of this.chats.values()) {
      if (!st.vmid || st.idleDeadline !== undefined || !st.conn) continue;
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
   * onShutdown: close connections, leave containers as they are. The idle
   * deadlines written here are what lets the next load stop them on time.
   */
  async dispose(): Promise<void> {
    await this.noteDeadlines().catch(() => {});
    this.closeAll();
    this.chats.clear();
  }
}

interface LxcConfig {
  hostname?: string;
  description?: string;
  template?: number | string;
}

const GONE = /does not exist|no such|not found/i;

function inRange(s: Settings, vmid: number): boolean {
  return vmid >= s.vmidStart && vmid <= s.vmidEnd && vmid !== s.templateVmid;
}

/** The description every clone gets. `parseDescription` reads it back; keep the two in step. */
export function describe(chatId: string, instance: string): string {
  return `Dispatch terminal for chat ${chatId} (proxmox-terminal plugin, instance ${instance}). Destroyed when the chat is deleted.`;
}

export function parseDescription(text: string | undefined): { chatId?: string; instance?: string } {
  const t = text ?? "";
  return {
    chatId: t.match(/terminal for chat ([A-Za-z0-9_-]+)/)?.[1],
    instance: t.match(/instance ([a-z0-9]+)\)/)?.[1],
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve with `p`'s value, or undefined once `ms` passes or `signal` aborts — whichever is first. */
function withDeadline<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    void p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

/* ------------------------------------------------------------------ helpers */

/** A DNS-safe, recognisable hostname per chat. */
export function hostnameFor(chatId: string): string {
  const slug = chatId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "chat";
  return `dt-${slug}`;
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
}

/** `https://github.com/o/r.git` for a GitHub origin in any of its spellings; undefined otherwise. */
export function githubHttps(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m =
    url.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    url.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : undefined;
}

/**
 * Listening ports from `ss -Htln` → the address to dial INSIDE the container,
 * minus sshd and privileged ports nobody started from a terminal. A wildcard
 * listener is dialled on 127.0.0.1; a `[::1]` one on ::1 — Vite's default
 * `localhost` binds only that on a box whose resolver prefers IPv6, and
 * forwarding it to 127.0.0.1 gets a refused connection. When a port is held
 * on several addresses, a wildcard or v4 loopback wins.
 */
export function parseListeners(out: string): Map<number, string> {
  const ports = new Map<number, string>();
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const cut = local.lastIndexOf(":");
    const port = Number(local.slice(cut + 1));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) continue;
    const addr = local.slice(0, cut).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const host = addr === "*" || addr === "0.0.0.0" || addr === "::" ? "127.0.0.1" : addr;
    const prev = ports.get(port);
    if (!prev || host === "127.0.0.1") ports.set(port, host);
  }
  return ports;
}
