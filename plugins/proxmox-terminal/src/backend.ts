/**
 * The Proxmox terminal backend: one LXC per chat, linked-cloned from a
 * template the first time the chat opens a terminal, stopped when the chat
 * goes idle, destroyed when the chat is deleted.
 *
 * The container holds its OWN git checkout of the chat's code, synced from the
 * local worktree before every command (remote-core's RemoteCheckouts). Losing
 * the container loses only installs and build output: the real copy of the
 * code is on the Dispatch host.
 *
 * Everything that isn't Proxmox — the chat registry, spawning a synced shell,
 * forwarding ports, idle stops, destroy retries, adoption — is remote-core's
 * RemoteChats. This file is the Proxmox provider it drives, and the wiring.
 */
import type {
  PluginContext,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalSpawnInfo,
} from "@dispatch/plugin-sdk";
import { RemoteChats, SshConnection, type Provider, type ShutdownReason, type SshAuth } from "@dispatch-plugins/remote-core";
import { Proxmox, ProxmoxError, sleep } from "./proxmox.js";
import type { Settings } from "./settings.js";

export type { ShutdownReason };

export const BACKEND_ID = "proxmox";

/** What names a chat's container in kv: `chat:<chatId>` and `destroy:<vmid>`. */
export type ContainerRef = { vmid: number; hostname: string };

/** Under core's 60 s onChatDeleted timeout, so a slow destroy is ours to report, not a timeout. */
const DESTROY_WAIT_MS = 45_000;

export interface BackendDeps {
  ctx: PluginContext;
  /** Where each chat's vmid is remembered across restarts (`ctx.kv`). */
  kv?: PluginContext["kv"];
  settings: () => Settings;
  /** The Proxmox API token, `USER@REALM!ID=SECRET`. */
  token: () => Promise<string | undefined>;
  /** SSH credentials for the containers. */
  sshAuth: () => Promise<SshAuth>;
  /** Injectable for tests. */
  proxmox?: (s: Settings, token: string) => Proxmox;
  connect?: (host: string, user: string, auth: SshAuth) => SshConnection;
}

export class ProxmoxTerminalBackend implements TerminalBackend {
  readonly id = BACKEND_ID;
  readonly label = "Proxmox container";
  readonly shell = "bash" as const;
  private readonly chats: RemoteChats<ContainerRef>;

  constructor(private readonly deps: BackendDeps) {
    this.chats = new RemoteChats<ContainerRef>({
      backendId: BACKEND_ID,
      label: "proxmox-terminal",
      provider: new ProxmoxProvider(deps, () => this.chats.instanceId()),
      kv: deps.kv,
      log: deps.ctx.log,
      publishPort: (p) => deps.ctx.terminals!.publishPort(BACKEND_ID, p),
      policy: () => {
        const s = deps.settings();
        return { idleStopMinutes: s.idleStopMinutes, destroyUnusedDays: s.destroyUnusedDays, workDir: s.workDir };
      },
    });
  }

  get spawnTimeoutMs(): number {
    return Math.max(30, this.deps.settings().spawnTimeoutSeconds) * 1_000;
  }

  spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle> {
    return this.chats.spawn(info);
  }

