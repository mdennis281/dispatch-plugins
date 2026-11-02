/**
 * One chat shell on a machine, as the `TerminalBackendHandle` core drives:
 * the plugin's half of dispatch-host's framed protocol (host-agent's
 * protocol.ts).
 *
 * The shell lives in a supervisor on the machine, not in the SSH channel. So
 * when the channel drops, the shell keeps running, and this handle says
 * `stalled` (core pauses the command's timeout) and re-attaches. It asks for
 * the output from the last byte it got, and the supervisor replays it from its
 * journal. The command in flight carries on and its result arrives intact.
 * Only a drop that outlasts {@link HostShellOptions.giveUpMs}, or a session
 * the machine no longer has, ends the shell as `transport-lost`.
 */
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { PluginLog, TerminalBackendHandle, TerminalExitReason } from "@dispatch/plugin-sdk";
import {
  F,
  FrameDecoder,
  MAX_FRAME,
  decodeJson,
  decodeOutput,
  encodeFrame,
  type ErrorMsg,
  type ExitMsg,
  type Frame,
  type ReadyMsg,
  type RunEndMsg,
} from "@dispatch-plugins/host-agent";
import { signalName } from "@dispatch-plugins/remote-core";

/** The part of an ssh2 exec channel the session uses. */
export interface SessionChannel {
  write(data: Buffer): unknown;
  end(): unknown;
  close?(): unknown;
  on(event: "data", listener: (data: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  stderr: { on(event: "data", listener: (data: Buffer) => void): unknown };
}

export interface SessionOpener {
  /** A channel running `dispatch-host session` for this session. `resume` re-attaches from those offsets. */
  open(resume?: { out: number; err: number }): Promise<SessionChannel>;
  /** Best effort, when there is no channel to send KILL down: end the session from outside. */
  killDetached?(): void;
}

export interface HostShellOptions {
  /** The machine's name, for messages. */
  label: string;
  log?: PluginLog;
  /** How often to tell the supervisor Dispatch is still here. Its own timeout is 60 s. */
  heartbeatMs?: number;
  /** Silence after which the shell is reported stalled. */
  stallAfterMs?: number;
  /** How long to keep trying to re-attach before ending the shell. Core pauses a command for at most 10 min. */
  giveUpMs?: number;
  /** Delays between re-attach attempts; the last repeats. */
  retryMs?: readonly number[];
  /** Most input held while detached; more ends the shell rather than lose some of it. */
  maxQueuedBytes?: number;
  now?: () => number;
}

type Phase = "starting" | "attached" | "detached" | "exited";
type Stream = "out" | "err";

export class HostShell extends EventEmitter implements TerminalBackendHandle {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: TerminalBackendHandle["stdin"];
  /** The shell's working directory on the machine, once it has started. */
  cwd?: string;

  private phase: Phase = "starting";
  private ch?: SessionChannel;
  private readonly got: Record<Stream, number> = { out: 0, err: 0 };
  private readonly text: Record<Stream, StringDecoder> = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
  private queue: Buffer[] = [];
  private queued = 0;
  private stalled = false;
  private lastFrameAt: number;
  private detachedAt?: number;
  private attempts = 0;
  private heartbeat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private relayErr = "";
  private starting?: { resolve: () => void; reject: (e: Error) => void };
  private readonly o: Required<Omit<HostShellOptions, "log">> & { log?: PluginLog };

  private constructor(
    private readonly opener: SessionOpener,
    opts: HostShellOptions,
  ) {
    super();
    this.o = {
      heartbeatMs: 10_000,
      stallAfterMs: 30_000,
      giveUpMs: 10 * 60_000,
      retryMs: [1_000, 2_000, 5_000, 10_000],
      maxQueuedBytes: 4 * 1024 * 1024,
      now: () => performance.now(),
      ...opts,
    };
    this.lastFrameAt = this.o.now();
    this.stdin = {
      write: (chunk: string) => {
        const data = Buffer.from(chunk, "utf8");
        for (let at = 0; at < data.length; at += MAX_FRAME) this.send(encodeFrame(F.stdin, data.subarray(at, at + MAX_FRAME)));
        return true;
      },
      end: () => this.send(encodeFrame(F.stdinEnd)),
      on: () => undefined, // input never errors here: a dead link is a stall, then an exit
    };
  }

  /** Start a session; resolves once the shell runs on the machine. */
  static async start(opener: SessionOpener, opts: HostShellOptions, signal?: AbortSignal): Promise<HostShell> {
    const sh = new HostShell(opener, opts);
    const started = new Promise<void>((resolve, reject) => (sh.starting = { resolve, reject }));
    const onAbort = () => sh.abortStart();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) throw new Error("cancelled");
      sh.wire(await opener.open());
      await started;
      return sh;
    } catch (err) {
      sh.abortStart();
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Tell the supervisor a command is about to be written, so its journal can mark the run. */
  runBegin(runId: string, background: boolean): void {
    if (this.phase !== "exited") this.send(encodeFrame(F.runBegin, { runId, background }));
  }

  /**
   * No signal (core's teardown) or KILL: end the session and everything it
   * started, and report the exit now. Any other signal is delivered to the
   * session's foreground, and its exit (if any) is reported when it comes.
   */
  kill(signal?: string): void {
    if (this.phase === "exited") return;
    const name = signalName(signal);
    if (name !== "KILL") {
      this.send(encodeFrame(F.signal, { signal: name }));
      return;
    }
    const ch = this.ch;
    if (ch && this.phase === "attached") {
      // Let the channel finish on its own: closing it now could drop the
      // KILL before it is flushed. Its 'close' is ignored once it isn't ours.
      this.ch = undefined;
      try {
        ch.write(encodeFrame(F.kill));
        ch.end();
      } catch {
        this.opener.killDetached?.();
      }
    } else {
      this.closeChannel();
      this.opener.killDetached?.();
    }
    this.exit(null, { kind: "killed", detail: "stopped by Dispatch" });
  }

  private abortStart(): void {
    if (this.phase !== "starting") return;
    this.phase = "exited";
    this.closeChannel();
    this.opener.killDetached?.();
    this.settleStart(new Error("cancelled"));
  }

  private settleStart(err?: Error): void {
    const s = this.starting;
    this.starting = undefined;
    if (!s) return;
    if (err) s.reject(err);
    else s.resolve();
  }

  private send(frame: Buffer): void {
    if (this.phase === "exited") return;
    if (this.phase === "attached" && this.ch) {
      this.ch.write(frame);
      return;
    }
    this.queue.push(frame);
    this.queued += frame.length;
    if (this.queued > this.o.maxQueuedBytes) {
      this.exit(null, {
        kind: "transport-lost",
        detail: `more than ${Math.round(this.o.maxQueuedBytes / 1048576)} MB of input queued while ${this.o.label} was unreachable`,
      });
    }
  }

  private wire(ch: SessionChannel): void {
    this.ch = ch;
    this.relayErr = "";
    const decoder = new FrameDecoder();
    ch.on("data", (data: Buffer) => {
      if (this.ch !== ch) return;
      let frames: Frame[];
      try {
        frames = decoder.push(data);
      } catch (err) {
        this.o.log?.warn(`remote-host ${this.o.label}: unreadable session stream (${String(err)}); re-attaching`);
        this.closeChannel();
        this.channelLost(ch);
        return;
      }
      this.lastFrameAt = this.o.now();
      // Quiet, not gone: a stall from unanswered heartbeats ends with the next frame.
      if (this.stalled && this.phase === "attached") {
        this.stalled = false;
        this.emit("resumed");
      }
      for (const f of frames) {
        if (this.ch !== ch) break;
        this.frame(ch, f);
      }
    });
    ch.stderr.on("data", (d: Buffer) => {
      this.relayErr = (this.relayErr + d.toString("utf8")).slice(-2_000);
    });
    ch.on("error", () => {
      /* 'close' follows */
    });
    ch.on("close", () => this.channelLost(ch));
  }

  private frame(ch: SessionChannel, f: Frame): void {
    switch (f.type) {
      case F.ready:
        return this.ready(decodeJson<ReadyMsg>(f.payload));
      case F.stdout:
      case F.stderr: {
        const { offset, data } = decodeOutput(f.payload);
        return this.output(f.type === F.stdout ? "out" : "err", offset, data);
      }
      case F.exit:
        return this.remoteExit(ch, decodeJson<ExitMsg>(f.payload));
      case F.error:
        return this.remoteError(ch, decodeJson<ErrorMsg>(f.payload));
      case F.runEnd:
        this.emit("runEnd", decodeJson<RunEndMsg>(f.payload));
        return;
      default:
        return; // heartbeat acks; anything newer than this plugin knows
    }
  }

  private ready(m: ReadyMsg): void {
    if (this.phase === "exited") return;
    this.cwd = m.cwd;
    this.phase = "attached";
    this.detachedAt = undefined;
    this.attempts = 0;
    const queue = this.queue;
    this.queue = [];
    this.queued = 0;
    for (const frame of queue) this.ch?.write(frame);
    this.startHeartbeat();
    if (this.starting) this.settleStart();
    if (this.stalled) {
      this.stalled = false;
      this.emit("resumed");
    }
  }

  private output(stream: Stream, offset: number, data: Buffer): void {
    const have = this.got[stream];
    if (offset + data.length <= have) return; // replayed bytes we already passed on
    const from = Math.max(offset, have);
    // The journal no longer held them (it rotated while Dispatch was away).
    if (offset > have) this.notice(`${offset - have} bytes of output were lost while Dispatch was disconnected.`);
    this.got[stream] = offset + data.length;
    const text = this.text[stream].write(data.subarray(from - offset));
    if (text) (stream === "out" ? this.stdout : this.stderr).emit("data", text);
  }

  private notice(line: string): void {
    this.stderr.emit("data", `\n[remote-host] ${line}\n`);
  }

  private remoteExit(ch: SessionChannel, m: ExitMsg): void {
    if (this.ch === ch) this.closeChannel();
    const label = this.o.label;
    const reason: TerminalExitReason =
      m.reason === "exited"
        ? { kind: "exited" }
        : m.reason === "heartbeat"
          ? { kind: "killed", detail: `${label} ended it: Dispatch's heartbeat stopped arriving` }
          : m.reason === "dead-man"
            ? { kind: "killed", detail: `${label}'s dead-man switch ended it (no contact from Dispatch for hours)` }
            : m.reason === "start-failed"
              ? { kind: "exited", detail: m.detail ?? "the shell could not start" }
              : { kind: "killed", detail: m.detail ?? "stopped" };
    if (this.phase === "starting") {
      this.phase = "exited";
      this.settleStart(new Error(`the shell on ${label} did not start: ${m.detail ?? m.reason}`));
      return;
    }
    this.exit(m.code, reason);
  }

  private remoteError(ch: SessionChannel, m: ErrorMsg): void {
    if (this.ch === ch) this.closeChannel();
    const label = this.o.label;
    if (this.phase === "starting") {
      this.phase = "exited";
      this.settleStart(
        new Error(
          m.code === "no-cwd"
            ? `the shell's directory does not exist on ${label}, so it was not started: ${m.message}`
            : `dispatch-host on ${label} refused the session (${m.code}): ${m.message}`,
        ),
      );
      return;
    }
    this.exit(null, {
      kind: "transport-lost",
      detail:
        m.code === "gone"
          ? `the session was gone from ${label} when Dispatch reconnected`
          : `re-attaching on ${label} failed (${m.code}): ${m.message}`,
    });
  }

  /** The channel closed. Before READY that is a failed start; after it, a drop to recover from. */
  private channelLost(ch: SessionChannel): void {
    if (this.ch !== ch) return;
    this.ch = undefined;
    this.stopHeartbeat();
    if (this.phase === "exited") return;
    if (this.phase === "starting") {
      this.phase = "exited";
      const why = this.relayErr.trim();
      this.settleStart(new Error(`dispatch-host on ${this.o.label} ended before the shell started${why ? `: ${why}` : ""}`));
      return;
    }
    this.phase = "detached";
    this.detachedAt ??= this.o.now();
    this.stall(`lost the connection to ${this.o.label}; reconnecting`);
    this.scheduleReattach();
  }

  private stall(detail: string): void {
    if (this.stalled) return;
    this.stalled = true;
    this.emit("stalled", { detail });
  }

  private scheduleReattach(): void {
    if (this.phase !== "detached" || this.retry) return;
    const away = this.o.now() - (this.detachedAt ?? this.o.now());
    if (away >= this.o.giveUpMs) {
      this.exit(null, {
        kind: "transport-lost",
        detail: `no connection to ${this.o.label} for ${Math.round(away / 60_000)} min; the command may still have run there`,
      });
      return;
    }
    const delays = this.o.retryMs;
    const wait = delays[Math.min(this.attempts, delays.length - 1)] ?? 5_000;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.reattach();
    }, wait);
    this.retry.unref?.();
  }

