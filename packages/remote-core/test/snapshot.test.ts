/**
 * The local half of the sync, against a real throwaway repository: "the real
 * index is untouched" is a claim about git, not about this code.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remotePathFor, snapshot } from "../src/index.js";

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

describe("remotePathFor", () => {
  it("maps a local cwd under the worktree onto the remote checkout", () => {
    const root = process.platform === "win32" ? "C:\\w\\repo" : "/w/repo";
    const sub = process.platform === "win32" ? "C:\\w\\repo\\packages\\server" : "/w/repo/packages/server";
    expect(remotePathFor(root, sub, "/root/work/repo")).toBe("/root/work/repo/packages/server");
    expect(remotePathFor(root, root, "/root/work/repo")).toBe("/root/work/repo");
    expect(remotePathFor(root, process.platform === "win32" ? "C:\\elsewhere" : "/elsewhere", "/r")).toBe("/r");
  });
});
