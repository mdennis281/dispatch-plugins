/**
 * What Dispatch's chat lifecycle needs done on a machine.
 *
 * - `forget --chat C`: the chat was deleted. End its sessions, drop its refs
 *   in every shared repository, delete its session records (they hold its
 *   output), and move its directory to the trash. The trash is emptied in the
 *   background: a checkout with node_modules can take minutes to delete, and
 *   Dispatch waits on this for a minute at most.
 * - `forget --all`: the plugin was uninstalled. The same for this instance's
 *   whole namespace. Never another instance's.
 * - `chats`: the instance's chat directories, so Dispatch can find orphans
 *   (chats deleted while it wasn't listening).
 * - `gc`, about once a day:
 *   - empty the trash;
 *   - delete a shared repository no chat has used for a week;
 *   - let git collect garbage in the others and in each checkout, once git
 *     thinks it worthwhile.
 *
 *   A checkout borrows its repository's objects (alternates), and git can't
 *   see that from the repository's side. So before a repository is collected,
 *   each checkout's commits are pinned in it under `refs/dispatch/keep/`.
 *   Pruning only takes what has been unreachable for two weeks (git's
 *   default), so an object a sync is sending right now is never at risk.
 * - `instances`: every instance with a namespace here and when it last talked,
 *   so a namespace this Dispatch left under its previous id can be shown, and
 *   never adopted.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gitEnv } from "./git-env.js";
import { assertId, instanceLayout, type SessionRecord } from "./layout.js";
import { listRecords, readRecord } from "./records.js";

/** Where removed directories wait to be deleted. Machine-wide: garbage is garbage, whoever empties it. */
export function trashDir(root: string): string {
  return join(root, "trash");
}

/** Ends one session, as `kill` does. Passed in, so this module needs no process table. */
export type KillSession = (recordFile: string, rec: SessionRecord) => Promise<void>;

/** A trash entry is left alone this long, while the `rm` that was started for it runs. */
const TRASH_GRACE_MS = 10 * 60_000;

/**
 * Move `dir` to the trash and start deleting it in the background. Returns
 * false when there was nothing there. A rename, so it is instant, and what is
 * left of it if the delete is cut short goes with the next `gc`.
 */
