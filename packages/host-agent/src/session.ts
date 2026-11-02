/**
 * One chat shell, as its owner process keeps it: the shell, its journal, the
 * client attached right now (if any), and the heartbeat watchdog.
 *
 * Pure logic over injected pieces (the shell process, the clock, the killer),
 * so it is tested with fakes; owner.ts wires it to a real bash and a socket.
 *
 * WHY THE SHELL'S STDIN IS OURS. The shell reads a pipe this process holds,
 * never the SSH channel. A connection that drops therefore doesn't EOF the shell, and
 * the shell doesn't exit. A background command, which core leaves reading the
 * shell's stdin so a watcher never sees EOF, keeps running too. A foreground
 * command reads /dev/null: core writes it as `eval '…' </dev/null`.
 */
import type { EventEmitter } from "node:events";
import { SentinelScanner, type RunEntry, type StreamLog } from "./journal.js";
import {
  F,
  PROTOCOL_VERSION,
  decodeJson,
  encodeFrame,
  encodeOutput,
  type AttachMsg,
  type ExitMsg,
  type ExitReason,
  type Frame,
  type ReadyMsg,
  type RunBeginMsg,
  type SignalMsg,
} from "./protocol.js";

/** The shell, as `child_process.spawn` returns it. */
export interface ShellProc extends EventEmitter {
  pid?: number;
  stdin: { write(data: Buffer): unknown; end(): unknown } | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
}

/** An attached client: the relay's end of the socket. */
export interface Client {
  write(data: Buffer): unknown;
  /** Bytes queued and not yet sent. */
  readonly writableLength: number;
  end(): void;
  destroy(): void;
}

export interface SessionDeps {
  sid: string;
  agentVersion: string;
  cwd: string;
  shell: ShellProc;
  out: StreamLog;
  err: StreamLog;
  journalRun(entry: RunEntry): void;
  /** Milliseconds on a MONOTONIC clock. Time asleep must not count against the heartbeat. */
  now(): number;
  /** Kill the session after this long without a frame from Dispatch. */
  heartbeatMs: number;
  /** Drop a client that has this much output queued. It re-attaches and replays. Default 8 MiB. */
  maxBacklog?: number;
  /** Kill the shell's whole tree. */
  killTree(): Promise<void>;
  /** Deliver a signal (a bare name: `INT`) to the session. */
  signal(name: string): Promise<void>;
  /** The session is over: persist it. Called once. */
  onExit(exit: ExitMsg): void;
  /** Dispatch was heard from (throttled by the caller). */
  onContact?(): void;
  log?(line: string): void;
}

/** Signals a client may ask for by name. Anything else is refused. */
const SIGNALS = new Set(["HUP", "INT", "QUIT", "KILL", "TERM", "USR1", "USR2", "STOP", "CONT", "TSTP", "WINCH"]);

export class Session {
  private client?: Client;
  private lastBeat: number;
  private activeRun?: string;
  private exitMsg?: ExitMsg;
  /** Why we are killing the shell, so its exit is reported as that and not as `exited`. */
  private ending?: { reason: ExitReason; detail?: string };
  private readonly scanner = new SentinelScanner();

  constructor(private readonly d: SessionDeps) {
    this.lastBeat = d.now();
    d.shell.stdout?.on("data", (c: Buffer) => this.output(F.stdout, c));
    d.shell.stderr?.on("data", (c: Buffer) => this.output(F.stderr, c));
    // `close`, not `exit`: it comes after the last stdout/stderr data.
    d.shell.on("close", (code: number | null, signal: NodeJS.Signals | null) => void this.shellEnded(code, signal));
    d.shell.on("error", (err: Error) => {
      this.ending ??= { reason: "start-failed", detail: err.message };
      void this.shellEnded(null, null);
    });
  }

  get exited(): ExitMsg | undefined {
    return this.exitMsg;
  }

  get hasClient(): boolean {
    return Boolean(this.client);
  }

  /**
   * A client connected and sent its ATTACH. A newer client replaces an older
   * one: the old one is a half-open connection Dispatch has already given up
   * on. It gets READY, then everything after its resume point, then live
   * output. That all happens in this one call, so no byte can fall between the
   * replay and the live stream.
   */
  attach(client: Client, msg: AttachMsg): void {
    if (this.client && this.client !== client) this.client.destroy();
    this.client = client;
    this.lastBeat = this.d.now();
    const from = msg.resume ?? { out: 0, err: 0 };
    const gap: ReadyMsg["gap"] = {};
    if (this.d.out.start > from.out) gap.out = this.d.out.start;
    if (this.d.err.start > from.err) gap.err = this.d.err.start;
    const ready: ReadyMsg = {
      v: PROTOCOL_VERSION,
      sid: this.d.sid,
      pid: this.d.shell.pid ?? 0,
      agentVersion: this.d.agentVersion,
      cwd: this.d.cwd,
      out: this.d.out.offset,
      err: this.d.err.offset,
      resumed: Boolean(msg.resume),
      ...(gap.out !== undefined || gap.err !== undefined ? { gap } : {}),
    };
    client.write(encodeFrame(F.ready, ready));
    for (const frame of replay(this.d.out, from.out, F.stdout)) client.write(frame);
    for (const frame of replay(this.d.err, from.err, F.stderr)) client.write(frame);
    if (this.exitMsg) {
      client.write(encodeFrame(F.exit, this.exitMsg));
      client.end();
      this.client = undefined;
    }
  }

