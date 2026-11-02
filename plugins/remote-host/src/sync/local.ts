/**
 * The local half of the sync: the chat's worktree as a commit, the objects a
 * machine lacks for it, and changes the machine made written back.
 *
 * A snapshot is the worktree exactly as `git status` sees it (committed,
 * staged, unstaged, untracked-but-not-ignored) as ONE parentless commit,
 * built in a temp index so the real index, HEAD and branches are never
 * touched. Parentless is what keeps transfers shallow: the machine gets the
 * tree it runs against and never the history behind it. Its identity and
 * dates are pinned, so the same tree is the same commit every time.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { git } from "@dispatch-plugins/remote-core";

export const ZERO = "0".repeat(40);
/** A path that isn't there, as git's raw diff spells it. */
export const ABSENT: Entry = { mode: "000000", sha: ZERO };

export const SNAPSHOT_MESSAGE = "dispatch: working-tree snapshot";
export const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "Dispatch",
  GIT_AUTHOR_EMAIL: "dispatch@localhost",
  GIT_COMMITTER_NAME: "Dispatch",
  GIT_COMMITTER_EMAIL: "dispatch@localhost",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

export interface Entry {
  mode: string;
  sha: string;
}

/** One path that differs between two trees. */
export interface Change {
  path: string;
  from: Entry;
  to: Entry;
}

export interface Snapshot {
  commit: string;
  tree: string;
  /** Untracked files left out for being over the size cap. */
  tooBig: Array<{ path: string; size: number }>;
  /** Pins that applied (their file is still as written); the rest are stale. */
  pinned: string[];
}

/**
 * A file written here from the machine's blob that hashes differently here
 * (CRLF content under autocrlf, say). While the file still hashes to `local`,
 * the snapshot says `host`: it is the same file, and sending it back would
 * rewrite the machine's.
 */
export interface Pin {
  local: string;
  host: string;
}

export interface SnapshotOptions {
  /** Untracked files bigger than this stay behind. */
  capBytes: number;
  /** Paths never to include (conflict copies). */
  exclude?: readonly string[];
  /** Modes the local filesystem can't hold (an exec bit, a symlink on Windows), by path. */
  overlay?: Readonly<Record<string, string>>;
  pins?: Readonly<Record<string, Pin>>;
}

export function isAbsent(e: Entry): boolean {
  return e.sha === ZERO;
}

export function sameEntry(a: Entry, b: Entry): boolean {
  return a.sha === b.sha && (a.mode === b.mode || (isAbsent(a) && isAbsent(b)));
}

/** git's `-z` raw diff (`:<mode> <mode> <sha> <sha> <status>\0<path>\0` …), renames off. */
export function parseRawDiff(z: string): Change[] {
  const parts = z.split("\0");
  const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i]!.replace(/^\n+/, "");
    const m = head.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z]\d*$/);
    if (!m) break;
    out.push({ path: parts[i + 1]!, from: { mode: m[1]!, sha: m[3]! }, to: { mode: m[2]!, sha: m[4]! } });
  }
  return out;
}

/** Where git keeps this worktree's index, as an absolute path. */
async function indexPath(root: string): Promise<string> {
  const p = await git(root, ["rev-parse", "--git-path", "index"]);
  return isAbsolute(p) ? p : join(root, p);
}

