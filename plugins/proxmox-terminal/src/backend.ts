/**
 * proxmox-terminal 0.2: one LXC per chat, linked-cloned from a template the
 * first time the chat opens a terminal, stopped when the chat goes idle,
 * destroyed when the chat is deleted — with everything that runs ON the
 * container (the session supervisor, three-way sync, ports, MCP) done by
 * remote-host, reached through core's plugin dependencies as `machines@1`.
 *
 * This file is the Proxmox half: {@link ProxmoxProvider} (clone, start, stop,
 * destroy, prove a container is the chat's) under remote-core's
 * MachineLifecycle (kv, sweep, idle, destroy queue, adoption, TTL), and
 * {@link ProxmoxTerminal}, which ties them to remote-host: its `provision`
 * brings a chat's container up, rescues a pre-0.2 checkout once
 * (legacy-rescue.ts), and hands remote-host a lease to connect with.
 */
import type { PluginContext } from "@dispatch/plugin-sdk";
import {
  MachineLifecycle,
  SshConnection,
  errText,
  pinnedHostKey,
  trustProvisioner,
  type LeaseChat,
  type MachineProvider,
  type ShutdownReason,
  type SshAuth,
} from "@dispatch-plugins/remote-core";
import { BACKEND_ID, LABEL, ProxmoxForwarder } from "./forwarder.js";
import { LegacyRescue, sshRescueRemote, type RescueJob, type RescueRemote, type RescueResult } from "./legacy-rescue.js";
import type { MachineLease, PluginDependencies, ProvisionedBackendOptions, ProvisionRequest } from "./machines-api.js";
import { Proxmox, ProxmoxError, sleep } from "./proxmox.js";
import { RemoteHostLink } from "./remote-host-link.js";
import type { Settings } from "./settings.js";

export type { ShutdownReason };
export { BACKEND_ID };

/** What names a chat's container in kv: `chat:<chatId>` and `destroy:<vmid>`. */
export type ContainerRef = { vmid: number; hostname: string };

/** `chat:<id>.layout` once the container's pre-0.2 checkouts are rescued (or it never had any). */
export const LAYOUT = 2;

/** Under core's 60 s onChatDeleted timeout, so a slow destroy is ours to report, not a timeout. */
const DESTROY_WAIT_MS = 45_000;

export interface BackendDeps {
  ctx: PluginContext;
  /** Where each chat's vmid is remembered across restarts (`ctx.kv`). */
  kv?: PluginContext["kv"];
  settings: () => Settings;
  /** The Proxmox API token, `USER@REALM!ID=SECRET`. */
  token: () => Promise<string | undefined>;
  /** SSH credentials for the containers. Read per connect, never kept. */
  sshAuth: () => Promise<SshAuth>;
  /** `ctx.dependencies` (core C2); undefined on a core without plugin dependencies. */
  dependencies?: () => PluginDependencies | undefined;
  /** remote-host came or went: the backend's status should follow. */
  statusChanged?: () => void;
  /** Injectable for tests. */
  proxmox?: (s: Settings, token: string) => Proxmox;
  /** A shell on a container for the legacy rescue. Default: SSH with the same key. Injectable for tests. */
  rescueRemote?: (host: string, s: Settings, auth: SshAuth) => Promise<RescueRemote>;
}

/** Everything proxmox-terminal runs; one per activation. */
export class ProxmoxTerminal {
  readonly provider: ProxmoxProvider;
  readonly life: MachineLifecycle<ContainerRef>;
  readonly rescue: LegacyRescue;
  readonly link: RemoteHostLink;
  /** What is registered as the `proxmox` terminal backend. */
  readonly forwarder: ProxmoxForwarder;

  constructor(private readonly deps: BackendDeps) {
    const log = deps.ctx.log;
    this.provider = new ProxmoxProvider(deps, () => this.life.instanceId());
    this.rescue = new LegacyRescue({ kv: deps.kv, log });
    this.life = new MachineLifecycle<ContainerRef>({
      provider: this.provider,
      kv: deps.kv,
      log,
      policy: () => {
        const s = deps.settings();
        return { idleStopMinutes: s.idleStopMinutes, destroyUnusedDays: s.destroyUnusedDays };
      },
      busy: (chatId) => this.busy(chatId),
      detach: (chatId, why) => this.detach(chatId, why),
      // An unrescued pre-0.2 container may hold edits that never came back:
      // never destroy it for being unused. Deleting its chat still does.
      mayExpire: (rec) => rec.layout === LAYOUT,
      // 0.1.x may have queued destroys (the TTL) for chats that still exist,
      // under rules that let it destroy unrescued containers. Revive those.
      reviveLiveDestroys: { marker: "migrated-destroys" },
    });
    this.link = new RemoteHostLink({
      deps: () => deps.dependencies?.(),
      options: () => this.provisionOptions(),
      log,
      changed: () => deps.statusChanged?.(),
    });
    this.forwarder = new ProxmoxForwarder({ link: this.link, life: this.life, settings: deps.settings, log });
  }

