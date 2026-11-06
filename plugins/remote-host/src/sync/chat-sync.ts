/**
 * One chat's checkout on one machine, kept in step with its local worktree
 * around every command: a three-way sync whose base is the last snapshot both
 * sides agreed on.
 *
 * Before a command (`beforeRun`), and fail closed:
 * 1. Pull back what changed on the machine since the base (a dev server's
 *    codegen, a background job), as after a command. If that fails it is
 *    said, and the push goes ahead: it never overwrites a change there.
 * 2. Refuse while a conflict is unresolved.
 * 3. Push: snapshot the worktree; if it isn't the base, send the objects the
 *    machine lacks (in batches it keeps, so a dropped connection resumes
 *    where it stopped) and check the snapshot out there.
 * 4. A foreground command takes the checkout's lock until it is over: a
 *    command in another terminal of the chat would otherwise sync files out
 *    from under it. One core stopped waiting for (timed out, cancelled)
 *    keeps it until the shell there says it ended, or the shell is gone.
 *
 * After a command (`afterRun`): pull back. Each path the machine changed
 * comes back where the local file still matches the base, checked against
 * the file itself at the moment of writing, not only the snapshot. Where both
 * sides changed it differently, the machine's version is saved beside the
 * local file (`<path>.from-<machine>`) and the next command is refused until
 * that copy is gone. The new base takes the machine's side of every path it
 * changed, so whatever the local file says once the copy is deleted wins.
 *
 * Nothing is ever overwritten on either side to make a sync go through. What
 * can't be brought back safely (a name Windows can't hold, a file here that
 * git ignores, a directory where a file goes) is set aside: left as it is on
 * both sides, and said once.
 *
 * Deletes are trusted least, because a damaged checkout there looks like a
 * command that deleted files:
 * - A checkout is known by an id written into its `.git` at setup and kept in
 *   the record. One without it, or with another, is set up again from your
 *   files, never read against the base. Only setup makes a checkout (a new
 *   terminal included); nothing makes a bare directory where one was.
 * - A pull-back that would delete more than half the files here, or more than
 *   {@link MASS_DELETE_MAX}, takes nothing and refuses the command (or says
 *   so, after one). The next command finds them deleted here too and syncs as
 *   usual, or puts them back there.
 * - Every delete it does bring back names the snapshot of your files just
 *   before, with the one line that gets them back.
 */
import type { PluginContext, PluginLog, TerminalAfterRunInfo, TerminalBeforeRunResult, TerminalRunInfo } from "@dispatch/plugin-sdk";
import { errText, git } from "@dispatch-plugins/remote-core";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ABSENT,
  DIR_HERE,
  EMPTY_TREE,
  holdsOnly,
  batches,
  composeTree,
  diffTrees,
  fileBlob,
  hasObject,
  inside,
  isAbsent,
  objectSizes,
  objectsFor,
  onDisk,
  packInto,
  pathProblem,
  receivePack,
  repoIds,
  sameEntry,
  setExec,
  snapshotBlobs,
  snapshotWorktree,
  treeMap,
  writeCopy,
  writeWorktree,
  type Change,
  type Entry,
  type Pin,
  type RepoIds,
} from "./local.js";
import {
  ClashError,
  StaleError,
  checkoutCommit,
  checkoutHasFiles,
  checkoutStatus,
  dropCheckoutGit,
  hashThere,
  initCheckout,
  missingObjects,
  receiveObjects,
  remotePaths,
  restoreThere,
  sendCommit,
  sendObjects,
  setBase,
  setCheckoutId,
  shellDir,
  type RemotePaths,
  type RemoteSide,
} from "./remote.js";

/** Untracked files bigger than this aren't sent; new files the machine makes bigger than this aren't brought back. */
export const DEFAULT_CAP_BYTES = 50 * 1024 * 1024;
/** One transfer batch: what a dropped connection costs at most. */
const BATCH_BYTES = 32 * 1024 * 1024;
/** Paths listed in a notice before "and N more". */
const LIST_MAX = 15;

export interface Conflict {
  path: string;
  /** Where the machine's version was saved. */
  copy: string;
  /** The command after which it was found. */
  by?: string;
  /** The machine's blob, and the id of the copy's bytes (`blobSha`): a copy moved over the file is the machine's version, kept. */
  host?: string;
  raw?: string;
}

/** What survives a restart, in kv `sync:<slug>:<chatId>` ({@link syncKey}). */
export interface SyncRecord {
  v: 1;
  root: string;
  base?: { commit: string; tree: string };
  /** Modes the local filesystem can't hold, by path. */
  overlay: Record<string, string>;
  /** Files written from the machine that hash differently here, by path. */
  pins: Record<string, Pin>;
  conflicts: Conflict[];
  /** Changes there set aside (not brought back), by path → blob, so each is said once. */
  skippedHost: Record<string, string>;
  /** Untracked local files too big to send, by path → size (said once per size). */
  skippedLocal: Record<string, number>;
  /** The id of the checkout `base` describes, written into its `.git` at setup (remote.ts's CHECKOUT_ID_FILE). */
  checkout?: string;
  /**
   * A bulk delete there that was held back ({@link MASS_DELETE_MAX}): against
   * which base, how many of how many files. The next command that still finds
   * it puts the files back there.
   */
  held?: { base: string; count: number; total: number };
}

