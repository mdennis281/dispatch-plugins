/**
 * A chat's dev servers on the machine, reachable on this computer.
 *
 * - **Only what the chat started.** dispatch-host attributes every TCP
 *   listener to the session whose process tree holds it (`dispatch-host
 *   ports`). A chat's own listeners are forwarded; nothing else there ever is:
 *   not AirPlay on 5000/7000, not another chat's, not the other Dispatch's, not
 *   the account's own.
 * - **The same port here when it is free**, so an OAuth redirect, a CORS
 *   origin or a cookie set for `localhost:3000` still works. Otherwise any free
 *   port, and the published URL says which.
 * - **Never a port Dispatch reserves** (`ctx.runner.reservedPorts()`: both
 *   instances' ports, the dev server's live-reload socket, plugins' process
 *   ports), even while nothing holds it. A dev server on 4319 there, forwarded
 *   onto 4319 here, would stop the dev instance from starting; on Windows it
 *   could even share the port with it and answer half its requests. Such a
 *   forward goes on another port, and the log says why.
 * - **Loopback only**, on both ends: it listens on 127.0.0.1 here and dials
 *   the machine's loopback there (the key's `permitopen` allows nothing else).
 * - **It outlives a reconnect.** The listener here stays put; each connection
 *   to it dials the machine over whatever connection the link has NOW. While
 *   the machine is offline a connection is refused, and nothing is polled.
 *
 * One poll per machine every few seconds, only while one of its shells is
 * alive. A chat's forwards go when its last shell there does.
 */
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { PluginLog, TerminalPortForwardInput } from "@dispatch/plugin-sdk";
import type { Attribution, Listener } from "@dispatch-plugins/host-agent";
import { errText } from "@dispatch-plugins/remote-core";

export interface PortForwardsDeps {
  /** `dispatch-host ports` for this instance: every listener, by session. */
  list(): Promise<Attribution>;
  /** One connection to `host:port` on the machine. */
  dial(host: string, port: number): Promise<Duplex>;
  /** Whether the machine is reachable now; while it isn't, forwards stay and nothing is polled. */
  online(): boolean;
  /** Announce a forward (`ctx.terminals.publishPort`); returns its withdraw. */
  publish(port: TerminalPortForwardInput): () => void;
  /** The chats with a live shell on this machine. */
  chats(): ReadonlySet<string>;
  log: PluginLog;
  /** The machine, for log lines. */
  label(): string;
  /** Ports here a forward must never take, and why (`ctx.runner.reservedPorts()`). Without it, {@link DEFAULT_RESERVED}. */
  reserved?(): Promise<readonly ReservedPort[]>;
  intervalMs?: number;
}

/** How often a machine with live shells is asked what is listening. */
export const PORT_POLL_MS = 4_000;

/** A port here a forward must never take, and why: "the development Dispatch instance's default port". */
export interface ReservedPort {
  port: number;
  reason: string;
}

/**
 * Dispatch's own fixed ports, worded as core words them. Reserved always:
 * alone when this Dispatch has no `ctx.runner` (older than Dispatch #517),
 * and added to what it reports otherwise.
 */
export const DEFAULT_RESERVED: readonly ReservedPort[] = [
  { port: 4318, reason: "the installed Dispatch instance's default port" },
  { port: 4319, reason: "the development Dispatch instance's default port" },
  { port: 24678, reason: "a development Dispatch instance's live-reload socket" },
];

interface Forward {
  chat: string;
  remotePort: number;
  /** Where to dial it on the machine: 127.0.0.1, or ::1 for a listener bound only there. */
  host: string;
  localPort: number;
  server: Server;
  sockets: Set<Socket>;
  withdraw: () => void;
}

export interface ForwardView {
  chat: string;
  remotePort: number;
  localPort: number;
  url: string;
}

export class PortForwards {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private readonly forwards = new Map<string, Forward>();
  /** Ports that failed to forward, so each failure is logged once rather than every poll. */
  private readonly failed = new Set<string>();
  private listFailing = false;
  private reservedFailing = false;
  private disposed = false;

  constructor(private readonly deps: PortForwardsDeps) {}

  /** A shell started: poll while there are any. Idempotent. */
  wake(): void {
    if (this.disposed || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? PORT_POLL_MS);
    this.timer.unref?.();
    void this.tick();
  }

