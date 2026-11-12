/**
 * `machines@1` end to end: a caller's provisioned backend, through core's
 * membrane (the SDK's `callAs`), running a chat's shells and sync under the
 * real dispatch-host on two "machines". Each machine is a real SSH server in
 * this process with a throwaway HOME, and both have ONE host key, as linked
 * clones of one template do. That makes the attack the incarnation token
 * exists for possible: a stale address answered by the wrong machine.
 *
 * Skipped on Windows; CI runs it on Linux (as root too) and macOS.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TerminalBackendHandle } from "@dispatch/plugin-sdk";
import { isPluginCallError } from "@dispatch/plugin-sdk";
import { createTestContext, type TestContext } from "@dispatch/plugin-sdk/testing";
import { NODE_RUNTIME, sq } from "@dispatch-plugins/host-agent";
import { generateKeyPair } from "@dispatch-plugins/remote-core";
import { runLocally, startTestSshServer, type TestSshServer } from "@dispatch-plugins/remote-core/testing";
import type { MachinesV1, ProvisionedBackend } from "@dispatch-plugins/remote-host-api";
import { bundledAgent } from "../src/agent.js";
import { MachinesService } from "../src/machines.js";
import { runsOf } from "../src/sync/run-lock.js";

const posix = process.platform !== "win32";
const INSTANCE = "pe2e-instance";
const BACKEND = "proxmox";

const until = async (cond: () => boolean, ms = 20_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

function watch(h: TerminalBackendHandle) {
  const w = { out: "", exited: false };
  h.stdout.on("data", (d) => (w.out += d.toString()));
  h.on("exit", () => (w.exited = true));
  return w;
}

/** A "machine": a throwaway HOME with dispatch-host's Node stood in by this test's own. */
function machineHome(): string {
  // Short: dispatch-host's sockets live under it (104 bytes on macOS).
  const home = realpathSync(mkdtempSync("/tmp/rp-"));
  const bin = join(home, ".dispatch-host", "runtime", "node", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "node"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${NODE_RUNTIME.version}; exit 0; fi\nexec ${sq(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  return home;
}

describe.skipIf(!posix)("machines@1 end to end: a provisioned machine per chat (POSIX)", () => {
  const homes: string[] = [];
  const servers: TestSshServer[] = [];
  let a: TestSshServer;
  let b: TestSshServer;
  let homeA: string;
  let homeB: string;
  let key: string;
  /** A stretch of the private key's body: it must never show up anywhere. */
  let keyBody: string;
  let t: TestContext;
  let consumer: TestContext;
  let service: MachinesService;
  let pb: ProvisionedBackend;
  let repo: string;
  /** What the provisioner says now, and how often it was asked. */
  const lease = { machine: "m:1", at: () => a };
  let provisions = 0;
  let authCalls = 0;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeAll(async () => {
    const kp = generateKeyPair("pe2e@test");
    key = kp.privateKey;
    keyBody = key.split("\n").filter((l) => l && !l.startsWith("-----")).join("").slice(20, 60);
    // One host key for both: linked clones of one template.
    const template = generateKeyPair("template-host").privateKey;
    homeA = machineHome();
    homeB = machineHome();
    homes.push(homeA, homeB);
    const env = (home: string) => ({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      SHELL: "/bin/bash",
      USER: process.env.USER ?? "test",
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "test",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
    });
    a = await startTestSshServer({ authorizedKeys: () => [kp.publicKey], hostKey: template, maxSessions: 10, exec: runLocally(env(homeA)) });
    b = await startTestSshServer({ authorizedKeys: () => [kp.publicKey], hostKey: template, maxSessions: 10, exec: runLocally(env(homeB)) });
    servers.push(a, b);
    expect(a.fingerprint).toBe(b.fingerprint);

    t = createTestContext({ id: "remote-host", provides: { machines: [1] }, instance: { id: INSTANCE }, kv: {} });
    const runs = runsOf(t.ctx);
    service = new MachinesService({
      instanceId: INSTANCE,
      log: t.ctx.log,
      kv: t.ctx.kv!,
      agent: bundledAgent(),
      runtime: {
        tarball: async () => {
          throw new Error("the test stands in its own Node; nothing should be downloaded");
        },
      },
      ...(runs ? { runs } : {}),
      paired: (backend) => backend.startsWith("remote-host/"),
      overrides: {
        timing: { tickMs: 100, helloEveryMs: 1_000 },
        shell: { heartbeatMs: 200, stallAfterMs: 5_000, retryMs: [100] },
        portPollMs: 300,
        lockWaitMs: 20_000,
      },
    });
    service.serve(t.ctx);
    const api = t.callAs<MachinesV1>("proxmox-terminal", "machines", 1, { capabilities: ["terminals"] });
    pb = api.createProvisionedBackend({
      id: BACKEND,
      label: "Test container",
      io: { publishPort: () => () => {} },
      provision: async () => {
        provisions++;
        const s = lease.at();
        return {
          machine: lease.machine,
          addresses: [s.host],
          port: s.port,
          user: "test",
          auth: async () => {
            authCalls++;
            return { privateKey: key };
          },
          hostKey: { pin: [s.fingerprint] },
        };
      },
    });
    // The caller's own backend, as proxmox-terminal registers it: here, the one it forwards to.
    consumer = createTestContext({ id: "proxmox-terminal", capabilities: ["terminals"] });
    consumer.ctx.terminals!.registerBackend(pb.backend);

    repo = realpathSync(mkdtempSync(join(tmpdir(), "rp-repo-")));
    git("init", "-q");
    git("config", "user.name", "t");
    git("config", "user.email", "t@t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "init");
  }, 60_000);

  afterAll(async () => {
    await service?.dispose();
    for (const s of servers) await s.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
    if (repo) rmSync(repo, { recursive: true, force: true });
  }, 30_000);

  it("runs a chat's shell on its machine, marked as its own, and syncs both ways", { timeout: 90_000 }, async () => {
    const h = await consumer.terminals.spawn(BACKEND, { chatId: "pc-1", name: "main", cwd: repo, worktreePath: repo });
    const w = watch(h);
    expect(h.cwd).toBe(`${homeA}/.dispatch-host/${INSTANCE}/chats/pc-1/${basename(repo)}`);
    expect(readFileSync(join(homeA, ".dispatch-host", "incarnation"), "utf8")).toMatch(/^m:1 [0-9a-f]{32}\n$/);
    expect(provisions).toBe(1);

    const before = await consumer.terminals.beforeRun(BACKEND, { chatId: "pc-1", terminal: "main", command: "edit", runId: "p-1", cwd: repo });
    expect(before.ran).toBe(true);
    expect(before.notices.join("\n")).toMatch(/Set up this chat's files there/);
    // Ended as core ends a command: its sentinel line, which is when dispatch-host says the run is over.
    h.stdin.write(`cat a.txt; echo changed > a.txt; echo made > made.txt; echo step-1; echo 'CMTERMSENTINEL_pe2e|0|True|'"$PWD"\n`);
    await until(() => w.out.includes("step-1"), 20_000, "step-1");
    await until(() => !pb.machines()[0]?.running, 10_000, "the run to end there");
    const after = await consumer.terminals.afterRun(BACKEND, { chatId: "pc-1", terminal: "main", command: "edit", runId: "p-1", cwd: repo });
    expect(after.notices.join("\n")).toMatch(/Brought back the changes made there by `edit`/);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(repo, "made.txt"), "utf8")).toBe("made\n");
    expect(pb.machines()).toEqual([{ chatId: "pc-1", machine: "m:1", connected: true, shells: 1, running: false, address: a.host }]);
  });

  it("shares the chat's files with a paired machine as remote-host's own (the older run keeps them), and waits for another plugin's", { timeout: 90_000 }, async () => {
    const h = await consumer.terminals.spawn(BACKEND, { chatId: "pc-1", name: "lock", cwd: repo, worktreePath: repo });
    const w = watch(h);
    // Core lists every run in flight, this machine's too: what tells the lock which is older.
    const runs: string[] = [];
    const start = (run: Parameters<typeof t.terminals.startRun>[0]) => {
      const r = t.terminals.startRun(run);
      runs.push(r.runId);
      return r;
    };
    try {
      // A paired machine's command started first: it keeps the files, as between two paired machines.
      const first = start({ chatId: "pc-1", backend: "remote-host/cvx-mac", cwd: "/elsewhere", terminal: "paired", startedAt: Date.now() - 1_000 });
      start({ chatId: "pc-1", backend: BACKEND, runId: "p-2", cwd: repo, terminal: "lock" });
      const refused = await consumer.terminals.beforeRun(BACKEND, { chatId: "pc-1", terminal: "lock", command: "one", runId: "p-2", cwd: repo });
      expect(refused.ran).toBe(false);
      expect(refused.refusal).toMatch(/^Not run: terminal "paired" on remote-host\/cvx-mac/);
      t.terminals.endRun(first.runId);
      t.terminals.endRun("p-2");

      start({ chatId: "pc-1", backend: BACKEND, runId: "p-3", cwd: repo, terminal: "lock" });
      expect((await consumer.terminals.beforeRun(BACKEND, { chatId: "pc-1", terminal: "lock", command: "two", runId: "p-3", cwd: repo })).ran).toBe(true);
      h.stdin.write("echo y > lock2.txt; echo step-3\n");
      await until(() => w.out.includes("step-3"), 20_000, "step-3");
      // Started after this one: the pull-back doesn't wait on remote-host's own
      // (that one waited for this; waiting back could wait on a wait), but does on another plugin's.
      start({ chatId: "pc-1", backend: "remote-host/cvx-mac", cwd: "/elsewhere", terminal: "paired" });
      const foreign = start({ chatId: "pc-1", backend: "other-plugin/box", cwd: "/w", terminal: "box" });
      setTimeout(() => t.terminals.endRun(foreign.runId), 1_500);
      const waited = await consumer.terminals.afterRun(BACKEND, { chatId: "pc-1", terminal: "lock", command: "two", runId: "p-3", cwd: repo });
      expect(waited.notices.join("\n")).toMatch(/Waited \d+ s for terminal "box"/);
      expect(waited.notices.join("\n")).not.toMatch(/"paired"/);
      expect(existsSync(join(repo, "lock2.txt"))).toBe(true);
    } finally {
      // Nothing left in flight to refuse the next test's commands.
      for (const id of runs) t.terminals.endRun(id);
      h.kill();
    }
  });

  it("starts afresh on a machine made again: push-only, nothing here deleted, and says so once", { timeout: 90_000 }, async () => {
    writeFileSync(join(repo, "only-here.txt"), "untracked, local\n");
    lease.machine = "m:2";
    lease.at = () => b;
    const h = await consumer.terminals.spawn(BACKEND, { chatId: "pc-1", name: "again", cwd: repo, worktreePath: repo });
    expect(h.cwd).toBe(`${homeB}/.dispatch-host/${INSTANCE}/chats/pc-1/${basename(repo)}`);
    expect(readFileSync(join(homeB, ".dispatch-host", "incarnation"), "utf8")).toMatch(/^m:2 /);
    const first = await consumer.terminals.beforeRun(BACKEND, { chatId: "pc-1", terminal: "again", command: "ls", runId: "p-4", cwd: repo });
    expect(first.refusal).toBeUndefined();
    expect(first.notices.join("\n")).toMatch(/machine was made again/);
    expect(first.notices.join("\n")).toMatch(/Set up this chat's files there/);
    await consumer.terminals.afterRun(BACKEND, { chatId: "pc-1", terminal: "again", command: "ls", runId: "p-4", cwd: repo });
    // Every file here is as it was; the new machine has them all.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
    expect(existsSync(join(repo, "made.txt"))).toBe(true);
    expect(existsSync(join(repo, "only-here.txt"))).toBe(true);
    expect(readFileSync(`${h.cwd}/only-here.txt`, "utf8")).toBe("untracked, local\n");
    expect([...t.kv.keys()].filter((k) => k.includes("/m:1"))).toEqual([`ptoken:x/proxmox-terminal/${BACKEND}/m:1`]);
    const second = await consumer.terminals.beforeRun(BACKEND, { chatId: "pc-1", terminal: "again", command: "ls", runId: "p-5", cwd: repo });
    expect(second.notices.join("\n")).not.toMatch(/made again/);
    await consumer.terminals.afterRun(BACKEND, { chatId: "pc-1", terminal: "again", command: "ls", runId: "p-5", cwd: repo });
    // No shell left to resume (and dial) behind the next test's back.
    h.kill();
  });

  it("runs nothing on another machine answering at a stale address with the same host key", { timeout: 60_000 }, async () => {
    // pc-1's machine is m:2 (on B); a stale lease sends its address to A, a different machine with the same key.
    lease.at = () => a;
    const tokenOnA = readFileSync(join(homeA, ".dispatch-host", "incarnation"), "utf8");
    const execsOnA = a.execs.length;
    // Its connection is up; drop it, so the next spawn dials.
    a.dropClients();
    b.dropClients();
    await until(() => !pb.machines()[0]?.connected, 10_000, "the connection to drop");
    const err = await consumer.terminals.spawn(BACKEND, { chatId: "pc-1", name: "stale", cwd: repo, worktreePath: repo }).catch((e: unknown) => e);
    expect(isPluginCallError(err) ? (err as { code?: string }).code : String(err)).toBe("wrong-machine");
    // Only the look at who answered ran there.
    expect(a.execs.length - execsOnA).toBe(1);
    expect(readFileSync(join(homeA, ".dispatch-host", "incarnation"), "utf8")).toBe(tokenOnA);
    lease.at = () => b;
  });

  it("never lets the key land anywhere, and asks for it on every connect", () => {
    const everywhere = [
      JSON.stringify([...t.kv.entries()]),
      JSON.stringify(t.log),
      JSON.stringify(consumer.log),
      JSON.stringify(t.settings.get()),
      a.execs.join("\n"),
      b.execs.join("\n"),
    ].join("\n");
    expect(everywhere).not.toContain(keyBody);
    expect(authCalls).toBeGreaterThanOrEqual(provisions);
  });

  it("ends a caller's shells when its link closes, and keeps what it kept: a disable isn't a delete", { timeout: 60_000 }, async () => {
    const h = await consumer.terminals.spawn(BACKEND, { chatId: "pc-1", name: "last", cwd: repo, worktreePath: repo });
    const w = watch(h);
    const kept = [...t.kv.keys()].sort();
    t.revoke("proxmox-terminal");
    await until(() => w.exited, 20_000, "the shell to end");
    expect(service.serves(BACKEND)).toBe(false);
    expect([...t.kv.keys()].sort()).toEqual(kept);
    expect(pb.machines()).toBeUndefined();
  });
});