/** A pull-back that would delete more files here than this, or more than half of them, is held back. */
export const MASS_DELETE_MAX = 50;

export interface ChatSyncDeps {
  chatId: string;
  /** The chat's local worktree root (a repository's top level). */
  root: string;
  /** The machine's label and slug, for messages and the conflict copy's name. */
  label: string;
  slug: string;
  instanceId: string;
  /** The machine's dispatch-host root (`~/.dispatch-host`), once connected. */
  hostRoot: () => Promise<string>;
  remote: RemoteSide;
  kv?: PluginContext["kv"];
  log: PluginLog;
  capBytes?: number;
  /** Most bytes per transfer batch (tests make it small). */
  batchBytes?: number;
}

interface Holder {
  runId: string;
  terminal: string;
  command: string;
  /** Core stopped waiting without the command being over. */
  ended?: "timed-out" | "cancelled";
}

export class ChatSync {
  private rec: SyncRecord;
  private loaded = false;
  private ids?: RepoIds;
  private paths?: RemotePaths;
  private chain: Promise<unknown> = Promise.resolve();
  private holder?: Holder;
  private readonly cap: number;
  /** Said with the next command: what a new terminal's setup found. */
  private pending: string[] = [];
  /** The paths of the bulk delete last held back, for its notice (the record keeps only counts). */
  private heldPaths: string[] = [];

  constructor(private readonly d: ChatSyncDeps) {
    this.rec = empty(d.root);
    this.cap = d.capBytes ?? DEFAULT_CAP_BYTES;
  }

  /** The local worktree this keeps in step. */
  get root(): string {
    return this.d.root;
  }

  async beforeRun(info: TerminalRunInfo): Promise<TerminalBeforeRunResult> {
    return this.serial(async () => {
      const h = this.holder;
      // A command core stopped waiting for may still be running, even in this terminal.
      if (h && (h.terminal !== info.terminal || h.ended)) return { refuse: this.busyText(h) };
      const notices: string[] = this.pending.splice(0);
      try {
        await this.prepare();
        try {
          await this.pullBack(notices, undefined, info.signal);
        } catch (err) {
          // The push never overwrites a change there it hasn't seen (git
          // refuses), so it can go ahead without the pull-back.
          if (info.signal.aborted) throw err;
          notices.push(
            `[${this.d.label}] Could not check for changes made there (${errText(err)}). Whatever changed there stays, and isn't overwritten.`,
          );
        }
        // A bulk delete there, just held back: fail closed until it is settled one way or the other.
        if (this.rec.held) return { refuse: `Not run: ${this.heldText(undefined)}`, notices };
        await this.resolved(notices);
        if (!this.rec.conflicts.length) await this.push(notices, info.signal);
        if (this.rec.conflicts.length) return { refuse: `Not run: ${this.conflictText()}`, notices };
      } catch (err) {
        return {
          refuse: `Not run: your files could not be synced to ${this.d.label} (${errText(err)}). The command would have run against stale files.`,
          notices,
        };
      }
      // Core has stopped waiting: this run won't happen, so it holds nothing.
      if (info.signal.aborted) return { refuse: "Not run: cancelled while syncing." };
      if (!info.background) this.holder = { runId: info.runId, terminal: info.terminal, command: info.command };
      return notices.length ? { notices } : {};
    });
  }

  async afterRun(info: TerminalAfterRunInfo): Promise<{ notices?: string[] }> {
    const h = this.holder;
    if (h?.runId === info.runId) {
      // Only "finished" (or a shell that is gone) means the command is over.
      if (info.outcome === "finished" || info.outcome === "shell-exited") this.holder = undefined;
      else h.ended = info.outcome;
    }
    return this.serial(async () => {
      const notices: string[] = [];
      try {
        await this.prepare();
        if (!this.rec.base) return {};
        await this.pullBack(notices, info.command, info.signal);
      } catch (err) {
        notices.push(
          `[${this.d.label}] Could not check for changes the command made there (${errText(err)}). ` +
            `They are brought back before the next command.`,
        );
      }
      if (this.rec.held) notices.push(this.heldText(info.command));
      if (this.rec.conflicts.length) notices.push(`The next command won't run until this is settled: ${this.conflictText()}`);
      return notices.length ? { notices } : {};
    });
  }

  /**
   * For a new shell: the directory it starts in, `sub` within the checkout.
   * A checkout that isn't there is set up (with a new id) rather than made by
   * a bare `mkdir -p`. If it had synced before, it is gone, so the record
   * starts again from your files and the next command says so.
   */
  async ensureCheckout(sub: string): Promise<void> {
    return this.serial(async () => {
      const p = await this.prepare();
      if ((await shellDir(this.d.remote, p, sub)) === "ready") return;
      const id = newCheckoutId();
      await initCheckout(this.d.remote, p, id);
      if (this.rec.base) {
        this.pending.push(`[${this.d.label}] This chat's checkout there was gone; it is set up again from your files. Nothing was deleted here.`);
      }
      this.rec.base = undefined;
      this.rec.conflicts = [];
      this.rec.held = undefined;
      this.rec.checkout = id;
      await this.save();
      if ((await shellDir(this.d.remote, p, sub)) !== "ready") throw new Error(`the checkout there could not be set up (${p.work})`);
    });
  }