  /** One poll: forward each chat's new listeners, close those that went. Overlapping calls share one. */
  tick(): Promise<void> {
    this.ticking ??= this.poll().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    const chats = this.deps.chats();
    if (!chats.size) {
      this.stopTimer();
      for (const k of [...this.forwards.keys()]) this.close(k);
      return;
    }
    if (!this.deps.online()) return;
    let report: Attribution;
    try {
      report = await this.deps.list();
      this.listFailing = false;
    } catch (err) {
      if (!this.listFailing) this.deps.log.warn(`remote-host ${this.deps.label()}: could not list its listening ports: ${errText(err)}`);
      this.listFailing = true;
      return;
    }
    if (this.disposed) return;
    const live = this.deps.chats();
    const want = new Map<string, { chat: string; l: Listener }>();
    for (const s of report.sessions ?? []) {
      if (!live.has(s.chat)) continue;
      for (const l of s.ports ?? []) {
        if (validPort(l.port) && isLoopback(l.host)) want.set(key(s.chat, l.port), { chat: s.chat, l });
      }
    }
    const reserved = want.size || this.forwards.size ? await this.reserved() : new Map<number, string>();
    if (this.disposed) return;
    // Close first: a port that passed from one chat to another frees its
    // local port for the new owner.
    for (const [k, f] of this.forwards) {
      const w = want.get(k);
      // A port can become reserved after it was taken (the installed Dispatch
      // restarted onto it, say): give it up, and the loop below moves the forward.
      const why = reserved.get(f.localPort);
      if (!w || w.l.host !== f.host) this.close(k);
      else if (why) {
        this.deps.log.info(`remote-host ${this.deps.label()}: moving port ${f.remotePort}'s forward off ${f.localPort}, now reserved here (${why})`);
        this.close(k);
      }
    }
    for (const k of [...this.failed]) if (!want.has(k)) this.failed.delete(k);
    for (const [k, { chat, l }] of want) {
      if (this.forwards.has(k) || this.disposed) continue;
      try {
        const f = await this.open(chat, l, reserved);
        this.forwards.set(k, f);
        this.failed.delete(k);
        // Torn down, or the chat's last shell went, while it was opening.
        if (this.disposed || !this.deps.chats().has(chat)) this.close(k);
      } catch (err) {
        if (!this.failed.has(k)) this.deps.log.warn(`remote-host ${this.deps.label()}: could not forward port ${l.port}: ${errText(err)}`);
        this.failed.add(k);
      }
    }
  }

  /** The chat's shells here are gone (it ended them, went idle, was deleted): its forwards go too. */
  dropChat(chat: string): void {
    for (const [k, f] of this.forwards) if (f.chat === chat) this.close(k);
  }

  /** What is forwarded now, for tests and the log. */
  list(chat?: string): ForwardView[] {
    return [...this.forwards.values()]
      .filter((f) => !chat || f.chat === chat)
      .map((f) => ({ chat: f.chat, remotePort: f.remotePort, localPort: f.localPort, url: urlOf(f.localPort) }));
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    for (const k of [...this.forwards.keys()]) this.close(k);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The ports no forward may take, by port, with why. Dispatch's own fixed
   * ones always, whatever `ctx.runner` says or if asking it fails.
   */
  private async reserved(): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (this.deps.reserved) {
      try {
        for (const r of await this.deps.reserved()) if (validPort(r.port) && !out.has(r.port)) out.set(r.port, r.reason);
        this.reservedFailing = false;
      } catch (err) {
        if (!this.reservedFailing) {
          this.deps.log.warn(`remote-host ${this.deps.label()}: could not ask Dispatch which ports are reserved, so only its own are kept clear: ${errText(err)}`);
        }
        this.reservedFailing = true;
      }
    }
    for (const r of DEFAULT_RESERVED) if (!out.has(r.port)) out.set(r.port, r.reason);
    return out;
  }