  /** For `ctx.terminals.setStatus("proxmox", …)`. */
  status(): { state: "online" | "offline"; detail?: string } {
    if (!this.deps.settings().apiUrl) return { state: "offline", detail: "not set up: no Proxmox API URL (Settings → Plugins → Proxmox terminal)" };
    const why = this.link.reason();
    return why ? { state: "offline", detail: why } : { state: "online" };
  }

  /* ------------------------------------------------------- remote-host */

  provisionOptions(): ProvisionedBackendOptions {
    const terminals = this.deps.ctx.terminals!;
    return {
      id: BACKEND_ID,
      label: LABEL,
      io: {
        publishPort: (p) => terminals.publishPort(BACKEND_ID, p),
        updateBackend: (u) => terminals.updateBackend?.(BACKEND_ID, u),
      },
      provision: (req) => this.provision(req),
    };
  }

  /**
   * remote-host's way in: bring the chat's container up (cloning one the
   * first time), rescue a pre-0.2 container's checkouts once, and say how to
   * reach it. Runs as a lease, so no idle stop or boot sweep can stop the
   * container under it.
   */
  provision(req: ProvisionRequest): Promise<MachineLease> {
    const s = this.deps.settings();
    return this.life.lease(req.chatId, async (chat) => {
      const up = await this.provider.ensureUp(chat, req.signal);
      const ref: ContainerRef = { vmid: up.vmid, hostname: up.hostname };
      const notices: string[] = [];
      if (up.created) {
        await this.life.patch(req.chatId, { layout: LAYOUT }, ref);
      } else if ((await this.life.record(req.chatId))?.layout !== LAYOUT) {
        const res = await this.rescueFor(req, up, s);
        await this.life.patch(req.chatId, { layout: LAYOUT, rescue: res.entries.map(({ d, state, ref: r }) => ({ d, state, ref: r })) }, ref);
        if (res.notice) notices.push(res.notice);
      }
      const rec = await this.life.record(req.chatId);
      // The incarnation: a container re-created under the same vmid is a new machine to remote-host.
      const machine = `${up.vmid}:${rec?.createdAt ?? 0}`;
      if (rec?.machine !== machine) await this.life.patch(req.chatId, { machine }, ref);
      return {
        machine,
        addresses: [up.ip],
        user: s.sshUser,
        auth: () => this.auth(),
        hostKey: s.templateHostKey ? { pin: [s.templateHostKey] } : { trust: "provisioner" },
        hostname: up.hostname,
        notices,
      } satisfies MachineLease;
    });
  }

  /** Read per connect; never kept. */
  private async auth(): Promise<{ privateKey?: string; password?: string }> {
    const a = await this.deps.sshAuth();
    if (!a.privateKey && !a.password) {
      throw new Error("no SSH credentials: set the sshKeyPath setting, or the PROXMOX_TERMINAL_SSH_KEY / _SSH_PASSWORD secret");
    }
    return { privateKey: a.privateKey, password: a.password };
  }

  /**
   * The rescue of a pre-0.2 container, waited on for part of the spawn's
   * budget. Still going after that: the spawn is refused with its progress
   * and the job carries on; the next spawn picks up its result.
   */
  private async rescueFor(req: ProvisionRequest, up: { vmid: number; ip: string }, s: Settings): Promise<RescueResult> {
    const job: RescueJob = {
      chatId: req.chatId,
      vmid: up.vmid,
      workDir: s.workDir,
      candidates: [req.worktreePath, req.repoPath].filter((p): p is string => !!p),
      connect: () => this.rescueRemote(up.ip, s),
    };
    const run = this.rescue.run(job);
    run.catch(() => {}); // abandoned by a refused spawn, it still settles on its own
    const waitMs = Math.max(10_000, this.forwarder.spawnTimeoutMs - 90_000);
    const done = await settleWithin(run, waitMs, req.signal).catch(async (err: unknown) => {
      const n = (await this.rescue.state(req.chatId))?.failures ?? 1;
      throw new Error(`${errText(err)} (attempt ${n}; the next command tries again, and the container is left as it is)`);
    });
    if (done === PENDING) throw new Error(`${this.rescue.describe(req.chatId)}. It keeps going on its own: run the command again in a minute`);
    return done;
  }

  private async rescueRemote(ip: string, s: Settings): Promise<RescueRemote> {
    const auth = await this.auth();
    if (this.deps.rescueRemote) return this.deps.rescueRemote(ip, s, auth);
    const conn = new SshConnection({
      host: ip,
      username: s.sshUser,
      ...auth,
      hostVerifier: s.templateHostKey ? pinnedHostKey([s.templateHostKey]) : trustProvisioner(),
    });
    await conn.connect(60_000);
    return { ...sshRescueRemote(conn), close: () => conn.close() };
  }

