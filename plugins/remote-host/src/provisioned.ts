/**
 * Machines another plugin provisions, one per chat, behind that plugin's own
 * terminal backend: what `machines@1`'s `createProvisionedBackend` returns
 * (the plugin-dependencies design §2.3–§2.6).
 *
 * Each chat gets a {@link MachineEngine} on a {@link ProvisionedLink}, made on
 * the chat's first spawn and dialled only on demand. The provisioner owns the
 * lifecycle: it calls `endChat` when the chat goes idle, `forgetChat` when it
 * is deleted, `machineGone` when it destroys a machine.
 *
 * What is kept here is the caller's, under `x/<callerId>/<backendId>`:
 *   pchat:<base>:<chat>             { machine }: the chat's current incarnation
 *   ptoken:<base>/<machine>         { token }: what the machine's incarnation file must say
 *   served:<base>/<machine>:<chat>  sync:<base>/<machine>:<chat>   (the engine's)
 * A chat whose lease names a new incarnation (the machine was made again)
 * drops the old one's records and starts afresh there: push-only, nothing
 * pulled back or deleted here.
 *
 * Everything handed back is a plain object of functions, so core's membrane
 * can make it inert once the link to the caller closes. A spawn that
 * finishes after that is killed, never delivered.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  PluginContext,
  PluginLog,
  TerminalAfterRunInfo,
  TerminalAfterRunResult,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalBeforeRunResult,
  TerminalProcessHandle,
  TerminalProcessSpawnInfo,
  TerminalRunInfo,
  TerminalSpawnInfo,
} from "@dispatch/plugin-sdk";
import type { SshTarget } from "@dispatch-plugins/remote-core";
import { assertId, type ProbeResult } from "@dispatch-plugins/host-agent";
import type { MachineLease, ProvisionedBackend, ProvisionedBackendOptions, ProvisionedMachine, ProvisionRequest } from "@dispatch-plugins/remote-host-api";
import type { AgentBundle, RuntimeSource } from "./agent.js";
import { MachineEngine, machineNote, mcpLocalHostDir, type EngineDeps } from "./engine.js";
import type { HostConfig } from "./hosts.js";
import type { LinkConnection, LinkTiming } from "./link.js";
import { MachinesError } from "./machines-error.js";
import { ProvisionedLink } from "./provisioned-link.js";
import type { HostShellOptions } from "./session.js";
import type { ChatSyncDeps } from "./sync/chat-sync.js";
import type { RunsView } from "./sync/run-lock.js";
import type { ReservedPort } from "./ports.js";

export interface ProvisionedDeps {
  callerId: string;
  /** Aborts when the caller or remote-host goes down (core's `caller.signal`): everything made for it ends. */
  signal: AbortSignal;
  instanceId: string;
  log: PluginLog;
  kv?: PluginContext["kv"];
  agent: AgentBundle;
  runtime: RuntimeSource;
  runs?: RunsView;
  where?: (backend: string) => string;
  mine?: (backend: string) => boolean;
  reservedPorts?: () => Promise<readonly ReservedPort[]>;
  agentTools?: boolean;
  /** Tests. */
  connect?: (target: SshTarget) => LinkConnection;
  timing?: Partial<Pick<LinkTiming, "tickMs" | "helloEveryMs" | "idleSessionConnectionMs">>;
  shell?: Partial<HostShellOptions>;
  sync?: Pick<ChatSyncDeps, "capBytes" | "batchBytes">;
  portPollMs?: number;
  lockWaitMs?: number;
  mcpLocalRoot?: string;
}

interface Slot {
  chatId: string;
  machine: string;
  link: ProvisionedLink;
  engine: MachineEngine;
  user: string;
  /** What the chat's last spawn said about it, for provisioning again on a reconnect. */
  req: Omit<ProvisionRequest, "signal">;
}

interface ChatRecord {
  machine: string;
  at: number;
}

/** The kv prefixes of everything kept for one of a caller's backends (`base` = `x/<caller>/<backend>`). */
export function backendPrefixes(base: string): string[] {
  return [`served:${base}/`, `sync:${base}/`, `pchat:${base}:`, `ptoken:${base}/`];
}

/** The kv prefixes of everything kept for a caller, all its backends. */
export function callerPrefixes(callerId: string): string[] {
  return ["served:", "sync:", "pchat:", "ptoken:"].map((p) => `${p}x/${callerId}/`);
}

export const chatKey = (base: string, chatId: string) => `pchat:${base}:${chatId}`;
const tokenKey = (base: string, machine: string) => `ptoken:${base}/${machine}`;