  private async open(chat: string, l: Listener, reserved: ReadonlyMap<number, string>): Promise<Forward> {
    const sockets = new Set<Socket>();
    const server = createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.on("error", () => {});
      // Until the channel opens, what the client sends waits in the socket (it isn't flowing yet).
      this.deps.dial(l.host, l.port).then(
        (ch) => {
          if (sock.destroyed) return void ch.destroy();
          ch.on("error", () => sock.destroy());
          ch.on("close", () => sock.destroy());
          sock.on("close", () => ch.destroy());
          sock.pipe(ch).pipe(sock);
        },
        () => sock.destroy(),
      );
    });
    const localPort = await listen(server, l.port, reserved);
    const label = command(l.command);
    const why = reserved.get(l.port);
    let withdraw: () => void;
    try {
      // Throws once the backend is unregistered. The port must not stay bound
      // then: the next poll would find it taken and bind yet another.
      withdraw = this.deps.publish({ chatId: chat, remotePort: l.port, url: urlOf(localPort), ...(label ? { label } : {}) });
    } catch (err) {
      server.close();
      for (const s of sockets) s.destroy();
      throw err;
    }
    this.deps.log.info(
      `remote-host ${this.deps.label()}: forwarding port ${l.port}${label ? ` (${label})` : ""} for chat ${chat} to ${urlOf(localPort)}` +
        (why ? `; not to ${l.port}, which is reserved here (${why})` : ""),
    );
    return { chat, remotePort: l.port, host: l.host, localPort, server, sockets, withdraw };
  }

  private close(k: string): void {
    const f = this.forwards.get(k);
    if (!f) return;
    this.forwards.delete(k);
    try {
      f.withdraw();
    } catch {
      /* the backend is already gone, and its ports with it */
    }
    f.server.close();
    for (const s of f.sockets) s.destroy();
  }
}

/** How many ephemeral ports to try before taking one that is busy on ::1. */
const EPHEMERAL_TRIES = 8;
/** And before giving up on finding one that isn't reserved (the system only hands out a reserved one nothing holds). */
const RESERVED_TRIES = 64;

/**
 * Listen on 127.0.0.1:`preferred` when that port is free on BOTH loopbacks
 * and not `reserved`, else on another port that is. Resolves with the port;
 * never a reserved one.
 *
 * Both, because the forward is published as `http://127.0.0.1:<port>` but a
 * person (or a browser that tries IPv6 first) types `localhost:<port>`. With
 * another program on [::1]:<port>, which is how Vite listens on Windows,
 * that name reached the other program, not the machine's dev server (seen in
 * the live run on cvx-mac, where two other chats' Vite servers held ::1).
 */
export async function listen(server: Server, preferred: number, reserved: { has(port: number): boolean } = new Set()): Promise<number> {
  const attempt = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const fail = (err: Error) => {
        server.off("listening", ok);
        reject(err);
      };
      const ok = () => {
        server.off("error", fail);
        resolve((server.address() as AddressInfo).port);
      };
      server.once("error", fail);
      server.once("listening", ok);
      server.listen(port, "127.0.0.1");
    });
  if (!reserved.has(preferred) && (await freeOnV6Loopback(preferred))) {
    try {
      return await attempt(preferred);
    } catch {
      /* busy on 127.0.0.1: any port will do */
    }
  }
  for (let i = 1; ; i++) {
    const port = await attempt(0);
    if (!reserved.has(port) && (i >= EPHEMERAL_TRIES || (await freeOnV6Loopback(port)))) return port;
    await new Promise<void>((r) => server.close(() => r()));
    if (i >= RESERVED_TRIES) throw new Error(`no free port here that isn't reserved, after ${i} tries`);
  }
}

/**
 * Whether nothing listens on [::1]:`port`. Asked by binding it for a moment.
 * A computer without IPv6 has no [::1] for `localhost` to reach, so that
 * counts as free; only "in use" (or, on Windows, a reserved port) is taken.
 */
export function freeOnV6Loopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code !== "EADDRINUSE" && err.code !== "EACCES"));
    probe.listen({ port, host: "::1", ipv6Only: true, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/**
 * `ctx.runner.reservedPorts`, when this Dispatch has it (#517) and the
 * manifest declared `runner`. Looked up, not assumed: an older Dispatch has
 * no such member, and the defaults stand in.
 */
export function reservedPortsOf(ctx: unknown): (() => Promise<readonly ReservedPort[]>) | undefined {
  const runner = (ctx as { runner?: { reservedPorts?: unknown } } | undefined)?.runner;
  if (!runner || typeof runner.reservedPorts !== "function") return undefined;
  const view = runner as { reservedPorts(): Promise<readonly ReservedPort[]> };
  return () => view.reservedPorts();
}

function key(chat: string, port: number): string {
  return `${chat}\u0000${port}`;
}

function urlOf(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function validPort(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536;
}

/** dispatch-host reports a wildcard listener as 127.0.0.1; one bound to a LAN address only can't be dialled through the key. */
function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

/** The listener's program, as a label: a short name only, since the machine's account chooses what it is called. */
export function command(c: string | undefined): string | undefined {
  const name = (c ?? "").match(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}/)?.[0];
  // Node names its main thread, and Linux's lsof reports a process by that
  // thread's name (`comm`), so every Node server there would read "MainThread".
  return name === "MainThread" ? "node" : name;
}
