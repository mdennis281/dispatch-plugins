/**
 * Forward whatever a machine is listening on, while a chat has shells there.
 * Polled, because a dev server announces its port on its own schedule and the
 * agent should not have to ask.
 */
import type { SshConnection } from "../ssh/connection.js";

export interface PortWatchOptions {
  /** The chat's live connection, if it has one. */
  conn: () => SshConnection | undefined;
  /** Publish a forward (`ctx.terminals.publishPort`); returns its withdraw. */
  publish: (port: { remotePort: number; url: string }) => () => void;
  log: { info(msg: string): void; warn(msg: string): void };
  chatId: string;
  /** The machine, for log lines. */
  host: () => string;
  /** Lists TCP listeners; its output goes to `parse`. Default `ss -Htln`. */
  probe?: string;
  parse?: (out: string) => Map<number, string>;
  intervalMs?: number;
}

export class PortWatch {
  private timer?: ReturnType<typeof setInterval>;
  private readonly forwards = new Map<number, { close: () => void; withdraw: () => void }>();

  constructor(private readonly opts: PortWatchOptions) {}

  start(): void {
    if (this.timer) return;
    const { conn: connOf, publish, log, chatId } = this.opts;
    const probe = this.opts.probe ?? "ss -Htln 2>/dev/null";
    const parse = this.opts.parse ?? parseListeners;
    const tick = async () => {
      const conn = connOf();
      if (!conn?.isOpen) return;
      const r = await conn.exec(probe, { timeoutMs: 10_000 }).catch(() => undefined);
      if (!r || r.code !== 0) return;
      const ports = parse(r.stdout);
      for (const [port, host] of ports) {
        if (this.forwards.has(port)) continue;
        try {
          const fwd = await conn.forward(port, host);
          const withdraw = publish({ remotePort: port, url: `http://127.0.0.1:${fwd.localPort}` });
          this.forwards.set(port, { close: fwd.close, withdraw });
          log.info(`forwarding ${this.opts.host()}:${port} → 127.0.0.1:${fwd.localPort}`);
        } catch (err) {
          log.warn(`could not forward port ${port} for chat ${chatId}: ${String(err)}`);
        }
      }
      for (const [port, f] of this.forwards) {
        if (!ports.has(port)) {
          f.withdraw();
          f.close();
          this.forwards.delete(port);
        }
      }
    };
    this.timer = setInterval(() => void tick(), this.opts.intervalMs ?? 3_000);
    this.timer.unref?.();
    void tick();
  }

  /** Stop polling and withdraw every forward. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const f of this.forwards.values()) {
      f.withdraw();
      f.close();
    }
    this.forwards.clear();
  }
}

/**
 * Listening ports from `ss -Htln` → the address to dial ON the machine,
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