/** The engine's records of one chat on one incarnation. */
async function dropEngineRecords(kv: PluginContext["kv"] | undefined, base: string, chatId: string, machine: string): Promise<void> {
  await kv?.delete(`served:${base}/${machine}:${chatId}`);
  await kv?.delete(`sync:${base}/${machine}:${chatId}`);
}

/** Everything kept for a chat of `base`, when nothing is running for it (remote-host's reconcile). */
export async function forgetChatRecords(kv: PluginContext["kv"] | undefined, base: string, chatId: string): Promise<void> {
  const rec = await kv?.get<ChatRecord>(chatKey(base, chatId)).catch(() => undefined);
  if (rec?.machine) await dropEngineRecords(kv, base, chatId, rec.machine);
  await kv?.delete(chatKey(base, chatId));
}

export class ProvisionedMachines {
  readonly id: string;
  readonly label: string;
  /** `x/<callerId>/<backendId>`. */
  readonly base: string;
  /** The engines' key: logs, conflict copies (`<file>.from-<key>`), the local folder of MCP copies. */
  readonly key: string;
  private readonly slots = new Map<string, Slot>();
  /** Spawns for one chat take turns: two terminals opening at once must not make two engines. */
  private readonly turns = new Map<string, Promise<unknown>>();
  /** What the chat's next command result says once: the lease's notices, a machine made again. */
  private readonly notices = new Map<string, string[]>();
  /** What each chat's machine was last seen to be, for the agent note while it is stopped. */
  private readonly seen = new Map<string, { user: string; probe?: ProbeResult }>();
  private disposed = false;

  constructor(
    private readonly opts: ProvisionedBackendOptions,
    private readonly d: ProvisionedDeps,
    private readonly onDisposed: () => void = () => {},
  ) {
    this.id = opts.id;
    this.label = opts.label;
    this.base = `x/${d.callerId}/${opts.id}`;
    this.key = opts.id.replace(/[^A-Za-z0-9_-]/g, "-");
    if (d.signal.aborted) void this.dispose();
    else d.signal.addEventListener("abort", () => void this.dispose(), { once: true });
  }

  /** What the caller gets: plain objects of functions, which the membrane can revoke. */
  facade(): ProvisionedBackend {
    const backend: TerminalBackend = {
      id: this.id,
      label: this.label,
      shell: "bash",
      fallback: "refuse",
      spawnTimeoutMs: 5 * 60_000,
      runHookTimeoutMs: 30 * 60_000,
      spawn: (info) => this.spawn(info),
      spawnProcess: (info) => this.spawnProcess(info),
      beforeRun: (info) => this.beforeRun(info),
      afterRun: (info) => this.afterRun(info),
      agentNote: (info) => this.agentNote(info),
    };
    return {
      backend,
      endChat: (chatId) => this.endChat(chatId),
      forgetChat: (chatId) => this.forgetChat(chatId),
      machineGone: (machine) => this.machineGone(machine),
      forgetAll: () => this.forgetAll(),
      dispose: () => this.dispose(),
      machines: () => this.machines(),
    };
  }

  /** The chat's slot, if it has a machine this run. */
  slot(chatId: string): { engine: MachineEngine; link: ProvisionedLink } | undefined {
    return this.slots.get(chatId);
  }

  /** Whether the chat had a machine here this run, connected or not. */
  knows(chatId: string): boolean {
    return this.slots.has(chatId) || this.seen.has(chatId);
  }

  lastSeen(chatId: string): ProbeResult | undefined {
    return this.slots.get(chatId)?.link.probe ?? this.seen.get(chatId)?.probe;
  }

  async spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle> {
    const slot = await this.inTurn(info.chatId, () => this.attach(info));
    const sh = await slot.engine.spawn(info);
    return this.deliver(slot, sh);
  }

  async spawnProcess(info: TerminalProcessSpawnInfo): Promise<TerminalProcessHandle> {
    const slot = await this.inTurn(info.chatId, () => this.attach(info));
    const p = await slot.engine.spawnProcess(info);
    return this.deliver(slot, p);
  }

  async beforeRun(info: TerminalRunInfo): Promise<TerminalBeforeRunResult> {
    const slot = this.slots.get(info.chatId);
    const r = slot ? await slot.engine.beforeRun(info) : {};
    const once = this.takeNotices(info.chatId);
    return once.length ? { ...r, notices: [...once, ...(r.notices ?? [])] } : r;
  }

  async afterRun(info: TerminalAfterRunInfo): Promise<TerminalAfterRunResult> {
    return (await this.slots.get(info.chatId)?.engine.afterRun(info)) ?? {};
  }