  private async reattach(): Promise<void> {
    if (this.phase !== "detached") return;
    this.attempts++;
    let ch: SessionChannel;
    try {
      ch = await this.opener.open({ out: this.got.out, err: this.got.err });
    } catch (err) {
      this.o.log?.info(`remote-host ${this.o.label}: re-attach attempt ${this.attempts} failed: ${(err as Error).message}`);
      this.scheduleReattach();
      return;
    }
    if (this.phase !== "detached") {
      try {
        ch.close?.();
      } catch {
        /* gone */
      }
      return;
    }
    this.wire(ch);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.phase !== "attached" || !this.ch) return;
      try {
        this.ch.write(encodeFrame(F.heartbeat));
      } catch {
        /* 'close' will report it */
      }
      const silent = this.o.now() - this.lastFrameAt;
      if (silent > this.o.stallAfterMs) this.stall(`no answer from ${this.o.label} for ${Math.round(silent / 1000)} s`);
    }, this.o.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private closeChannel(): void {
    const ch = this.ch;
    this.ch = undefined;
    this.stopHeartbeat();
    if (!ch) return;
    try {
      ch.close?.();
    } catch {
      /* already closed */
    }
  }

  private exit(code: number | null, reason: TerminalExitReason): void {
    if (this.phase === "exited") return;
    this.phase = "exited";
    this.closeChannel();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.queue = [];
    this.queued = 0;
    for (const stream of ["out", "err"] as const) {
      const rest = this.text[stream].end();
      if (rest) (stream === "out" ? this.stdout : this.stderr).emit("data", rest);
    }
    this.emit("exit", code, reason);
  }
}
