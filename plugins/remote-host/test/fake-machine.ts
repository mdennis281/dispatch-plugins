/**
 * A scripted machine for HostLink: which addresses answer with its key, what
 * is installed, and every command run on it. Installs really consume their
 * stdin, so a test can check exactly what was sent.
 */
import { EventEmitter } from "node:events";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ClientChannel } from "ssh2";
import { nodeTarball, type Attribution, type ChatDir, type GuiInstallResult, type ProbeResult } from "@dispatch-plugins/host-agent";
import type { ExecResult, SshTarget } from "@dispatch-plugins/remote-core";
import type { AgentBundle, RuntimeSource } from "../src/agent.js";
import { sha256 } from "../src/agent.js";
import type { LinkConnection } from "../src/link.js";

export type AddressBehaviour = "ok" | "wrong-key" | "refused" | "timeout" | "bad-key";

export const PROBE: ProbeResult = {
  agentVersion: "0.1.0",
  node: "v24.22.2",
  platform: "darwin",
  arch: "arm64",
  os: { name: "macOS", version: "13.5", build: "22G74" },
  kernel: "Darwin 22.6.0",
  user: "dispatch",
  home: "/Users/dispatch",
  consoleUser: "nx",
  freeDiskBytes: 600 * 1024 ** 3,
  path: "/usr/bin:/bin",
  tools: { git: "2.39.2", node: null, pnpm: null, xcodebuild: "Xcode 14.3.1", xcodeFirstLaunchDone: true },
};

export const AGENT: AgentBundle = { version: "0.1.0", source: "// dispatch-host for tests\n", sha256: sha256("// dispatch-host for tests\n") };

export function fakeRuntime(): RuntimeSource & { calls: number; bytes: string } {
  const dir = mkdtempSync(join(tmpdir(), "rh-runtime-"));
  const path = join(dir, "node.tar.gz");
  writeFileSync(path, "NODE-TARBALL");
  const r = {
    calls: 0,
    bytes: "NODE-TARBALL",
    async tarball(platform: string, arch: string) {
      r.calls++;
      return { path, tarball: nodeTarball(platform, arch) };
    },
  };
  return r;
}

export class FakeMachine {
  node: string | undefined = "v24.22.2";
  agent: string | undefined = "0.1.0";
  probe: ProbeResult = { ...PROBE };
  /** What `dispatch-host ports` reports. */
  ports: Attribution = { sessions: [], unattributed: [] };
  /** What `dispatch-host chats` reports: this instance's chat directories there. */
  chatDirs: ChatDir[] = [];
  helloFails = false;
  /** What `gui install` answers; "fail" makes it exit 1. The probe carries `probe.gui` on its own. */
  gui: GuiInstallResult | "fail" = { state: "no-gui-session", user: "dispatch", consoleUser: "root", installed: true };
  guiInstalls = 0;
  /** What `forget` fails with, as dispatch-host does when git won't run there. */
  forgetFails?: string;
  /** sshd's MaxSessions. */
  maxSessions = 10;
  /** What `uname -s`, `uname -m` say, and the C library line (absent: an answer from before it was asked). */
  uname: { platform: string; arch: string; libc?: string } = { platform: "Darwin", arch: "arm64" };
  /** What a `tcp` channel reaches: a test points it at a server of its own. */
  tcp?: (host: string, port: number) => Promise<ClientChannel>;
  /** Holds a connect to an address until it resolves. */
  hold?: (address: string) => Promise<void>;
  /** What `hostname` says there. */
  hostname = "fake-host";
  /** `~/.dispatch-host/incarnation` there (a provisioned machine's token): absent until written. */
  incarnation?: string;
  /** Its host key, when a test pins one: a connect whose verifier refuses it fails as ssh2's does. */
  hostKey?: Buffer;
  readonly addresses: Record<string, AddressBehaviour>;
  readonly targets: SshTarget[] = [];
  readonly commands: string[] = [];
  readonly stdin: Array<{ command: string; data: string }> = [];
  readonly conns: FakeConn[] = [];

  constructor(addresses: Record<string, AddressBehaviour>) {
    this.addresses = addresses;
  }

  connect = (target: SshTarget): LinkConnection => {
    this.targets.push(target);
    const c = new FakeConn(this, target);
    this.conns.push(c);
    return c;
  };

