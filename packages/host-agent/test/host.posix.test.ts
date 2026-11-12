/**
 * The built agent (dist/dispatch-host.mjs), driven the way the plugin will
 * drive it over SSH: `session` with framed stdio, and the query commands. Real
 * bash, real process groups, real sockets. POSIX only. CI runs it on Linux,
 * after `pnpm build`. Commands are written exactly as Dispatch core writes
 * them: `eval '<cmd>\n' </dev/null`, then the sentinel probe.
 */
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionPaths } from "../src/layout.js";
import { F, FrameDecoder, decodeJson, decodeOutput, encodeFrame, type ErrorMsg, type ExitMsg, type ReadyMsg } from "../src/protocol.js";

const DIST = fileURLToPath(new URL("../dist/dispatch-host.mjs", import.meta.url));
const posix = process.platform !== "win32";
const hasLsof = posix && spawnSync("sh", ["-c", "command -v lsof"]).status === 0;
/** Linux reads its listeners from ss or /proc; macOS needs lsof. */
const listsPorts = process.platform === "linux" || hasLsof;
/** Logged in as root (CI's Debian job), a shell gets no sudo shim. */
const asRoot = process.getuid?.() === 0;
const hasSetsid = posix && spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
const run = posix && existsSync(DIST);
const INSTANCE = "inst-test";

let work = "";
let root = "";
let cwd = "";
let fakeShell = "";
let seq = 0;

