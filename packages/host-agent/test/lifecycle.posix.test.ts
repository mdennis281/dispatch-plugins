/**
 * forget / chats / instances / gc against a real layout on disk, with real
 * git: a bare shared repository and chat checkouts borrowing from it through
 * a relative alternates entry, as remote-host's sync makes them. POSIX only
 * (the trash is emptied by /bin/sh); CI runs it on Linux and macOS.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix as P, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatWorktreePath, instanceLayout, repoPath, sessionPaths, type SessionRecord } from "../src/layout.js";
import { collectGarbage, forgetChat, forgetInstance, listChats, listInstances, trashDir, type KillSession } from "../src/lifecycle.js";
import { touchContact, writeRecord } from "../src/records.js";

const posix = process.platform !== "win32";
const I = "inst-a";
let root = "";

beforeEach(() => {
  if (!posix) return;
  root = join(realpathSync(mkdtempSync(join(tmpdir(), "dh-life-"))), "r");
  mkdirSync(root);
});
afterEach(() => {
  if (root) rmSync(join(root, ".."), { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

/** A snapshot commit made elsewhere (Dispatch's side) and sent to `repo` under `ref`. */
function send(repo: string, ref: string, files: Record<string, string>, opts: { force?: boolean } = {}): string {
  const src = mkdtempSync(join(tmpdir(), "dh-life-src-"));
  try {
    git(src, "init", "-q");
    for (const [f, body] of Object.entries(files)) writeFileSync(join(src, f), body);
    git(src, "add", "-A");
    git(src, "commit", "-qm", "snapshot");
    git(src, "push", "-q", ...(opts.force ? ["-f"] : []), repo, `HEAD:${ref}`);
    return git(src, "rev-parse", "HEAD");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

/**
 * A shared repository and a chat checkout borrowing from it, synced to one
 * snapshot, as the plugin leaves them: the snapshot's objects are in the
 * repository ONLY, and the checkout reaches them through its alternates.
 */
function syncedChat(chat: string, repoKey = "proj-abc", files: Record<string, string> = { "a.txt": "one\n" }) {
  const repo = repoPath(root, I, repoKey);
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "--bare");
  }
  const commit = send(repo, `refs/dispatch/chats/${chat}`, files);
  const work = chatWorktreePath(root, I, chat, "proj");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q");
  const objects = join(work, ".git", "objects");
  mkdirSync(join(objects, "info"), { recursive: true });
  writeFileSync(join(objects, "info", "alternates"), `${relative(objects, join(repo, "objects")).split("\\").join("/")}\n`);
  git(work, "update-ref", "--no-deref", "HEAD", commit);
  git(work, "read-tree", "-u", "--reset", commit);
  git(work, "update-ref", "refs/dispatch/base", commit);
  return { repo, work, commit };
}

/** Objects in the checkout's OWN store, alternates aside. */
const ownObjects = (work: string) =>
  execFileSync("find", [join(work, ".git", "objects"), "-type", "f", "-not", "-path", "*/info/*"], { encoding: "utf8" }).trim();

function record(sid: string, chat: string, state: SessionRecord["state"]): void {
  writeRecord(sessionPaths(root, I, sid).record, {
    v: 1,
    instance: I,
    chat,
    sid,
    agentVersion: "0.2.0",
    cwd: "/x",
    ownerPid: 999_999,
    state,
    startedAt: new Date().toISOString(),
    ...(state === "exited" ? { exit: { code: 0, signal: null, reason: "exited", at: new Date().toISOString() } } : {}),
  });
}

/** Marks a record exited, as a real kill does. */
const kill: KillSession & { calls: string[] } = Object.assign(
  async (file: string, rec: SessionRecord) => {
    kill.calls.push(rec.sid);
    writeRecord(file, { ...rec, state: "exited", exit: { code: null, signal: "SIGKILL", reason: "killed", at: new Date().toISOString() } });
  },
  { calls: [] as string[] },
);

const refs = (repo: string) => git(repo, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean).sort();
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!posix)("forget", () => {
  it("ends a deleted chat's sessions and removes its checkout, records and refs, and only its", async () => {
    kill.calls = [];
    const a = syncedChat("chat-a");
    syncedChat("chat-b");
    git(a.repo, "update-ref", "refs/dispatch/keep/chat-a-head", a.commit);
    record("s-run", "chat-a", "running");
    record("s-old", "chat-a", "exited");
    record("s-other", "chat-b", "running");

    const r = await forgetChat({ root, instance: I, chat: "chat-a", kill });
    expect(r).toEqual({ killed: ["s-run"], sessions: 2, refs: 1, removed: true });
    expect(kill.calls).toEqual(["s-run"]);
    expect(existsSync(join(instanceLayout(root, I).chatsDir, "chat-a"))).toBe(false);
    expect(existsSync(join(instanceLayout(root, I).chatsDir, "chat-b", "proj"))).toBe(true);
    expect(refs(a.repo)).toEqual(["refs/dispatch/chats/chat-b"]);
    expect(readdirSync(instanceLayout(root, I).sessionsDir)).toEqual(["s-other"]);
    // Moved to the trash at once, deleted there in the background.
    await until(() => readdirSync(trashDir(root)).length === 0);

    // Idempotent: core retries a delete that it thinks failed.
    expect(await forgetChat({ root, instance: I, chat: "chat-a", kill })).toEqual({ killed: [], sessions: 0, refs: 0, removed: false });
  });

  it("refuses a chat id that could reach outside its directory", async () => {
    await expect(forgetChat({ root, instance: I, chat: "../inst-b", kill })).rejects.toThrow(/chat must match/);
  });

  it("--all ends this instance's sessions and takes its whole namespace, never another instance's", async () => {
    kill.calls = [];
    syncedChat("chat-a");
    record("s-run", "chat-a", "running");
    touchContact(root, "inst-b");
    const r = await forgetInstance({ root, instance: I, kill });
    expect(r.killed).toEqual(["s-run"]);
    expect(r.removed).toBe(true);
    expect(existsSync(instanceLayout(root, I).dir)).toBe(false);
    expect(existsSync(instanceLayout(root, "inst-b").contactFile)).toBe(true);
  });
});

