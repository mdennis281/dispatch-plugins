/**
 * A long-lived bash on an SSH exec channel, as the `TerminalBackendHandle`
 * Dispatch drives.
 */
import { EventEmitter } from "node:events";
import type { ClientChannel } from "ssh2";
import type { TerminalBackendHandle } from "@dispatch/plugin-sdk";
import { sq } from "./quote.js";

/**
 * The command that starts the shell. It prints `DTPID:<pid>` first so `kill()`
 * can end its whole session — the shell AND whatever it started — with
 * `pkill -s`. sshd makes the exec'd command a session leader, and `exec bash`
 * keeps the pid, so the session id is that pid.
 */
export function remoteShellCommand(cwd: string, env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${sq(v)};`)
    .join(" ");
  return `echo "DTPID:$$"; ${exports} cd ${sq(cwd)} 2>/dev/null || cd ~; exec bash --noprofile --norc`;
}

/**
 * An exec channel as a `TerminalBackendHandle`. Holds back stdout until the
 * `DTPID:` line has been read, so Dispatch never sees it.
 */
export class RemoteShell extends EventEmitter implements TerminalBackendHandle {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: TerminalBackendHandle["stdin"];
  private pid?: number;
  private head = "";
  private exited = false;

  constructor(
    private readonly ch: ClientChannel,
    readonly cwd: string,
    private readonly killer: (pid: number) => void,
  ) {
    super();
    this.stdin = {
      write: (chunk: string) => ch.write(chunk),
      end: () => ch.end(),
      on: (_e: "error", l: (err: Error) => void) => {
        ch.on("error", l);
      },
    };
    ch.on("data", (c: Buffer) => this.onStdout(c.toString()));
    ch.stderr.on("data", (c: Buffer) => this.stderr.emit("data", c.toString()));
    ch.on("exit", (code: number | null) => this.finish(code));
    ch.on("close", () => this.finish(null));
    ch.on("error", (err: Error) => this.emit("error", err));
  }

  private onStdout(text: string): void {
    if (this.pid !== undefined) {
      this.stdout.emit("data", text);
      return;
    }
    this.head += text;
    const nl = this.head.indexOf("\n");
    if (nl < 0) return;
    const m = this.head.slice(0, nl).match(/DTPID:(\d+)/);
    if (m) this.pid = Number(m[1]);
    else this.pid = 0;
    const rest = this.head.slice(m ? nl + 1 : 0);
    this.head = "";
    if (rest) this.stdout.emit("data", rest);
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }

  kill(): void {
    if (this.pid) this.killer(this.pid);
    try {
      this.ch.close();
    } catch {
      /* already closed */
    }
    this.finish(null);
  }
}
