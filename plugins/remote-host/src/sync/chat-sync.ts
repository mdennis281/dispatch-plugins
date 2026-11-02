/**
 * One chat's checkout on one machine, kept in step with its local worktree
 * around every command: a three-way sync whose base is the last snapshot both
 * sides agreed on.
 *
 * Before a command (`beforeRun`), and fail closed:
 * 1. Pull back what changed on the machine since the base (a dev server's
 *    codegen, a background job), as after a command.
 * 2. Refuse while a conflict is unresolved.
 * 3. Push: snapshot the worktree; if it isn't the base, send the objects the
 *    machine lacks (in batches it keeps, so a dropped connection resumes
 *    where it stopped) and check the snapshot out there.
 * 4. A foreground command takes the checkout's lock until its `afterRun`:
 *    a command in another terminal of the chat would otherwise sync files
 *    out from under it.
 *
 * After a command (`afterRun`): pull back. Each path the machine changed
 * comes back where the local file still matches the base. Where both sides
 * changed it differently, the machine's version is saved beside the local
 * file (`<path>.from-<machine>`) and the next command is refused until that
 * copy is gone. The new base takes the machine's side of every path it
 * changed, so whatever the local file says once the copy is deleted wins.
 */
import type { PluginContext, PluginLog, TerminalAfterRunInfo, TerminalBeforeRunResult, TerminalRunInfo } from "@dispatch/plugin-sdk";
import { errText } from "@dispatch-plugins/remote-core";
import { PassThrough } from "node:stream";
import { access } from "node:fs/promises";
import {
  batches,
  composeTree,
  diffTrees,
  hasObject,
  inside,
  isAbsent,
  objectSizes,
  objectsFor,
  packInto,
  receivePack,
  repoIds,
  sameEntry,
  snapshotWorktree,
  writeCopy,
  writeWorktree,
  type Change,
  type Entry,
  type RepoIds,
} from "./local.js";
import {
  checkoutCommit,
  checkoutStatus,
  initCheckout,
  missingObjects,
  receiveObjects,
  remotePaths,
  sendCommit,
  sendObjects,
  setBase,
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
}

/** What survives a restart, in kv `sync:<chatId>`. */
export interface SyncRecord {
  v: 1;
  root: string;
  base?: { commit: string; tree: string };
  /** Modes the local filesystem can't hold, by path. */
  overlay: Record<string, string>;
  conflicts: Conflict[];
  /** New files on the machine too big to bring back, by path → blob (said once per version). */
  skippedHost: Record<string, string>;
  /** Untracked local files too big to send, by path → size (said once per size). */
  skippedLocal: Record<string, number>;
}