  agentNote({ chatId }: { chatId: string }): string {
    const st = this.chats.peek(chatId);
    const where = st
      ? `container ${st.ref?.hostname ?? hostnameFor(chatId)} (vmid ${st.ref?.vmid ?? 0})`
      : "a per-chat Proxmox container";
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

  onChatIdle(e: { chatId: string }): Promise<void> {
    return this.chats.onChatIdle(e);
  }

  onChatDeleted(e: { chatId: string }): Promise<void> {
    return this.chats.onChatDeleted(e);
  }

  /** This instance's id; every clone's description carries it. */
  instanceId(): Promise<string> {
    return this.chats.instanceId();
  }

  /** Called once from activate: the boot sweep, then one a minute. Never throws. */
  start(): Promise<void> {
    return this.chats.start();
  }

  sweep(opts?: { adopt?: boolean; boot?: boolean; liveChats?: ReadonlySet<string> }): Promise<void> {
    return this.chats.sweep(opts);
  }

  /** Startup reconcile (core's module hook, forwarded by server.ts). */
  reconcile(e: { chats: Iterable<string | { id: string }> }): Promise<void> {
    return this.chats.reconcile(e);
  }

  /** Timed shutdown (core's module hook, forwarded by server.ts). */
  onShutdown(e: { reason: ShutdownReason; deadline?: number; signal?: AbortSignal }): Promise<void> {
    return this.chats.onShutdown(e);
  }

  dispose(): Promise<void> {
    return this.chats.dispose();
  }
}

/**
 * Proxmox as remote-core's machine provider: one linked clone per chat, every
 * one tagged in its description with the chat and this instance, and never
 * stopped or destroyed unless that tag (or failing it, the hostname we gave
 * it) says it is the chat's.
 */
class ProxmoxProvider implements Provider<ContainerRef> {
  constructor(
    private readonly deps: BackendDeps,
    private readonly instanceId: () => Promise<string>,
  ) {}

  private get log() {
    return this.deps.ctx.log;
  }

  private async api(): Promise<Proxmox> {
    const s = this.deps.settings();
    if (!s.apiUrl) throw new Error("the proxmox-terminal plugin has no API URL set (Settings → Plugins → Proxmox terminal)");
    const token = await this.deps.token();
    if (!token) throw new Error("the PROXMOX_TERMINAL_API_TOKEN secret is not set");
    return this.deps.proxmox
      ? this.deps.proxmox(s, token)
      : new Proxmox({ apiUrl: s.apiUrl, token, caCert: s.caCert, insecureTls: s.insecureTls });
  }

  configured(): boolean {
    return Boolean(this.deps.settings().apiUrl);
  }

  refOf(rec: Record<string, unknown>): ContainerRef | undefined {
    const vmid = Number(rec.vmid);
    return vmid > 0 ? { vmid, hostname: String(rec.hostname ?? "") } : undefined;
  }

  keyOf(ref: ContainerRef): string {
    return String(ref.vmid);
  }

  name(ref: ContainerRef): string {
    return `container ${ref.vmid}`;
  }

  async preflight(): Promise<void> {
    await this.api();
  }