  /** A terminal's shell ended: whatever it was running is over, and its lock goes. */
  releaseTerminal(terminal: string): void {
    if (this.holder?.terminal === terminal) this.holder = undefined;
  }

  /** The shell there says a run is over (one core stopped waiting for, say): it no longer holds the checkout. */
  runEnded(runId: string): void {
    if (this.holder?.runId === runId) this.holder = undefined;
  }

  /** Run `fn` after every earlier sync of this chat. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async prepare(): Promise<RemotePaths> {
    if (!this.loaded) {
      let saved = await this.d.kv?.get<SyncRecord>(this.key()).catch(() => undefined);
      if (!saved) {
        // Up to 0.5.9 the record was the chat's, whatever the machine: the
        // first machine to load it takes it over, as before.
        const legacy = legacySyncKey(this.d.chatId);
        saved = await this.d.kv?.get<SyncRecord>(legacy).catch(() => undefined);
        if (saved) {
          await this.d.kv?.set(this.key(), saved).catch(() => {});
          await this.d.kv?.delete(legacy).catch(() => {});
        }
      }
      if (saved && saved.v === 1 && saved.root === this.d.root) this.rec = { ...empty(this.d.root), ...saved };
      this.loaded = true;
    }
    this.ids ??= await repoIds(this.d.root);
    const root = await this.d.hostRoot();
    this.paths = remotePaths(root, this.d.instanceId, this.d.chatId, this.ids.repoName, this.ids.repoKey);
    return this.paths;
  }

  /**
   * Bring back what the machine changed since the base. `by` names the
   * command, for the notice (absent before a command: something running in
   * the background made the change).
   */
  private async pullBack(notices: string[], by: string | undefined, signal: AbortSignal, restored = false): Promise<void> {
    const p = this.paths!;
    const root = this.d.root;
    let base = this.rec.base;
    let st = await checkoutStatus(this.d.remote, p, base?.tree);
    if (!base && st.state !== "ok") return; // the first push sets it up
    // Is this the checkout the base describes? Not when it is gone, has no
    // .git (a command removed it, or it was wiped and its directory made
    // again), or carries another id than the record's. Read against the base,
    // its missing files would come back here as deletions: it did, live, on
    // cvx-mac. Such a checkout is set up again from your files instead.
    let foreign = st.state !== "ok";
    if (base && st.state === "ok") {
      if (this.rec.checkout) foreign = st.id !== this.rec.checkout;
      else await this.adoptCheckout(p, st.id);
      // Still the same checkout, its HEAD lost, and nothing but directories in it.
      if (!foreign && !st.head && !(await checkoutHasFiles(this.d.remote, p))) foreign = true;
    }
    if (foreign && base) {
      // Its files stay; the first push meets them as on any first sync (the same
      // file joins, a different one becomes a conflict copy here).
      if (st.state === "ok") await dropCheckoutGit(this.d.remote, p);
      this.rec.base = undefined;
      this.rec.checkout = undefined;
      this.rec.conflicts = [];
      this.rec.held = undefined;
      notices.push(
        `[${this.d.label}] This chat's checkout there was gone, or isn't the one last synced; it is set up again from your files. ` +
          `Nothing was deleted here.`,
      );
      await this.save();
      return;
    }
    if (base && st.state === "ok" && !st.head) {
      // The same checkout (its id says so), its HEAD lost (rebuilding it was
      // cut short, or HEAD names a commit it can't read), its files there:
      // rebuild it on the base, so what changed there is still seen as a change.
      await initCheckout(this.d.remote, p);
      await this.sendObjects(await objectsFor(root, base.commit, base.tree), signal);
      await setBase(this.d.remote, p, this.d.chatId, base.commit);
      notices.push(`[${this.d.label}] The checkout's HEAD there was gone or broken; it was rebuilt on the last sync, and the files there kept.`);
      st = await checkoutStatus(this.d.remote, p, base.tree);
      if (st.state !== "ok") throw new Error("the machine's checkout could not be rebuilt");
    }
    // Missing and no .git returned above; this only says so to the compiler.
    if (st.state !== "ok") return;
    if (!base) {
      // Dispatch lost its record (kv), the machine kept its own: carry on from it
      // rather than overwrite whatever changed there since.
      if (!st.base) return;
      base = this.rec.base = st.base;
      await this.adoptCheckout(p, st.id);
      st = await checkoutStatus(this.d.remote, p, base.tree);
      if (st.state !== "ok") return;
    }
    if (st.tree === base.tree) return this.unhold();
    if (!st.changes) {
      // The checkout can't see the base's objects (a gc there, a re-made .git
      // without its alternates): restore its link to the shared repository
      // and send them again.
      await initCheckout(this.d.remote, p);
      await this.sendObjects(await objectsFor(root, base.commit, base.tree), signal);
      st = await checkoutStatus(this.d.remote, p, base.tree);
      if (st.state !== "ok" || !st.changes) throw new Error("the machine's checkout has lost track of the last sync");
    }
    const host = st.changes;
    if (!host.length) return this.unhold();

    await this.ensureLocal(base.commit, signal);
    // Each change must start from the base: a machine is not trusted to say
    // what a file was, only what it is now.
    const was = await treeMap(root, base.tree);
    const off = host.find((c) => !sameEntry(was.get(c.path) ?? ABSENT, c.from));
    if (off) throw new Error(`the machine's changes don't start from the last sync (${off.path})`);

    const sub = (c: Change) => c.to.mode === "160000" || c.from.mode === "160000";
    const big = (c: Change) => isAbsent(c.from) && (st.sizes.get(c.to.sha) ?? 0) > this.cap;
    const again = (c: Change) => this.rec.skippedHost[c.path] === c.to.sha;
    // Fetch first, so the look at the worktree below is as late as it can be:
    // not a submodule's commit, a big new file, a blob set aside last time
    // for the same path, nor one that is here already.
    await this.fetchMissing(host.filter((c) => !isAbsent(c.to) && !sub(c) && !big(c) && !again(c)).map((c) => c.to.sha), signal);

    // The look, just before anything is written or deleted: the worktree
    // snapshotted exactly as a push would see it, and what is on disk where
    // that sees nothing (a file git ignores here, or one too big to send). An
    // edit made while the machine's changes were on their way is seen.
    const snap = await snapshotWorktree(root, this.snapOpts());
    const local = new Map((await diffTrees(root, base.tree, snap.tree)).map((c) => [c.path, c.to]));

    const accept: Change[] = [];
    const copies: Array<{ c: Change; copy: string }> = [];
    const aside: Array<{ c: Change; why: string }> = [];
    const said = { back: [] as string[], kept: [] as string[], sub: [] as string[] };
    const writes: Array<{ path: string } & Entry> = [];
    const deletes: string[] = [];
    /** Brought back, by path; a mode this filesystem can't hold is noted once the write went through. */
    const back = new Map<string, Change>();
    /** Only the mode is theirs: taken after the writes. */
    const modes: Change[] = [];
    const inTheWay: Change[] = [];

    const conflict = async (c: Change) => {
      const copy = `${c.path}.from-${this.d.slug}`;
      const bad = await pathProblem(root, copy);
      if (bad) aside.push({ c, why: `changed here too, and the machine's version can't be saved beside it: ${bad}` });
      else copies.push({ c, copy });
    };
    const take = (c: Change, disk: string) => {
      accept.push(c);
      back.set(c.path, c);
      said.back.push(`${tag(c)} ${c.path}`);
      if (isAbsent(c.to)) {
        if (disk === "file") deletes.push(c.path);
      } else if (c.to.sha !== c.from.sha || this.ids!.modes) writes.push({ path: c.path, ...c.to });
    };

    for (const c of host) {
      if (sub(c)) {
        said.sub.push(c.path);
        continue;
      }
      const bad = await pathProblem(root, c.path);
      // A directory in the way may be one the same changes empty: decided below.
      if (bad && bad !== DIR_HERE) {
        aside.push({ c, why: bad });
        continue;
      }
      const mine = local.get(c.path) ?? c.from;
      const disk = await onDisk(root, c.path);
      if (disk === "file" && isAbsent(mine)) {
        aside.push({ c, why: "here it is a file that isn't synced (ignored, or too big to send)" });
      } else if (sameEntry(mine, c.from)) {
        // Unchanged here: theirs comes back.
        if (disk === "dir" && !isAbsent(c.to)) inTheWay.push(c);
        else if (!isAbsent(c.from) && disk === "none") aside.push({ c, why: "it isn't checked out here (a sparse checkout?)" });
        else if (big(c)) aside.push({ c, why: `too big to bring back, ${mb(st.sizes.get(c.to.sha) ?? 0)}` });
        else take(c, disk);
      } else if (sameEntry(mine, c.to)) {
        accept.push(c);
      } else if (isAbsent(c.to)) {
        // Deleted there, edited here: keep the edit; it goes back next time.
        accept.push(c);
        said.kept.push(c.path);
      } else if (mine.sha === c.to.sha || c.from.sha === c.to.sha) {
        // Only the mode is theirs (an exec bit set there): take it, keep the content here.
        accept.push(c);
        modes.push(c);
      } else {
        await conflict(c);
      }
    }
    // A directory there that became a file: fine where the same changes
    // delete everything in the directory here.
    const deleting = new Set(deletes);
    for (const c of inTheWay) {
      if (isAbsent(c.from) && (await holdsOnly(root, c.path, deleting))) take(c, "dir");
      else aside.push({ c, why: DIR_HERE });
    }
    // Fail closed on a bulk delete: a checkout damaged there (half wiped, a
    // stray `rm -rf`) must not empty your worktree. Nothing of it is taken;
    // the next command either finds them deleted here too (meant: synced as
    // usual) or puts them back there from the last sync.
    const total = [...was.values()].filter((e) => e.mode !== "160000").length;
    if (deletes.length > MASS_DELETE_MAX || deletes.length * 2 > total) {
      const held = this.rec.held;
      if (!restored && held?.base === base.commit) {
        await restoreThere(this.d.remote, p, base.commit, deletes);
        this.rec.held = undefined;
        await this.save();
        notices.push(
          `[${this.d.label}] Put back there, from the last sync, the ${deletes.length} files deleted there that you didn't delete here: ` +
            `${list(deletes)}`,
        );
        return this.pullBack(notices, by, signal, true);
      }
      this.rec.held = { base: base.commit, count: deletes.length, total };
      this.heldPaths = deletes;
      await this.save();
      return;
    }
    if (this.rec.held) this.rec.held = undefined;
    // What was set aside last time and can be written now.
    await this.fetchMissing([...writes.map((w) => w.sha), ...copies.map((x) => x.c.to.sha)], signal);

    const failed = await writeWorktree(root, writes, deletes);
    const lost = new Set(failed.map((f) => f.path));
    for (const f of failed) aside.push({ c: back.get(f.path)!, why: `couldn't be written here: ${f.why.split("\n")[0]}` });
    said.back = said.back.filter((s) => !lost.has(s.slice(s.indexOf(" ") + 1)));
    for (const c of back.values()) if (!lost.has(c.path)) this.noteMode(c);
    for (const c of modes) await this.takeMode(c);
    const written = writes.filter((w) => !lost.has(w.path));
    // A blob that hashes differently once written here (CRLF content under
    // autocrlf): pin it, or the next push would rewrite the machine's file.
    await this.pin(written.map((w) => ({ path: w.path, host: w.sha })));
    for (const pth of deletes) {
      if (lost.has(pth)) continue;
      delete this.rec.overlay[pth];
      delete this.rec.pins[pth];
    }
    for (const x of copies) {
      let raw: string;
      try {
        raw = await writeCopy(root, x.c.to.sha, x.c.path, x.copy);
      } catch (err) {
        aside.push({ c: x.c, why: `changed here too, and the machine's version couldn't be saved beside it: ${errText(err)}` });
        continue;
      }
      accept.push(x.c);
      this.noteMode(x.c);
      this.addConflict({ path: x.c.path, copy: x.copy, ...(by ? { by } : {}), host: x.c.to.sha, raw });
    }

    const taken = accept.filter((c) => !lost.has(c.path));
    const next = await composeTree(root, base.tree, taken);
    if (next.tree !== base.tree) {
      await this.sendObjects(await objectsFor(root, next.commit, next.tree, base.tree), signal);
      await setBase(this.d.remote, p, this.d.chatId, next.commit);
      this.rec.base = next;
    }
    const fresh = aside.filter((a) => this.rec.skippedHost[a.c.path] !== a.c.to.sha);
    for (const c of taken) delete this.rec.skippedHost[c.path];
    for (const a of aside) this.rec.skippedHost[a.c.path] = a.c.to.sha;
    await this.save();

    const from = by ? ` by \`${short(by)}\`` : " (by something still running there)";
    if (said.back.length) notices.push(`[${this.d.label}] Brought back the changes made there${from}: ${list(said.back)}`);
    const gone = deletes.filter((d) => !lost.has(d));
    if (gone.length) {
      // The snapshot just taken holds them as they were here: name it, and the line that gets them back.
      notices.push(
        `[${this.d.label}] Deleted here, as they were deleted there${from}: ${list(gone)}. Your files from just before are in ` +
          `commit ${snap.commit}. To get these back: ${await restoreLine(root, snap.commit, gone)}`,
      );
    }
    if (said.kept.length) notices.push(`[${this.d.label}] Deleted there${from} but changed here, so your version was kept and goes back: ${list(said.kept)}`);
    if (fresh.length) {
      notices.push(
        `[${this.d.label}] Changed there${from} but not brought back, and left as they are on both sides: ` +
          `${list(fresh.map((a) => `${a.c.path} (${a.why})`))}`,
      );
    }
    if (said.sub.length) notices.push(`[${this.d.label}] Submodules aren't synced; changes there to ${list(said.sub)} stay there.`);
    if (st.head && st.head !== base.commit && st.head !== this.rec.base?.commit) {
      notices.push(
        `[${this.d.label}] Something there moved the checkout's HEAD (a commit or checkout there). Its files came back as changes; ` +
          `commit on this computer — the machine's checkout follows yours.`,
      );
    }
  }

