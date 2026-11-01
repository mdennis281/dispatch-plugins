/**
 * A long-lived bash on an SSH exec channel, as the `TerminalBackendHandle`
 * Dispatch drives.
 */
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { ClientChannel } from "ssh2";
import type { TerminalBackendHandle } from "@dispatch/plugin-sdk";
import { sq } from "./quote.js";

/** How the start command exits when its directory is missing. */
export const NO_CWD_EXIT = 97;

/**
 * The command that starts the shell in `cwd`, or refuses to.
 *
 * It prints `DTPID:<pid>` once it is in `cwd`, so `kill()` can end its whole
 * session — the shell AND whatever it started — with `pkill -s`. sshd makes
 * the exec'd command a session leader, and `exec bash` keeps the pid, so the
 * session id is that pid.
 *
 * A missing `cwd` prints `DTERR:cwd` and exits, and nothing else runs. It
 * used to `cd ~` instead, and the agent's next command — `rm -rf build`, say
 * — ran in the home directory.
 */
export function remoteShellCommand(cwd: string, env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${sq(v)};`)
    .join(" ");
  return `${exports} cd ${sq(cwd)} 2>/dev/null || { echo "DTERR:cwd"; exit ${NO_CWD_EXIT}; }; echo "DTPID:$$"; exec bash --noprofile --norc`;
}

/** Signals `kill()` passes on by name. Anything else is KILL: the name goes into a remote command line. */
const SIGNALS = new Set(["HUP", "INT", "QUIT", "KILL", "TERM", "USR1", "USR2", "STOP", "CONT", "TSTP", "WINCH"]);

/** `"SIGTERM"`, `"term"` → `"TERM"`; undefined or unknown → `"KILL"`. */
export function signalName(signal?: string): string {
  const name = (signal ?? "").toUpperCase().replace(/^SIG/, "");
  return SIGNALS.has(name) ? name : "KILL";
}

/** Why a shell did not start. */
export class ShellStartError extends Error {
  constructor(
    readonly reason: "no-cwd" | "exited",
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ShellStartError";
  }
}

/**
 * An exec channel as a `TerminalBackendHandle`. Holds back stdout until the
 * start command's first line has been read, so Dispatch never sees it.
 */
export class RemoteShell extends EventEmitter implements TerminalBackendHandle {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: TerminalBackendHandle["stdin"];
  /**
   * Settles on the start command's first line: resolves once the shell runs
   * in `cwd`, rejects with a {@link ShellStartError} when it never will.
   */
  readonly ready: Promise<void>;
  private settle!: { resolve: () => void; reject: (err: ShellStartError) => void };
  private pid?: number;
  private head = "";
  private exited = false;
  /**
   * One decoder per stream: the channel hands over bytes in whatever pieces
   * the transport made, and a multi-byte character cut in two decoded as two
   * U+FFFD when each piece was decoded on its own.
   */
  private readonly outText = new StringDecoder("utf8");
  private readonly errText = new StringDecoder("utf8");

  constructor(
    private readonly ch: ClientChannel,
    readonly cwd: string,
    /** Send `signal` (a name like `TERM`) to every process in session `pid`. */
    private readonly killer: (pid: number, signal: string) => void,
  ) {
    super();
    this.ready = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    this.ready.catch(() => {}); // a caller that never awaits it must not crash the host
    this.stdin = {
      write: (chunk: string) => ch.write(chunk),
      end: () => ch.end(),
      on: (_e: "error", l: (err: Error) => void) => {
        ch.on("error", l);
      },
    };
    ch.on("data", (c: Buffer) => this.onStdout(this.outText.write(c)));
    ch.stderr.on("data", (c: Buffer) => this.onStderr(this.errText.write(c)));
    ch.on("exit", (code: number | null) => this.finish(code));
    ch.on("close", () => this.finish(null));
    ch.on("error", (err: Error) => this.emit("error", err));
  }

  private onStderr(text: string): void {
    if (text) this.stderr.emit("data", text);
  }

  private onStdout(text: string): void {
    if (!text) return;
    if (this.pid !== undefined) {
      this.stdout.emit("data", text);
      return;
    }
    this.head += text;
    const nl = this.head.indexOf("\n");
    if (nl < 0) return;
    const first = this.head.slice(0, nl);
    if (/DTERR:cwd/.test(first)) {
      this.pid = 0;
      this.head = "";
      this.settle.reject(new ShellStartError("no-cwd", null, `${this.cwd} does not exist`));
      return;
    }
    const m = first.match(/DTPID:(\d+)/);
    if (m) this.pid = Number(m[1]);
    else this.pid = 0;
    const rest = this.head.slice(m ? nl + 1 : 0);
    this.head = "";
    this.settle.resolve();
    if (rest) this.stdout.emit("data", rest);
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    // Whatever the decoders still hold (a character the shell never finished)
    // goes out before the exit, not after it.
    this.onStdout(this.outText.end());
    this.onStderr(this.errText.end());
    // A no-op once ready has settled.
    this.settle.reject(new ShellStartError("exited", code, `the shell exited before it started (exit ${code ?? "unknown"})`));
    this.emit("exit", code);
  }

  /**
   * No signal (core's teardown) or KILL: kill the shell's whole session,
   * close the channel and report the exit now. Any other signal is delivered
   * to the session and nothing more, as `ChildProcess.kill` does: the shell
   * may trap it or outlive it, and its exit is reported when it happens.
   */
  kill(signal?: string): void {
    const name = signalName(signal);
    if (this.pid) this.killer(this.pid, name);
    else if (name !== "KILL") {
      // No session id to signal (the start line never came): the SSH
      // channel's own signal request is all there is.
      try {
        this.ch.signal(name);
      } catch {
        /* closed, or the server does not take signal requests */
      }
    }
    if (name !== "KILL") return;
    try {
      this.ch.close();
    } catch {
      /* already closed */
    }
    this.finish(null);
  }
}