async function withTempIndex<T>(fn: (env: { GIT_INDEX_FILE: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rh-idx-"));
  try {
    return await fn({ GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The commit a tree's snapshot is: the same tree always gives the same sha. */
export function commitFor(root: string, tree: string): Promise<string> {
  return git(root, ["commit-tree", tree, "-m", SNAPSHOT_MESSAGE], SNAPSHOT_ENV);
}

export async function snapshotWorktree(root: string, opts: SnapshotOptions): Promise<Snapshot> {
  return withTempIndex(async (env) => {
    await copyFile(await indexPath(root), env.GIT_INDEX_FILE).catch(() => {
      /* no index yet: `add -A` builds one */
    });
    // What `add -A` would pick up new. Anything over the cap stays out, and is
    // never even hashed.
    const others = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const tooBig: Snapshot["tooBig"] = [];
    for (let i = 0; i < others.length; i += 64) {
      const sizes = await Promise.all(
        others.slice(i, i + 64).map(async (p) => {
          const s = await stat(join(root, p)).catch(() => undefined);
          return s?.isFile() && s.size > opts.capBytes ? { path: p, size: s.size } : undefined;
        }),
      );
      for (const s of sizes) if (s) tooBig.push(s);
    }
    const left = [...tooBig.map((b) => b.path), ...(opts.exclude ?? [])];
    const spec = [".", ...left.map((p) => `:(exclude,literal)${p}`)].join("\0") + "\0";
    await git(root, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], env, spec);

    const overlay = new Map(Object.entries(opts.overlay ?? {}));
    const pins = new Map(Object.entries(opts.pins ?? {}));
    const pinned: string[] = [];
    if (overlay.size || pins.size) {
      const listed = (await git(root, ["ls-files", "-s", "-z"], env)).split("\0").filter(Boolean);
      const fix: string[] = [];
      for (const line of listed) {
        const m = line.match(/^(\d{6}) ([0-9a-f]{40}) \d\t([\s\S]*)$/);
        if (!m) continue;
        const [, mode0, sha0, path] = m as unknown as [string, string, string, string];
        const pin = pins.get(path);
        const sha = pin && pin.local === sha0 ? pin.host : sha0;
        if (sha !== sha0) pinned.push(path);
        const mode = overlay.get(path) ?? mode0;
        if (mode !== mode0 || sha !== sha0) fix.push(`${mode} ${sha}\t${path}`);
      }
      if (fix.length) await git(root, ["update-index", "-z", "--index-info"], env, fix.join("\0") + "\0");
    }
    const tree = await git(root, ["write-tree"], env);
    return { tree, commit: await commitFor(root, tree), tooBig, pinned };
  });
}

/**
 * Why `p`, a path the machine reported, can't be written or deleted here
 * safely; undefined when it can. Git refuses some of these itself, but a
 * delete is ours, and a machine is not trusted to keep to git's rules.
 */
export async function pathProblem(root: string, p: string, win = process.platform === "win32"): Promise<string | undefined> {
  const parts = p.split("/");
  if (!p || p.startsWith("/") || parts.some((s) => s === "" || s === "." || s === "..")) return "not a plain relative path";
  if (parts.some((s) => /^\.git$/i.test(s) || /^git~\d+$/i.test(s))) return "inside .git";
  if (win) {
    const bad = parts.find(
      (s) => /[<>:"|?*\\\x00-\x1f]/.test(s) || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s),
    );
    if (bad !== undefined) return `"${bad}" is not a valid file name on Windows`;
  }
  // Every directory on the way must be a real directory (or not there yet):
  // never write or delete through a symlink, never replace a file by a folder.
  let at = resolve(root);
  for (const s of parts.slice(0, -1)) {
    at = join(at, s);
    const st = await lstat(at).catch(() => undefined);
    if (!st) break;
    if (st.isSymbolicLink()) return `${relPosix(root, at)} is a symlink here`;
    if (!st.isDirectory()) return `${relPosix(root, at)} is a file here`;
  }
  const st = await lstat(join(root, ...parts)).catch(() => undefined);
  if (st?.isDirectory()) return "it is a directory here";
  return undefined;
}

function relPosix(root: string, abs: string): string {
  return abs.slice(resolve(root).length + 1).split(sep).join("/");
}

/**
 * What each path holds here right now, as the blob `git add` would make of it
 * (null when there is nothing there, "dir" for a directory). Read at the last
 * moment before a write, so an edit made since the snapshot is seen.
 */
export async function localBlobs(root: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const files: string[] = [];
  for (const p of paths) {
    const st = await lstat(join(root, ...p.split("/"))).catch(() => undefined);
    if (!st) out.set(p, null);
    else if (st.isDirectory()) out.set(p, "dir");
    else if (st.isSymbolicLink()) out.set(p, blobSha(Buffer.from(await readlink(join(root, ...p.split("/"))))));
    else files.push(p);
  }
  if (files.length) {
    const shas = (await git(root, ["hash-object", "--stdin-paths"], {}, files.join("\n") + "\n")).split("\n");
    files.forEach((p, i) => out.set(p, shas[i] ?? null));
  }
  return out;
}

function blobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Which of `paths` this worktree's ignore rules ignore. */
export async function ignoredPaths(root: string, paths: readonly string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  // Exit 1 means "none ignored", which `git()` would call a failure.
  const out = await git(root, ["check-ignore", "-z", "--no-index", "--stdin"], {}, paths.join("\0") + "\0").catch(() => "");
  return new Set(out.split("\0").filter(Boolean));
}

/** Give `p` the exec bit of `mode` here (a filesystem that holds one). */
export async function setExec(root: string, p: string, mode: string): Promise<void> {
  const abs = inside(root, p);
  const st = await lstat(abs).catch(() => undefined);
  if (!st?.isFile()) return;
  const m = st.mode & 0o777;
  await chmod(abs, mode === "100755" ? m | ((m & 0o444) >> 2) : m & ~0o111);
}

export async function diffTrees(root: string, a: string, b: string): Promise<Change[]> {
  if (a === b) return [];
  return parseRawDiff(await git(root, ["diff-tree", "-r", "-z", "--no-renames", a, b]));
}

/**
 * The objects a machine needs to check `commit` out, given it already holds
 * tree `since` (when known): the commit, its root tree, and every tree and
 * blob that is new. Submodule commits are another repository's, so not these.
 */
export async function objectsFor(root: string, commit: string, tree: string, since?: string): Promise<string[]> {
  const shas = new Set<string>([commit, tree]);
  if (since) {
    const changes = parseRawDiff(await git(root, ["diff-tree", "-r", "-t", "-z", "--no-renames", since, tree]));
    for (const c of changes) if (!isAbsent(c.to) && c.to.mode !== "160000") shas.add(c.to.sha);
  } else {
    for (const line of (await git(root, ["ls-tree", "-r", "-t", "-z", tree])).split("\0")) {
      const m = line.match(/^\d{6} (blob|tree) ([0-9a-f]{40})\t/);
      if (m) shas.add(m[2]!);
    }
  }
  return [...shas];
}

/** Sizes of objects this repository has; missing ones are left out. */
export async function objectSizes(root: string, shas: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!shas.length) return out;
  const lines = (await git(root, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], {}, shas.join("\n") + "\n")).split("\n");
  for (const l of lines) {
    const m = l.match(/^([0-9a-f]{40}) (\d+)$/);
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

export async function hasObject(root: string, sha: string): Promise<boolean> {
  return (await objectSizes(root, [sha])).has(sha);
}

/** Split `shas` into batches of at most `maxBytes` (and 20 000 objects) each, so one lost connection loses one batch. */
export function batches(shas: readonly string[], sizes: ReadonlyMap<string, number>, maxBytes: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const s of shas) {
    const n = sizes.get(s) ?? 0;
    if (cur.length && (bytes + n > maxBytes || cur.length >= 20_000)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(s);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A pack of exactly `shas` (no history walk), streamed into `sink`. */
export function packInto(root: string, shas: readonly string[], sink: Writable): Promise<void> {
  return runGit(root, ["pack-objects", "--stdout", "-q"], { input: shas.join("\n") + "\n", stdout: sink });
}

/** Take a pack from `source` into this repository's objects. */
export function receivePack(root: string, source: Readable): Promise<void> {
  return runGit(root, ["index-pack", "--stdin"], { stdin: source });
}

function runGit(
  root: string,
  args: string[],
  io: { input?: string; stdin?: Readable; stdout?: Writable },
): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-4_000)));
    if (io.stdout) child.stdout.pipe(io.stdout, { end: true });
    else child.stdout.resume();
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res() : rej(new Error(`git ${args[0]}: ${err.trim() || `exit ${code}`}`))));
    child.stdin.on("error", () => {});
    if (io.stdin) io.stdin.pipe(child.stdin);
    else child.stdin.end(io.input ?? "");
  });
}

