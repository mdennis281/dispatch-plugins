/**
 * The whole chain against a REAL OpenSSH sshd, logged in as the user it runs
 * as. CI's Debian 12 job runs it as root, which is how a provisioned Linux
 * box (a Proxmox container) is reached: sshd on 127.0.0.1:22, root's key in
 * its authorized_keys, the host key pinned. Elsewhere it is skipped. The
 * in-process server's end-to-end test (e2e.posix.test.ts) covers the rest.
 *
 * The job sets:
 * - REMOTE_HOST_SSHD_KEY: a private key file sshd takes for this user;
 * - REMOTE_HOST_SSHD_HOST_KEY: sshd's ed25519 host key fingerprint (SHA256:…);
 * - REMOTE_HOST_SSHD_PORTS: what should find listeners there (`ss`);
 * - REMOTE_HOST_SSHD_PORT: sshd's port, if not 22.
 *
 * The machine is this one, so its Node stands in for the pinned runtime, as
 * in the other end-to-end test, and nothing is downloaded.
 */
import { execFileSync } from "node:child_process";
import { get } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TerminalBackendHandle } from "@dispatch/plugin-sdk";
import { createTestContext, type TestContext } from "@dispatch/plugin-sdk/testing";
import { NODE_RUNTIME, sq } from "@dispatch-plugins/host-agent";
import { bundledAgent } from "../src/agent.js";
import type { HostConfig } from "../src/hosts.js";
import { HostRegistry } from "../src/registry.js";

const KEY = process.env.REMOTE_HOST_SSHD_KEY;
const HOST_KEY = process.env.REMOTE_HOST_SSHD_HOST_KEY;
const PORTS = process.env.REMOTE_HOST_SSHD_PORTS;
const SSH_PORT = Number(process.env.REMOTE_HOST_SSHD_PORT || 22);
const INSTANCE = "sshd-e2e";
const ID = "remote-host/sshd";