  /** A held bulk delete settled outside the sync (put back there by hand): nothing left to hold. */
  private async unhold(): Promise<void> {
    if (!this.rec.held) return;
    this.rec.held = undefined;
    await this.save();
  }

  /**
   * A record from before checkout ids, or one Dispatch lost and took back from
   * the machine: take the checkout's id, or give it one now.
   */
  private async adoptCheckout(p: RemotePaths, id: string | undefined): Promise<void> {
    if (id) {
      this.rec.checkout = id;
      return;
    }
    const mine = newCheckoutId();
    await setCheckoutId(this.d.remote, p, mine);
    this.rec.checkout = mine;
  }

  private heldText(by: string | undefined): string {
    const h = this.rec.held!;
    const why = h.count > MASS_DELETE_MAX ? `more than ${MASS_DELETE_MAX}` : "more than half of them";
    const what = this.heldPaths.length ? `: ${list(this.heldPaths)}` : "";
    return (
      `${by ? `\`${short(by)}\` deleted` : "Something deleted"} ${h.count} of the ${h.total} files in this chat's checkout on ` +
      `${this.d.label}${what}. That is ${why}, so none of it was deleted here${by ? "" : ", and the command didn't run"}. ` +
      `If that is what you meant, delete them here too, then run the next command. If not, just run the next command: ` +
      `they are put back there from your files.`
    );
  }

  /** Conflicts whose copy is gone are settled: what the local file says now wins. */
  private async resolved(notices: string[]): Promise<void> {
    if (!this.rec.conflicts.length) return;
    const left: Conflict[] = [];
    const done: Conflict[] = [];
    for (const c of this.rec.conflicts) {
      if (await exists(inside(this.d.root, c.copy))) left.push(c);
      else done.push(c);
    }
    if (!done.length) return;
    // A copy moved over its file keeps the machine's version: pinned like
    // any file written from there, so it goes back exactly as it came.
    const kept: Array<{ path: string; host: string }> = [];
    for (const c of done) if (c.host && c.raw && (await fileBlob(this.d.root, c.path)) === c.raw) kept.push({ path: c.path, host: c.host });
    await this.pin(kept);
    this.rec.conflicts = left;
    await this.save();
    notices.push(`[${this.d.label}] Conflict settled, your version goes there: ${list(done.map((c) => c.path))}`);
  }

  private conflictText(): string {
    const items = this.rec.conflicts.map((c) => `\`${c.path}\` (theirs: \`${c.copy}\`${c.by ? `, changed by \`${short(c.by)}\`` : ""})`);
    return (
      `a conflict with ${this.d.label}. These files were changed both there and here since the last sync: ${list(items)}. ` +
      `The machine's version of each is saved beside yours. Merge what you want into your file, then delete the copy ` +
      `(to keep the machine's version, move the copy over your file). Once every copy is gone, your files go there and commands run again.`
    );
  }

  private busyText(h: Holder): string {
    const what = `\`${short(h.command)}\``;
    if (h.ended) {
      return (
        `Not run: in terminal "${h.terminal}", ${what} ${h.ended === "timed-out" ? "timed out" : "was cancelled"} and may still be ` +
        `running in this chat's checkout on ${this.d.label}; syncing your files now would change them under it. ` +
        `Wait for it to finish, or stop it (Ctrl-C in that terminal, or close the terminal).`
      );
    }
    return (
      `Not run: terminal "${h.terminal}" is still running ${what} in this chat's checkout on ${this.d.label}, ` +
      `and syncing your files now would change them under it. Wait for it to finish (or stop it), or run this in "${h.terminal}".`
    );
  }

  private async push(notices: string[], signal: AbortSignal): Promise<void> {
    const p = this.paths!;
    let snap = await snapshotWorktree(this.d.root, this.snapOpts());
    // A pin whose file changed since no longer applies.
    for (const path of Object.keys(this.rec.pins)) if (!snap.pinned.includes(path)) delete this.rec.pins[path];
    const big = snap.tooBig.filter((b) => this.rec.skippedLocal[b.path] !== b.size);
    this.rec.skippedLocal = Object.fromEntries(snap.tooBig.map((b) => [b.path, b.size]));
    if (big.length) {
      notices.push(
        `[${this.d.label}] Not sent, over ${mb(this.cap)} and untracked: ${list(big.map((b) => `${b.path} (${mb(b.size)})`))}. ` +
          `Commands there won't see them.`,
      );
    }
    const base = this.rec.base;
    if (base && snap.tree === base.tree) {
      await this.save();
      return;
    }
    const first = !base;
    const started = Date.now();
    if (first) {
      // Setting it up: the checkout gets its id, kept (once saved with the base) to know it by later.
      const id = this.rec.checkout ?? newCheckoutId();
      await initCheckout(this.d.remote, p, id);
      this.rec.checkout = id;
    }
    const sent = await this.sendObjects(await objectsFor(this.d.root, snap.commit, snap.tree, base?.tree), signal);
    if (signal.aborted) throw new Error("cancelled");
    for (let attempt = 0; ; attempt++) {
      try {
        await checkoutCommit(this.d.remote, p, this.d.chatId, snap.commit, !first || attempt > 0);
        break;
      } catch (err) {
        if (err instanceof ClashError && attempt === 0) {
          // Conflicts now: the command is refused until they are settled.
          if (!(await this.adoptClashes(err.paths, snap.tree, signal))) return;
          // Each joined, and their modes with them: snapshot again, against the new base.
          snap = await snapshotWorktree(this.d.root, this.snapOpts());
          await this.sendObjects(await objectsFor(this.d.root, snap.commit, snap.tree, this.rec.base!.tree), signal);
          continue;
        }
        if (err instanceof StaleError && err.file && this.rec.skippedHost[err.file] !== undefined) {
          throw new Error(
            `\`${err.file}\` changed on the machine but can't be brought back here (said earlier), and your files change it too. ` +
              `Nothing was overwritten; rename or undo your change to it here.`,
          );
        }
        throw err;
      }
    }
    this.rec.base = { commit: snap.commit, tree: snap.tree };
    await this.save();
    if (first) {
      notices.push(
        `[${this.d.label}] Set up this chat's files there (${p.work}): ${sent.objects} objects, ${mb(sent.bytes)}, in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
      );
    }
  }

  /**
   * Your files add paths the machine already has outside the sync (ignored
   * there, set aside, made since, or there before the first checkout). One
   * the same as yours just joins the sync; any other becomes a conflict, the
   * machine's version saved beside yours, rather than be overwritten.
   * Resolves true when every one joined, so the checkout can go ahead.
   */
  private async adoptClashes(paths: readonly string[], snapTree: string, signal: AbortSignal): Promise<boolean> {
    const p = this.paths!;
    const baseTree = this.rec.base?.tree ?? EMPTY_TREE;
    const there = await hashThere(this.d.remote, p, paths);
    const mine = await treeMap(this.d.root, snapTree);
    const adopt: Change[] = [];
    const copies: Array<{ path: string; to: Entry; copy: string }> = [];
    const blocked: string[] = [];
    for (const path of paths) {
      const t = there.get(path);
      if (!t || t === "dir" || t === "other") {
        blocked.push(`${path} (${t === "dir" ? "a directory" : "not a plain file"} there)`);
        continue;
      }
      const to = { mode: t.mode, sha: t.sha };
      if (mine.get(path)?.sha === t.sha) {
        adopt.push({ path, from: ABSENT, to });
        continue;
      }
      if (t.size > this.cap) {
        blocked.push(`${path} (${mb(t.size)} there, too big to bring back)`);
        continue;
      }
      const copy = `${path}.from-${this.d.slug}`;
      if (await pathProblem(this.d.root, copy)) {
        blocked.push(`${path} (its copy can't be saved here)`);
        continue;
      }
      copies.push({ path, to, copy });
    }
    await this.fetchMissing(copies.map((c) => c.to.sha), signal);
    let conflicts = 0;
    for (const c of copies) {
      let raw: string;
      try {
        raw = await writeCopy(this.d.root, c.to.sha, c.path, c.copy);
      } catch (err) {
        blocked.push(`${c.path} (its copy couldn't be saved here: ${errText(err)})`);
        continue;
      }
      adopt.push({ path: c.path, from: ABSENT, to: c.to });
      this.addConflict({ path: c.path, copy: c.copy, host: c.to.sha, raw });
      conflicts++;
    }
    if (adopt.length) {
      // The machine's files join the base, so once a copy is gone the local
      // version replaces the machine's like any other change.
      const next = await composeTree(this.d.root, baseTree, adopt);
      await this.sendObjects(await objectsFor(this.d.root, next.commit, next.tree, baseTree), signal);
      await setBase(this.d.remote, p, this.d.chatId, next.commit);
      this.rec.base = next;
      // Their mode joins too: one this filesystem can't hold is remembered.
      for (const c of adopt) this.noteMode(c);
      await this.save();
    }
    if (blocked.length) {
      throw new Error(
        `your files add paths that are already on the machine, outside the sync: ${list(blocked)}. ` +
          `Nothing was overwritten; rename yours here.`,
      );
    }
    return conflicts === 0;
  }

  private addConflict(k: Conflict): void {
    this.rec.conflicts = this.rec.conflicts.filter((x) => x.path !== k.path);
    this.rec.conflicts.push(k);
  }

  /** Pin each file that is the machine's blob `host` but hashes differently here; drop any other pin on it. */
  private async pin(files: ReadonlyArray<{ path: string; host: string }>): Promise<void> {
    const hashed = await snapshotBlobs(this.d.root, files.map((f) => f.path));
    for (const f of files) {
      const h = hashed.get(f.path);
      if (h && h !== f.host) this.rec.pins[f.path] = { local: h, host: f.host };
      else delete this.rec.pins[f.path];
    }
  }

  /** Send the machine whichever of `shas` it lacks, in batches it keeps. */
  private async sendObjects(shas: readonly string[], signal: AbortSignal): Promise<{ objects: number; bytes: number }> {
    const p = this.paths!;
    const missing = await missingObjects(this.d.remote, p, shas);
    if (!missing.length) return { objects: 0, bytes: 0 };
    const sizes = await objectSizes(this.d.root, missing);
    let bytes = 0;
    for (const batch of batches(missing, sizes, this.d.batchBytes ?? BATCH_BYTES)) {
      if (signal.aborted) throw new Error("cancelled");
      await receiveObjects(this.d.remote, p, (sink) => packInto(this.d.root, batch, sink), signal);
      for (const s of batch) bytes += sizes.get(s) ?? 0;
    }
    return { objects: missing.length, bytes };
  }

  /** Fetch whichever of `shas` (blobs the machine made) the local repository lacks. */
  private async fetchMissing(shas: readonly string[], signal: AbortSignal): Promise<void> {
    const want = [...new Set(shas)];
    if (!want.length) return;
    const have = await objectSizes(this.d.root, want);
    const missing = want.filter((s) => !have.has(s));
    if (!missing.length) return;
    const pipe = new PassThrough();
    const taking = receivePack(this.d.root, pipe);
    taking.catch(() => {});
    await sendObjects(this.d.remote, this.paths!, missing, pipe, signal);
    await taking;
  }

  /** The base's objects, here. They are normally (each base began here); a long-unused chat's may have been gc'd. */
  private async ensureLocal(commit: string, signal: AbortSignal): Promise<void> {
    if (await hasObject(this.d.root, commit)) return;
    const pipe = new PassThrough();
    const taking = receivePack(this.d.root, pipe);
    taking.catch(() => {});
    await sendCommit(this.d.remote, this.paths!, commit, pipe, signal);
    await taking;
  }

  /** A mode the machine set on a path whose content stays as it is here. */
  private async takeMode(c: Change): Promise<void> {
    if (this.ids!.modes) await setExec(this.d.root, c.path, c.to.mode).catch(() => {});
    else this.noteMode(c);
  }

  /** Remember a mode this filesystem can't hold, so the snapshot keeps the machine's. */
  private noteMode(c: Change): void {
    if (this.ids!.modes || isAbsent(c.to)) return;
    if (c.to.mode !== (isAbsent(c.from) ? "100644" : c.from.mode)) this.rec.overlay[c.path] = c.to.mode;
  }

  private snapOpts() {
    return {
      capBytes: this.cap,
      exclude: this.rec.conflicts.map((c) => c.copy),
      overlay: this.rec.overlay,
      pins: this.rec.pins,
      ...(this.rec.base ? { base: this.rec.base } : {}),
    };
  }

  private key(): string {
    return syncKey(this.d.slug, this.d.chatId);
  }

  private async save(): Promise<void> {
    try {
      await this.d.kv?.set(this.key(), this.rec);
    } catch (err) {
      this.d.log.warn(`remote-host ${this.d.slug}: could not save chat ${this.d.chatId}'s sync state: ${errText(err)}`);
    }
  }
}

