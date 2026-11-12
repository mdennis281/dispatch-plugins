/**
 * The connection to a machine another plugin provisioned for one chat (a
 * container, say): `machines@1`, the plugin-dependencies design §2.3.
 *
 * Unlike a paired machine's {@link HostLink}, it dials ON DEMAND only: when a
 * spawn or a command needs the machine, with the addresses the provisioner
 * gave for THAT connect. It never reconnects in the background and remembers
 * no address (DHCP gives a stopped container's address to the next one), and
 * a dropped connection stays down until something needs the machine again,
 * which asks the provisioner first (it may have to start the machine).
 *
 * Linked clones of one template share its host key, so a valid key at a
 * stale address may be ANOTHER chat's machine. Before anything runs on a
 * connection (no install, no sweep, no session), it checks the incarnation
 * token written there on the machine's first connect, and the hostname when
 * the lease names one. A mismatch is `wrong-machine`: the connection closes
 * and nothing ran.
 *
 * The credential is asked for on every connect (`lease.auth()`) and goes
 * straight into that connection: never kept here, logged, or put in a message.
 */
import { randomBytes } from "node:crypto";
import type { PluginLog } from "@dispatch/plugin-sdk";
import { SshConnection, errText, pinnedHostKey, trustProvisioner, type SshTarget } from "@dispatch-plugins/remote-core";
import { shCommand, sq, type ProbeResult } from "@dispatch-plugins/host-agent";
import type { MachineLease } from "@dispatch-plugins/remote-host-api";
import type { AgentBundle, RuntimeSource } from "./agent.js";
import { agentCommand, ensureAgent } from "./install.js";
import { DEFAULT_TIMING, KEEPALIVE, LinkBase, describeConnectError, withAbort, type LinkConnection, type LinkTiming, type Linked } from "./link.js";
import { MachinesError } from "./machines-error.js";

/** Where the token is, under the login's home. */
export const INCARNATION_FILE = ".dispatch-host/incarnation";
/** How long a spawn's lease stays good for the connect after it. Older, and the connect provisions again. */
export const FRESH_LEASE_MS = 60_000;

export interface ProvisionedLinkDeps {
  instanceId: string;
  /** What messages call the machine ("Proxmox container"). */
  label: string;
  agent: AgentBundle;
  runtime: RuntimeSource;
  log: PluginLog;
  /** Ask the provisioner for this chat's machine again: the connection dropped, and something needs it. */
  provision(): Promise<MachineLease>;
  /** The incarnation token kept here for this machine (kv). */
  token: { get(): Promise<string | undefined>; set(token: string): Promise<void> };
  connect?: (target: SshTarget) => LinkConnection;
  timing?: Partial<Pick<LinkTiming, "tickMs" | "helloEveryMs" | "idleSessionConnectionMs">>;
  now?: () => number;
}

export class ProvisionedLink extends LinkBase {
  /** A lease the next connect uses instead of asking again (the spawn that just provisioned), and when. */
  private fresh?: { lease: MachineLease; at: number };
  /** The lease the live connection came from: extra connections for shells use it too. */
  private current?: MachineLease;
  private connecting?: Promise<Linked>;
  private gen = 0;
  private lastProbe?: ProbeResult;
  private lastAddress?: string;
  private timer?: NodeJS.Timeout;
  private lastHelloAt = 0;
  private busy = false;
  private readonly t: Pick<LinkTiming, "tickMs" | "helloEveryMs" | "idleSessionConnectionMs">;

  constructor(
    /** The incarnation this link reaches, and no other. */
    readonly machine: string,
    private readonly deps: ProvisionedLinkDeps,
  ) {
    super(deps.now);
    this.t = { ...DEFAULT_TIMING, ...deps.timing };
  }

  get probe(): ProbeResult | undefined {
    return this.lastProbe;
  }

  get address(): string | undefined {
    return this.linked?.address ?? this.lastAddress;
  }

  /**
   * A lease just provisioned for this machine, for the connect that follows
   * it. With a connection up, or one being made, nothing takes it now, and
   * kept until the next drop it would be stale by then: a machine stopped,
   * then dialled at its old address without the provisioner starting it or
   * saying where it is now.
   */
  use(lease: MachineLease): void {
    if (this.linked?.conn.isOpen || this.connecting) return;
    this.fresh = { lease, at: this.now() };
  }

  ready(signal?: AbortSignal): Promise<Linked> {
    if (this.linked?.conn.isOpen) {
      this.fresh = undefined;
      return Promise.resolve(this.linked);
    }
    if (this.disposed) return Promise.reject(new Error(`${this.deps.label}: the connection was closed`));
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return withAbort(this.connecting, signal);
  }

  /** End the connections (the chat went idle). The next thing that needs the machine provisions and dials again. */
  close(): void {
    this.gen++;
    this.fresh = undefined;
    const l = this.linked;
    this.linked = undefined;
    l?.conn.close();
    this.closePool();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.close();
  }

  protected generation(): number {
    return this.gen;
  }

  protected name(): string {
    return this.deps.label;
  }