const until = async (cond: () => boolean, ms = 20_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

function watch(h: TerminalBackendHandle) {
  const w = { out: "", err: "" };
  h.stdout.on("data", (d) => (w.out += d.toString()));
  h.stderr.on("data", (d) => (w.err += d.toString()));
  return w;
}

describe.skipIf(!KEY || !HOST_KEY || process.platform !== "linux")("end to end under a real sshd on Linux", () => {
  // The login's home as sshd sees it (passwd), not $HOME: a CI container sets HOME=/github/home.
  const home = userInfo().homedir;
  const root = join(home, ".dispatch-host");
  let t: TestContext;
  let registry: HostRegistry;
  let hadRoot = false;

  beforeAll(async () => {
    hadRoot = existsSync(root);
    const bin = join(root, "runtime", "node", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${NODE_RUNTIME.version}; exit 0; fi\nexec ${sq(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    t = createTestContext({ id: "remote-host", secrets: { REMOTE_HOST_KEY_SSHD: readFileSync(KEY!, "utf8") }, instance: { id: INSTANCE } });
    registry = new HostRegistry({
      ctx: t.ctx,
      instanceId: INSTANCE,
      agent: bundledAgent(),
      runtime: {
        tarball: async () => {
          throw new Error("the test stands in its own Node; nothing should be downloaded");
        },
      },
      timing: { tickMs: 100, helloEveryMs: 1_000, backoffMs: [100] },
      shell: { heartbeatMs: 200, stallAfterMs: 5_000, retryMs: [100] },
      portPollMs: 300,
    });
    const host: HostConfig = {
      slug: "sshd",
      label: "Debian box",
      user: userInfo().username,
      addresses: ["127.0.0.1"],
      port: SSH_PORT,
      hostKey: HOST_KEY!,
      hostKeyType: "ssh-ed25519",
      keyFingerprint: `SHA256:${"c".repeat(43)}`,
      allowFrom: ["127.0.0.1"],
      pairedAt: new Date().toISOString(),
    };
    registry.sync([host]);
    await until(() => !!registry.get("sshd")?.link.probe && t.terminalStatus.get(ID)?.state === "online", 90_000, `${ID} online (${JSON.stringify(t.terminalStatus.get(ID))})`);
  }, 120_000);

  afterAll(async () => {
    await registry?.get("sshd")?.link.agent(["kill", "--instance", INSTANCE, "--all"]).catch(() => {});
    await registry?.dispose();
    // This machine's own ~/.dispatch-host: only what this test made.
    if (!hadRoot) rmSync(root, { recursive: true, force: true });
    else rmSync(join(root, INSTANCE), { recursive: true, force: true });
  }, 30_000);

  it("probes the machine as it is: Debian, its uid, root for a root login, and what finds ports", () => {
    const p = registry.get("sshd")!.link.probe!;
    expect(p.platform).toBe("linux");
    expect(p.os.id).toBe("debian");
    expect(p.uid).toBe(process.getuid!());
    expect(p.elevation).toBe(p.uid === 0 ? "root" : "approval-helper");
    if (PORTS) expect(p.ports).toBe(PORTS);
    expect(p.bash).toMatch(/\/bash$/);
    const note = registry.get("sshd")!.backend.agentNote({ chatId: "chat-1" });
    expect(note).toContain("This terminal runs on Debian box (Debian GNU/Linux 12,");
    if (p.uid === 0) expect(note).toContain("- Root: the login on Debian box is root");
  });

  it("runs a shell through sshd, as the login, with no sudo shim for root", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-1", name: "main" });
    const w = watch(h);
    h.stdin.write('echo "uid=$(id -u) sudo=$(command -v sudo || echo none) shell=$BASH_VERSION"\n');
    await until(() => /uid=\d+ sudo=\S+ shell=\S+/.test(w.out), 20_000, "the shell's answer");
    expect(w.out).toContain(`uid=${process.getuid!()}`);
    if (process.getuid!() === 0) expect(w.out).not.toMatch(/sudo=\S*\.dispatch-host/);
    h.kill();
  });

  it("syncs a chat's worktree there and brings a command's changes back", { timeout: 90_000 }, async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rh-sshd-repo-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.name", "t");
      git("config", "user.email", "t@t");
      writeFileSync(join(repo, "a.txt"), "one\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      writeFileSync(join(repo, "here.txt"), "made here\n");
      const h = await t.terminals.spawn(ID, { chatId: "chat-sync", name: "main", cwd: repo, worktreePath: repo });
      const w = watch(h);
      expect(h.cwd).toBe(`${root}/${INSTANCE}/chats/chat-sync/${basename(repo)}`);
      expect((await t.terminals.beforeRun(ID, { chatId: "chat-sync", terminal: "main", command: "edit", runId: "s-1" })).ran).toBe(true);
      h.stdin.write("cat here.txt; echo two > a.txt; echo made-there > there.txt; echo step-done\n");
      await until(() => w.out.includes("step-done"), 20_000, "step-done");
      expect(w.out).toContain("made here");
      const a = await t.terminals.afterRun(ID, { chatId: "chat-sync", terminal: "main", command: "edit", runId: "s-1" });
      expect(a.notices.join("\n")).toMatch(/Brought back the changes made there/);
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("two\n");
      expect(readFileSync(join(repo, "there.txt"), "utf8")).toBe("made-there\n");
      h.kill();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("forwards a server the chat starts there, found by what the probe said", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-ports", name: "main" });
    const w = watch(h);
    const js = "require('http').createServer((q,s)=>s.end('served-there')).listen(0,'127.0.0.1',function(){console.log('port='+this.address().port)})";
    h.stdin.write(`${sq(process.execPath)} -e ${sq(js)} &\n`);
    await until(() => /port=\d+/.test(w.out), 20_000, "the server's port");
    const port = Number(w.out.match(/port=(\d+)/)![1]);
    const mine = () => t.terminalPorts.find((p) => p.chatId === "chat-ports" && p.remotePort === port);
    await until(() => !!mine(), 20_000, `port ${port} published (${JSON.stringify(t.terminalPorts)})`);
    expect(await fetchText(`${mine()!.url}/`)).toBe("served-there");
    h.kill();
    await until(() => !mine(), 10_000, "the forward withdrawn");
  });
});

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    }).on("error", reject);
  });
}
