/**
 * One machine's connection: found, verified, kept up, and reported.
 *
 * - **Found** by trying its addresses in order, the last one that worked first.
 *   The pinned host key decides whether an address IS the machine. A different
 *   key means "not this machine", so that address is skipped. It never turns
 *   into a prompt to trust the new key: anything on the LAN can answer to
 *   `cvx-mac.lan`. Only pairing again changes the pin.
 * - **Verified** on every connect: dispatch-host is installed or upgraded if
 *   needed, orphans from a previous Dispatch run are swept, and the machine is
 *   probed (OS, tools, disk).
 * - **Kept up** with a `hello` every 30 s. That also feeds dispatch-host's
 *   dead-man switch. A link that drops, or a machine that sleeps, is retried
 *   with backoff.
 * - **Reported** through `setStatus` the whole time: a spawn on an offline
 *   machine is refused at once instead of waiting out a timeout.
 */
import type { PluginContext, PluginLog, TerminalBackendStatusInput } from "@dispatch/plugin-sdk";
import { SshConnection, errText, pinnedHostKey, type SshTarget } from "@dispatch-plugins/remote-core";
import type { ProbeResult } from "@dispatch-plugins/host-agent";
import type { ClientChannel } from "ssh2";
import type { AgentBundle, RuntimeSource } from "./agent.js";
import { keySecretName, type HostConfig } from "./hosts.js";
import { agentCommand, ensureAgent, type Exec, type HostPaths } from "./install.js";

/** A connection to one address. `SshConnection` is one; tests pass fakes. */
export interface LinkConnection extends Exec {
  readonly isOpen: boolean;
  /** Keep trying until `deadlineMs` (pairing, where the human just pressed a button). */
  connect(deadlineMs: number, signal?: AbortSignal): Promise<void>;
  /** One attempt (the link, which tries the next address and comes back later). */
  connectOnce(): Promise<void>;
  channel(command: string): Promise<ClientChannel>;
  close(): void;
  on(event: "close", listener: () => void): unknown;
}

export interface Linked {
  conn: LinkConnection;
  paths: HostPaths;
  /** The address that answered with the pinned key. */
  address: string;
}

export interface LinkTiming {
  /** How often the link looks at itself. */
  tickMs: number;
  helloEveryMs: number;
  probeEveryMs: number;
  /** Waits between failed connects; the last repeats. */
  backoffMs: readonly number[];
}

export const DEFAULT_TIMING: LinkTiming = {
  tickMs: 5_000,
  helloEveryMs: 30_000,
  probeEveryMs: 5 * 60_000,
  backoffMs: [2_000, 5_000, 15_000, 30_000, 60_000],
};

export interface HostLinkDeps {
  instanceId: string;
  privateKey: () => Promise<string | undefined>;
  agent: AgentBundle;
  runtime: RuntimeSource;
  /** Report to core. Called right away by `start`, then on every change. */
  setStatus: (status: TerminalBackendStatusInput) => void;
  log: PluginLog;
  kv?: PluginContext["kv"];
  connect?: (target: SshTarget) => LinkConnection;
  timing?: Partial<LinkTiming>;
  now?: () => number;
}

/** What `kv` keeps per machine, per instance: shown while it is offline, and used to try the last good address first. */
export interface LinkMemory {
  lastAddress?: string;
  lastSeenAt?: number;
  probe?: ProbeResult;
}

/** Below this much free disk the machine is still usable, but flagged. */
const LOW_DISK_BYTES = 5 * 1024 ** 3;

export class HostLink {
  private linked?: Linked;
  private connecting?: Promise<Linked>;
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastHelloAt = 0;
  private lastProbeAt = 0;
  private busy = false;
  private disposed = false;
  private memory: LinkMemory = {};
  private current: TerminalBackendStatusInput = { state: "degraded", detail: "connecting" };
  private readonly t: LinkTiming;
  private readonly now: () => number;

  constructor(
    private host: HostConfig,
    private readonly deps: HostLinkDeps,
  ) {
    this.t = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
  }

  get status(): TerminalBackendStatusInput {
    return this.current;
  }

  /** The last probe, from this connection or remembered from an earlier one. */
  get probe(): ProbeResult | undefined {
    return this.memory.probe;
  }

  get address(): string | undefined {
    return this.linked?.address ?? this.memory.lastAddress;
  }

  get paths(): HostPaths | undefined {
    return this.linked?.paths;
  }

  get config(): HostConfig {
    return this.host;
  }

  /** Report "connecting", then connect in the background and keep the link up. */
  start(): void {
    this.report(this.current);
    void this.loadMemory().then(() => this.attempt().catch(() => {}));
    this.timer = setInterval(() => void this.tick(), this.t.tickMs);
    this.timer.unref?.();
  }