  /**
   * Something runs on the chat's container: a shell or a command remote-host
   * holds there, a lease in flight (the lifecycle counts those itself), or
   * the rescue. While remote-host is away nothing can run there.
   */
  private busy(chatId: string): boolean {
    if (this.rescue.running(chatId)) return true;
    const p = this.link.get();
    if (!p) return false;
    const ms = p.machines();
    if (!Array.isArray(ms)) return false; // inert: revoked under us
    return ms.some((m) => m.chatId === chatId && ((m.connected && m.shells > 0) || m.running));
  }

  /** The lifecycle is about to stop or destroy the chat's container: tell remote-host, best effort. */
  private async detach(chatId: string, why: "stop" | "destroy" | "close"): Promise<void> {
    if (why === "stop") return this.link.quietly(`ending chat ${chatId}'s sessions`, (p) => p.endChat(chatId));
    if (why === "destroy") {
      const machine = (await this.life.record(chatId))?.machine;
      if (typeof machine === "string") await this.link.quietly(`forgetting machine ${machine}`, (p) => p.machineGone(machine));
      else await this.link.quietly(`forgetting chat ${chatId}`, (p) => p.forgetChat(chatId));
    }
  }

  /* --------------------------------------------- the backend's surface */

  spawn(info: Parameters<ProxmoxForwarder["spawn"]>[0]): ReturnType<ProxmoxForwarder["spawn"]> {
    return this.forwarder.spawn(info);
  }

  onChatIdle(e: { chatId: string }): Promise<void> {
    return this.forwarder.onChatIdle(e);
  }

  onChatDeleted(e: { chatId: string }): Promise<void> {
    return this.forwarder.onChatDeleted(e);
  }

  /** This instance's id; every clone's description carries it. */
  instanceId(): Promise<string> {
    return this.life.instanceId();
  }

  /** Called once from activate: the boot sweep, then one a minute. Never throws. */
  start(): Promise<void> {
    return this.life.start();
  }

  sweep(opts?: { adopt?: boolean; boot?: boolean; liveChats?: ReadonlySet<string> }): Promise<void> {
    return this.life.sweep(opts);
  }

  /** Startup reconcile (core's module hook, forwarded by server.ts). */
  reconcile(e: { chats: Iterable<string | { id: string }> }): Promise<void> {
    return this.life.reconcile(e);
  }

  /** Timed shutdown (core's module hook). Uninstall: remote-host forgets this plugin's machines first. */
  async onShutdown(e: { reason: ShutdownReason; deadline?: number; signal?: AbortSignal }): Promise<void> {
    if (e.reason === "uninstall") await this.link.quietly("forgetting this plugin's machines", (p) => p.forgetAll());
    return this.life.onShutdown(e);
  }

  dispose(): Promise<void> {
    return this.life.dispose();
  }
}

const PENDING = Symbol("pending");

/** `p`'s value, or PENDING once `ms` passes or `signal` aborts. `p`'s rejection propagates. */
function settleWithin<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | typeof PENDING> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(PENDING), ms);
    signal?.addEventListener("abort", () => resolve(PENDING), { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/**
 * Proxmox as remote-core's machine provider: one linked clone per chat, every
 * one tagged in its description with the chat and this instance, and never
 * stopped or destroyed unless that tag (or failing it, the hostname we gave
 * it) says it is the chat's.
 */
export class ProxmoxProvider implements MachineProvider<ContainerRef> {
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

  /**
   * Make sure the chat's container exists and runs, and return its address.
   * A remembered vmid that no longer holds the chat's container is never
   * reused: a new one is cloned. `created`: it was cloned just now, so it has
   * no pre-0.2 checkouts to rescue.
   */
  async ensureUp(
    chat: LeaseChat<ContainerRef>,
    signal: AbortSignal,
  ): Promise<{ vmid: number; hostname: string; ip: string; created: boolean }> {
    const s = this.deps.settings();
    const api = await this.api();
    let vmid = chat.ref?.vmid ?? 0;
    const hostname = chat.ref?.hostname || hostnameFor(chat.chatId);
    let status = vmid ? await api.status(s.node, vmid) : undefined;
    // A remembered vmid whose container was destroyed behind our back may
    // since have gone to another chat (or the other Dispatch instance sharing
    // the pool). Starting THAT would be the worst outcome here.
    if (status && (await this.ownership(api, s, vmid, chat.chatId)) !== "ours") {
      this.log.warn(`vmid ${vmid} no longer holds chat ${chat.chatId}'s container; making a new one`);
      status = undefined;
    }
    let created = false;
    if (!status) {
      vmid = await this.cloneFor(api, s, chat, hostname, signal);
      status = "stopped";
      created = true;
    }
    if (status !== "running") {
      this.log.info(`starting container ${vmid} for chat ${chat.chatId}`);
      const upid = await api.call<string>("POST", `/nodes/${s.node}/lxc/${vmid}/status/start`);
      await api.waitTask(s.node, upid, 60_000, signal);
    }
    const ip = await this.waitForIp(api, s.node, vmid, signal);
    return { vmid, hostname, ip, created };
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
