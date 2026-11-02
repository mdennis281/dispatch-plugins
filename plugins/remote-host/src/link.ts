/**
 * One machine's connection: found, verified, kept up, and reported.
 *
 * - **Found** by trying its addresses in order, the last one that worked first.
 *   The pinned host key decides whether an address IS the machine. A different
 *   key means "not this machine", so that address is skipped. It never turns
 *   into a prompt to trust the new key: anything on the LAN can answer to
 *   `cvx-mac.lan`. Only pairing again changes the pin.
 * - **Verified** on connect: dispatch-host is installed or upgraded if needed,
 *   and `hello` says Dispatch is here. The first connect also sweeps orphans a
 *   previous Dispatch run left and probes the machine (OS, tools, disk). Later
 *   reconnects skip both and get back to their shells quickly; the sweep and
 *   the probe then run from the timer.
 * - **Kept up** with a `hello` every 30 s, which also feeds dispatch-host's
 *   dead-man switch, and SSH keepalives that notice a dead link in about 15 s.
 *   A link that drops, or a machine that sleeps, is retried with backoff.
 * - **Reported** through `setStatus` the whole time: a spawn on an offline
 *   machine is refused at once instead of waiting out a timeout.
 *
 * Shells don't share the control connection. sshd allows ten sessions per
 * connection (`MaxSessions`), and every shell holds its channel open for its
 * whole life, so shells go on extra connections, at most
 * {@link SESSIONS_PER_CONNECTION} each. The control connection keeps its own
 * room for `hello`, `mkdir` and `kill`, which take turns, a few at a time.
 */
import type { PluginContext, PluginLog, TerminalBackendStatusInput } from "@dispatch/plugin-sdk";
import { SshConnection, errText, pinnedHostKey, type ExecResult, type SshTarget } from "@dispatch-plugins/remote-core";
import type { ProbeResult } from "@dispatch-plugins/host-agent";
import type { ClientChannel } from "ssh2";
import type { AgentBundle, RuntimeSource } from "./agent.js";
import { hostKeyAlgorithms, keySecretName, type HostConfig } from "./hosts.js";
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
  sweepEveryMs: number;
  /** Waits between failed connects; the last repeats. */
  backoffMs: readonly number[];
  /** An extra connection with no shells on it is closed after this long. */
  idleSessionConnectionMs: number;
}

export const DEFAULT_TIMING: LinkTiming = {
  tickMs: 5_000,
  helloEveryMs: 30_000,
  probeEveryMs: 5 * 60_000,
  sweepEveryMs: 10 * 60_000,
  backoffMs: [2_000, 5_000, 15_000, 30_000, 60_000],
  idleSessionConnectionMs: 60_000,
};

/** sshd's `MaxSessions` defaults to 10; leave room. */
export const SESSIONS_PER_CONNECTION = 8;

/** Commands at once on the control connection, under the same limit. */
export const CONTROL_EXECS = 6;

/** A keepalive every 5 s, three missed: a dead link (Wi-Fi gone, the Mac asleep) is noticed in about 15 s. */
const KEEPALIVE = { intervalMs: 5_000, countMax: 3 };

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

interface PoolEntry {
  conn: LinkConnection;
  open: number;
  idleSince?: number;
}

/** Below this much free disk the machine is still usable, but flagged. */
const LOW_DISK_BYTES = 5 * 1024 ** 3;

export class HostLink {
  private linked?: Linked;
  private connecting?: { gen: number; p: Promise<Linked> };
  /** Bumped whenever how to reach the machine changes. A connect from an older generation is thrown away. */
  private gen = 0;
  private pool: PoolEntry[] = [];
  private adding?: Promise<PoolEntry>;
  private execs = 0;
  private execWaiting: Array<() => void> = [];
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastHelloAt = 0;
  private lastProbeAt = 0;
  private lastSweepAt = 0;
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

