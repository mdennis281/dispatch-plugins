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
import { nodeTarball, type ProbeResult } from "@dispatch-plugins/host-agent";
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
  helloFails = false;
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
    if (command.includes("uname -s")) return ok(`/Users/dispatch\nDarwin\narm64\n${this.node ?? "none"}\n${this.node && this.agent ? this.agent : "none"}\n`);
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
    if (command.includes("'probe'")) return ok(JSON.stringify(this.probe) + "\n");
    if (command.includes("'kill'")) return ok(JSON.stringify({ killed: [] }) + "\n");
    return ok("");
  }

  /** Every connection that is still open. */
  open(): FakeConn[] {
    return this.conns.filter((c) => c.isOpen);
  }
}

export class FakeConn extends EventEmitter implements LinkConnection {
  isOpen = false;

  constructor(
    private readonly m: FakeMachine,
    readonly target: SshTarget,
  ) {
    super();
  }

  async connectOnce(): Promise<void> {
    const b = this.m.addresses[this.target.host] ?? "timeout";
    if (b === "wrong-key") throw new Error("Host denied (verification failed)");
    if (b === "refused") throw new Error(`connect ECONNREFUSED ${this.target.host}:22`);
    if (b === "timeout") throw new Error("Timed out while waiting for handshake");
    if (b === "bad-key") throw new Error("All configured authentication methods failed");
    this.isOpen = true;
  }

  connect(): Promise<void> {
    return this.connectOnce();
  }

  exec(command: string, opts: { stdin?: (ch: ClientChannel) => Promise<void>; timeoutMs?: number } = {}): Promise<ExecResult> {
    if (!this.isOpen) return Promise.reject(new Error("closed"));
    return this.m.run(command, opts);
  }

  channel(): Promise<ClientChannel> {
    return Promise.reject(new Error("no channels in this fake"));
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.emit("close");
  }
}
