/**
 * The local half of the sync, against a real throwaway repository: "the real
 * index is untouched" is a claim about git, not about this code.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localHas, remotePathFor, repoInfo, snapshot } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  // Retries: on Windows a git child can still hold the directory for a moment.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rc-repo-"));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

describe("snapshot", () => {
  it("captures uncommitted and untracked files, skips ignored ones, and leaves the real index alone", async () => {
    const dir = gitRepo();
    const indexBefore = readFileSync(join(dir, ".git", "index"));
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "big.js"), "ignored\n");
    const sha = await snapshot(dir);
    const show = (p: string) => execFileSync("git", ["show", `${sha}:${p}`], { cwd: dir, stdio: "pipe" }).toString();
    expect(show("a.txt")).toBe("two\n");
    expect(show("new.txt")).toBe("untracked\n");
    expect(() => show("node_modules/big.js")).toThrow();
    // Real index byte-identical; nothing staged; HEAD unmoved.
    expect(readFileSync(join(dir, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir }).toString().trim()).toBe("");
    expect(execFileSync("git", ["stash", "list"], { cwd: dir }).toString().trim()).toBe("");
  });

  it("is deterministic: an unchanged tree on an unchanged HEAD is the same commit", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    expect(await snapshot(dir)).toBe(await snapshot(dir));
  });
});

describe("a repository with no commits yet", () => {
  // `git init` and some files, nothing committed: HEAD names a branch that
  // does not exist. A fresh project is exactly this, and its terminal must work.
  function unborn(): string {
    const dir = mkdtempSync(join(tmpdir(), "rc-unborn-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "a.txt"), "first\n");
    return dir;
  }

  it("repoInfo names the unborn branch and no head", async () => {
    const dir = unborn();
    const info = await repoInfo(dir);
    expect(info).toMatchObject({ branch: "trunk", head: undefined });
  });

  it("snapshots the worktree as a commit with no parent", async () => {
    const dir = unborn();
    const sha = await snapshot(dir);
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
    expect(g("show", `${sha}:a.txt`)).toBe("first");
    expect(g("rev-list", "--parents", "-n", "1", sha)).toBe(sha);
    expect(await snapshot(dir)).toBe(sha);
  });
});

describe("localHas", () => {
  it("says which shas are commits here, in order, asking git once", async () => {
    const dir = gitRepo();
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
    const first = g("rev-parse", "HEAD");
    const tree = g("rev-parse", "HEAD^{tree}");
    g("tag", "-a", "v1", "-m", "a tag object", first);
    const tag = g("rev-parse", "v1");
    writeFileSync(join(dir, "b.txt"), "b\n");
    g("add", "-A");
    g("commit", "-qm", "two");
    const second = g("rev-parse", "HEAD");
    const missing = "0123456789abcdef0123456789abcdef01234567";
    // GIT_TRACE logs every git process started; the sync asks about every ref
    // the remote has, and one process per sha was seconds per command on Windows.
    const traceDir = mkdtempSync(join(tmpdir(), "rc-trace-"));
    dirs.push(traceDir);
    const trace = join(traceDir, "trace.log");
    process.env.GIT_TRACE = trace;
    let has: string[];
    try {
      has = await localHas(dir, [second, missing, tree, first, "not-a-sha", tag, second]);
    } finally {
      delete process.env.GIT_TRACE;
    }
    // A tag peels to its commit; a tree is not one; duplicates stay duplicates.
    expect(has).toEqual([second, first, tag, second]);
    const started = existsSync(trace) ? readFileSync(trace, "utf8").split("\n").filter((l) => /built-in: git cat-file/.test(l)) : [];
    expect(started).toHaveLength(1);
  });

  it("starts no git at all for nothing to ask", async () => {
    expect(await localHas(process.cwd(), ["not-a-sha"])).toEqual([]);
  });
});

describe("remotePathFor", () => {
  it("maps a local cwd under the worktree onto the remote checkout", () => {
    const root = process.platform === "win32" ? "C:\\w\\repo" : "/w/repo";
    const sub = process.platform === "win32" ? "C:\\w\\repo\\packages\\server" : "/w/repo/packages/server";
    expect(remotePathFor(root, sub, "/root/work/repo")).toBe("/root/work/repo/packages/server");
    expect(remotePathFor(root, root, "/root/work/repo")).toBe("/root/work/repo");
    expect(remotePathFor(root, process.platform === "win32" ? "C:\\elsewhere" : "/elsewhere", "/r")).toBe("/r");
  });
});