beforeAll(() => {
  if (!run) return;
  // Real path: macOS tmpdir is under /var, a symlink to /private/var, and bash reports the real one.
  work = realpathSync(mkdtempSync(join(tmpdir(), "dh-it-")));
  root = join(work, "r");
  cwd = join(work, "proj");
  execFileSync("mkdir", ["-p", join(cwd, "sub")]);
  // A login shell whose profile is chatty, exports a token, and puts a tool dir on PATH.
  fakeShell = join(work, "loginsh");
  writeFileSync(
    fakeShell,
    [
      "#!/bin/sh",
      'echo "Welcome to the fake profile"',
      "export GITHUB_TOKEN=leak-me HOMEBREW_PREFIX=/opt/homebrew-test",
      'export PATH="/opt/fake-tools/bin:$PATH"',
      'exec /bin/sh -c "$3" "$4"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeShell, 0o755);
});

afterAll(() => {
  if (!run) return;
  spawnSync(process.execPath, [DIST, "kill", "--root", root, "--instance", INSTANCE, "--all"]);
  rmSync(work, { recursive: true, force: true });
});

/** One `dispatch-host session` process, as an SSH channel would run it. */
class Relay {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly frames: Array<{ type: number; payload: Buffer }> = [];
  private readonly dec = new FrameDecoder();
  readonly exited: Promise<number | null>;
  /** stdout bytes received, by offset: what a client "has". */
  outEnd = 0;
  errEnd = 0;

  constructor(sid: string, extra: string[] = [], dir = cwd) {
    this.proc = spawn(
      process.execPath,
      [DIST, "session", "--root", root, "--instance", INSTANCE, "--chat", "c1", "--sid", sid, "--cwd", dir, ...extra],
      { env: { ...process.env, SHELL: fakeShell } },
    );
    this.proc.stdout.on("data", (c: Buffer) => {
      for (const f of this.dec.push(c)) {
        this.frames.push(f);
        if (f.type === F.stdout || f.type === F.stderr) {
          const { offset, data } = decodeOutput(f.payload);
          if (f.type === F.stdout) this.outEnd = Math.max(this.outEnd, offset + data.length);
          else this.errEnd = Math.max(this.errEnd, offset + data.length);
        }
      }
    });
    this.exited = new Promise((r) => this.proc.on("close", (code) => r(code)));
  }

  send(type: number, payload?: object | Buffer): void {
    this.proc.stdin.write(encodeFrame(type, payload));
  }

  /** Write a command the way core does, then its probe; resolves with the marker's exit code. */
  async run(cmd: string, opts: { background?: boolean; runId?: string; noWait?: boolean } = {}): Promise<number> {
    const nonce = `n${++seq}`;
    if (opts.runId) this.send(F.runBegin, { runId: opts.runId, background: Boolean(opts.background) });
    const quoted = `'${cmd.replace(/'/g, "'\\''")}\n'`;
    this.send(F.stdin, Buffer.from(opts.background ? `eval ${quoted} ; ` : `eval ${quoted} </dev/null\n`));
    this.send(
      F.stdin,
      Buffer.from(
        `__cm_ec=$?; printf '%s|%s|%s|%s\\n' 'CMTERMSENTINEL_${nonce}' "$__cm_ec" "$([ "$__cm_ec" -eq 0 ] && echo True || echo False)" "$PWD"\n`,
      ),
    );
    if (opts.background || opts.noWait) return -1;
    const m = await this.waitText(new RegExp(`CMTERMSENTINEL_${nonce}\\|(-?\\d+)\\|`));
    return Number(m[1]);
  }

  text(type: number = F.stdout): string {
    return this.frames
      .filter((f) => f.type === type)
      .map((f) => decodeOutput(f.payload).data.toString())
      .join("");
  }

  of<T>(type: number): T[] {
    return this.frames.filter((f) => f.type === type).map((f) => decodeJson<T>(f.payload));
  }

  async waitFor<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out; stdout so far: ${JSON.stringify(this.text())} frames: ${this.frames.map((f) => f.type.toString(16)).join(",")}`);
      await sleep(25);
    }
  }

  waitText(re: RegExp): Promise<RegExpMatchArray> {
    return this.waitFor(() => this.text().match(re) ?? undefined);
  }

  ready(): Promise<ReadyMsg> {
    return this.waitFor(() => this.of<ReadyMsg>(F.ready)[0]);
  }

  /** The connection drops: the relay dies without a word, as sshd's child would. */
  drop(): Promise<number | null> {
    this.proc.kill("SIGKILL");
    return this.exited;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sid = () => `s${Date.now().toString(36)}${++seq}`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const cli = (...args: string[]) =>
  JSON.parse(execFileSync(process.execPath, [DIST, ...args, "--root", root, "--instance", INSTANCE]).toString()) as unknown;

describe.skipIf(!run)("dispatch-host on a real POSIX host", () => {
  it("starts bash in the cwd, runs core-wrapped commands, and gives foreground commands EOF", async () => {
    const r = new Relay(sid());
    const ready = await r.ready();
    expect(ready).toMatchObject({ cwd, resumed: false, out: 0 });
    expect(await r.run("pwd")).toBe(0);
    expect(r.text()).toContain(`${cwd}\n`);
    // `cat` reads /dev/null, not the shell's stdin: it returns at once.
    expect(await r.run("cat; echo after-cat")).toBe(0);
    expect(await r.run("cd sub && false")).toBe(1);
    expect(r.text()).toMatch(new RegExp(`\\|1\\|False\\|${cwd}/sub\\n`));
    r.send(F.kill);
    expect((await r.waitFor(() => r.of<ExitMsg>(F.exit)[0])).reason).toBe("killed");
  });

  it("refuses a missing cwd with no-cwd and exit 97, never falling back to ~", async () => {
    const r = new Relay(sid(), [], join(work, "nope"));
    expect(await r.exited).toBe(97);
    expect(r.of<ErrorMsg>(F.error)[0]).toMatchObject({ code: "no-cwd" });
  });

  it("gives the shell the login PATH and Homebrew vars, but not a token the profile exports", async () => {
    const r = new Relay(sid());
    await r.ready();
    await r.run('echo "token=${GITHUB_TOKEN:-none} brew=$HOMEBREW_PREFIX path=$PATH"');
    // The sudo shims' directory first (not as root: no shims), then the login PATH as the profile left it.
    const bin = asRoot ? "" : `${join(dirname(DIST), "bin")}:`;
    expect(r.text()).toContain(`token=none brew=/opt/homebrew-test path=${bin}/opt/fake-tools/bin:`);
    r.send(F.kill);
  });

  it.skipIf(asRoot)("routes sudo to dispatch-elevate, which asks over the session's socket", async () => {
    const r = new Relay(sid());
    await r.ready();
    await r.run('echo "sudo=$(command -v sudo) sock=${DISPATCH_ELEVATE_SOCK:+set}"');
    expect(r.text()).toContain(`sudo=${join(dirname(DIST), "bin", "sudo")} sock=set`);
    r.send(F.kill);
  });

  it("survives a dropped connection and resumes from the exact byte, run result included", async () => {
    const id = sid();
    const a = new Relay(id);
    await a.ready();
    await a.run("echo first");
    // A command still going when the connection drops.
    await a.run("for i in 1 2 3 4 5 6; do echo line$i; sleep 0.2; done", { runId: "r-drop", noWait: true });
    await a.waitText(/line1/);
    await a.drop();
    const had = a.outEnd;
    await sleep(1_500);
    const b = new Relay(id, ["--resume-out", String(had), "--resume-err", "0"]);
    const ready = await b.ready();
    expect(ready.resumed).toBe(true);
    const done = await b.waitText(/CMTERMSENTINEL_n\d+\|(\d+)\|True/);
    expect(done[1]).toBe("0");
    const all = a.text().slice(0, had) + b.text();
    expect(all.match(/line\d/g)).toEqual(["line1", "line2", "line3", "line4", "line5", "line6"]);
    // RUN_END is a frame of its own, after the output that holds the
    // sentinel: it can arrive a read later. Wait for it rather than look the
    // moment the sentinel shows (that flaked on macOS). The journal's end is
    // written before the frame is sent, so it is there once the frame is.
    const end = await b.waitFor(() => b.of<{ runId: string; exitCode: number }>(F.runEnd).find((e) => e.runId === "r-drop"));
    expect(end.exitCode).toBe(0);
    const runs = readFileSync(sessionPaths(root, INSTANCE, id).runs, "utf8");
    expect(runs).toMatch(/"t":"end","runId":"r-drop","exitCode":0/);
    b.send(F.kill);
  });

  it("keeps a background command's stdin open across a drop: it reads the owner's pipe, not the channel", async () => {
    const id = sid();
    const a = new Relay(id);
    const { pid } = await a.ready();
    await a.run("cat >/dev/null; echo cat-ended", { background: true });
    await sleep(300);
    await a.drop();
    await sleep(800);
    const b = new Relay(id, ["--resume-out", String(a.outEnd), "--resume-err", "0"]);
    await b.ready();
    await sleep(300);
    expect(a.text() + b.text()).not.toContain("cat-ended");
    expect(alive(pid)).toBe(true);
    b.send(F.kill);
    const exit = await b.waitFor(() => b.of<ExitMsg>(F.exit)[0]);
    expect(exit.reason).toBe("killed");
    await b.waitFor(() => !alive(pid));
  });

  it("kills the whole tree once the heartbeat lapses, background children included", async () => {
    const id = sid();
    const a = new Relay(id, ["--heartbeat-ms", "1500"]);
    const { pid } = await a.ready();
    await a.run("sleep 300 & echo bg=$!");
    const bg = Number((await a.waitText(/bg=(\d+)/))[1]);
    expect(alive(bg)).toBe(true);
    await a.drop();
    await a.waitFor(() => !alive(pid) && !alive(bg), 8_000);
    // The owner records the exit after the tree is gone, so wait for that too
    // (reading it the moment the processes die raced it on CI).
    const read = () => JSON.parse(readFileSync(sessionPaths(root, INSTANCE, id).record, "utf8")) as { state: string; exit?: { reason: string } };
    await a.waitFor(() => read().state === "exited", 5_000);
    expect(read()).toMatchObject({ state: "exited", exit: { reason: "heartbeat" } });
  });

  it("reports a session that ended while nobody was attached with its real exit code", async () => {
    const id = sid();
    const a = new Relay(id);
    await a.ready();
    await a.run("echo before-exit");
    a.send(F.stdin, Buffer.from("exit 3\n"));
    expect((await a.waitFor(() => a.of<ExitMsg>(F.exit)[0])).code).toBe(3);
    await a.exited;
    const b = new Relay(id, ["--resume-out", "0", "--resume-err", "0"]);
    expect(await b.exited).toBe(0);
    expect(b.text()).toContain("before-exit");
    expect(b.of<ExitMsg>(F.exit)[0]).toMatchObject({ code: 3, reason: "exited" });
  });

  it.skipIf(!hasSetsid)("reports an exit promptly even when an escaped process holds the shell's output open", async () => {
    const r = new Relay(sid());
    await r.ready();
    // Like `ssh -f`: a new session at once, still holding the shell's stdout.
    await r.run("setsid sleep 31.7 &");
    r.send(F.stdin, Buffer.from("exit 4\n"));
    const exit = await r.waitFor(() => r.of<ExitMsg>(F.exit)[0], 5_000);
    expect(exit).toMatchObject({ code: 4, reason: "exited" });
    spawnSync("pkill", ["-f", "sleep 31.7"]);
  });

  it("starts ONE owner when two relays race to open the same new session", async () => {
    const id = sid();
    const a = new Relay(id);
    const b = new Relay(id);
    const [ra, rb] = await Promise.all([a.ready(), b.ready()]);
    expect(ra.pid).toBe(rb.pid);
    const rec = JSON.parse(readFileSync(sessionPaths(root, INSTANCE, id).record, "utf8")) as { ownerPid: number; state: string };
    expect(rec.state).toBe("running");
    expect(alive(rec.ownerPid)).toBe(true);
    // The later attach replaced the earlier one. End the session from outside.
    expect(cli("kill", "--sid", id)).toEqual({ killed: [id] });
    await Promise.all([a.exited, b.exited]);
  });

  it("refuses an --env it can't use before starting anything", async () => {
    const env = Buffer.from(JSON.stringify({ "A-B": "x" })).toString("base64");
    const r = new Relay(sid(), ["--env", env]);
    expect(await r.exited).toBe(1);
    expect(r.of<ErrorMsg>(F.error)[0]).toMatchObject({ code: "bad-args" });
  });

  it("takes an --env-file's environment, removes the file, and keeps the values out of the owner's argv", async () => {
    const dir = join(root, INSTANCE, "mcp", "c1", "srv");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ".env-x");
    writeFileSync(file, Buffer.from(JSON.stringify({ SECRET_TOKEN: "tok-123" })).toString("base64"), { mode: 0o600 });
    const id = sid();
    const r = new Relay(id, ["--env-file", file]);
    await r.ready();
    expect(existsSync(file)).toBe(false);
    await r.run("echo got=$SECRET_TOKEN left=${DISPATCH_HOST_SESSION_ENV:-none}");
    expect((await r.waitText(/got=(\S+) left=(\S+)/)).slice(1)).toEqual(["tok-123", "none"]);
    const rec = JSON.parse(readFileSync(sessionPaths(root, INSTANCE, id).record, "utf8")) as { ownerPid: number };
    const args = execFileSync("ps", ["-o", "args=", "-p", String(rec.ownerPid)]).toString();
    expect(args).toContain("serve");
    expect(args).not.toContain(Buffer.from(JSON.stringify({ SECRET_TOKEN: "tok-123" })).toString("base64"));
    expect(cli("kill", "--sid", id)).toEqual({ killed: [id] });
    await r.exited;
  });

  it("reads an --env-file only from the chat's mcp directory", async () => {
    const file = join(work, "elsewhere.env");
    writeFileSync(file, Buffer.from("{}").toString("base64"));
    const r = new Relay(sid(), ["--env-file", file]);
    expect(await r.exited).toBe(1);
    expect(r.of<ErrorMsg>(F.error)[0]).toMatchObject({ code: "bad-args" });
    expect(existsSync(file)).toBe(true); // not its to remove
  });

  it("answers a resume of a session it never had with `gone`, instead of a fresh shell", async () => {
    const r = new Relay(sid(), ["--resume-out", "10", "--resume-err", "0"]);
    expect(await r.exited).toBe(1);
    expect(r.of<ErrorMsg>(F.error)[0]).toMatchObject({ code: "gone" });
  });

  it("kills sessions by chat from the CLI, and sweep reaps the tree of an owner that died", async () => {
    const a = new Relay(sid());
    await a.ready();
    expect(cli("kill", "--chat", "c1")).toMatchObject({ killed: expect.arrayContaining([expect.any(String)]) });
    expect((await a.waitFor(() => a.of<ExitMsg>(F.exit)[0])).reason).toBe("killed");

    const id = sid();
    const b = new Relay(id);
    const { pid } = await b.ready();
    await b.run("sleep 300 & echo bg=$!");
    const bg = Number((await b.waitText(/bg=(\d+)/))[1]);
    const rec = JSON.parse(readFileSync(sessionPaths(root, INSTANCE, id).record, "utf8")) as { ownerPid: number };
    process.kill(rec.ownerPid, "SIGKILL");
    await b.exited;
    // bash reads the owner's pipe, so it ends at that EOF; its background child is orphaned.
    await b.waitFor(() => !alive(pid));
    expect(alive(bg)).toBe(true);
    expect((cli("sweep") as { reaped: string[] }).reaped).toContain(id);
    await b.waitFor(() => !alive(bg));
  });

  it.skipIf(!asRoot)("gives a root login's shell no sudo shim: it is root, and sudo is the machine's own", async () => {
    const r = new Relay(sid());
    await r.ready();
    await r.run('echo "uid=$(id -u) sudo=$(command -v sudo || echo none) sock=${DISPATCH_ELEVATE_SOCK:-unset}"');
    expect(r.text()).toMatch(/uid=0 sudo=\S+ sock=unset/);
    expect(r.text()).not.toContain(join(dirname(DIST), "bin", "sudo"));
    r.send(F.kill);
  });

  it.skipIf(!listsPorts)("attributes a listener to the chat whose shell started it", async () => {
    const port = await new Promise<number>((res) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => res(p));
      });
    });
    const r = new Relay(sid());
    await r.ready();
    await r.run(`${process.execPath} -e 'require("net").createServer().listen(${port}, "127.0.0.1")'`, { background: true });
    const found = await r.waitFor(() => {
      const out = cli("ports") as { sessions: Array<{ chat: string; ports: Array<{ port: number }> }> };
      return out.sessions.some((s) => s.chat === "c1" && s.ports.some((p) => p.port === port)) || undefined;
    });
    expect(found).toBe(true);
    r.send(F.kill);
  });

  it("forget ends a deleted chat's live session, its background children and its directory, from the CLI", async () => {
    const id = sid();
    const dir = join(root, INSTANCE, "chats", "c1");
    execFileSync("mkdir", ["-p", dir]);
    const r = new Relay(id, [], dir);
    const { pid } = await r.ready();
    await r.run("sleep 300 & echo bg=$!");
    const bg = Number((await r.waitText(/bg=(\d+)/))[1]);
    expect((cli("chats") as Array<{ chat: string }>).map((c) => c.chat)).toContain("c1");
    const out = cli("forget", "--chat", "c1") as { killed: string[]; removed: boolean };
    expect(out.killed).toContain(id);
    expect(out.removed).toBe(true);
    await r.waitFor(() => !alive(pid) && !alive(bg));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(sessionPaths(root, INSTANCE, id).dir)).toBe(false);
    expect((cli("chats") as Array<{ chat: string }>).map((c) => c.chat)).not.toContain("c1");
  });

  it("forget exits 1 with git's reason when git won't run, keeping the ref for the retry that finishes", () => {
    // A shared repository holding the chat's ref.
    const repo = join(root, INSTANCE, "repos", "p.git");
    execFileSync("git", ["init", "-q", "--bare", repo]);
    const tree = execFileSync("git", ["--git-dir", repo, "mktree"], { input: "" }).toString().trim();
    const commit = execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "--git-dir", repo, "commit-tree", tree, "-m", "x"]).toString().trim();
    execFileSync("git", ["--git-dir", repo, "update-ref", "refs/dispatch/chats/c2", commit]);
    const refsOf = () => execFileSync("git", ["--git-dir", repo, "for-each-ref", "--format=%(refname)"]).toString().trim();

    // git as it was on cvx-mac once Xcode updated itself: it prints why, and won't run.
    const bin = mkdtempSync(join(tmpdir(), "dh-badgit-"));
    writeFileSync(join(bin, "git"), '#!/bin/sh\necho "You have not agreed to the Xcode license agreements." >&2\nexit 69\n');
    chmodSync(join(bin, "git"), 0o755);
    try {
      const r = spawnSync(process.execPath, [DIST, "forget", "--chat", "c2", "--root", root, "--instance", INSTANCE], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/could not delete chat c2's refs: p\.git: You have not agreed to the Xcode license agreements/);
      expect((JSON.parse(r.stdout.trim()) as { errors: string[] }).errors).toHaveLength(1);
      expect(refsOf()).toBe("refs/dispatch/chats/c2");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }

    // git works again: the retry finishes.
    expect(cli("forget", "--chat", "c2")).toMatchObject({ refs: 1 });
    expect(refsOf()).toBe("");
  });
});