describe.skipIf(!posix)("chats and instances", () => {
  it("lists the instance's chat directories with when they last changed", () => {
    syncedChat("chat-a");
    mkdirSync(join(instanceLayout(root, I).chatsDir, "not a chat"), { recursive: true });
    const old = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(join(instanceLayout(root, I).chatsDir, "chat-a"), old, old);
    expect(listChats(root, I)).toEqual([{ chat: "chat-a", mtimeMs: old * 1000 }]);
    expect(listChats(root, "inst-none")).toEqual([]);
  });

  it("lists every instance with a contact stamp, and how many of its sessions are running", () => {
    touchContact(root, I);
    utimesSync(instanceLayout(root, I).contactFile, 1_700_000_000, 1_700_000_000);
    record("s1", "chat-a", "running");
    record("s2", "chat-a", "exited");
    touchContact(root, "inst-b");
    mkdirSync(join(root, "runtime", "node"), { recursive: true });
    const all = listInstances(root).sort((x, y) => x.id.localeCompare(y.id));
    expect(all.map((i) => [i.id, i.running])).toEqual([
      [I, 1],
      ["inst-b", 0],
    ]);
    expect(Math.round(all[0]!.contactAt! / 1000)).toBe(1_700_000_000);
  });
});

describe.skipIf(!posix)("gc", () => {
  it("empties old trash, leaving what a delete started a moment ago is still working on", async () => {
    const trash = trashDir(root);
    mkdirSync(join(trash, `x.chat-old.${(Date.now() - 3_600_000).toString(36)}.1`, "deep"), { recursive: true });
    mkdirSync(join(trash, `x.chat-new.${Date.now().toString(36)}.2`), { recursive: true });
    // A read-only directory, as a Go module cache leaves: rm alone can't delete inside it.
    const ro = join(trash, `x.chat-ro.${(Date.now() - 3_600_000).toString(36)}.3`, "mod");
    mkdirSync(ro, { recursive: true });
    writeFileSync(join(ro, "f"), "x");
    execFileSync("chmod", ["-R", "a-w", ro]);
    const r = await collectGarbage({ root, instance: I, now: Date.now() });
    expect(r.trash).toBe(2);
    expect(readdirSync(trash).map((n) => n.split(".")[1])).toEqual(["chat-new"]);
  });

  it("deletes a shared repository no checkout uses once it has sat a week, not before", async () => {
    const { repo } = syncedChat("chat-a");
    rmSync(join(instanceLayout(root, I).chatsDir, "chat-a"), { recursive: true });
    expect((await collectGarbage({ root, instance: I, now: Date.now() })).reposRemoved).toEqual([]);
    const r = await collectGarbage({ root, instance: I, now: Date.now() + 8 * 86_400_000 });
    expect(r.reposRemoved).toEqual([P.basename(repo)]);
    expect(existsSync(repo)).toBe(false);
  });

  it("pins each checkout's commits in the repository it borrows from, so a prune can't take them", async () => {
    const a = syncedChat("chat-a", "proj-abc", { "a.txt": "first\n" });
    // As in the plugin: the checkout's commit is in the repository only, not in its own store.
    expect(ownObjects(a.work)).toBe("");
    // The repository moved on (a newer snapshot) while the checkout still stands on the old one.
    send(a.repo, "refs/dispatch/chats/chat-a", { "a.txt": "second\n" }, { force: true });
    // And something nobody needs, to see the prune really ran.
    const junk = send(a.repo, "refs/junk", { "junk.txt": "junk\n" });
    git(a.repo, "update-ref", "-d", "refs/junk");
    // A pin left by a chat that is gone.
    git(a.repo, "update-ref", "refs/dispatch/keep/chat-gone-head", git(a.repo, "rev-parse", "refs/dispatch/chats/chat-a"));

    const r = await collectGarbage({ root, instance: I, now: Date.now(), git: { force: true, pruneExpire: "now" } });
    expect(r.errors).toEqual([]);
    expect(r.repos).toBe(1);
    expect(refs(a.repo)).toEqual(["refs/dispatch/chats/chat-a", "refs/dispatch/keep/chat-a-base", "refs/dispatch/keep/chat-a-head"]);
    expect(() => git(a.repo, "cat-file", "-e", `${junk}^{commit}`)).toThrow();
    // The checkout is whole: its commit and every object under it are still there.
    expect(git(a.work, "cat-file", "-p", `${a.commit}:a.txt`)).toBe("first");
    expect(git(a.work, "fsck", "--connectivity-only", "--no-dangling")).toBe("");
    expect(git(a.work, "status", "--porcelain")).toBe("");
  });
});