  /** How many connections carry shells right now (for tests and the log). */
  get sessionConnections(): number {
    return this.pool.length;
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
    this.gen++;
    this.drop("its settings changed; reconnecting", "degraded");
    this.closePool();
    this.failures = 0;
    void this.attempt().catch(() => {});
  }

  /** A live, verified connection: the current one, or a new one. Rejects with why the machine can't be reached. */
  ready(signal?: AbortSignal): Promise<Linked> {
    if (this.linked?.conn.isOpen) return Promise.resolve(this.linked);
    return withAbort(this.attempt(), signal);
  }

  /**
   * A channel running `command` for a shell, on a connection with room for it
   * (opened if none has). The channel stays open for the shell's life.
   */
  async openSession(command: string, signal?: AbortSignal): Promise<ClientChannel> {
    await this.ready(signal);
    const gen = this.gen;
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      const slot = this.pool.find((p) => p.conn.isOpen && p.open < SESSIONS_PER_CONNECTION);
      if (!slot) {
        this.adding ??= this.addSessionConnection().finally(() => {
          this.adding = undefined;
        });
        await withAbort(this.adding, signal);
        continue;
      }
      if (gen !== this.gen) throw new Error("the machine's settings changed; try again");
      slot.open++;
      slot.idleSince = undefined;
      let ch: ClientChannel;
      try {
        ch = await slot.conn.channel(command);
      } catch (err) {
        this.release(slot);
        throw err;
      }
      ch.on("close", () => this.release(slot));
      return ch;
    }
  }

  /**
   * Run a command on the control connection. At most {@link CONTROL_EXECS} run
   * at once, the rest wait their turn: a burst (a dozen spawns each making
   * its directory, kills after a drop) must not hit sshd's `MaxSessions`.
   */
  async exec(command: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    await this.takeExecSlot();
    try {
      const { conn } = await this.ready();
      return await conn.exec(command, opts);
    } finally {
      this.execs--;
      this.execWaiting.shift()?.();
    }
  }

  /** Run a dispatch-host query command (`hello`, `list`, `kill` …) and parse its one line of JSON. */
  async agent<T>(args: readonly string[], timeoutMs = 30_000): Promise<T> {
    const { paths } = await this.ready();
    const r = await this.exec(agentCommand(paths, args), { timeoutMs });
    if (r.code !== 0) throw new Error(`dispatch-host ${args[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
    return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null") as T;
  }

  private async takeExecSlot(): Promise<void> {
    while (this.execs >= CONTROL_EXECS) await new Promise<void>((r) => this.execWaiting.push(r));
    this.execs++;
  }

  /**
   * For a human pressing "Check": probe a live link without disturbing its
   * shells, or try an offline one now instead of at the end of its backoff.
   */
  async checkNow(): Promise<TerminalBackendStatusInput> {
    if (this.linked?.conn.isOpen) {
      try {
        await this.hello();
        await this.probeNow();
      } catch (err) {
        this.lost(`no answer: ${errText(err)}`);
      }
      return this.current;
    }
    this.failures = 0;
    this.nextAttemptAt = 0;
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
    this.closePool();
  }

  private attempt(): Promise<Linked> {
    if (this.disposed) return Promise.reject(new Error("the plugin is shutting down"));
    if (this.linked?.conn.isOpen) return Promise.resolve(this.linked);
    if (this.connecting && this.connecting.gen === this.gen) return this.connecting.p;
    const gen = this.gen;
    const p = this.connectOnce(gen)
      .then(
        (linked) => {
          this.failures = 0;
          return linked;
        },
        (err: unknown) => {
          if (gen === this.gen) {
            this.failures++;
            const wait = this.t.backoffMs[Math.min(this.failures - 1, this.t.backoffMs.length - 1)] ?? 60_000;
            this.nextAttemptAt = this.now() + wait;
            if (!this.disposed) this.report({ state: "offline", detail: errText(err), ...this.seen() });
          }
          throw err;
        },
      )
      .finally(() => {
        if (this.connecting?.p === p) this.connecting = undefined;
      });
    this.connecting = { gen, p };
    return p;
  }

  private target(address: string, key: string): SshTarget {
    const host = this.host;
    return {
      host: address,
      port: host.port,
      username: host.user,
      privateKey: key,
      hostVerifier: pinnedHostKey(host.hostKey),
      algorithms: { serverHostKey: hostKeyAlgorithms(host.hostKeyType) as never },
      keepalive: KEEPALIVE,
    };
  }

  private make(target: SshTarget): LinkConnection {
    return this.deps.connect ? this.deps.connect(target) : (new SshConnection(target) as LinkConnection);
  }

  private async connectOnce(gen: number): Promise<Linked> {
    const host = this.host;
    const key = await this.deps.privateKey();
    if (!key) throw new Error(`no key: the ${keySecretName(host.slug)} secret is missing; pair the machine again`);
    const order = [...host.addresses];
    const last = this.memory.lastAddress;
    if (last && order.includes(last)) order.sort((a, b) => (a === last ? -1 : b === last ? 1 : 0));

    const misses: string[] = [];
    for (const address of order) {
      const conn = this.make(this.target(address, key));
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
        return await this.verify(conn, address, gen);
      } catch (err) {
        conn.close();
        throw err;
      }
    }
    throw new Error(misses.length === 1 ? misses[0]! : misses.join("; "));
  }

  private async verify(conn: LinkConnection, address: string, gen: number): Promise<Linked> {
    const first = this.lastProbeAt === 0;
    const { paths, installed } = await ensureAgent(conn, { agent: this.deps.agent, runtime: this.deps.runtime });
    if (installed.length) this.deps.log.info(`remote-host ${this.host.slug}: installed ${installed.join(", ")}`);
    const run = async <T>(args: string[]): Promise<T> => {
      const r = await conn.exec(agentCommand(paths, args), { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`dispatch-host ${args[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
      return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null") as T;
    };
    if (first) await this.sweepWith(run);
    await run(["hello", "--instance", this.deps.instanceId]);
    const probe = first ? await run<ProbeResult>(["probe"]) : undefined;
    if (this.disposed || gen !== this.gen) {
      conn.close();
      throw new Error(this.disposed ? "the plugin is shutting down" : "the machine's settings changed while connecting");
    }
    const linked: Linked = { conn, paths, address };
    this.linked = linked;
    conn.on("close", () => this.closed(conn));
    const at = this.now();
    this.lastHelloAt = at;
    this.memory = { ...this.memory, lastAddress: address, lastSeenAt: at, ...(probe ? { probe } : {}) };
    if (probe) this.lastProbeAt = at;
    void this.saveMemory();
    this.report(this.memory.probe ? statusFrom(this.memory.probe, at) : { state: "online", lastSeenAt: at });
    const p = this.memory.probe;
    this.deps.log.info(
      `remote-host ${this.host.slug}: connected at ${address}` +
        (p ? ` (${[p.os.name, p.os.version].filter(Boolean).join(" ") || p.platform}, ${p.arch})` : ""),
    );
    return linked;
  }

  private async sweepWith(run: <T>(args: string[]) => Promise<T>): Promise<void> {
    // Sessions a dead Dispatch left behind (their owner died, or nobody has
    // been in touch for too long) go now, not at the dead-man deadline.
    const swept = await run<{ reaped?: string[]; deadMan?: string[] }>(["sweep", "--instance", this.deps.instanceId]);
    this.lastSweepAt = this.now();
    const reaped = [...(swept?.reaped ?? []), ...(swept?.deadMan ?? [])];
    if (reaped.length) this.deps.log.info(`remote-host ${this.host.slug}: swept ${reaped.length} orphaned session(s)`);
  }

  private async addSessionConnection(): Promise<PoolEntry> {
    const linked = await this.ready();
    const gen = this.gen;
    const key = await this.deps.privateKey();
    if (!key) throw new Error(`no key: the ${keySecretName(this.host.slug)} secret is missing`);
    const conn = this.make(this.target(linked.address, key));
    try {
      await conn.connectOnce();
    } catch (err) {
      conn.close();
      throw new Error(`could not open another connection for shells: ${describeConnectError(err)}`);
    }
    const entry: PoolEntry = { conn, open: 0, idleSince: this.now() };
    conn.on("close", () => {
      this.pool = this.pool.filter((p) => p !== entry);
    });
    // Opened for an address the settings have since moved away from.
    if (this.disposed || gen !== this.gen) {
      conn.close();
      throw new Error(this.disposed ? "the plugin is shutting down" : "the machine's settings changed; try again");
    }
    this.pool.push(entry);
    return entry;
  }

  private release(slot: PoolEntry): void {
    slot.open = Math.max(0, slot.open - 1);
    if (slot.open === 0) slot.idleSince = this.now();
  }

  private closePool(): void {
    const pool = this.pool;
    this.pool = [];
    for (const p of pool) p.conn.close();
  }

  private closed(conn: LinkConnection): void {
    if (this.linked?.conn !== conn) return;
    this.linked = undefined;
    if (this.disposed) return;
    this.report({ state: "offline", detail: "connection lost; reconnecting", ...this.seen() });
    this.nextAttemptAt = this.now() + (this.t.backoffMs[0] ?? 2_000);
  }

  private lost(detail: string): void {
    this.drop(detail, "offline");
    this.nextAttemptAt = this.now();
  }

  private drop(detail: string, state: "offline" | "degraded"): void {
    const l = this.linked;
    this.linked = undefined;
    l?.conn.close();
    this.report({ state, detail, ...this.seen() });
  }

  private seen(): { lastSeenAt?: number } {
    return this.memory.lastSeenAt ? { lastSeenAt: this.memory.lastSeenAt } : {};
  }

  private async hello(): Promise<void> {
    await this.agent(["hello", "--instance", this.deps.instanceId], 15_000);
    this.lastHelloAt = this.now();
    this.memory.lastSeenAt = this.lastHelloAt;
    this.report({ ...this.current, lastSeenAt: this.lastHelloAt });
  }

  private async probeNow(): Promise<void> {
    const probe = await this.agent<ProbeResult>(["probe"], 60_000);
    this.lastProbeAt = this.now();
    this.memory.probe = probe;
    this.report(statusFrom(probe, this.lastHelloAt));
    void this.saveMemory();
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      for (const p of this.pool) {
        if (p.open === 0 && p.idleSince !== undefined && now - p.idleSince >= this.t.idleSessionConnectionMs) p.conn.close();
      }
      if (!this.linked?.conn.isOpen) {
        if (!this.connecting && now >= this.nextAttemptAt) await this.attempt().catch(() => {});
        return;
      }
      if (now - this.lastHelloAt >= this.t.helloEveryMs) {
        try {
          await this.hello();
        } catch (err) {
          // A channel the connection couldn't open is a full connection, not
          // a dead one: say so, and keep the link.
          if (/channel open failure|open failed/i.test(errText(err))) {
            this.deps.log.warn(`remote-host ${this.host.slug}: hello could not open a channel: ${errText(err)}`);
          } else {
            this.lost(`no answer: ${errText(err)}`);
            return;
          }
        }
      }
      if (now - this.lastProbeAt >= this.t.probeEveryMs) {
        await this.probeNow().catch((err: unknown) => this.deps.log.warn(`remote-host ${this.host.slug}: probe failed: ${errText(err)}`));
      }
      if (now - this.lastSweepAt >= this.t.sweepEveryMs) {
        await this.agent<{ reaped?: string[]; deadMan?: string[] }>(["sweep", "--instance", this.deps.instanceId], 60_000)
          .then((s) => {
            this.lastSweepAt = this.now();
            const n = (s?.reaped?.length ?? 0) + (s?.deadMan?.length ?? 0);
            if (n) this.deps.log.info(`remote-host ${this.host.slug}: swept ${n} orphaned session(s)`);
          })
          .catch((err: unknown) => this.deps.log.warn(`remote-host ${this.host.slug}: sweep failed: ${errText(err)}`));
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

function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