  agentNote(info: { chatId: string }): string {
    const slot = this.slots.get(info.chatId);
    if (slot) return slot.engine.agentNote(info);
    // Its machine is stopped, or not made yet: what was last seen of it.
    const seen = this.seen.get(info.chatId);
    return machineNote({
      label: this.label,
      ...(seen ? { user: seen.user } : {}),
      key: this.key,
      probe: seen?.probe,
      where: `~/.dispatch-host/…/chats/${info.chatId}`,
      elevation: undefined,
      mcpLocalDir: join(mcpLocalHostDir(this.d.mcpLocalRoot, this.d.instanceId, this.key), info.chatId),
      agentTools: !!this.d.agentTools,
      provisioned: true,
    });
  }

  /** The chat went idle: its sessions there end (if the machine is connected; never a dial), and the connection closes. */
  async endChat(chatId: string): Promise<void> {
    const slot = this.slots.get(chatId);
    if (!slot) return;
    this.slots.delete(chatId);
    this.remember(slot);
    try {
      await slot.engine.chatIdle(chatId);
    } finally {
      this.close(slot);
    }
  }

  /** The chat was deleted: everything kept for it here goes. The machine is never contacted; destroying it is the caller's. */
  async forgetChat(chatId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) return;
    const slot = this.slots.get(chatId);
    this.slots.delete(chatId);
    this.notices.delete(chatId);
    this.seen.delete(chatId);
    if (slot) {
      await slot.engine.forgetLocal(chatId);
      this.close(slot);
    }
    await rm(join(mcpLocalHostDir(this.d.mcpLocalRoot, this.d.instanceId, this.key), chatId), { recursive: true, force: true }).catch(() => {});
    await forgetChatRecords(this.d.kv, this.base, chatId);
  }

  /** The caller destroyed `machine`: every chat on it is forgotten, and so is its token. */
  async machineGone(machine: string): Promise<void> {
    const chats = new Set<string>();
    for (const s of this.slots.values()) if (s.machine === machine) chats.add(s.chatId);
    for (const k of (await this.d.kv?.list(`pchat:${this.base}:`)) ?? []) {
      const rec = await this.d.kv?.get<ChatRecord>(k).catch(() => undefined);
      if (rec?.machine === machine) chats.add(k.slice(`pchat:${this.base}:`.length));
    }
    for (const chat of chats) await this.forgetChat(chat);
    await this.d.kv?.delete(tokenKey(this.base, machine));
  }

  /** The caller is being uninstalled: everything kept for this backend goes. */
  async forgetAll(): Promise<void> {
    for (const chat of [...this.slots.keys()]) await this.forgetChat(chat);
    for (const prefix of backendPrefixes(this.base)) {
      for (const k of (await this.d.kv?.list(prefix)) ?? []) await this.d.kv?.delete(k);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Not served from this moment: the lock and the tools stop counting it.
    this.onDisposed();
    const slots = [...this.slots.values()];
    this.slots.clear();
    // KILL down every channel while the connections still carry it, then close them.
    await Promise.all(slots.map((s) => s.engine.killAll(300).catch(() => {})));
    for (const s of slots) this.close(s);
  }

  machines(): ProvisionedMachine[] {
    return [...this.slots.values()].map((s) => {
      const address = s.link.address;
      return {
        chatId: s.chatId,
        machine: s.machine,
        connected: s.link.connected,
        shells: s.engine.chatActivity(s.chatId).shells.length,
        running: s.engine.running(s.chatId),
        ...(address ? { address } : {}),
      };
    });
  }

  /** The chat's machine, provisioned now, with an engine for it: the one it had, or a new one for a new incarnation. */
  private async attach(info: TerminalSpawnInfo | TerminalProcessSpawnInfo): Promise<Slot> {
    this.live();
    const chatId = assertId("chat", info.chatId);
    const spawnInfo = info as Partial<TerminalSpawnInfo>;
    const req: Omit<ProvisionRequest, "signal"> = {
      chatId,
      ...(spawnInfo.projectId ? { projectId: spawnInfo.projectId } : {}),
      ...(spawnInfo.worktreePath ? { worktreePath: spawnInfo.worktreePath } : {}),
      ...(spawnInfo.repoPath ? { repoPath: spawnInfo.repoPath } : {}),
    };
    const lease = checkLease(await this.opts.provision({ ...req, signal: info.signal }));
    this.live();
    this.note(chatId, lease.notices);
    let slot = this.slots.get(chatId);
    if (slot && slot.machine === lease.machine) {
      slot.req = req;
      slot.user = lease.user;
      slot.link.use(lease);
      return slot;
    }
    const kv = this.d.kv;
    const before = slot?.machine ?? (await kv?.get<ChatRecord>(chatKey(this.base, chatId)).catch(() => undefined))?.machine;
    if (slot) {
      this.slots.delete(chatId);
      await slot.engine.killAll(0).catch(() => {});
      this.close(slot);
    }
    if (before && before !== lease.machine) {
      // Made again: what the old one had is gone with it. A fresh record means
      // a fresh checkout from the files here, so nothing is pulled back or
      // deleted on this side.
      await dropEngineRecords(kv, this.base, chatId, before);
      this.note(chatId, ["this chat's machine was made again: what was installed or built on the old one is gone, and your files go to the new one"]);
      this.d.log.info(`remote-host ${this.key}: chat ${chatId}'s machine is a new one (${lease.machine}, was ${before})`);
    }
    await kv?.set(chatKey(this.base, chatId), { machine: lease.machine, at: Date.now() } satisfies ChatRecord);
    slot = this.makeSlot(chatId, lease, req);
    this.slots.set(chatId, slot);
    this.seen.delete(chatId);
    return slot;
  }

  private makeSlot(chatId: string, lease: MachineLease, req: Omit<ProvisionRequest, "signal">): Slot {
    const machine = lease.machine;
    const kv = this.d.kv;
    const link = new ProvisionedLink(machine, {
      instanceId: this.d.instanceId,
      label: this.label,
      agent: this.d.agent,
      runtime: this.d.runtime,
      log: this.d.log,
      provision: () => this.reprovision(chatId),
      token: {
        get: async () => (await kv?.get<{ token?: string }>(tokenKey(this.base, machine)))?.token,
        set: async (token) => {
          await kv?.set(tokenKey(this.base, machine), { token });
        },
      },
      ...(this.d.connect ? { connect: this.d.connect } : {}),
      ...(this.d.timing ? { timing: this.d.timing } : {}),
    });
    const slot: Slot = { chatId, machine, link, engine: undefined as unknown as MachineEngine, user: lease.user, req };
    // What the engine reads as "the machine": a provisioned one has no pairing, only a label and a login.
    const host = (): HostConfig => ({
      slug: this.key,
      label: this.label,
      user: slot.user,
      addresses: [],
      port: 22,
      hostKey: "",
      hostKeyType: "",
      keyFingerprint: "",
      allowFrom: [],
      pairedAt: "",
    });
    const deps: EngineDeps = {
      link,
      instanceId: this.d.instanceId,
      log: this.d.log,
      ...(kv ? { kv } : {}),
      // The caller's to publish: its forwards show under its backend.
      publish: (p) => {
        const withdraw = this.opts.io.publishPort(p);
        return typeof withdraw === "function" ? withdraw : () => {};
      },
      ...(this.d.runs ? { runs: this.d.runs } : {}),
      ...(this.d.where ? { where: this.d.where } : {}),
      ...(this.d.mine ? { mine: this.d.mine } : {}),
      ...(this.d.reservedPorts ? { reservedPorts: this.d.reservedPorts } : {}),
      ...(this.d.agentTools ? { agentTools: true } : {}),
      ...(this.d.shell ? { shell: this.d.shell } : {}),
      ...(this.d.sync ? { sync: this.d.sync } : {}),
      ...(this.d.portPollMs ? { portPollMs: this.d.portPollMs } : {}),
      ...(this.d.lockWaitMs !== undefined ? { lockWaitMs: this.d.lockWaitMs } : {}),
      ...(this.d.mcpLocalRoot ? { mcpLocalRoot: this.d.mcpLocalRoot } : {}),
    };
    slot.engine = new MachineEngine(
      { backendId: this.id, key: this.key, kvPrefix: `${this.base}/${machine}`, adoptLegacySync: false, host, provisioned: true },
      deps,
    );
    link.use(lease);
    return slot;
  }

  /** The connection dropped and something needs the machine: ask the provisioner again (it may have to start it). */
  private async reprovision(chatId: string): Promise<MachineLease> {
    this.live();
    const req = this.slots.get(chatId)?.req ?? { chatId };
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    this.d.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const lease = checkLease(await this.opts.provision({ ...req, signal: ctl.signal }));
      this.live();
      this.note(chatId, lease.notices);
      const slot = this.slots.get(chatId);
      if (slot && slot.machine === lease.machine) slot.user = lease.user;
      return lease;
    } finally {
      this.d.signal.removeEventListener("abort", onAbort);
    }
  }

  /** A handle made for a caller that went away meanwhile is ended, never delivered. */
  private deliver<T extends { kill(signal?: string): void }>(slot: Slot, handle: T): T {
    this.remember(slot);
    if (this.disposed || this.d.signal.aborted) {
      handle.kill();
      throw new MachinesError("revoked", `${this.label}: remote-host stopped serving this backend`);
    }
    return handle;
  }

  private remember(slot: Slot): void {
    this.seen.set(slot.chatId, { user: slot.user, ...(slot.link.probe ? { probe: slot.link.probe } : {}) });
  }

  private close(slot: Slot): void {
    slot.engine.dispose();
    slot.link.dispose();
  }

  private inTurn<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.turns.get(chatId) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(fn);
    const tail = p.catch(() => {});
    this.turns.set(chatId, tail);
    void tail.then(() => {
      if (this.turns.get(chatId) === tail) this.turns.delete(chatId);
    });
    return p;
  }

  private note(chatId: string, notices: readonly string[] | undefined): void {
    if (!notices?.length) return;
    const list = this.notices.get(chatId) ?? [];
    for (const n of notices) list.push(`[${this.label}] ${n}`);
    this.notices.set(chatId, list.slice(-10));
  }

  private takeNotices(chatId: string): string[] {
    const list = this.notices.get(chatId) ?? [];
    this.notices.delete(chatId);
    return list;
  }

  private live(): void {
    if (this.disposed || this.d.signal.aborted) throw new MachinesError("revoked", `${this.label}: remote-host stopped serving this backend`);
  }
}