  protected async dialAgain(linked: Linked): Promise<LinkConnection> {
    const lease = this.current;
    if (!lease) throw new Error(`${this.deps.label} is not connected`);
    const conn = this.make(this.target(linked.address, lease, await credentials(lease)));
    try {
      await conn.connectOnce();
    } catch (err) {
      conn.close();
      throw new Error(`could not open another connection for shells: ${describeConnectError(err, this.lastProbe?.platform)}`);
    }
    return conn;
  }

  private async connect(): Promise<Linked> {
    // Only a lease from just now: one a spawn left behind (it failed before
    // dialling) may name an address the machine has since left.
    const f = this.fresh;
    this.fresh = undefined;
    const lease = f && this.now() - f.at < FRESH_LEASE_MS ? f.lease : await this.deps.provision();
    if (lease.machine !== this.machine) {
      // The provisioner made a new machine for the chat: what this link served is gone with the old one.
      throw new Error(`${this.deps.label}: this chat's machine was made again, so its terminals there are gone; open the terminal again`);
    }
    const gen = this.gen;
    const misses: string[] = [];
    const wrong: string[] = [];
    let keyMismatches = 0;
    for (const address of lease.addresses) {
      if (this.disposed) break;
      const conn = this.make(this.target(address, lease, await credentials(lease)));
      try {
        await conn.connectOnce();
      } catch (err) {
        conn.close();
        const why = describeConnectError(err, this.lastProbe?.platform);
        if (/host denied/i.test(errText(err))) keyMismatches++;
        misses.push(`${address}: ${why}`);
        continue;
      }
      try {
        return await this.verify(conn, address, lease, gen);
      } catch (err) {
        conn.close();
        if (err instanceof MachinesError && err.code === "wrong-machine") {
          wrong.push(`${address}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    if (this.disposed) throw new Error(`${this.deps.label}: the connection was closed`);
    if (wrong.length) {
      throw new MachinesError("wrong-machine", `${this.deps.label}: another machine answered (${wrong.join("; ")}); nothing was run there`);
    }
    if (keyMismatches && keyMismatches === misses.length) {
      throw new MachinesError("host-key-mismatch", `${this.deps.label}: ${misses.join("; ")}`);
    }
    throw new MachinesError("unreachable", `${this.deps.label} can't be reached: ${misses.join("; ") || "no address to try"}`);
  }

  /** Is this the machine, and is dispatch-host ready on it? Nothing runs there before the first answer is yes. */
  private async verify(conn: LinkConnection, address: string, lease: MachineLease, gen: number): Promise<Linked> {
    await this.checkIdentity(conn, lease);
    const { paths, installed } = await ensureAgent(conn, { agent: this.deps.agent, runtime: this.deps.runtime });
    if (installed.length) this.deps.log.info(`remote-host ${this.deps.label} ${this.machine}: installed ${installed.join(", ")}`);
    const run = async <T>(args: string[]): Promise<T> => {
      const r = await conn.exec(agentCommand(paths, args), { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`dispatch-host ${args[0]} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
      return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null") as T;
    };
    // A machine that was stopped lost its sessions: their records go now, not at the dead-man deadline.
    await run(["sweep", "--instance", this.deps.instanceId]);
    await run(["hello", "--instance", this.deps.instanceId]);
    const probe = await run<ProbeResult>(["probe"]);
    if (this.disposed || gen !== this.gen) {
      conn.close();
      throw new Error(`${this.deps.label}: the connection was closed while connecting`);
    }
    const linked: Linked = { conn, paths, address };
    this.linked = linked;
    this.current = lease;
    this.lastAddress = address;
    this.lastProbe = probe;
    this.lastHelloAt = this.now();
    conn.on("close", () => {
      if (this.linked?.conn === conn) this.linked = undefined;
    });
    this.startTimer();
    this.deps.log.info(
      `remote-host ${this.deps.label} ${this.machine}: connected at ${address} (${[probe.os.name, probe.os.version].filter(Boolean).join(" ") || probe.platform}, ${probe.arch})`,
    );
    return linked;
  }

  /**
   * The incarnation token, and the hostname if the lease gives one. The token
   * is written on the incarnation's first connect, then must read back on
   * every later one: a machine with none, or another's, is not this one.
   */
  private async checkIdentity(conn: LinkConnection, lease: MachineLease): Promise<void> {
    const id = await conn.exec(shCommand(IDENTITY_SCRIPT), { timeoutMs: 20_000 });
    if (id.code !== 0) throw new Error(`could not tell which machine answered (exit ${id.code}): ${id.stderr.trim().slice(0, 200)}`);
    const { hostname, incarnation } = parseIdentity(id.stdout);
    if (lease.hostname && !sameHostname(hostname, lease.hostname)) {
      throw new MachinesError("wrong-machine", `its hostname is ${JSON.stringify(hostname ?? "")}, not ${JSON.stringify(lease.hostname)}`);
    }
    const kept = await this.deps.token.get();
    if (incarnation !== undefined) {
      const cut = incarnation.lastIndexOf(" ");
      const machine = cut > 0 ? incarnation.slice(0, cut) : "";
      const token = cut > 0 ? incarnation.slice(cut + 1) : "";
      if (machine !== lease.machine || !token) throw new MachinesError("wrong-machine", "it is another chat's machine (its incarnation token names another)");
      if (kept && token !== kept) throw new MachinesError("wrong-machine", "its incarnation token isn't the one this chat's machine was given");
      // The record here was lost; the machine says it is this incarnation, which only it can.
      if (!kept) await this.deps.token.set(token);
      return;
    }
    if (kept) {
      throw new MachinesError("wrong-machine", "it has no incarnation token, so it isn't the machine this chat used (a new machine at a reused address)");
    }
    const token = randomBytes(16).toString("hex");
    const w = await conn.exec(shCommand(writeTokenScript(lease.machine, token)), { timeoutMs: 20_000 });
    if (w.code !== 0) throw new Error(`could not mark the machine as this chat's (exit ${w.code}): ${w.stderr.trim().slice(0, 200)}`);
    // There first, then here: a token kept here that the machine never got would lock the chat out of it.
    await this.deps.token.set(token);
  }

  private target(address: string, lease: MachineLease, auth: { privateKey?: string; password?: string }): SshTarget {
    return {
      host: address,
      port: lease.port ?? 22,
      username: lease.user,
      ...(auth.privateKey ? { privateKey: auth.privateKey } : { password: auth.password! }),
      hostVerifier: "pin" in lease.hostKey ? pinnedHostKey(lease.hostKey.pin) : trustProvisioner(),
      keepalive: KEEPALIVE,
    };
  }

  private make(target: SshTarget): LinkConnection {
    return this.deps.connect ? this.deps.connect(target) : (new SshConnection(target) as LinkConnection);
  }

  private startTimer(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => void this.tick(), this.t.tickMs);
    this.timer.unref?.();
  }

  /** While connected: the hellos dispatch-host's dead-man switch wants, and idle extra connections closed. Never a reconnect. */
  private async tick(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      this.closeIdle(this.t.idleSessionConnectionMs);
      if (!this.linked?.conn.isOpen || this.now() - this.lastHelloAt < this.t.helloEveryMs) return;
      try {
        await this.agent(["hello", "--instance", this.deps.instanceId], 15_000);
        this.lastHelloAt = this.now();
      } catch (err) {
        if (/channel open failure|open failed/i.test(errText(err))) return;
        this.deps.log.info(`remote-host ${this.deps.label} ${this.machine}: no answer (${errText(err)}); connecting again when it is next needed`);
        this.close();
      }
    } finally {
      this.busy = false;
    }
  }
}

/**
 * The lease's credential for one connect. A password only with a pinned
 * host key: sent to whatever answers, it would otherwise go to anything at
 * that address.
 */
async function credentials(lease: MachineLease): Promise<{ privateKey?: string; password?: string }> {
  const a = await lease.auth();
  const privateKey = typeof a?.privateKey === "string" && a.privateKey ? a.privateKey : undefined;
  const password = typeof a?.password === "string" && a.password ? a.password : undefined;
  if (privateKey) return { privateKey };
  if (!password) throw new MachinesError("bad-lease", "the lease's auth() gave neither a private key nor a password");
  if (!("pin" in lease.hostKey)) throw new MachinesError("bad-lease", "a password is sent only to a pinned host key; this lease trusts the provisioner instead");
  return { password };
}

/** Who answered: its hostname, and the incarnation token, or a line saying there is none. */
export const IDENTITY_SCRIPT = [
  `h=$(hostname 2>/dev/null || uname -n)`,
  `printf 'host=%s\\n' "$h"`,
  `f="$HOME/${INCARNATION_FILE}"`,
  `if [ -f "$f" ]; then printf 'incarnation=%s\\n' "$(head -n 1 "$f")"; else echo 'incarnation-none'; fi`,
].join("\n");

/** Write the token, never over one that is there (noclobber: two first connects can't both win). */
export function writeTokenScript(machine: string, token: string): string {
  return [
    `umask 077`,
    `mkdir -p "$HOME/.dispatch-host"`,
    `(set -C; printf '%s\\n' ${sq(`${machine} ${token}`)} > "$HOME/${INCARNATION_FILE}")`,
  ].join("\n");
}

export function parseIdentity(stdout: string): { hostname?: string; incarnation?: string } {
  let hostname: string | undefined;
  let incarnation: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("host=")) hostname = line.slice(5).trim();
    else if (line.startsWith("incarnation=")) incarnation = line.slice(12).trim();
  }
  return { ...(hostname ? { hostname } : {}), ...(incarnation !== undefined ? { incarnation } : {}) };
}

/** `dt-x` and `dt-x.lan` are one name; letter case never matters in one. */
function sameHostname(seen: string | undefined, want: string): boolean {
  if (!seen) return false;
  const short = (h: string) => h.toLowerCase().split(".")[0];
  return seen.toLowerCase() === want.toLowerCase() || short(seen) === short(want);
}