/**
 * `base` with `changes` applied (each path set to its `to`), as a commit.
 * The blobs needn't all be here: a tree only names them.
 */
export async function composeTree(root: string, base: string, changes: readonly Change[]): Promise<{ tree: string; commit: string }> {
  if (!changes.length) return { tree: base, commit: await commitFor(root, base) };
  return withTempIndex(async (env) => {
    await git(root, ["read-tree", base], env);
    const lines = changes.map((c) => (isAbsent(c.to) ? `0 ${ZERO}\t${c.path}` : `${c.to.mode} ${c.to.sha}\t${c.path}`));
    await git(root, ["update-index", "-z", "--index-info"], env, lines.join("\0") + "\0");
    const tree = await git(root, ["write-tree", "--missing-ok"], env);
    return { tree, commit: await commitFor(root, tree) };
  });
}

/** `p` under `root`, or an error: a path from the machine never lands outside the worktree. */
export function inside(root: string, p: string): string {
  const abs = resolve(root, p);
  const r = resolve(root);
  if (abs === r || !abs.startsWith(r + sep)) throw new Error(`refusing a path outside the worktree: ${p}`);
  return abs;
}

/**
 * Write the blobs of `writes` into the worktree the way a checkout would
 * (line endings, symlinks as this filesystem allows), and delete `deletes`.
 * Through a temp index: the real one is never touched. Returns what couldn't
 * be done, path by path, rather than failing the lot.
 */