  async run(command: string, opts: { stdin?: (ch: ClientChannel) => Promise<void> } = {}): Promise<ExecResult> {
    this.commands.push(command);
    let data = "";
    if (opts.stdin) {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await opts.stdin(sink as unknown as ClientChannel);
      await new Promise<void>((r) => (sink.writableFinished ? r() : sink.on("finish", () => r())));
      data = Buffer.concat(chunks).toString("utf8");
      this.stdin.push({ command, data });
    }
    const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
    if (command.includes("incarnation-none")) {
      return ok(`host=${this.hostname}\n${this.incarnation !== undefined ? `incarnation=${this.incarnation}` : "incarnation-none"}\n`);
    }
    if (command.includes("set -C")) {
      if (this.incarnation !== undefined) return { code: 1, stdout: "", stderr: "cannot overwrite existing file\n" };
      // The token as the script quotes it, inside the script's own quoting: '\''<machine> <token>'\''.
      const m = command.match(/'\\''(\S+) ([0-9a-f]{32})'\\''/);
      this.incarnation = m ? `${m[1]} ${m[2]}` : "?";
      return ok("");
    }
    if (command.includes("uname -s")) {
      const u = this.uname;
      return ok(`/Users/dispatch\n${u.platform}\n${u.arch}\n${this.node ?? "none"}\n${this.node && this.agent ? this.agent : "none"}\n${u.libc ? `${u.libc}\n` : ""}`);
    }
    if (command.includes("unpacked node is not")) {
      this.node = "v24.22.2";
      return ok("installed v24.22.2\n");
    }
    if (command.includes("agent checksum mismatch")) {
      this.agent = AGENT.version;
      return ok("installed\n");
    }
    if (/dispatch-host.mjs' '?version'?$/.test(command)) return ok(`${this.agent}\n`);
    if (command.includes("'sweep'")) return ok(JSON.stringify({ reaped: [], deadMan: [], removed: [] }) + "\n");
    if (command.includes("'hello'")) {
      if (this.helloFails) return { code: 1, stdout: "", stderr: "boom" };
      return ok(JSON.stringify({ agentVersion: "0.1.0" }) + "\n");
    }
    if (command.includes("'gui' 'install'")) {
      this.guiInstalls++;
      if (this.gui === "fail") return { code: 1, stdout: "", stderr: 'dispatch-host: unknown command "gui"' };
      return ok(JSON.stringify(this.gui) + "\n");
    }
    if (command.includes("'probe'")) return ok(JSON.stringify(this.probe) + "\n");
    if (command.includes("'kill'")) return ok(JSON.stringify({ killed: [] }) + "\n");
    if (command.includes("'ports'")) return ok(JSON.stringify(this.ports) + "\n");
    if (command.includes("'chats'")) return ok(JSON.stringify(this.chatDirs) + "\n");
    if (command.includes("'forget'")) {
      if (this.forgetFails) {
        const out = JSON.stringify({ killed: [], sessions: 0, refs: 0, removed: true, errors: [this.forgetFails] }) + "\n";
        return { code: 1, stdout: out, stderr: `dispatch-host: could not delete chat's refs: ${this.forgetFails}\n` };
      }
      return ok(JSON.stringify({ killed: [], sessions: 0, refs: 0, removed: true }) + "\n");
    }
    if (command.includes("'gc'")) return ok(JSON.stringify({ trash: 0, reposRemoved: [], repos: 0, checkouts: 0, errors: [] }) + "\n");
    return ok("");
  }

  /** Every connection that is still open. */
  open(): FakeConn[] {
    return this.conns.filter((c) => c.isOpen);
  }
}

/** A session channel on the fake machine: it only opens and closes. */
export class FakeSessionChannel extends EventEmitter {
  closed = false;

  constructor(readonly command: string) {
    super();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

export class FakeConn extends EventEmitter implements LinkConnection {
  isOpen = false;
  readonly channels: FakeSessionChannel[] = [];

  constructor(
    private readonly m: FakeMachine,
    readonly target: SshTarget,
  ) {
    super();
  }

  /** Channels open on this connection now, exec'd commands aside. */
  live(): number {
    return this.channels.filter((c) => !c.closed).length;
  }

  async connectOnce(): Promise<void> {
    await this.m.hold?.(this.target.host);
    const b = this.m.addresses[this.target.host] ?? "timeout";
    if (b === "wrong-key") throw new Error("Host denied (verification failed)");
    if (b === "refused") throw new Error(`connect ECONNREFUSED ${this.target.host}:22`);
    if (b === "timeout") throw new Error("Timed out while waiting for handshake");
    if (b === "bad-key") throw new Error("All configured authentication methods failed");
    if (this.m.hostKey && this.target.hostVerifier && !(await this.target.hostVerifier(this.m.hostKey))) {
      throw new Error("Host denied (verification failed)");
    }
    this.isOpen = true;
  }

  connect(): Promise<void> {
    return this.connectOnce();
  }

  /** Execs running now, and the most there ever were at once. */
  running = 0;
  peak = 0;

  async exec(command: string, opts: { stdin?: (ch: ClientChannel) => Promise<void>; timeoutMs?: number } = {}): Promise<ExecResult> {
    if (!this.isOpen) throw new Error("closed");
    if (this.live() + this.running >= this.m.maxSessions) throw new Error("(SSH) Channel open failure: open failed");
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    try {
      // A command takes a moment, so a burst of them overlaps as it would.
      await new Promise((r) => setTimeout(r, 1));
      return await this.m.run(command, opts);
    } finally {
      this.running--;
    }
  }

  /** Like sshd: at most `maxSessions` at once on one connection. */
  async channel(command: string): Promise<ClientChannel> {
    if (!this.isOpen) throw new Error("closed");
    if (this.live() >= this.m.maxSessions) throw new Error("(SSH) Channel open failure: open failed");
    const ch = new FakeSessionChannel(command);
    this.channels.push(ch);
    return ch as unknown as ClientChannel;
  }

  /** Dials `tcp` on the machine; a test sets it to reach a server it runs. Default: nothing listens. */
  async tcp(host: string, port: number): Promise<ClientChannel> {
    if (!this.isOpen) throw new Error("closed");
    if (!this.m.tcp) throw new Error(`(SSH) Channel open failure: connect failed (${host}:${port})`);
    return this.m.tcp(host, port);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const ch of this.channels) ch.close();
    this.emit("close");
  }
}
