/**
 * The whole chain on one POSIX machine: the plugin's registry and link, a real
 * SSH server (in this process) that runs commands with /bin/sh as sshd would,
 * and the real dispatch-host bundle, installed over SSH into a throwaway HOME.
 * The pinned Node is stood in for by this test's own Node.
 *
 * Skipped on Windows; CI runs it on Linux and macOS.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { get } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TerminalBackendHandle, TerminalExitReason } from "@dispatch/plugin-sdk";
import { createTestContext, type TestContext } from "@dispatch/plugin-sdk/testing";
import { NODE_RUNTIME, sq } from "@dispatch-plugins/host-agent";
import { generateKeyPair } from "@dispatch-plugins/remote-core";
import { runLocally, startTestSshServer, type ExecRequest, type TestSshServer } from "@dispatch-plugins/remote-core/testing";
import { HELPER_VERSION, helperScript, removeElevation, verifyElevation, type HelperPaths } from "../src/elevation-setup.js";
import { bundledAgent } from "../src/agent.js";
import { ELEVATE_USER, type ApprovalRequest, type ApprovalResult } from "../src/elevation.js";
import type { HostConfig } from "../src/hosts.js";
import { HostRegistry } from "../src/registry.js";

const posix = process.platform !== "win32";
/** dispatch-host finds listeners with lsof; a runner without it can't attribute ports. */
const hasLsof = posix && spawnSync("sh", ["-c", "command -v lsof"]).status === 0;
const INSTANCE = "e2e-instance";
const ID = "remote-host/e2e";

