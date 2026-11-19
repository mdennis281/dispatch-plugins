/**
 * legacy-rescue against real git on both sides. The "container" is a temp
 * directory driven through a real `sh` (the same commands that go over SSH),
 * and its checkouts are made the way 0.1 made them: remote-core's snapshot of
 * the local worktree, fetched in as `refs/dispatch/snapshot` and force-checked
 * out detached.
 *
 * POSIX only (it needs `sh`, GNU `stat` and `xargs -r`); CI's Linux job runs
 * it. DISPATCH_TEST_SH=1 runs it anyway, e.g. under Git for Windows.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { snapshot } from "@dispatch-plugins/remote-core";
import { LegacyRescue, rescueRef, type RescueRemote, type RescueStep } from "../src/legacy-rescue.js";

const posix = (process.platform !== "win32" || process.env.DISPATCH_TEST_SH === "1") && spawnSync("sh", ["-c", "command -v git"]).status === 0;

const ENV = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "1710000000 +0000",
  GIT_COMMITTER_DATE: "1710000000 +0000",
  GIT_CONFIG_NOSYSTEM: "1",
};

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A local repo L, a container dir with workDir, and helpers to sync L into it the 0.1 way. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rescue-")).replace(/\\/g, "/");
  roots.push(root);
  const local = `${root}/local/repo`;
  const workDir = `${root}/ct/root/work`;
  mkdirSync(local, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  g(local, "init", "-q", "-b", "main");
  writeFileSync(`${local}/a.ts`, "export const a = 1;\n");
  writeFileSync(`${local}/b.txt`, "bee\n");
  writeFileSync(`${local}/c.txt`, "sea\n");
  writeFileSync(`${local}/.gitignore`, "node_modules/\n");
  g(local, "add", "-A");
  g(local, "commit", "-q", "-m", "first");
  return { root, local, workDir };
}

/** 0.1's sync of `from` (a local worktree) into `<workDir>/<d>`. Returns the snapshot (`base`). */
async function legacySync(from: string, workDir: string, d: string): Promise<string> {
  const snap = await snapshot(from);
  const dir = `${workDir}/${d}`;
  if (!existsSync(`${dir}/.git`)) {
    mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q");
  }
  g(from, "update-ref", "refs/tmp/s", snap);
  g(dir, "fetch", "-q", from, "refs/tmp/s:refs/dispatch/snapshot");
  g(from, "update-ref", "-d", "refs/tmp/s");
  g(dir, "checkout", "-q", "--force", "--detach", snap);
  return snap;
}

/** The container's shell: the commands run under a real sh, as they would over SSH. */
interface Counter {
  connects: number;
  execs: number;
  pipes?: number;
  aborted?: number;
  timeouts?: number[];
}

function shRemote(counter: Counter = { connects: 0, execs: 0 }): RescueRemote {
  return {
    exec: (cmd, opts = {}) =>
      new Promise((resolve, reject) => {
        counter.execs++;
        if (opts.timeoutMs !== undefined) (counter.timeouts ??= []).push(opts.timeoutMs);
        const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => out.push(c));
        child.stderr.on("data", (c: Buffer) => err.push(c));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
        // A command that never reads stdin may exit first: EPIPE, which the exit code already covers.
        child.stdin.on("error", () => {});
        child.stdin.end(opts.input ?? "");
      }),
    pipe: (cmd, sink, opts) =>
      new Promise((resolve, reject) => {
        counter.pipes = (counter.pipes ?? 0) + 1;
        const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
        opts.signal?.addEventListener("abort", () => {
          counter.aborted = (counter.aborted ?? 0) + 1;
          try {
            process.kill(-child.pid!, "SIGKILL"); // the whole pipeline, as sshd hanging up would
          } catch {
            child.kill("SIGKILL");
          }
        });
        let bytes = 0;
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => {
          bytes += c.length;
          opts.onBytes?.(bytes);
        });
        child.stdout.pipe(sink);
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      }),
  };
}

function rescuer(kv: Record<string, unknown> = {}, opts: { afterStep?: (s: RescueStep, d: string) => void; caps?: Record<string, number> } = {}) {
  const t = createTestContext({ id: "proxmox-terminal", kv });
  const r = new LegacyRescue({ kv: t.ctx.kv, log: t.ctx.log, afterStep: opts.afterStep, caps: opts.caps });
  return { r, t, kvNow: () => Object.fromEntries(t.kv) as Record<string, unknown> };
}