/**
 * A lease as the provisioner gave it, checked: anything that can't be used
 * as it is fails here (`bad-lease`), before any connection is made. Its
 * `auth` is kept as given and called per connect; its result never is.
 */
export function checkLease(lease: unknown): MachineLease {
  const bad = (why: string) => new MachinesError("bad-lease", `the provisioner's lease ${why}`);
  if (!lease || typeof lease !== "object") throw bad("isn't an object");
  const l = lease as Partial<MachineLease>;
  if (typeof l.machine !== "string" || !/^[\x21-\x7e]{1,200}$/.test(l.machine)) {
    throw bad("has no usable `machine` (1 to 200 printable characters, no spaces)");
  }
  const addresses = Array.isArray(l.addresses) ? [...l.addresses] : [];
  if (!addresses.length || addresses.length > 16 || !addresses.every((a) => typeof a === "string" && /^[A-Za-z0-9.:%_[\]-]{1,253}$/.test(a))) {
    throw bad("has no usable `addresses` (1 to 16 host names or IPs)");
  }
  if (l.port !== undefined && !(Number.isInteger(l.port) && l.port >= 1 && l.port <= 65_535)) throw bad("has a `port` that isn't one");
  if (typeof l.user !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(l.user)) throw bad("has no usable `user`");
  if (typeof l.auth !== "function") throw bad("has no `auth()`");
  const hk = l.hostKey as { pin?: unknown; trust?: unknown } | undefined;
  let hostKey: MachineLease["hostKey"];
  if (hk && typeof hk === "object" && "pin" in hk) {
    const pins = Array.isArray(hk.pin) ? [...(hk.pin as unknown[])] : [];
    if (!pins.length || !pins.every((p) => typeof p === "string" && /^SHA256:[A-Za-z0-9+/]{43}=?$/.test(p))) {
      throw bad("has a `hostKey.pin` that isn't a list of SHA256 fingerprints");
    }
    hostKey = { pin: pins as string[] };
  } else if (hk && typeof hk === "object" && hk.trust === "provisioner") {
    hostKey = { trust: "provisioner" };
  } else {
    throw bad('has no `hostKey` (a `pin` list, or `{ trust: "provisioner" }`)');
  }
  if (l.hostname !== undefined && (typeof l.hostname !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(l.hostname))) throw bad("has a `hostname` that isn't one");
  const notices = Array.isArray(l.notices) ? l.notices.filter((n): n is string => typeof n === "string" && !!n.trim()).slice(0, 5).map((n) => n.slice(0, 500)) : [];
  const auth = l.auth;
  return {
    machine: l.machine,
    addresses: addresses as string[],
    ...(l.port !== undefined ? { port: l.port } : {}),
    user: l.user,
    auth: () => auth(),
    hostKey,
    ...(l.hostname !== undefined ? { hostname: l.hostname } : {}),
    ...(notices.length ? { notices } : {}),
  };
}
