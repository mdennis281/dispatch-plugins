/**
 * The local half of the code sync: turn the chat's worktree — committed,
 * staged, unstaged and untracked-but-not-ignored, exactly what `git status`
 * would show — into ONE commit, without touching the repository's real index,
 * stash, branches or HEAD.
 *
 * How: copy the worktree's index to a temp file (so git's stat cache makes
 * `add -A` fast on a big tree), point `GIT_INDEX_FILE` at the copy, `add -A`,
 * `write-tree`, `commit-tree -p HEAD`. Author and committer dates are pinned,
 * so the same tree on the same HEAD is the same commit sha every time — which
 * is what lets a sync before every command cost one `git add -A` and nothing
 * else when nothing changed.
 *
 * The commit is never referenced by any local ref; `git gc` collects it once
 * it is old enough. The remote checkout keeps it under `refs/dispatch/snapshot`.
 *
 * Then `pack()` produces the objects the remote lacks: `git pack-objects
 * --revs` fed the snapshot and `^<every commit the remote already has>`.
 * Not `--thin`, so the receiving `index-pack` needs no base objects — the
 * remote may be a shallow clone of GitHub, or nothing at all.
 */
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Pinned so identical trees produce identical commits (see header). */
const FIXED_DATE = "1700000000 +0000";

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) rej(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
        else res(stdout.trim());
      },
    );
  });
}

export interface RepoInfo {
  /** Absolute path of the worktree root that contains `cwd`. */
  root: string;
  /** The current branch, or undefined on a detached HEAD. */
  branch?: string;
  /** `origin`'s URL, when there is one. */
  originUrl?: string;
  head: string;
}

export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined);
  const originUrl = await git(root, ["remote", "get-url", "origin"]).catch(() => undefined);
  return { root: resolve(root), head, branch: branch || undefined, originUrl: originUrl || undefined };
}

/**
 * The snapshot commit for `root`'s worktree as it is right now. The real index
 * is copied, never written.
 */
export async function snapshot(root: string): Promise<string> {
  const realIndex = await git(root, ["rev-parse", "--git-path", "index"]);
  const indexPath = isAbsolute(realIndex) ? realIndex : join(root, realIndex);
  const dir = await mkdtemp(join(tmpdir(), "dispatch-snap-"));
  const tmpIndex = join(dir, "index");
  try {
    await copyFile(indexPath, tmpIndex).catch(() => {
      /* a repo with no index yet — `add -A` builds one from scratch */
    });
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ["add", "-A"], env);
    const tree = await git(root, ["write-tree"], env);
    const head = await git(root, ["rev-parse", "HEAD"]);
    return await git(root, ["commit-tree", tree, "-p", head, "-m", "dispatch: working-tree snapshot"], {
      GIT_AUTHOR_NAME: "Dispatch",
      GIT_AUTHOR_EMAIL: "dispatch@localhost",
      GIT_COMMITTER_NAME: "Dispatch",
      GIT_COMMITTER_EMAIL: "dispatch@localhost",
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Which of `shas` this repository has as commits. */
export async function localHas(root: string, shas: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const sha of shas) {
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const ok = await git(root, ["cat-file", "-e", `${sha}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (ok) out.push(sha);
  }
  return out;
}

/**
 * Stream a pack of everything reachable from `tip` but not from `exclude` into
 * `sink`. Resolves with the byte count once git exits 0.
 */
export function pack(
  root: string,
  tip: string,
  exclude: string[],
  sink: NodeJS.WritableStream,
): Promise<number> {
  return new Promise((res, rej) => {
    const child = spawn("git", ["pack-objects", "--revs", "--stdout", "-q"], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      bytes += c.length;
    });
    child.stdout.pipe(sink, { end: true });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res(bytes) : rej(new Error(`git pack-objects: ${stderr.trim() || code}`))));
    child.stdin.end([tip, ...exclude.map((s) => `^${s}`)].join("\n") + "\n");
  });
}

/**
 * Where a LOCAL directory lands on the remote machine: the same path relative to
 * the worktree root, under `remoteRoot`. A cwd outside the worktree (a project
 * with no worktree for this chat, say) maps to the root.
 */
export function remotePathFor(localRoot: string, localCwd: string, remoteRoot: string): string {
  const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(localRoot);
  const cwd = norm(localCwd);
  const same = process.platform === "win32" ? cwd.toLowerCase() === root.toLowerCase() : cwd === root;
  const inside = process.platform === "win32"
    ? cwd.toLowerCase().startsWith(root.toLowerCase() + "/")
    : cwd.startsWith(root + "/");
  if (same || !inside) return remoteRoot;
  return `${remoteRoot}/${cwd.slice(root.length + 1)}`;
}