const job = (workDir: string, candidates: string[], counter?: Counter) => ({
  chatId: "chat1",
  vmid: 9003,
  workDir,
  candidates,
  connect: async () => {
    if (counter) counter.connects++;
    return shRemote(counter);
  },
});

const fsckClean = (repo: string) => expect(() => g(repo, "fsck", "--no-progress", "--strict")).not.toThrow();
const nameStatus = (repo: string, a: string, b: string) => g(repo, "diff", "--name-status", "--no-renames", a, b);

describe.skipIf(!posix)("legacy rescue (real git)", () => {
  it("saves modified, new and deleted files into a local ref, touching nothing local, then moves the checkout aside", async () => {
    const { local, workDir } = fixture();
    const base = await legacySync(local, workDir, "repo");
    const D = `${workDir}/repo`;
    writeFileSync(`${D}/a.ts`, "export const a = 2; // edited there\n");
    writeFileSync(`${D}/new.txt`, "made by a command\n");
    rmSync(`${D}/c.txt`);
    mkdirSync(`${D}/node_modules/x`, { recursive: true });
    writeFileSync(`${D}/node_modules/x/i.js`, "ignored\n");
    const indexBefore = statSync(`${D}/.git/index`).mtimeMs;
    const statusBefore = g(D, "--no-optional-locks", "status", "--porcelain");

    const { r, kvNow } = rescuer();
    const res = await r.run(job(workDir, [local]));

    const ref = rescueRef("chat1", 9003, "repo");
    expect(res.entries).toMatchObject([{ d: "repo", state: "moved", ref, pathCount: 3, commits: 0 }]);
    expect(nameStatus(local, base, ref)).toBe("M\ta.ts\nD\tc.txt\nA\tnew.txt");
    expect(g(local, "show", `${ref}:a.ts`)).toBe("export const a = 2; // edited there");
    expect(g(local, "rev-parse", `${ref}^`)).toBe(base);
    expect(() => g(local, "cat-file", "-e", `${ref}:node_modules/x/i.js`)).toThrow();
    // Nothing local changed: worktree, index, HEAD.
    expect(g(local, "status", "--porcelain")).toBe("");
    expect(readFileSync(`${local}/a.ts`, "utf8")).toBe("export const a = 1;\n");
    fsckClean(local);
    // Moved aside whole, with its real index as it was.
    expect(existsSync(D)).toBe(false);
    const aside = `${workDir}.pre-0.2/repo`;
    expect(readFileSync(`${aside}/a.ts`, "utf8")).toContain("edited there");
    expect(statSync(`${aside}/.git/index`).mtimeMs).toBe(indexBefore);
    expect(g(aside, "--no-optional-locks", "status", "--porcelain")).toBe(statusBefore);
    expect(res.notice).toContain(ref);
    expect(res.notice).toContain("`a.ts` (modified)");
    expect(res.notice).toContain("`new.txt` (new)");
    expect(res.notice).toContain("`c.txt` (deleted)");
    expect(res.notice).toContain(`git diff ${base.slice(0, 12)} ${ref} --stat`);
    expect(kvNow()["rescue:chat1"]).toMatchObject({ phase: "done", failures: 0, vmid: 9003 });
  });

  it("brings commits made in the container, on top of the last sync", async () => {
    const { local, workDir } = fixture();
    const base = await legacySync(local, workDir, "repo");
    const D = `${workDir}/repo`;
    writeFileSync(`${D}/b.txt`, "bee two\n");
    g(D, "commit", "-q", "-am", "container work");
    const containerHead = g(D, "rev-parse", "HEAD");
    writeFileSync(`${D}/later.txt`, "uncommitted after it\n");

    const res = await rescuer().r.run(job(workDir, [local]));
    const ref = rescueRef("chat1", 9003, "repo");
    expect(res.entries[0]).toMatchObject({ commits: 1, pathCount: 2 });
    expect(g(local, "rev-parse", `${ref}^`)).toBe(containerHead);
    expect(g(local, "log", "--format=%s", `${base}..${ref}`)).toContain("container work");
    expect(g(local, "show", `${ref}:later.txt`)).toBe("uncommitted after it");
    expect(res.notice).toContain("1 commit made there");
    fsckClean(local);
  });

  it("leaves an untracked file over 50 MB out, and says so", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    const D = `${workDir}/repo`;
    execFileSync("sh", ["-c", `truncate -s 51M ${JSON.stringify(`${D}/big.bin`)}`]); // sparse: no 51 MB written
    writeFileSync(`${D}/small.txt`, "kept\n");
    const res = await rescuer().r.run(job(workDir, [local]));
    const ref = rescueRef("chat1", 9003, "repo");
    expect(res.entries[0]).toMatchObject({ excludedCount: 1, excluded: [{ path: "big.bin", bytes: 51 * 1024 * 1024 }] });
    expect(g(local, "show", `${ref}:small.txt`)).toBe("kept");
    expect(() => g(local, "cat-file", "-e", `${ref}:big.bin`)).toThrow();
    expect(res.notice).toContain("`big.bin` (51 MB)");
    expect(existsSync(`${workDir}.pre-0.2/repo/big.bin`)).toBe(true);
  });

  it("stops taking untracked files at the total and count caps, in path order", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    for (const n of [1, 2, 3, 4, 5]) writeFileSync(`${workDir}/repo/u${n}.txt`, "abc"); // 3 bytes each
    const byBytes = await rescuer({}, { caps: { totalBytes: 7 } }).r.run(job(workDir, [local]));
    expect(byBytes.entries[0]).toMatchObject({ pathCount: 2, excludedCount: 3 });
    expect(byBytes.entries[0]!.excluded!.map((f) => f.path)).toEqual(["u3.txt", "u4.txt", "u5.txt"]);

    const two = fixture();
    await legacySync(two.local, two.workDir, "repo");
    for (const n of [1, 2, 3, 4, 5]) writeFileSync(`${two.workDir}/repo/u${n}.txt`, "abc");
    const byCount = await rescuer({}, { caps: { files: 4 } }).r.run(job(two.workDir, [two.local]));
    expect(byCount.entries[0]).toMatchObject({ pathCount: 4, excludedCount: 1, excluded: [{ path: "u5.txt" }] });
  });

  it("works when the local repo no longer has the snapshot (gc'd), through the commit it was taken on", async () => {
    const { local, workDir } = fixture();
    const base = await legacySync(local, workDir, "repo");
    g(local, "reflog", "expire", "--expire=now", "--all");
    g(local, "gc", "-q", "--prune=now");
    expect(() => g(local, "cat-file", "-e", base)).toThrow();
    writeFileSync(`${workDir}/repo/a.ts`, "changed\n");

    const res = await rescuer().r.run(job(workDir, [local]));
    const ref = rescueRef("chat1", 9003, "repo");
    expect(g(local, "rev-parse", `${ref}^`)).toBe(base); // came along in the pack
    expect(nameStatus(local, base, ref)).toBe("M\ta.ts");
    expect(res.entries[0]!.diffFrom).toBe(base);
    fsckClean(local);
  });

  it("keeps a checkout that matches none of the chat's repos where it is, and rescues the other", async () => {
    const { root, local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    const other = `${root}/elsewhere/other`;
    mkdirSync(other, { recursive: true });
    g(other, "init", "-q");
    writeFileSync(`${other}/o.txt`, "o\n");
    g(other, "add", "-A");
    g(other, "commit", "-q", "-m", "unrelated");
    await legacySync(other, workDir, "other");
    writeFileSync(`${workDir}/other/o.txt`, "edited\n");
    writeFileSync(`${workDir}/repo/a.ts`, "edited\n");
    mkdirSync(`${workDir}/notacheckout`);
    writeFileSync(`${workDir}/notacheckout/f`, "x");

    const res = await rescuer().r.run(job(workDir, [local]));
    expect(res.entries.map((e) => [e.d, e.state])).toEqual([
      ["other", "kept"],
      ["repo", "moved"],
    ]);
    expect(readFileSync(`${workDir}/other/o.txt`, "utf8")).toBe("edited\n"); // untouched
    expect(existsSync(`${workDir}/notacheckout/f`)).toBe(true);
    expect(res.notice).toContain(`\`${workDir}/other\` on this chat's container was left where it is`);
    expect(g(local, "for-each-ref", "--format=%(refname)", "refs/dispatch/rescue")).toBe(rescueRef("chat1", 9003, "repo"));
  });

  it("attributes a checkout named after the worktree, not the repo, and the ref is shared by both", async () => {
    const { root, local, workDir } = fixture();
    const wt = `${root}/local/feat-x`;
    g(local, "worktree", "add", "-q", "-b", "feat-x", wt);
    writeFileSync(`${wt}/wt.txt`, "worktree only\n");
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", "on the branch");
    await legacySync(wt, workDir, "feat-x");
    writeFileSync(`${workDir}/feat-x/wt.txt`, "edited there\n");

    const res = await rescuer().r.run(job(workDir, [wt, local]));
    const ref = rescueRef("chat1", 9003, "feat-x");
    expect(res.entries[0]).toMatchObject({ d: "feat-x", state: "moved", ref, repo: wt });
    expect(g(local, "show", `${ref}:wt.txt`)).toBe("edited there");
    fsckClean(local);
  });

  it("never gives the local repo a commit whose parent is missing: shallow history comes as a parentless commit", async () => {
    const { root, local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    const up = `${root}/upstream`;
    mkdirSync(up, { recursive: true });
    g(up, "init", "-q", "-b", "main");
    for (const n of [1, 2, 3]) {
      writeFileSync(`${up}/u.txt`, `v${n}\n`);
      g(up, "add", "-A");
      g(up, "commit", "-q", "-m", `up ${n}`);
    }
    const D = `${workDir}/repo`;
    g(D, "fetch", "-q", "--depth", "1", `file://${up.startsWith("/") ? "" : "/"}${up}`, "main");
    g(D, "checkout", "-q", "--force", "--detach", "FETCH_HEAD");
    writeFileSync(`${D}/u.txt`, "edited on top\n");

    const res = await rescuer().r.run(job(workDir, [local]));
    const ref = rescueRef("chat1", 9003, "repo");
    expect(g(local, "rev-list", "--parents", "-n", "1", ref).split(" ")).toHaveLength(1); // no parent
    expect(g(local, "show", `${ref}:u.txt`)).toBe("edited on top");
    expect(res.entries[0]!.state).toBe("moved");
    fsckClean(local);
  });

  it("moves a checkout with nothing to save aside without a ref or a notice", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    const res = await rescuer().r.run(job(workDir, [local]));
    expect(res.entries).toMatchObject([{ d: "repo", state: "moved", pathCount: 0 }]);
    expect(res.entries[0]!.ref).toBeUndefined();
    expect(res.notice).toBeUndefined();
    expect(existsSync(`${workDir}.pre-0.2/repo`)).toBe(true);
    expect(g(local, "for-each-ref", "refs/dispatch")).toBe("");
  });

  it("an empty or missing workDir is done at once", async () => {
    const { root, local } = fixture();
    const res = await rescuer().r.run(job(`${root}/ct/nowhere`, [local]));
    expect(res).toEqual({ entries: [], notice: undefined, notices: [] });
  });

  it("concurrent spawns share one run", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    writeFileSync(`${workDir}/repo/a.ts`, "x\n");
    const counter = { connects: 0, execs: 0 };
    const { r } = rescuer();
    const j = job(workDir, [local], counter);
    const one = r.run(j);
    const two = r.run(j);
    expect(r.running("chat1")).toBe(true);
    expect(two).toBe(one);
    await Promise.all([one, two]);
    expect(counter.connects).toBe(1);
    expect(r.running("chat1")).toBe(false);
  });

  it("a second run after a finished one changes nothing and says the same", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    writeFileSync(`${workDir}/repo/a.ts`, "x\n");
    const one = rescuer();
    const first = await one.r.run(job(workDir, [local]));
    const again = await rescuer(one.kvNow()).r.run(job(workDir, [local]));
    expect(again).toEqual(first);
  });

  it("a pack over the cap is cut off at both ends without taking the process down, and leaves no ref", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    writeFileSync(`${workDir}/repo/big.txt`, "x".repeat(200_000) + Math.random()); // incompressible enough
    const one = rescuer({}, { caps: { packBytes: 1 } });
    const counter: Counter = { connects: 0, execs: 0 };
    await expect(one.r.run(job(workDir, [local], counter))).rejects.toThrow(/is over/);
    expect(counter.aborted).toBe(1); // the remote pack-objects was stopped too
    expect(g(local, "for-each-ref", "refs/dispatch")).toBe("");
    expect(existsSync(`${workDir}/repo`)).toBe(true); // not moved
    const two = rescuer(one.kvNow());
    const res = await two.r.run(job(workDir, [local]));
    expect(res.entries[0]).toMatchObject({ state: "moved", ref: rescueRef("chat1", 9003, "repo") });
  });

  it("a run resumed long after the first one started gets a full budget of its own", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    writeFileSync(`${workDir}/repo/a.ts`, "x\n");
    const hourAgo = Date.now() - 3_600_000;
    const stale = { vmid: 9003, phase: "failed", startedAt: hourAgo, updatedAt: hourAgo, entries: {}, failures: 2, lastError: "budget" };
    const counter: Counter = { connects: 0, execs: 0 };
    const res = await rescuer({ "rescue:chat1": stale }).r.run(job(workDir, [local], counter));
    expect(res.entries[0]!.state).toBe("moved");
    // Every command was allowed its own time, not the 1 s floor a spent clock gives.
    expect(Math.min(...counter.timeouts!)).toBeGreaterThan(60_000);
  });

  it("says so when the only unsaved files there were left out by the caps", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    execFileSync("sh", ["-c", `truncate -s 60M ${JSON.stringify(`${workDir}/repo/huge.bin`)}`]);
    const res = await rescuer().r.run(job(workDir, [local]));
    expect(res.entries[0]).toMatchObject({ state: "moved", excludedCount: 1 });
    expect(res.entries[0]!.ref).toBeUndefined();
    expect(res.notice).toContain("`huge.bin` (60 MB)");
    expect(res.notice).toContain(`${workDir}.pre-0.2/repo`);
  });

  it("a failure is recorded and counted; the next run finishes", async () => {
    const { local, workDir } = fixture();
    await legacySync(local, workDir, "repo");
    writeFileSync(`${workDir}/repo/a.ts`, "x\n");
    const one = rescuer({}, {
      afterStep: (s) => {
        if (s === "commit") throw new Error("ssh: connection lost");
      },
    });
    await expect(one.r.run(job(workDir, [local]))).rejects.toThrow(/container 9003: ssh: connection lost/);
    expect(one.kvNow()["rescue:chat1"]).toMatchObject({ phase: "failed", failures: 1, lastError: "ssh: connection lost" });
    const two = rescuer(one.kvNow());
    await two.r.run(job(workDir, [local]));
    expect(two.kvNow()["rescue:chat1"]).toMatchObject({ phase: "done", failures: 0 });
  });

  describe("killed between any two steps, a re-run ends exactly where an uninterrupted run does", () => {
    /** Two checkouts: one with a commit there and edits on top, one with nothing to save. Same shas every time. */
    async function scenario() {
      const f = fixture();
      await legacySync(f.local, f.workDir, "repo");
      const D = `${f.workDir}/repo`;
      writeFileSync(`${D}/b.txt`, "bee two\n");
      g(D, "commit", "-q", "-am", "container work");
      writeFileSync(`${D}/a.ts`, "edited\n");
      writeFileSync(`${D}/new.txt`, "new\n");
      rmSync(`${D}/c.txt`);
      await legacySync(f.local, f.workDir, "zclean");
      return f;
    }
    const outcome = (f: { local: string; workDir: string }, res: Awaited<ReturnType<LegacyRescue["run"]>>) => ({
      refs: g(f.local, "for-each-ref", "--format=%(refname) %(objectname)", "refs/dispatch"),
      left: existsSync(`${f.workDir}/repo`) || existsSync(`${f.workDir}/zclean`),
      aside: ["repo", "zclean"].map((d) => existsSync(`${f.workDir}.pre-0.2/${d}`)),
      entries: res.entries.map(({ repo: _repo, ...e }) => e),
      notice: res.notice?.replaceAll(f.workDir, "<w>"),
    });

    it("every kill point", async () => {
      const clean = await scenario();
      const steps: string[] = [];
      const cleanRun = await rescuer({}, { afterStep: (s, d) => void steps.push(`${s}:${d}`) }).r.run(job(clean.workDir, [clean.local]));
      const want = outcome(clean, cleanRun);
      expect(want.aside).toEqual([true, true]);
      expect(steps.length).toBeGreaterThanOrEqual(9);

      for (let k = 1; k <= steps.length; k++) {
        const f = await scenario();
        let n = 0;
        const killed = rescuer({}, {
          afterStep: () => {
            if (++n === k) throw new Error(`killed after ${steps[k - 1]}`);
          },
        });
        await expect(killed.r.run(job(f.workDir, [f.local]))).rejects.toThrow(/killed/);
        const res = await rescuer(killed.kvNow()).r.run(job(f.workDir, [f.local]));
        expect({ k, ...outcome(f, res) }).toEqual({ k, ...want });
        fsckClean(f.local);
      }
    }, 600_000);
  });
});