/**
 * A chat's sync record on one machine. Per machine because its base is that
 * machine's checkout: a chat moved to another machine and back must not read
 * the old checkout against the other's base, or its stale files come back as
 * changes made there.
 */
export function syncKey(slug: string, chatId: string): string {
  return `sync:${slug}:${chatId}`;
}

/** Where the record was up to 0.5.9: one per chat. */
export function legacySyncKey(chatId: string): string {
  return `sync:${chatId}`;
}

function empty(root: string): SyncRecord {
  return { v: 1, root, overlay: {}, pins: {}, conflicts: [], skippedHost: {}, skippedLocal: {} };
}

/** A checkout's id (remote.ts's CHECKOUT_ID_FILE): a fresh one at every setup. */
function newCheckoutId(): string {
  return randomUUID();
}

/**
 * One line that puts `paths` back in the worktree as `commit` has them, in
 * any shell. A few plain names are listed in it; otherwise they go in a
 * pathspec file in this repository's git directory, each taken literally.
 */
async function restoreLine(root: string, commit: string, paths: readonly string[]): Promise<string> {
  const cmd = `git restore --source=${commit} --worktree`;
  if (paths.length <= 5 && paths.every((x) => /^[\w.@+/-]+$/.test(x) && !x.startsWith("-"))) {
    return `\`${cmd} -- ${paths.map((x) => `'${x}'`).join(" ")}\``;
  }
  const file = resolve(root, await git(root, ["rev-parse", "--git-path", `dispatch-restore-${commit.slice(0, 12)}`])).replace(/\\/g, "/");
  await writeFile(file, paths.map((x) => `:(literal)${x}\0`).join(""));
  return `\`${cmd} --pathspec-file-nul --pathspec-from-file=${file}\``;
}

/** The same content (or both absent), whatever the modes. */
function sameBlob(a: Entry, b: Entry): boolean {
  return isAbsent(a) ? isAbsent(b) : a.sha === b.sha;
}

function tag(c: Change): string {
  if (isAbsent(c.from)) return "A";
  if (isAbsent(c.to)) return "D";
  return c.from.sha === c.to.sha ? "mode" : "M";
}

function list(items: readonly string[]): string {
  const shown = items.slice(0, LIST_MAX).join(", ");
  return items.length > LIST_MAX ? `${shown}, and ${items.length - LIST_MAX} more` : shown;
}

function short(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}

function mb(n: number): string {
  return n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}