export interface ChatSyncDeps {
  chatId: string;
  /** The chat's local worktree root. */
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

export class ChatSync {
  private rec: SyncRecord;
  private loaded = false;
  private ids?: RepoIds;
  private paths?: RemotePaths;
  private chain: Promise<unknown> = Promise.resolve();
  private holder?: { runId: string; terminal: string; command: string };
  private readonly cap: number;

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
      if (h && h.terminal !== info.terminal && h.runId !== info.runId) {
        return {
          refuse:
            `Not run: terminal "${h.terminal}" is still running \`${short(h.command)}\` in this chat's checkout on ${this.d.label}, ` +
            `and syncing your files now would change them under it. Wait for it to finish (or stop it), or run this in "${h.terminal}".`,
        };
      }
      const notices: string[] = [];
      try {
        await this.prepare();
        await this.pullBack(notices, undefined, info.signal);
        await this.resolved(notices);
        if (this.rec.conflicts.length) return { refuse: `Not run: ${this.conflictText()}`, notices };
        await this.push(notices, info.signal);
      } catch (err) {
        return {
          refuse: `Not run: your files could not be synced to ${this.d.label} (${errText(err)}). The command would have run against stale files.`,
          notices,
        };
      }
      if (!info.background) this.holder = { runId: info.runId, terminal: info.terminal, command: info.command };
      return notices.length ? { notices } : {};
    });
  }

  async afterRun(info: TerminalAfterRunInfo): Promise<{ notices?: string[] }> {
    if (this.holder?.runId === info.runId) this.holder = undefined;
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
      if (this.rec.conflicts.length) notices.push(`The next command won't run until this is settled: ${this.conflictText()}`);
      return notices.length ? { notices } : {};
    });
  }

  /** Run `fn` after every earlier sync of this chat. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async prepare(): Promise<RemotePaths> {
    if (!this.loaded) {
      const saved = await this.d.kv?.get<SyncRecord>(this.key()).catch(() => undefined);
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
  private async pullBack(notices: string[], by: string | undefined, signal: AbortSignal): Promise<void> {
    const p = this.paths!;
    let base = this.rec.base;
    let st = await checkoutStatus(this.d.remote, p, base?.tree);
    if (st.state === "missing") {
      if (!base) return;
      // Wiped, or never made on this machine: start again from the local files.
      this.rec.base = undefined;
      this.rec.conflicts = [];
      notices.push(`[${this.d.label}] This chat's checkout there was gone; it is set up again from your files.`);
      await this.save();
      return;
    }
    if (!base) {
      // Dispatch lost its record (kv), the machine kept its own: carry on from it
      // rather than overwrite whatever changed there since.
      if (!st.base) return;
      base = this.rec.base = st.base;
      st = await checkoutStatus(this.d.remote, p, base.tree);
      if (st.state === "missing") return;
    }
    if (st.tree === base.tree) return;
    if (!st.changes) {
      // The machine lost the base's objects (a gc, a wiped repository): send them again.
      await this.sendObjects(await objectsFor(this.d.root, base.commit, base.tree), signal);
      st = await checkoutStatus(this.d.remote, p, base.tree);
      if (st.state === "missing" || !st.changes) throw new Error("the machine's checkout has lost track of the last sync");
    }
    const host = st.changes.filter((c) => this.rec.skippedHost[c.path] !== c.to.sha);
    if (!host.length) return;

    // Where the local side stands, against the same base.
    await this.ensureLocal(base.commit, signal);
    const snap = await snapshotWorktree(this.d.root, this.snapOpts());
    const local = new Map((await diffTrees(this.d.root, base.tree, snap.tree)).map((c) => [c.path, c.to]));

    const accept: Change[] = [];
    const writes: Array<{ path: string } & Entry> = [];
    const deletes: string[] = [];
    const copies: Array<{ path: string; sha: string; copy: string }> = [];
    const said = { back: [] as string[], kept: [] as string[], big: [] as string[], sub: [] as string[] };

    for (const c of host) {
      const mine = local.get(c.path) ?? c.from;
      if (c.to.mode === "160000" || c.from.mode === "160000") {
        said.sub.push(c.path);
        continue;
      }
      if (sameEntry(mine, c.to)) {
        accept.push(c);
        continue;
      }
      if (sameEntry(mine, c.from)) {
        if (isAbsent(c.from) && (st.sizes.get(c.to.sha) ?? 0) > this.cap) {
          this.rec.skippedHost[c.path] = c.to.sha;
          said.big.push(`${c.path} (${mb(st.sizes.get(c.to.sha) ?? 0)})`);
          continue;
        }
        accept.push(c);
        if (isAbsent(c.to)) deletes.push(c.path);
        else if (c.to.sha !== mine.sha || this.ids!.modes) writes.push({ path: c.path, ...c.to });
        this.noteMode(c);
        said.back.push(`${tag(c)} ${c.path}`);
        continue;
      }
      // Both sides changed it.
      if (isAbsent(c.to)) {
        // Deleted there, edited here: keep the edit; it goes back next time.
        accept.push(c);
        said.kept.push(c.path);
        continue;
      }
      if (mine.sha === c.to.sha || c.from.sha === c.to.sha) {
        // Only a mode differs (an exec bit set there): take it, keep the content here.
        accept.push(c);
        this.noteMode(c);
        continue;
      }
      accept.push(c);
      const copy = `${c.path}.from-${this.d.slug}`;
      copies.push({ path: c.path, sha: c.to.sha, copy });
      this.rec.conflicts = this.rec.conflicts.filter((x) => x.path !== c.path);
      this.rec.conflicts.push({ path: c.path, copy, ...(by ? { by } : {}) });
    }

    const need = [...new Set([...writes.map((w) => w.sha), ...copies.map((c) => c.sha)])];
    if (need.length) await this.fetch(need, signal);
    await writeWorktree(this.d.root, writes, deletes);
    for (const c of copies) await writeCopy(this.d.root, c.sha, c.path, c.copy);
    for (const pth of deletes) delete this.rec.overlay[pth];

    const next = await composeTree(this.d.root, base.tree, accept);
    if (next.tree !== base.tree) {
      await this.sendObjects(await objectsFor(this.d.root, next.commit, next.tree, base.tree), signal);
      await setBase(this.d.remote, p, this.d.chatId, next.commit);
      this.rec.base = next;
    }
    await this.save();

    const from = by ? ` by \`${short(by)}\`` : " (by something still running there)";
    if (said.back.length) notices.push(`[${this.d.label}] Brought back the changes made there${from}: ${list(said.back)}`);
    if (said.kept.length) notices.push(`[${this.d.label}] Deleted there${from} but changed here, so your version was kept and goes back: ${list(said.kept)}`);
    if (said.big.length) notices.push(`[${this.d.label}] New files made there are too big to bring back (over ${mb(this.cap)}), and stay only there: ${list(said.big)}`);
    if (said.sub.length) notices.push(`[${this.d.label}] Submodules aren't synced; changes there to ${list(said.sub)} stay there.`);
    if (st.head && st.head !== base.commit && st.head !== this.rec.base?.commit) {
      notices.push(
        `[${this.d.label}] Something there moved the checkout's HEAD (a commit or checkout there). Its files came back as changes; ` +
          `commit on this computer — the machine's checkout follows yours.`,
      );
    }
  }

  /** Conflicts whose copy is gone are settled: what the local file says now wins. */
  private async resolved(notices: string[]): Promise<void> {
    if (!this.rec.conflicts.length) return;
    const left: Conflict[] = [];
    const done: string[] = [];
    for (const c of this.rec.conflicts) {
      if (await exists(inside(this.d.root, c.copy))) left.push(c);
      else done.push(c.path);
    }
    if (!done.length) return;
    this.rec.conflicts = left;
    await this.save();
    notices.push(`[${this.d.label}] Conflict settled, your version goes there: ${list(done)}`);
  }

  private conflictText(): string {
    const items = this.rec.conflicts.map((c) => `\`${c.path}\` (theirs: \`${c.copy}\`${c.by ? `, changed by \`${short(c.by)}\`` : ""})`);
    return (
      `a conflict with ${this.d.label}. These files were changed both there and here since the last sync: ${list(items)}. ` +
      `The machine's version of each is saved beside yours. Merge what you want into your file, then delete the copy ` +
      `(to keep the machine's version, move the copy over your file). Once every copy is gone, your files go there and commands run again.`
    );
  }

  private async push(notices: string[], signal: AbortSignal): Promise<void> {
    const p = this.paths!;
    const snap = await snapshotWorktree(this.d.root, this.snapOpts());
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
      if (big.length) await this.save();
      return;
    }
    const first = !base;
    const started = Date.now();
    if (first) await initCheckout(this.d.remote, p);
    const since = base && (await hasObject(this.d.root, base.tree)) ? base.tree : undefined;
    const sent = await this.sendObjects(await objectsFor(this.d.root, snap.commit, snap.tree, since), signal);
    if (signal.aborted) throw new Error("cancelled");
    await checkoutCommit(this.d.remote, p, this.d.chatId, snap.commit);
    this.rec.base = { commit: snap.commit, tree: snap.tree };
    await this.save();
    if (first) {
      notices.push(
        `[${this.d.label}] Set up this chat's files there (${p.work}): ${sent.objects} objects, ${mb(sent.bytes)}, in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
      );
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

  /** Fetch blobs the machine made into the local repository. */
  private async fetch(shas: readonly string[], signal: AbortSignal): Promise<void> {
    const pipe = new PassThrough();
    const taking = receivePack(this.d.root, pipe);
    taking.catch(() => {});
    await sendObjects(this.d.remote, this.paths!, shas, pipe, signal);
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

  private noteMode(c: Change): void {
    if (this.ids!.modes || isAbsent(c.to)) return;
    if (c.to.mode !== (isAbsent(c.from) ? "100644" : c.from.mode)) this.rec.overlay[c.path] = c.to.mode;
  }

  private snapOpts() {
    return { capBytes: this.cap, exclude: this.rec.conflicts.map((c) => c.copy), overlay: this.rec.overlay };
  }

  private key(): string {
    return `sync:${this.d.chatId}`;
  }

  private async save(): Promise<void> {
    try {
      await this.d.kv?.set(this.key(), this.rec);
    } catch (err) {
      this.d.log.warn(`remote-host ${this.d.slug}: could not save chat ${this.d.chatId}'s sync state: ${errText(err)}`);
    }
  }
}

function empty(root: string): SyncRecord {
  return { v: 1, root, overlay: {}, conflicts: [], skippedHost: {}, skippedLocal: {} };
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
