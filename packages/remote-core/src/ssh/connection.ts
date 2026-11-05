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
import { RemoteShell, ShellStartError, remoteShellCommand } from "../shell/remote-shell.js";
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
  /**
   * What the two ends may negotiate. Pinning a host key needs
   * `{ serverHostKey: [<the pinned key's type>] }` as well: a host offers one
   * key per type, and which one it shows depends on what was negotiated.
   */
  algorithms?: ConnectConfig["algorithms"];
  /**
   * How quickly a silent connection is given up on: a keepalive every
   * `intervalMs`, dropped after `countMax` unanswered. Default 15 s × 4.
   */
  keepalive?: { intervalMs: number; countMax: number };
  /**
   * Dial a host NAME on this address family only. Unset: whichever the
   * resolver lists first, which for an mDNS name can be IPv6. Matters when
   * the key's `from=` list names only addresses of the other family: sshd
   * then refuses the key outright.
   */
  family?: 4 | 6;
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

  /**
   * One attempt, within ssh2's 10 s ready timeout. For a machine that is
   * either there or not: a refused or silent address is an answer, not a
   * reason to wait.
   */
  connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const cfg: ConnectConfig = {
        host: this.target.host,
        port: this.target.port ?? 22,
        username: this.target.username,
        readyTimeout: 10_000,
        keepaliveInterval: this.target.keepalive?.intervalMs ?? 15_000,
        keepaliveCountMax: this.target.keepalive?.countMax ?? 4,
        hostVerifier: toSsh2(this.target.hostVerifier ?? trustProvisioner()),
        ...(this.target.algorithms ? { algorithms: this.target.algorithms } : {}),
        ...(this.target.family === 4 ? { forceIPv4: true } : this.target.family === 6 ? { forceIPv6: true } : {}),
        ...(this.target.privateKey ? { privateKey: this.target.privateKey } : {}),
        // macOS's sshd asks for a password through keyboard-interactive (PAM)
        // as often as through `password`.
        ...(this.target.password ? { password: this.target.password, tryKeyboard: true } : {}),
      };
      const password = this.target.password;
      if (password) {
        client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
          // One hidden prompt is the password. Anything else (a second factor)
          // is not something a stored password can answer.
          finish(prompts.length === 1 && !prompts[0]!.echo ? [password] : []);
        });
      }
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
        // Bytes, decoded once at the end: a chunk may end mid-character.
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let code: number | null = null;
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              ch.close();
              reject(new Error(`remote command timed out after ${opts.timeoutMs}ms: ${command.slice(0, 80)}`));
            }, opts.timeoutMs)
          : undefined;
        ch.on("data", (c: Buffer) => stdout.push(c));
        ch.stderr.on("data", (c: Buffer) => stderr.push(c));
        ch.on("exit", (c: number | null) => (code = c));
        ch.on("close", () => {
          if (timer) clearTimeout(timer);
          resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
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

  /**
   * Start `command` and hand back its channel, still open, for an exchange
   * the caller drives itself (binary frames, say). {@link exec} would hold
   * every byte until the command ended.
   */
  channel(command: string): Promise<ClientChannel> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      client.exec(command, (err, ch) => (err ? reject(err) : resolve(ch)));
    });
  }

  /** `exec`, throwing on a non-zero exit with stderr in the message. */
  async run(command: string, timeoutMs = 120_000): Promise<string> {
    const r = await this.exec(command, { timeoutMs });
    if (r.code !== 0) throw new Error(`remote \`${command.slice(0, 80)}\` exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }

  /**
   * Start a long-lived bash in `cwd` (see {@link remoteShellCommand}).
   * Resolves once it runs there. REJECTS when `cwd` is missing, the shell
   * dies first, or it hasn't started within `startTimeoutMs`: a terminal that
   * can't start where it was asked starts nowhere.
   */
  shell(cwd: string, env: Record<string, string>, startTimeoutMs = 30_000): Promise<TerminalBackendHandle> {
    const client = this.requireClient();
    const cmd = remoteShellCommand(cwd, env);
    const host = this.target.host;
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, ch) => {
        if (err) return reject(err);
        const sh = new RemoteShell(ch, cwd, (pid, signal) => this.signalSession(pid, signal));
        const timer = setTimeout(() => {
          sh.kill();
          reject(new Error(`the shell on ${host} did not start within ${startTimeoutMs / 1000}s`));
        }, startTimeoutMs);
        sh.ready.then(
          () => {
            clearTimeout(timer);
            resolve(sh);
          },
          (e: unknown) => {
            clearTimeout(timer);
            sh.kill();
            reject(
              e instanceof ShellStartError && e.reason === "no-cwd"
                ? new Error(
                    `${cwd} does not exist on ${host}, so the terminal was not started (a directory that is empty ` +
                      `or git-ignored locally is not synced)`,
                  )
                : new Error(`the shell on ${host} ${e instanceof Error ? e.message.replace(/^the shell /, "") : String(e)}`),
            );
          },
        );
      });
    });
  }

  /** Send `signal` (a bare name from RemoteShell's allow-list) to every process in session `pid`. */
  private signalSession(pid: number, signal: string): void {
    if (!this.isOpen) return;
    void this.exec(`pkill -${signal} -s ${pid} 2>/dev/null; kill -${signal} ${pid} 2>/dev/null; true`, { timeoutMs: 10_000 }).catch(() => {});
  }

  /**
   * One TCP connection to `host:port` as the machine sees it (a `direct-tcpip`
   * channel). sshd counts these apart from `MaxSessions`, which limits shells
   * and execs only. Rejects when the connection is down or the machine refuses
   * (nothing listening, or a key whose `permitopen` doesn't cover it).
   */
  tcp(host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen || !this.client) return reject(new Error("not connected"));
      this.client.forwardOut("127.0.0.1", 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }

  /**
   * Listen on 127.0.0.1:<ephemeral> and pipe each connection to
   * 127.0.0.1:<remotePort> on the machine. Resolves with the local port.
   */
  forward(remotePort: number, remoteHost = "127.0.0.1"): Promise<{ localPort: number; close: () => void }> {
    return new Promise((resolve, reject) => {
      const server: Server = createServer((sock) => {
        if (!this.isOpen) return sock.destroy();
        this.tcp(remoteHost, remotePort).then(
          (stream) => {
            sock.pipe(stream).pipe(sock);
            sock.on("error", () => stream.close());
            stream.on("error", () => sock.destroy());
            stream.on("close", () => sock.destroy());
          },
          () => sock.destroy(),
        );
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
