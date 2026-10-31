/**
 * One SSH connection per container (ssh2, pure JS — no `ssh.exe`, no OpenSSH
 * on the Windows host required). Everything rides it as separate channels:
 * each terminal's shell, every sync's upload, the port probe, and each
 * forwarded TCP connection.
 */
import { EventEmitter } from "node:events";
import { createServer, type AddressInfo, type Server } from "node:net";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { TerminalBackendHandle } from "@dispatch/plugin-sdk";

export interface SshTarget {
  host: string;
  username: string;
  privateKey?: string;
  password?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Quote one argument for a POSIX shell. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class SshConnection extends EventEmitter {
  private client?: Client;
  private closed = false;

  constructor(readonly target: SshTarget) {
    super();
  }

  get isOpen(): boolean {
    return Boolean(this.client) && !this.closed;
  }

  /** Connect, retrying while sshd comes up in a freshly started container. */
  async connect(deadlineMs: number, signal?: AbortSignal): Promise<void> {
    const until = Date.now() + deadlineMs;
    let last: unknown;
    while (Date.now() < until) {
      if (signal?.aborted) throw new Error("cancelled");
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        last = err;
        // Auth failures will not fix themselves by waiting.
        if (err instanceof Error && /authentication/i.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
    throw new Error(`SSH to ${this.target.host} failed: ${last instanceof Error ? last.message : String(last)}`);
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const cfg: ConnectConfig = {
        host: this.target.host,
        port: 22,
        username: this.target.username,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        // Every container is a fresh linked clone of one template, so they all
        // present the template's host key and an address DHCP may have handed
        // to another clone yesterday. There is no stable identity to pin; the
        // trust anchor is that this plugin created the container a moment ago
        // through the authenticated Proxmox API and asked it for its address.
        hostVerifier: () => true,
        ...(this.target.privateKey ? { privateKey: this.target.privateKey } : {}),
        ...(this.target.password ? { password: this.target.password } : {}),
      };
      client
        .once("ready", () => {
          this.client = client;
          this.closed = false;
          client.on("close", () => {
            this.closed = true;
            this.emit("close");
          });
          client.on("error", () => {
            /* surfaced through 'close'; an unlistened 'error' would crash the host */
          });
          resolve();
        })
        .once("error", (err) => {
          client.end();
          reject(err);
        })
        .connect(cfg);
    });
  }

  private requireClient(): Client {
    if (!this.client || this.closed) throw new Error(`SSH connection to ${this.target.host} is closed`);
    return this.client;
  }

  /** Run a command to completion; optionally feed it stdin. */
  exec(command: string, opts: { stdin?: (ch: ClientChannel) => Promise<void>; timeoutMs?: number } = {}): Promise<ExecResult> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      client.exec(command, (err, ch) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let code: number | null = null;
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              ch.close();
              reject(new Error(`remote command timed out after ${opts.timeoutMs}ms: ${command.slice(0, 80)}`));
            }, opts.timeoutMs)
          : undefined;
        ch.on("data", (c: Buffer) => (stdout += c.toString()));
        ch.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
        ch.on("exit", (c: number | null) => (code = c));
        ch.on("close", () => {
          if (timer) clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        if (opts.stdin) {
          opts.stdin(ch).catch((e: unknown) => {
            ch.close();
            reject(e);
          });
        } else {
          ch.end();
        }
      });
    });
  }

  /** `exec`, throwing on a non-zero exit with stderr in the message. */
  async run(command: string, timeoutMs = 120_000): Promise<string> {
    const r = await this.exec(command, { timeoutMs });
    if (r.code !== 0) throw new Error(`remote \`${command.slice(0, 80)}\` exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }

  /**
   * Start a long-lived bash on an exec channel and adapt it to the handle
   * Dispatch drives. The shell prints `DTPID:<pid>` first so `kill()` can end
   * its whole session — the shell AND whatever it started — with `pkill -s`.
   * sshd makes the exec'd command a session leader, and `exec bash` keeps the
   * pid, so the session id is that pid.
   */
  shell(cwd: string, env: Record<string, string>): Promise<TerminalBackendHandle> {
    const client = this.requireClient();
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${sq(v)};`)
      .join(" ");
    const cmd = `echo "DTPID:$$"; ${exports} cd ${sq(cwd)} 2>/dev/null || cd ~; exec bash --noprofile --norc`;
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, ch) => {
        if (err) return reject(err);
        resolve(new RemoteShell(ch, cwd, (pid) => this.killSession(pid)));
      });
    });
  }

  private killSession(pid: number): void {
    if (!this.isOpen) return;
    void this.exec(`pkill -KILL -s ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`, { timeoutMs: 10_000 }).catch(() => {});
  }

  /**
   * Listen on 127.0.0.1:<ephemeral> and pipe each connection to
   * 127.0.0.1:<remotePort> inside the container. Resolves with the local port.
   */
  forward(remotePort: number, remoteHost = "127.0.0.1"): Promise<{ localPort: number; close: () => void }> {
    return new Promise((resolve, reject) => {
      const server: Server = createServer((sock) => {
        if (!this.isOpen) return sock.destroy();
        this.client!.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (err, stream) => {
          if (err) return sock.destroy();
          sock.pipe(stream).pipe(sock);
          sock.on("error", () => stream.close());
          stream.on("error", () => sock.destroy());
          stream.on("close", () => sock.destroy());
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ localPort: port, close: () => server.close() });
      });
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.client?.end();
    } catch {
      /* already gone */
    }
  }
}

/**
 * An exec channel as a `TerminalBackendHandle`. Holds back stdout until the
 * `DTPID:` line has been read, so Dispatch never sees it.
 */
class RemoteShell extends EventEmitter implements TerminalBackendHandle {
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
