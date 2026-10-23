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

/** What survives a restart, per chat, in the plugin's kv. */
interface ChatRecord {
  vmid: number;
  hostname: string;
  createdAt: number;
}

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
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = undefined;
    await this.ensureReady(st, info.signal as AbortSignal);
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
    st = {
      chatId,
      vmid: rec?.vmid ?? 0,
      hostname: rec?.hostname ?? hostnameFor(chatId),
      repos: new Map(),
      syncChain: Promise.resolve(),
      forwards: new Map(),
      shells: new Set(),
    };
    this.chats.set(chatId, st);
    return st;
  }

  /** Make sure the chat's container exists, is running, and has an open SSH connection. */
  private ensureReady(st: ChatState, signal: AbortSignal): Promise<void> {
    if (st.conn?.isOpen) return Promise.resolve();
    if (!st.ready) {
      st.ready = this.bringUp(st, signal).finally(() => {
        st.ready = undefined;
      });
    }
    return st.ready;
  }

  private async bringUp(st: ChatState, signal: AbortSignal): Promise<void> {
    const s = this.deps.settings();
    const api = await this.api();
    let status = st.vmid ? await api.status(s.node, st.vmid) : undefined;
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
    const pool = await api.call<{ members?: Array<{ vmid?: number }> }>("GET", `/pools/${encodeURIComponent(s.pool)}`).catch(
      () => ({ members: [] as Array<{ vmid?: number }> }),
    );
    const taken = new Set((pool.members ?? []).map((m) => m.vmid).filter((v): v is number => typeof v === "number"));
    let lastErr: unknown;
    for (let vmid = s.vmidStart; vmid <= s.vmidEnd; vmid++) {
      if (taken.has(vmid) || vmid === s.templateVmid) continue;
      try {
        this.log.info(`cloning template ${s.templateVmid} → ${vmid} (${st.hostname}) for chat ${st.chatId}`);
        const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${s.templateVmid}/clone`, {
          newid: vmid,
          hostname: st.hostname,
          pool: s.pool,
          description: `Dispatch terminal for chat ${st.chatId} (proxmox-terminal plugin). Destroyed when the chat is deleted.`,
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
      await this.deps.kv?.set(`chat:${st.chatId}`, { vmid, hostname: st.hostname, createdAt: Date.now() } satisfies ChatRecord);
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

  onChatIdle({ chatId }: { chatId: string }): void {
    const st = this.chats.get(chatId);
    if (!st?.vmid) return;
    const minutes = this.deps.settings().idleStopMinutes;
    if (minutes < 0) return;
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => {
      st.idleTimer = undefined;
      void this.stop(st).catch((err: unknown) => this.log.warn(`stopping ${st.vmid} failed: ${String(err)}`));
    }, minutes * 60_000);
    st.idleTimer.unref?.();
  }

  async onChatDeleted({ chatId }: { chatId: string }): Promise<void> {
    const st = await this.stateFor(chatId);
    if (st.idleTimer) clearTimeout(st.idleTimer);
    this.dropConnection(st);
    this.chats.delete(chatId);
    if (!st.vmid) return;
    const s = this.deps.settings();
    const api = await this.api();
    const status = await api.status(s.node, st.vmid);
    if (status === "running") {
      const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${st.vmid}/status/stop`);
      await api.waitTask(s.node, upid, 60_000);
    }
    if (status) {
      this.log.info(`destroying container ${st.vmid} (chat ${chatId} was deleted)`);
      const upid = await api.call<string>("DELETE", `/nodes/${s.node}/lxc/${st.vmid}`, {
        purge: 1,
        "destroy-unreferenced-disks": 1,
      });
      await api.waitTask(s.node, upid, 120_000);
    }
    await this.deps.kv?.delete(`chat:${chatId}`);
  }

  /** Stop a chat's container (idle). The next spawn starts it again. */
  async stop(st: ChatState): Promise<void> {
    this.dropConnection(st);
    const s = this.deps.settings();
    const api = await this.api();
    if ((await api.status(s.node, st.vmid)) !== "running") return;
    this.log.info(`stopping idle container ${st.vmid} (chat ${st.chatId})`);
    const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${st.vmid}/status/shutdown`, { timeout: 30, forceStop: 1 });
    await api.waitTask(s.node, upid, 90_000);
  }

  /** Plugin switched off: close connections. Containers are left as they are. */
  dispose(): void {
    for (const st of this.chats.values()) {
      if (st.idleTimer) clearTimeout(st.idleTimer);
      this.dropConnection(st);
    }
    this.chats.clear();
  }
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