  async bringUp(
    chat: { chatId: string; ref?: ContainerRef; remember(ref: ContainerRef): Promise<void> },
    signal: AbortSignal,
  ): Promise<SshConnection> {
    const s = this.deps.settings();
    const api = await this.api();
    let vmid = chat.ref?.vmid ?? 0;
    const hostname = chat.ref?.hostname ?? hostnameFor(chat.chatId);
    let status = vmid ? await api.status(s.node, vmid) : undefined;
    // A remembered vmid whose container was destroyed behind our back may
    // since have gone to another chat (or the other Dispatch instance sharing
    // the pool). Starting and syncing into THAT would be the worst outcome here.
    if (status && (await this.ownership(api, s, vmid, chat.chatId)) !== "ours") {
      this.log.warn(`vmid ${vmid} no longer holds chat ${chat.chatId}'s container; making a new one`);
      status = undefined;
    }
    if (!status) {
      vmid = await this.cloneFor(api, s, chat, hostname, signal);
      status = "stopped";
    }
    if (status !== "running") {
      this.log.info(`starting container ${vmid} for chat ${chat.chatId}`);
      const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${vmid}/status/start`);
      await api.waitTask(s.node, upid, 60_000, signal);
    }
    const ip = await this.waitForIp(api, s.node, vmid, signal);
    const auth = await this.deps.sshAuth();
    if (!auth.privateKey && !auth.password) {
      throw new Error("no SSH credentials: set the sshKeyPath setting, or the PROXMOX_TERMINAL_SSH_KEY / _SSH_PASSWORD secret");
    }
    const conn = this.deps.connect
      ? this.deps.connect(ip, s.sshUser, auth)
      : new SshConnection({ host: ip, username: s.sshUser, ...auth });
    await conn.connect(60_000, signal);
    return conn;
  }

  /** Linked-clone the template into a free vmid, size it, and remember it. */
  private async cloneFor(
    api: Proxmox,
    s: Settings,
    chat: { chatId: string; remember(ref: ContainerRef): Promise<void> },
    hostname: string,
    signal: AbortSignal,
  ): Promise<number> {
    // Best effort: a vmid held outside the pool still fails the clone with
    // "already exists", and the loop moves on.
    const taken = new Set(await this.poolVmids(api, s).catch(() => []));
    let lastErr: unknown;
    for (let vmid = s.vmidStart; vmid <= s.vmidEnd; vmid++) {
      if (taken.has(vmid) || vmid === s.templateVmid) continue;
      try {
        this.log.info(`cloning template ${s.templateVmid} → ${vmid} (${hostname}) for chat ${chat.chatId}`);
        const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${s.templateVmid}/clone`, {
          newid: vmid,
          hostname,
          pool: s.pool,
          description: describe(chat.chatId, await this.instanceId()),
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
      await chat.remember({ vmid, hostname });
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

  /** Stop a chat's container, after checking the vmid is still this chat's. */
  async stop(chatId: string, ref: ContainerRef): Promise<void> {
    const s = this.deps.settings();
    const api = await this.api();
    if ((await api.status(s.node, ref.vmid)) !== "running") return;
    if ((await this.ownership(api, s, ref.vmid, chatId)) !== "ours") return;
    this.log.info(`stopping idle container ${ref.vmid} (chat ${chatId})`);
    const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${ref.vmid}/status/shutdown`, { timeout: 30, forceStop: 1 });
    await api.waitTask(s.node, upid, 90_000);
  }

  /** Ask a running container of the chat's to shut down; don't wait for the task. */
  async release(chatId: string, ref: ContainerRef, reason: "stop" | "disable"): Promise<void> {
    const s = this.deps.settings();
    const api = await this.api();
    if ((await api.status(s.node, ref.vmid)) !== "running") return;
    if ((await this.ownership(api, s, ref.vmid, chatId)) !== "ours") return;
    this.log.info(`shutting down container ${ref.vmid} (chat ${chatId}): Dispatch is ${reason === "stop" ? "stopping" : "disabling the plugin"}`);
    await api.call("POST", `/nodes/${s.node}/lxc/${ref.vmid}/status/shutdown`, { timeout: 30, forceStop: 1 });
  }

  /**
   * Stop and destroy one container — only after checking it is a clone in the
   * configured range, not a template, and (by its description) the chat's.
   * Anything else is treated as already gone: never destroy what we can't
   * prove is ours.
   */
  async destroy(chatId: string, ref: ContainerRef, opts: { timeoutMs?: number } = {}): Promise<void> {
    const vmid = ref.vmid;
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

  /** Clones in the pool tagged with `instance` whose vmid is not in `known`. */
  async discover(instance: string, known: ReadonlySet<string>): Promise<Array<{ chatId: string; ref: ContainerRef }>> {
    const s = this.deps.settings();
    const api = await this.api();
    const out: Array<{ chatId: string; ref: ContainerRef }> = [];
    for (const vmid of await this.poolVmids(api, s)) {
      if (known.has(String(vmid)) || !inRange(s, vmid)) continue;
      const cfg = await this.config(api, s, vmid).catch(() => undefined);
      if (!cfg || Number(cfg.template) === 1) continue;
      const d = parseDescription(cfg.description);
      if (d.instance !== instance || !d.chatId) continue;
      out.push({ chatId: d.chatId, ref: { vmid, hostname: cfg.hostname ?? hostnameFor(d.chatId) } });
    }
    return out;
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

/** A DNS-safe, recognisable hostname per chat. */
export function hostnameFor(chatId: string): string {
  const slug = chatId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "chat";
  return `dt-${slug}`;
}
