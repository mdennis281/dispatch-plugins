/**
 * One SSH connection per machine (ssh2, pure JS — no `ssh.exe`, no OpenSSH
 * on the Windows host required). Everything rides it as separate channels:
 * each terminal's shell, every sync's upload, the port probe, and each
 * forwarded TCP connection.
 */
import { EventEmitter } from "node:events";
import { createServer, type AddressInfo, type Server } from "node:net";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { TerminalBackendHandle } from "@dispatch/plugin-sdk";
import { RemoteShell, remoteShellCommand } from "../shell/remote-shell.js";
import { trustProvisioner, type HostVerifier } from "./host-verifier.js";

export interface SshAuth {
  privateKey?: string;
  password?: string;
}

export interface SshTarget extends SshAuth {
  host: string;
  /** Default 22. */
  port?: number;
  username: string;
  /** Whether the key the host presents is the host we meant. Default {@link trustProvisioner}. */
  hostVerifier?: HostVerifier;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
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

  /** Connect, retrying while sshd comes up on a freshly started machine. */
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
        // Auth failures will not fix themselves by waiting, and a host key
        // the verifier refused means this address is some other machine.
        if (err instanceof Error && /authentication|host denied/i.test(err.message)) throw err;
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
        port: this.target.port ?? 22,
        username: this.target.username,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: toSsh2(this.target.hostVerifier ?? trustProvisioner()),
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

  /** Start a long-lived bash in `cwd` (see {@link remoteShellCommand}). */
  shell(cwd: string, env: Record<string, string>): Promise<TerminalBackendHandle> {
    const client = this.requireClient();
    const cmd = remoteShellCommand(cwd, env);
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
   * 127.0.0.1:<remotePort> on the machine. Resolves with the local port.
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
 * ssh2's verifier takes `(key, verify)` and accepts a boolean return; a
 * promise has to answer through `verify`. A verifier that throws or rejects
 * refuses the host.
 */
function toSsh2(verifier: HostVerifier): ConnectConfig["hostVerifier"] {
  return ((key: Buffer, verify: (ok: boolean) => void) => {
    let ret: boolean | Promise<boolean>;
    try {
      ret = verifier(key);
    } catch {
      return false;
    }
    if (typeof ret === "boolean") return ret;
    ret.then(verify, () => verify(false));
    return undefined;
  }) as ConnectConfig["hostVerifier"];
}