export async function writeWorktree(
  root: string,
  writes: ReadonlyArray<{ path: string } & Entry>,
  deletes: readonly string[],
): Promise<Array<{ path: string; why: string }>> {
  const failed: Array<{ path: string; why: string }> = [];
  for (const p of deletes) {
    await rm(inside(root, p), { force: true }).catch((err: unknown) => failed.push({ path: p, why: String((err as Error).message ?? err) }));
  }
  if (!writes.length) return failed;
  for (const w of writes) inside(root, w.path);
  const checkout = (ws: ReadonlyArray<{ path: string } & Entry>) =>
    withTempIndex(async (env) => {
      await git(root, ["update-index", "-z", "--index-info"], env, ws.map((w) => `${w.mode} ${w.sha}\t${w.path}`).join("\0") + "\0");
      await git(root, ["checkout-index", "-f", "-z", "--stdin"], env, ws.map((w) => w.path).join("\0") + "\0");
    });
  try {
    await checkout(writes);
  } catch {
    for (const w of writes) await checkout([w]).catch((err: unknown) => failed.push({ path: w.path, why: String((err as Error).message ?? err) }));
  }
  return failed;
}

/** A blob as a checkout would write it at `path`, saved at `to` instead. */
export async function writeCopy(root: string, sha: string, path: string, to: string): Promise<void> {
  const target = inside(root, to);
  const bytes = await new Promise<Buffer>((res, rej) => {
    const child = spawn("git", ["cat-file", "--filters", `--path=${path}`, sha], { cwd: root, windowsHide: true });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res(Buffer.concat(chunks)) : rej(new Error(`git cat-file: ${err.trim()}`))));
  });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

export interface RepoIds {
  /** Names the machine's shared repository for every worktree of this local repository. */
  repoKey: string;
  /** Names the chat's checkout on the machine. */
  repoName: string;
  /** Whether the local filesystem holds exec bits and symlinks; when not, modes from the machine go in an overlay. */
  modes: boolean;
}

export async function repoIds(root: string): Promise<RepoIds> {
  const common = resolve(root, await git(root, ["rev-parse", "--git-common-dir"]));
  const name = safeId(basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, ""));
  const key = createHash("sha256").update(common.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 12);
  const bool = async (k: string) => (await git(root, ["config", "--bool", k]).catch(() => "")) !== "false";
  return { repoKey: `${name.slice(0, 40)}-${key}`, repoName: repoName(root), modes: (await bool("core.filemode")) && (await bool("core.symlinks")) };
}

/** The checkout's directory name on the machine, from the local worktree's. */
export function repoName(root: string): string {
  return safeId(basename(resolve(root))).slice(0, 64);
}

function safeId(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+$/, "") || "repo";
}