const until = async (cond: () => boolean, ms = 20_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

function watch(h: TerminalBackendHandle) {
  const w = { out: "", err: "", events: [] as string[], exit: undefined as { code: number | null; reason?: TerminalExitReason } | undefined };
  h.stdout.on("data", (d) => (w.out += d.toString()));
  h.stderr.on("data", (d) => (w.err += d.toString()));
  const on = h.on as (e: string, l: (...a: unknown[]) => void) => unknown;
  on.call(h, "stalled", () => w.events.push("stalled"));
  on.call(h, "resumed", () => w.events.push("resumed"));
  h.on("exit", (code, reason) => {
    w.events.push("exit");
    w.exit = { code, ...(reason ? { reason } : {}) };
  });
  return w;
}

describe.skipIf(!posix)("end to end under a real SSH server and dispatch-host (POSIX)", () => {
  let home: string;
  let server: TestSshServer;
  let t: TestContext;
  let registry: HostRegistry;
  /** What the user was asked to approve, and how the test answers. */
  const approvalsAsked: Array<{ chatId: string; req: ApprovalRequest }> = [];
  let decide: (req: ApprovalRequest) => Promise<ApprovalResult["decision"]> = async () => "approved";
  /** The real root helper, under a scratch directory, with a sudo that only runs it as this user (CI has no root). */
  let helper: HelperPaths;
  let elevateKey: string;
  const installHelper = () => {
    mkdirSync(join(helper.home, ".ssh"), { recursive: true });
    writeFileSync(helper.helper, helperScript(helper), { mode: 0o755 });
    writeFileSync(join(helper.home, ".ssh", "authorized_keys"), "the setup's key line\n");
    writeFileSync(helper.sudoers, "the setup's sudoers rule\n");
  };

  beforeAll(async () => {
    // Short on purpose: dispatch-host's sockets live under it, and a unix
    // socket path is capped at 104 bytes on macOS. Its $TMPDIR
    // (/private/var/folders/…/T/) alone uses most of that. A real home,
    // /Users/dispatch, is far below it.
    home = realpathSync(mkdtempSync("/tmp/rh-"));
    const bin = join(home, ".dispatch-host", "runtime", "node", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${NODE_RUNTIME.version}; exit 0; fi\nexec ${sq(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const kp = generateKeyPair("e2e@test");
    const elevateKp = generateKeyPair("e2e-elevate@test");
    elevateKey = elevateKp.privateKey;
    const elev = join(home, "elevate");
    helper = {
      helper: join(elev, "dispatch-elevate"),
      account: ELEVATE_USER,
      home: join(elev, "home"),
      sudoers: join(elev, "sudoers"),
      log: join(elev, "log"),
      sudo: join(elev, "sudo"),
      dscl: join(elev, "dscl"),
      rootUid: process.getuid!(),
    };
    mkdirSync(elev, { recursive: true });
    writeFileSync(helper.sudo, '#!/bin/sh\n[ "$1" = -n ] || { echo "sudo: a password is required" >&2; exit 1; }\nshift\nexec "$@"\n', {
      mode: 0o755,
    });
    writeFileSync(
      helper.dscl,
      `#!/bin/sh\necho "$*" >> ${sq(join(elev, "dscl.log"))}\ncase "$*" in *"-read /Users/"*|*"-read /Groups/_"*|*-delete*) exit 0 ;; esac\nexit 1\n`,
      { mode: 0o755 },
    );
    installHelper();
    const asUser = runLocally({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      SHELL: "/bin/bash",
      USER: process.env.USER ?? "test",
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "test",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
    });
    const asHelper = (req: ExecRequest) =>
      runLocally({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: helper.home, SSH_ORIGINAL_COMMAND: req.command })({
        ...req,
        command: `exec /bin/bash ${sq(helper.helper)}`,
      });
    server = await startTestSshServer({
      authorizedKeys: () => [kp.publicKey, elevateKp.publicKey],
      // sshd's default: a connection past ten sessions has channels refused.
      maxSessions: 10,
      // The elevation account's forced command: the real root helper, which
      // reads the request from SSH_ORIGINAL_COMMAND, as sshd runs it.
      exec: (req) => (req.username === ELEVATE_USER ? asHelper(req) : asUser(req)),
    });
    t = createTestContext({
      id: "remote-host",
      secrets: { REMOTE_HOST_KEY_E2E: kp.privateKey, REMOTE_HOST_ELEVATE_KEY_E2E: elevateKp.privateKey },
      instance: { id: INSTANCE },
    });
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
      approvals: {
        request: async (chatId, req) => {
          approvalsAsked.push({ chatId, req });
          return { decision: await decide(req), by: "Tester", at: Date.now() };
        },
      },
    });
    const host: HostConfig = {
      slug: "e2e",
      label: "E2E",
      user: "test",
      addresses: [server.host],
      port: server.port,
      hostKey: server.fingerprint,
      hostKeyType: server.keyType,
      keyFingerprint: `SHA256:${"b".repeat(43)}`,
      allowFrom: ["127.0.0.1"],
      pairedAt: new Date().toISOString(),
    };
    registry.sync([host]);
    // Connected and probed. Online, or degraded if this runner lacks
    // something the probe looks for; either way the link is up.
    const up = () => {
      const s = t.terminalStatus.get(ID);
      return !!registry.get("e2e")?.link.probe && !!s && s.state !== "offline" && s.detail !== "connecting";
    };
    await until(up, 60_000, `${ID} connected (status: ${JSON.stringify(t.terminalStatus.get(ID))})`);
  }, 90_000);

  afterAll(async () => {
    await registry?.get("e2e")?.link.agent(["kill", "--instance", INSTANCE, "--all"]).catch(() => {});
    await registry?.dispose();
    await server?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  }, 30_000);

  it("installed the agent and probed the machine", () => {
    const view = registry.list()[0]!;
    expect(view.status.lastSeenAt).toBeTypeOf("number");
    expect(view.probe?.agentVersion).toBe(bundledAgent().version);
    expect(view.probe?.home).toBe(home);
  });

  it("runs a shell there, in the chat's own directory", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-1", name: "main" });
    const w = watch(h);
    expect(h.cwd).toBe(join(home, ".dispatch-host", INSTANCE, "chats", "chat-1"));
    h.stdin.write("echo hello-$((40+2)); pwd\n");
    await until(() => w.out.includes("hello-42"), 20_000, "hello-42");
    await until(() => w.out.includes(h.cwd!), 5_000, "pwd");
    h.stdin.write("exit 7\n");
    await until(() => w.exit !== undefined, 20_000, "exit");
    expect(w.exit).toEqual({ code: 7, reason: { kind: "exited" } });
  });

  it("rides out a dropped connection: the shell keeps running and nothing is lost or repeated", { timeout: 90_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-1", name: "drop" });
    const w = watch(h);
    h.stdin.write("echo before-drop; (sleep 2; echo after-drop) &\n");
    await until(() => w.out.includes("before-drop"), 20_000, "before-drop");
    server.dropClients();
    await until(() => w.events.includes("stalled"), 10_000, "stalled");
    await until(() => w.events.includes("resumed"), 30_000, "resumed");
    await until(() => w.out.includes("after-drop"), 20_000, "after-drop");
    h.stdin.write("echo still-here\n");
    await until(() => w.out.includes("still-here"), 20_000, "still-here");
    expect(w.out.match(/before-drop/g)).toHaveLength(1);
    expect(w.out.match(/after-drop/g)).toHaveLength(1);
    expect(w.exit).toBeUndefined();
    h.kill();
    expect(w.exit?.reason).toEqual({ kind: "killed", detail: "stopped by Dispatch" });
  });

  it("kill() ends the session and what it started on the machine", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-2", name: "main" });
    const w = watch(h);
    h.stdin.write("sleep 300 &\necho pid=$!\n");
    await until(() => /pid=\d+/.test(w.out), 20_000, "the sleep's pid");
    const pid = Number(w.out.match(/pid=(\d+)/)![1]);
    expect(alive(pid)).toBe(true);
    h.kill();
    const link = registry.get("e2e")!.link;
    type Row = { chat: string; state: string };
    const end = Date.now() + 20_000;
    for (;;) {
      const rows = await link.agent<Row[]>(["list", "--instance", INSTANCE]);
      const mine = rows.filter((r) => r.chat === "chat-2");
      if (mine.length && mine.every((r) => r.state === "exited")) break;
      if (Date.now() > end) throw new Error(`chat-2's session did not exit: ${JSON.stringify(mine)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    // The "machine" is this one, so the background job can be looked for.
    await until(() => !alive(pid), 10_000, `the background sleep (pid ${pid}) to end`);
  });

  it("syncs the chat's worktree there, starts in the same place, and brings a command's changes back", { timeout: 90_000 }, async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rh-e2e-repo-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.name", "t");
      git("config", "user.email", "t@t");
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "a.txt"), "one\n");
      writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      writeFileSync(join(repo, "uncommitted.txt"), "not committed yet\n");

      const h = await t.terminals.spawn(ID, { chatId: "chat-sync", name: "main", cwd: join(repo, "src"), worktreePath: repo });
      const w = watch(h);
      expect(h.cwd).toBe(`${home}/.dispatch-host/${INSTANCE}/chats/chat-sync/${basename(repo)}/src`);
      const b = await t.terminals.beforeRun(ID, { chatId: "chat-sync", terminal: "main", command: "edit things", runId: "sync-1" });
      expect(b.ran).toBe(true);
      expect(b.notices.join("\n")).toMatch(/Set up this chat's files there/);
      h.stdin.write("cat ../uncommitted.txt; echo changed > ../a.txt; echo made-there > gen.txt; echo step-done\n");
      await until(() => w.out.includes("step-done"), 20_000, "step-done");
      expect(w.out).toContain("not committed yet");
      const a = await t.terminals.afterRun(ID, { chatId: "chat-sync", terminal: "main", command: "edit things", runId: "sync-1" });
      expect(a.notices.join("\n")).toMatch(/Brought back the changes made there by `edit things`/);
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
      expect(readFileSync(join(repo, "src", "gen.txt"), "utf8")).toBe("made-there\n");

      // A command core stopped waiting for holds the checkout, even against
      // its own terminal, until the shell there says it ended.
      expect((await t.terminals.beforeRun(ID, { chatId: "chat-sync", terminal: "main", command: "slow", runId: "sync-2" })).ran).toBe(true);
      h.stdin.write("sleep 5; echo 'CMTERMSENTINEL_e2e|0|True|'\"$PWD\"\n");
      await t.terminals.afterRun(ID, { chatId: "chat-sync", terminal: "main", command: "slow", runId: "sync-2", outcome: "timed-out" });
      const held = await t.terminals.beforeRun(ID, { chatId: "chat-sync", terminal: "main", command: "next", runId: "sync-3" });
      expect(held.ran).toBe(false);
      expect(held.refusal).toMatch(/`slow` timed out and may still be running/);
      await until(() => w.out.includes("CMTERMSENTINEL_e2e"), 20_000, "the slow command's end");
      let next = held;
      for (let i = 0; i < 50 && !next.ran; i++) {
        await new Promise((r) => setTimeout(r, 100));
        next = await t.terminals.beforeRun(ID, { chatId: "chat-sync", terminal: "main", command: "next", runId: `sync-4-${i}` });
      }
      expect(next.ran).toBe(true);
      h.kill();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasLsof)("forwards a server the chat starts there, and withdraws it with the shell", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-ports", name: "main" });
    const w = watch(h);
    // A dev server: started in the background from the chat's own shell, on a port the OS picks.
    const js = "require('http').createServer((q,s)=>s.end('served-there')).listen(0,'127.0.0.1',function(){console.log('port='+this.address().port)})";
    h.stdin.write(`${sq(process.execPath)} -e ${sq(js)} &\n`);
    await until(() => /port=\d+/.test(w.out), 20_000, "the server's port");
    const port = Number(w.out.match(/port=(\d+)/)![1]);
    const mine = () => t.terminalPorts.find((p) => p.chatId === "chat-ports" && p.remotePort === port);
    await until(() => !!mine(), 20_000, `port ${port} published (${JSON.stringify(t.terminalPorts)})`);
    expect(mine()).toMatchObject({ backend: ID, label: "node" });
    // The "machine" is this computer, so its port is taken here: another one carries it.
    expect(mine()!.url).not.toBe(`http://127.0.0.1:${port}`);
    expect(await fetchText(`${mine()!.url}/`)).toBe("served-there");
    // Nothing another chat holds is forwarded for this one.
    expect(t.terminalPorts.filter((p) => p.chatId !== "chat-ports")).toEqual([]);
    h.kill();
    await until(() => !mine(), 10_000, "the forward withdrawn");
  });

  it("ends an idle chat's shells and what they started there, and keeps its directory", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-idle", name: "main" });
    const w = watch(h);
    h.stdin.write("sleep 300 &\necho pid=$!\n");
    await until(() => /pid=\d+/.test(w.out), 20_000, "the sleep's pid");
    const pid = Number(w.out.match(/pid=(\d+)/)![1]);
    await t.terminals.chatIdle("chat-idle");
    await until(() => w.exit !== undefined, 10_000, "the shell to end");
    await until(() => !alive(pid), 10_000, `the background sleep (pid ${pid}) to end`);
    expect(existsSync(join(home, ".dispatch-host", INSTANCE, "chats", "chat-idle"))).toBe(true);
  });

  it("deletes a deleted chat's directory, sessions and record there", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-del", name: "main" });
    const w = watch(h);
    h.stdin.write("echo made > here.txt; sleep 300 &\necho pid=$!\n");
    await until(() => /pid=\d+/.test(w.out), 20_000, "the sleep's pid");
    const pid = Number(w.out.match(/pid=(\d+)/)![1]);
    const dir = join(home, ".dispatch-host", INSTANCE, "chats", "chat-del");
    expect(existsSync(join(dir, "here.txt"))).toBe(true);
    expect([...t.kv.keys()]).toContain("served:e2e:chat-del");
    await t.terminals.chatDeleted("chat-del");
    expect(existsSync(dir)).toBe(false);
    await until(() => !alive(pid), 10_000, `the background sleep (pid ${pid}) to end`);
    expect([...t.kv.keys()]).not.toContain("served:e2e:chat-del");
    const rows = await registry.get("e2e")!.link.agent<Array<{ chat: string }>>(["list", "--instance", INSTANCE]);
    expect(rows.filter((r) => r.chat === "chat-del")).toEqual([]);
  });

  it("runs more shells than one connection has sessions for, and still answers", { timeout: 90_000 }, async () => {
    const shells = await Promise.all(Array.from({ length: 12 }, (_, i) => t.terminals.spawn(ID, { chatId: "chat-3", name: `s${i}` })));
    const ws = shells.map(watch);
    shells.forEach((h, i) => h.stdin.write(`echo shell-${i}-ok\n`));
    for (const [i, w] of ws.entries()) await until(() => w.out.includes(`shell-${i}-ok`), 20_000, `shell ${i}`);
    const link = registry.get("e2e")!.link;
    expect(link.sessionConnections).toBeGreaterThanOrEqual(2);
    await expect(link.agent(["hello", "--instance", INSTANCE])).resolves.toBeTruthy();
    for (const h of shells) h.kill();
    expect(ws.every((w) => w.exit?.reason?.kind === "killed")).toBe(true);
  });

  it("sudo in a chat shell asks the user, and only then runs the command over the elevation login", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-elev", name: "root" });
    const w = watch(h);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    decide = async () => {
      await held;
      return "approved";
    };
    h.stdin.write(`sudo sh -c 'echo elevated-$((6*7)) in $(pwd)' ; echo "rc=$?"\n`);
    await until(() => approvalsAsked.length === 1, 20_000, "the approval request");
    // Waiting on the user: the shell is stalled (core pauses the command's timeout), and nothing ran yet.
    await until(() => w.events.includes("stalled"), 5_000, "stalled");
    expect(w.out).not.toContain("elevated-42");
    expect(approvalsAsked[0]).toMatchObject({
      chatId: "chat-elev",
      req: { title: "Run as root on E2E", command: "sh -c 'echo elevated-$((6*7)) in $(pwd)'", machine: "E2E", cwd: h.cwd },
    });
    release();
    await until(() => w.out.includes("rc="), 20_000, "the command's end");
    expect(w.out).toContain(`elevated-42 in ${h.cwd}`);
    expect(w.out).toContain("rc=0");
    expect(w.err).toMatch(/approved by Tester; running as root on E2E/);
    expect(w.events.lastIndexOf("resumed")).toBeGreaterThan(w.events.indexOf("stalled"));
    // Over its own login, as the elevation account.
    expect(server.attempts.some((a) => a.username === ELEVATE_USER && a.method === "publickey")).toBe(true);
    h.kill();
  });

  it("a denial runs nothing and fails the command; one that runs exits with its own code", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-elev", name: "deny" });
    const w = watch(h);
    decide = async (req) => (req.command?.includes("touch") ? "denied" : "approved");
    h.stdin.write(`dispatch-elevate touch ${home}/should-not-exist ; echo "first=$?"; sudo sh -c 'exit 7'; echo "second=$?"\n`);
    await until(() => w.out.includes("second="), 30_000, "both commands");
    expect(w.out).toContain("first=1");
    expect(w.out).toContain("second=7");
    expect(w.err).toMatch(/the user denied running this as root by Tester; nothing ran/);
    expect(existsSync(join(home, "should-not-exist"))).toBe(false);
    h.kill();
  });

  it("Ctrl-C while it waits withdraws the request", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-elev", name: "cancel" });
    const w = watch(h);
    let seen: ApprovalRequest | undefined;
    decide = (req) =>
      new Promise((resolve) => {
        seen = req;
        req.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
    const before = approvalsAsked.length;
    h.stdin.write(`sudo id ; echo "rc=$?"\n`);
    await until(() => approvalsAsked.length === before + 1, 20_000, "the approval request");
    h.kill("SIGINT");
    await until(() => seen?.signal?.aborted === true, 20_000, "the request withdrawn");
    expect(w.out).not.toContain("rc=0");
    h.kill();
  });

  it("Ctrl-C while it runs as root stops it there", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-elev", name: "stop" });
    const w = watch(h);
    decide = async () => "approved";
    h.stdin.write(`sudo sh -c 'echo started; exec sleep 29.517' ; echo "rc=$?"\n`);
    await until(() => w.out.includes("started"), 20_000, "the command running as root");
    expect(running("sleep 29.517")).toBe(true);
    h.kill("SIGINT");
    await until(() => !running("sleep 29.517"), 15_000, "the root command stopped");
    await until(() => readFileSync(helper.log, "utf8").includes(": exit 143"), 10_000, "the helper's log line");
    h.kill();
  });

  it("the helper logs every request, and nothing a shell would expand runs", { timeout: 60_000 }, async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-elev", name: "literal" });
    const w = watch(h);
    decide = async () => "approved";
    h.stdin.write(`dispatch-elevate echo '$(touch ${home}/pwned)' '\`id\`'; echo "rc=$?"\n`);
    await until(() => w.out.includes("rc="), 20_000, "the command's end");
    expect(w.out).toContain(`$(touch ${home}/pwned) \`id\``);
    expect(existsSync(join(home, "pwned"))).toBe(false);
    const log = readFileSync(helper.log, "utf8");
    expect(log).toMatch(/run [A-Za-z0-9-]+ in .*: echo /);
    expect(log).toMatch(/: exit 0\n/);
    h.kill();
  });

  it("verify proves the helper answers as root; turning it off uninstalls it there", { timeout: 60_000 }, async () => {
    const el = registry.get("e2e")!.backend.elevation;
    await expect(verifyElevation(el, elevateKey, "E2E", helper.rootUid)).resolves.toEqual({ version: HELPER_VERSION });
    if (helper.rootUid !== 0) {
      await expect(verifyElevation(el, elevateKey, "E2E", 0)).rejects.toThrow(/ran as uid \d+, not as root/);
    }
    // A key the machine doesn't take.
    await expect(verifyElevation(el, generateKeyPair("other@test").privateKey, "E2E", helper.rootUid)).rejects.toThrow(
      /doesn't accept the elevation key yet/,
    );

    expect(await removeElevation(el)).toEqual({ there: "removed" });
    expect(existsSync(helper.helper)).toBe(false);
    expect(existsSync(helper.sudoers)).toBe(false);
    expect(existsSync(helper.home)).toBe(false);
    expect(readFileSync(helper.log, "utf8")).toMatch(/uninstalled\n$/); // the log stays
    expect(readFileSync(join(helper.home, "..", "dscl.log"), "utf8")).toContain(`. -delete /Users/${ELEVATE_USER}`);
    installHelper();
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

/** Whether a process exists (a zombie counts until it is reaped). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a process whose command line contains `text` is running. */
function running(text: string): boolean {
  return spawnSync("pgrep", ["-f", text]).status === 0;
}