  /** New settings for this machine. A change to how it is reached reconnects; a new label doesn't. */
  update(host: HostConfig, changedConnection: boolean): void {
    this.host = host;
    if (!changedConnection) return;
    this.drop("its settings changed; reconnecting", "degraded");
    this.failures = 0;
    void this.attempt().catch(() => {});
  }

  /** A live, verified connection: the current one, or a new one. Rejects with why the machine can't be reached. */
  ready(signal?: AbortSignal): Promise<Linked> {
    if (this.linked?.conn.isOpen) return Promise.resolve(this.linked);
    const p = this.attempt();
    if (!signal) return p;
    return new Promise<Linked>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("cancelled"));
      const onAbort = () => reject(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** Run a dispatch-host query command (`hello`, `list`, `kill` …) and parse its one line of JSON. */
  async agent<T>(args: readonly string[], timeoutMs = 30_000): Promise<T> {
    const { conn, paths } = await this.ready();
    const r = await conn.exec(agentCommand(paths, args), { timeoutMs });
    if (r.code !== 0) throw new Error(`dispatch-host ${args[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
    return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null") as T;
  }

  /** Reconnect now and probe, for a human pressing "Check". */
  async checkNow(): Promise<TerminalBackendStatusInput> {
    this.drop("checking", "degraded");
    this.failures = 0;
    await this.attempt().catch(() => {});
    return this.current;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const l = this.linked;
    this.linked = undefined;
    l?.conn.close();
  }

  private attempt(): Promise<Linked> {
    if (this.disposed) return Promise.reject(new Error("the plugin is shutting down"));
    if (this.linked?.conn.isOpen) return Promise.resolve(this.linked);
    this.connecting ??= this.connectOnce()
      .then(
        (linked) => {
          this.failures = 0;
          return linked;
        },
        (err: unknown) => {
          this.failures++;
          const wait = this.t.backoffMs[Math.min(this.failures - 1, this.t.backoffMs.length - 1)] ?? 60_000;
          this.nextAttemptAt = this.now() + wait;
          if (!this.disposed) {
            this.report({ state: "offline", detail: errText(err), ...(this.memory.lastSeenAt ? { lastSeenAt: this.memory.lastSeenAt } : {}) });
          }
          throw err;
        },
      )
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async connectOnce(): Promise<Linked> {
    const host = this.host;
    const key = await this.deps.privateKey();
    if (!key) throw new Error(`no key: the ${keySecretName(host.slug)} secret is missing; pair the machine again`);
    const order = [...host.addresses];
    const last = this.memory.lastAddress;
    if (last && order.includes(last)) order.sort((a, b) => (a === last ? -1 : b === last ? 1 : 0));

    const misses: string[] = [];
    for (const address of order) {
      const target: SshTarget = {
        host: address,
        port: host.port,
        username: host.user,
        privateKey: key,
        hostVerifier: pinnedHostKey(host.hostKey),
        algorithms: { serverHostKey: [host.hostKeyType as never] },
      };
      const conn = this.deps.connect ? this.deps.connect(target) : (new SshConnection(target) as LinkConnection);
      try {
        await conn.connectOnce();
      } catch (err) {
        conn.close();
        misses.push(`${address}: ${describeConnectError(err)}`);
        continue;
      }
      // The right machine answered. Anything that fails from here is about
      // the machine itself, and another address would only fail the same way.
      try {
        return await this.verify(conn, address);
      } catch (err) {
        conn.close();
        throw err;
      }
    }
    throw new Error(misses.length === 1 ? misses[0]! : misses.join("; "));
  }

  private async verify(conn: LinkConnection, address: string): Promise<Linked> {
    const { paths, installed } = await ensureAgent(conn, { agent: this.deps.agent, runtime: this.deps.runtime });
    if (installed.length) this.deps.log.info(`remote-host ${this.host.slug}: installed ${installed.join(", ")}`);
    const run = async <T>(args: string[]): Promise<T> => {
      const r = await conn.exec(agentCommand(paths, args), { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`dispatch-host ${args[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
      return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null") as T;
    };
    // Sessions a dead Dispatch left behind (their owner died, or nobody has
    // been in touch for too long) go now, not at the dead-man deadline.
    const swept = await run<{ reaped?: string[]; deadMan?: string[] }>(["sweep", "--instance", this.deps.instanceId]);
    const reaped = [...(swept?.reaped ?? []), ...(swept?.deadMan ?? [])];
    if (reaped.length) this.deps.log.info(`remote-host ${this.host.slug}: swept ${reaped.length} orphaned session(s)`);
    await run(["hello", "--instance", this.deps.instanceId]);
    const probe = await run<ProbeResult>(["probe"]);
    if (this.disposed) {
      conn.close();
      throw new Error("the plugin is shutting down");
    }
    const linked: Linked = { conn, paths, address };
    this.linked = linked;
    conn.on("close", () => this.closed(conn));
    const at = this.now();
    this.lastHelloAt = at;
    this.lastProbeAt = at;
    this.memory = { lastAddress: address, lastSeenAt: at, probe };
    void this.saveMemory();
    this.report(statusFrom(probe, at));
    this.deps.log.info(`remote-host ${this.host.slug}: connected at ${address} (${[probe.os.name, probe.os.version].filter(Boolean).join(" ") || probe.platform}, ${probe.arch})`);
    return linked;
  }

  private closed(conn: LinkConnection): void {
    if (this.linked?.conn !== conn) return;
    this.linked = undefined;
    if (this.disposed) return;
    this.report({ state: "offline", detail: "connection lost; reconnecting", ...(this.memory.lastSeenAt ? { lastSeenAt: this.memory.lastSeenAt } : {}) });
    this.nextAttemptAt = this.now() + (this.t.backoffMs[0] ?? 2_000);
  }

  private drop(detail: string, state: "offline" | "degraded"): void {
    const l = this.linked;
    this.linked = undefined;
    l?.conn.close();
    this.report({ state, detail, ...(this.memory.lastSeenAt ? { lastSeenAt: this.memory.lastSeenAt } : {}) });
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      if (!this.linked?.conn.isOpen) {
        if (!this.connecting && now >= this.nextAttemptAt) await this.attempt().catch(() => {});
        return;
      }
      if (now - this.lastHelloAt >= this.t.helloEveryMs) {
        try {
          await this.agent(["hello", "--instance", this.deps.instanceId], 15_000);
          this.lastHelloAt = this.now();
          this.memory.lastSeenAt = this.lastHelloAt;
          this.report({ ...this.current, lastSeenAt: this.lastHelloAt });
        } catch (err) {
          this.drop(`no answer: ${errText(err)}`, "offline");
          this.nextAttemptAt = this.now();
          return;
        }
      }
      if (now - this.lastProbeAt >= this.t.probeEveryMs) {
        try {
          const probe = await this.agent<ProbeResult>(["probe"], 60_000);
          this.lastProbeAt = this.now();
          this.memory.probe = probe;
          this.report(statusFrom(probe, this.lastHelloAt));
          void this.saveMemory();
        } catch (err) {
          this.deps.log.warn(`remote-host ${this.host.slug}: probe failed: ${errText(err)}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private report(status: TerminalBackendStatusInput): void {
    this.current = status;
    if (this.disposed) return;
    try {
      this.deps.setStatus(status);
    } catch (err) {
      // The backend was unregistered under us (the machine was removed).
      this.deps.log.warn(`remote-host ${this.host.slug}: could not report status: ${errText(err)}`);
    }
  }

  private memKey(): string {
    return `host:${this.host.slug}`;
  }

  private async loadMemory(): Promise<void> {
    try {
      const m = await this.deps.kv?.get<LinkMemory>(this.memKey());
      if (m && typeof m === "object") this.memory = { ...m, ...this.memory };
    } catch {
      /* nothing remembered */
    }
  }

  private async saveMemory(): Promise<void> {
    try {
      await this.deps.kv?.set(this.memKey(), this.memory);
    } catch (err) {
      this.deps.log.warn(`remote-host ${this.host.slug}: could not save its state: ${errText(err)}`);
    }
  }
}

/** Online, or degraded with the reason a human would want to know. */
export function statusFrom(probe: ProbeResult, lastSeenAt: number): TerminalBackendStatusInput {
  const issues: string[] = [];
  if (typeof probe.freeDiskBytes === "number" && probe.freeDiskBytes < LOW_DISK_BYTES) {
    issues.push(`low disk: ${(probe.freeDiskBytes / 1024 ** 3).toFixed(1)} GB free`);
  }
  if (!probe.tools?.git) issues.push("git not found");
  if (probe.loginEnvError) issues.push("login shell environment unreadable");
  return issues.length ? { state: "degraded", detail: issues.join("; "), lastSeenAt } : { state: "online", lastSeenAt };
}

/** One short reason per address, for the status line and the refusal. */
export function describeConnectError(err: unknown): string {
  const m = errText(err);
  if (/host denied/i.test(m)) return "a different host key answered (not this machine)";
  if (/authentication/i.test(m)) return "the key was refused (taken out of authorized_keys, or this computer's address isn't in its from= list)";
  if (/ECONNREFUSED/.test(m)) return "connection refused (is Remote Login on?)";
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "unknown name";
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return "unreachable";
  if (/ETIMEDOUT|timed out|Timed out/i.test(m)) return "no answer (asleep, off, or off the network)";
  return m.replace(/^SSH to \S+ failed: /, "");
}