export function discard(root: string, dir: string, label: string, now = Date.now()): boolean {
  if (!existsSync(dir)) return false;
  const trash = trashDir(root);
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  const to = join(trash, `${label}.${now.toString(36)}.${process.pid}`);
  renameSync(dir, to);
  // Its own session, so the end of this command (and of the SSH channel that
  // ran it) doesn't take it down. `chmod` first: a Go module cache or a
  // read-only build output can't be deleted otherwise.
  const child = spawn("/bin/sh", ["-c", 'chmod -R u+w "$1" 2>/dev/null; rm -rf "$1"', "sh", to], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  return true;
}

export interface ForgetResult {
  /** Sessions that were still running, now ended. */
  killed: string[];
  /** Session directories (records, journals) deleted. */
  sessions: number;
  /** Shared repositories whose refs for the chat were dropped. */
  refs: number;
  /** Whether the chat's (or the instance's) directory was there to remove. */
  removed: boolean;
  /** What could not be undone, per repository: git failed there. Present means "try again later". */
  errors?: string[];
}

/** The chat was deleted: everything this instance keeps for it here goes. Idempotent. */
export async function forgetChat(o: { root: string; instance: string; chat: string; kill: KillSession }): Promise<ForgetResult> {
  const chat = assertId("chat", o.chat);
  const { reposDir, chatsDir } = instanceLayout(o.root, o.instance);
  const killed: string[] = [];
  for (const { dir, rec } of listRecords(o.root, o.instance)) {
    if (rec.chat !== chat || rec.state === "exited") continue;
    await o.kill(join(dir, "session.json"), rec);
    killed.push(rec.sid);
  }
  let sessions = 0;
  for (const { dir, rec } of listRecords(o.root, o.instance)) {
    if (rec.chat !== chat || readRecord(join(dir, "session.json"))?.state !== "exited") continue;
    rmSync(dir, { recursive: true, force: true });
    sessions++;
  }
  // A git that won't run (an Xcode whose license isn't accepted, on cvx-mac)
  // must not pass for "nothing to delete": the chat's refs would stay, and
  // the objects under them, with nothing left to say so. Everything else
  // still goes; the caller is told, and tries again (core retries a delete).
  let refs = 0;
  const errors: string[] = [];
  for (const repo of repos(reposDir)) {
    // Not a repository (a sync that made the directory, then found git
    // broken, leaves it empty): no refs to forget. Asked of git, it would
    // fail every chat's delete here until gc took the directory away.
    if (!existsSync(join(repo, "HEAD")) || !existsSync(join(repo, "objects"))) continue;
    const names = [`refs/dispatch/chats/${chat}`, ...keepRefs(chat)];
    const list = await git(["--git-dir", repo, "for-each-ref", "--format=%(refname)", ...names]);
    if (list.code !== 0) {
      errors.push(`${basename(repo)}: ${gitError(list)}`);
      continue;
    }
    const had = list.stdout.trim();
    if (!had) continue;
    let dropped = true;
    for (const ref of had.split("\n")) {
      const d = await git(["--git-dir", repo, "update-ref", "-d", ref]);
      if (d.code !== 0) {
        errors.push(`${basename(repo)} ${ref}: ${gitError(d)}`);
        dropped = false;
      }
    }
    if (dropped) refs++;
  }
  const removed = discard(o.root, join(chatsDir, chat), `${o.instance}.chat-${chat}`);
  return { killed, sessions, refs, removed, ...(errors.length ? { errors } : {}) };
}

/** git's own first line of complaint, or how it ended. */
function gitError(r: { code: number; stderr: string }): string {
  const line = r.stderr.split("\n").map((l) => l.trim()).find(Boolean);
  return line ?? (r.code === -1 ? "git could not be run" : `git exited ${r.code}`);
}

/** The plugin was uninstalled: this instance's sessions end and its whole namespace goes. */
export async function forgetInstance(o: { root: string; instance: string; kill: KillSession }): Promise<ForgetResult> {
  const killed: string[] = [];
  for (const { dir, rec } of listRecords(o.root, o.instance)) {
    if (rec.state === "exited") continue;
    await o.kill(join(dir, "session.json"), rec);
    killed.push(rec.sid);
  }
  const removed = discard(o.root, instanceLayout(o.root, o.instance).dir, `${o.instance}.instance`);
  return { killed, sessions: 0, refs: 0, removed };
}

export interface ChatDir {
  chat: string;
  /** When the directory last changed (epoch ms): a chat made a moment ago is never taken for an orphan. */
  mtimeMs: number;
}

/** The chats this instance has a directory for. */
export function listChats(root: string, instance: string): ChatDir[] {
  const { chatsDir } = instanceLayout(root, instance);
  const out: ChatDir[] = [];
  for (const chat of entries(chatsDir)) {
    try {
      assertId("chat", chat);
      out.push({ chat, mtimeMs: statSync(join(chatsDir, chat)).mtimeMs });
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

export interface InstanceInfo {
  id: string;
  /** When a Dispatch last talked to it (epoch ms). */
  contactAt: number | null;
  /** Sessions its records say are still running. */
  running: number;
}

/** Every instance with a namespace on this machine. */
export function listInstances(root: string): InstanceInfo[] {
  const out: InstanceInfo[] = [];
  for (const id of entries(root)) {
    let contactAt: number | null;
    try {
      assertId("instance", id);
      contactAt = statSync(instanceLayout(root, id).contactFile).mtimeMs;
    } catch {
      continue; // runtime/, agent/, run/, trash/: not an instance
    }
    const running = listRecords(root, id).filter(({ rec }) => rec.state !== "exited").length;
    out.push({ id, contactAt, running });
  }
  return out;
}

export interface GcOptions {
  root: string;
  instance: string;
  now: number;
  /** A shared repository no chat's checkout uses is deleted after this long untouched. Default a week. */
  repoIdleMs?: number;
  /**
   * Tests: when git collects (`gc.auto`, `gc.autoPackLimit`; default 1000
   * loose objects or 20 packs) and how old an unreachable object must be to
   * go (`gc.pruneExpire`; default git's two weeks).
   */
  git?: { auto?: number; autoPackLimit?: number; pruneExpire?: string; force?: boolean };
}

export interface GcResult {
  /** Trash entries deleted. */
  trash: number;
  /** Unused shared repositories deleted. */
  reposRemoved: string[];
  /** Shared repositories git was given the chance to collect. */
  repos: number;
  /** Chat checkouts git was given the chance to collect. */
  checkouts: number;
  /** What went wrong along the way; the rest still ran. */
  errors: string[];
}

export async function collectGarbage(o: GcOptions): Promise<GcResult> {
  const result: GcResult = { trash: 0, reposRemoved: [], repos: 0, checkouts: 0, errors: [] };
  const note = (what: string, err: unknown) => result.errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);

  const trash = trashDir(o.root);
  for (const name of entries(trash)) {
    const at = parseInt(name.split(".").at(-2) ?? "", 36);
    if (Number.isFinite(at) && o.now - at < TRASH_GRACE_MS) continue;
    try {
      await sh('chmod -R u+w "$1" 2>/dev/null; rm -rf "$1"', join(trash, name));
      result.trash++;
    } catch (err) {
      note(`emptying ${name} from the trash`, err);
    }
  }

  // Which checkout borrows from which repository: its alternates entry.
  const { reposDir, chatsDir } = instanceLayout(o.root, o.instance);
  const users = new Map<string, Array<{ chat: string; work: string }>>();
  for (const chat of entries(chatsDir)) {
    for (const name of entries(join(chatsDir, chat))) {
      const work = join(chatsDir, chat, name);
      const objects = join(work, ".git", "objects");
      let alt: string;
      try {
        alt = readFileSync(join(objects, "info", "alternates"), "utf8");
      } catch {
        continue; // not a checkout (yet)
      }
      for (const line of alt.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const borrowed = resolve(objects, line);
        users.set(borrowed, [...(users.get(borrowed) ?? []), { chat, work }]);
      }
    }
  }

  for (const repo of repos(reposDir)) {
    const name = repo.slice(reposDir.length + 1);
    const using = users.get(resolve(repo, "objects")) ?? [];
    if (!using.length) {
      if (o.now - lastTouched(repo) > (o.repoIdleMs ?? 7 * 86_400_000)) {
        try {
          discard(o.root, repo, `${o.instance}.repo-${name}`, o.now);
          result.reposRemoved.push(name);
        } catch (err) {
          note(`removing ${name}`, err);
        }
      }
      continue;
    }
    try {
      await pinCheckouts(repo, using);
      await collect(["--git-dir", repo], o.git);
      result.repos++;
    } catch (err) {
      note(`collecting ${name}`, err);
    }
  }

  for (const chat of entries(chatsDir)) {
    for (const name of entries(join(chatsDir, chat))) {
      const work = join(chatsDir, chat, name);
      if (!existsSync(join(work, ".git"))) continue;
      try {
        await collect(["-C", work], o.git);
        result.checkouts++;
      } catch (err) {
        note(`collecting chat ${chat}'s ${name}`, err);
      }
    }
  }
  return result;
}

/**
 * Make every commit a checkout stands on reachable in the repository it
 * borrows from (`refs/dispatch/keep/<chat>-head|-base`), and drop the pins of
 * checkouts that are gone. A commit the repository doesn't have is the
 * checkout's own, out of the repository's gc's reach anyway.
 */
async function pinCheckouts(repo: string, using: ReadonlyArray<{ chat: string; work: string }>): Promise<void> {
  const keep = new Set<string>();
  for (const { chat, work } of using) {
    for (const [ref, rev] of [
      [`refs/dispatch/keep/${chat}-head`, "HEAD"],
      [`refs/dispatch/keep/${chat}-base`, "refs/dispatch/base"],
    ] as const) {
      const sha = (await git(["-C", work, "rev-parse", "-q", "--verify", `${rev}^{commit}`])).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
      if ((await git(["--git-dir", repo, "cat-file", "-e", `${sha}^{commit}`])).code !== 0) continue;
      const r = await git(["--git-dir", repo, "update-ref", ref, sha]);
      if (r.code !== 0) throw new Error(`pinning ${chat}'s ${rev}: ${r.stderr.trim()}`);
      keep.add(ref);
    }
  }
  const pinned = (await git(["--git-dir", repo, "for-each-ref", "--format=%(refname)", "refs/dispatch/keep/"])).stdout;
  for (const ref of pinned.split("\n").filter(Boolean)) {
    if (!keep.has(ref)) await git(["--git-dir", repo, "update-ref", "-d", ref]);
  }
}

/** git's own judgement of whether a collection is due, in the foreground, at our thresholds. */
async function collect(where: string[], t: GcOptions["git"] = {}): Promise<void> {
  const config = [
    `gc.auto=${t.auto ?? 1000}`,
    `gc.autoPackLimit=${t.autoPackLimit ?? 20}`,
    // In the foreground: the command's result means it is done, and nothing
    // of ours runs on after the SSH channel that started it.
    "gc.autoDetach=false",
    ...(t.pruneExpire ? [`gc.pruneExpire=${t.pruneExpire}`] : []),
  ].flatMap((c) => ["-c", c]);
  const r = await git([...where, ...config, "gc", ...(t.force ? [] : ["--auto"]), "--quiet"], 10 * 60_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git gc exited ${r.code}`);
}

function keepRefs(chat: string): string[] {
  return [`refs/dispatch/keep/${chat}-head`, `refs/dispatch/keep/${chat}-base`];
}

/** The shared repositories of an instance. */
function repos(reposDir: string): string[] {
  return entries(reposDir)
    .filter((n) => n.endsWith(".git"))
    .map((n) => join(reposDir, n));
}

/** When anything was last sent to, or recorded in, a shared repository. */
function lastTouched(repo: string): number {
  let latest = 0;
  for (const p of ["", "objects", "objects/pack", "refs", "refs/dispatch", "refs/dispatch/chats", "packed-refs"]) {
    try {
      latest = Math.max(latest, statSync(join(repo, p)).mtimeMs);
    } catch {
      /* not there */
    }
  }
  return latest;
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function git(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile("git", args, { env: gitEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolveRun({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function sh(script: string, arg: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    execFile("/bin/sh", ["-c", script, "sh", arg], { timeout: 10 * 60_000 }, (err) => (err ? reject(err) : resolveRun()));
  });
}