  /** The client's socket closed. The shell keeps running until the heartbeat lapses. */
  detachClient(client: Client): void {
    if (this.client === client) this.client = undefined;
  }

  /** A frame from `client`. Frames from a client that has been replaced are ignored. */
  handle(client: Client, frame: Frame): void {
    if (client !== this.client) return;
    this.lastBeat = this.d.now();
    switch (frame.type) {
      case F.stdin:
        this.d.shell.stdin?.write(frame.payload);
        break;
      case F.stdinEnd:
        this.d.shell.stdin?.end();
        break;
      case F.heartbeat:
        client.write(encodeFrame(F.heartbeatAck));
        this.d.onContact?.();
        break;
      case F.signal: {
        const name = String(decodeJson<SignalMsg>(frame.payload).signal ?? "").toUpperCase().replace(/^SIG/, "");
        if (name === "KILL") void this.terminate("killed");
        else if (SIGNALS.has(name)) void this.d.signal(name).catch((e: unknown) => this.d.log?.(`signal ${name}: ${String(e)}`));
        break;
      }
      case F.runBegin: {
        const m = decodeJson<RunBeginMsg>(frame.payload);
        this.activeRun = String(m.runId);
        this.d.journalRun({
          t: "begin",
          runId: this.activeRun,
          background: Boolean(m.background),
          out: this.d.out.offset,
          err: this.d.err.offset,
          at: new Date().toISOString(),
        });
        break;
      }
      case F.detach:
        this.client = undefined;
        client.end();
        break;
      case F.kill:
        void this.terminate("killed");
        break;
      default:
        break; // unknown frames are ignored: a newer plugin may send more than this agent knows
    }
  }

  /** Run every second or so: kills the session once Dispatch has been silent past the heartbeat timeout. */
  tick(): void {
    if (this.exitMsg || this.ending) return;
    const silent = this.d.now() - this.lastBeat;
    if (silent > this.d.heartbeatMs) {
      void this.terminate("heartbeat", `no heartbeat for ${Math.round(silent / 1000)}s`);
    }
  }

  /** End the session for `reason`: kill the tree; the shell's close reports it. */
  async terminate(reason: ExitReason, detail?: string): Promise<void> {
    if (this.exitMsg || this.ending) return;
    this.ending = { reason, ...(detail ? { detail } : {}) };
    this.d.log?.(`ending session: ${reason}${detail ? ` (${detail})` : ""}`);
    await this.d.killTree().catch((e: unknown) => this.d.log?.(`kill: ${String(e)}`));
  }

  private output(type: number, data: Buffer): void {
    const log = type === F.stdout ? this.d.out : this.d.err;
    const offset = log.append(data);
    const ends = type === F.stdout ? this.scanner.push(data) : [];
    const c = this.client;
    if (c) {
      for (const frame of encodeOutput(type, offset, data)) c.write(frame);
    }
    for (const end of ends) {
      if (!this.activeRun) continue; // a run the plugin never announced
      const runId = this.activeRun;
      this.activeRun = undefined;
      this.d.journalRun({
        t: "end",
        runId,
        exitCode: end.exitCode,
        cwd: end.cwd,
        out: this.d.out.offset,
        err: this.d.err.offset,
        at: new Date().toISOString(),
      });
      c?.write(encodeFrame(F.runEnd, { runId, exitCode: end.exitCode, cwd: end.cwd }));
    }
    // A client this far behind is a stalled link. Let it go: the journal has
    // every byte, and it replays them when it comes back.
    if (c && c.writableLength > (this.d.maxBacklog ?? 8 * 1024 * 1024)) {
      this.d.log?.(`client ${c.writableLength} bytes behind; dropping it until it re-attaches`);
      this.client = undefined;
      c.destroy();
    }
  }

  private async shellEnded(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.exitMsg) return;
    // The shell is gone; whatever it left running in the background goes with it.
    if (!this.ending) await this.d.killTree().catch((e: unknown) => this.d.log?.(`kill: ${String(e)}`));
    if (this.exitMsg) return;
    const exit: ExitMsg = {
      code,
      signal: signal ?? null,
      reason: this.ending?.reason ?? "exited",
      ...(this.ending?.detail ? { detail: this.ending.detail } : {}),
    };
    this.exitMsg = exit;
    const c = this.client;
    if (c) {
      c.write(encodeFrame(F.exit, exit));
      c.end();
      this.client = undefined;
    }
    this.d.onExit(exit);
  }
}

/** Output frames for everything `log` holds from `from` on. */
export function* replay(log: StreamLog, from: number, type: number): Generator<Buffer> {
  for (const { offset, data } of log.read(from)) yield* encodeOutput(type, offset, data);
}
