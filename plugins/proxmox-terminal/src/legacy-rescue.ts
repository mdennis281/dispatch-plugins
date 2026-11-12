/**
 * Rescue what a pre-0.2 container holds before 0.2 stops using its checkouts
 * (plugin-deps design §4.3–4.5).
 *
 * Up to 0.1.x each chat's container had one git checkout per local repo, at
 * `<workDir>/<safeName(basename(local worktree root))>`. Before every command
 * the local worktree was snapshotted, the snapshot pushed as a pack, recorded
 * as `refs/dispatch/snapshot` and force-checked-out (detached). Nothing ever
 * came back. So a checkout can hold tracked edits the last commands made,
 * untracked files that piled up (a force checkout never removes them), and
 * commits made there. 0.2 runs terminals in a new checkout that remote-host
 * syncs both ways; the old one is moved aside.
 *
 * Before that, for every legacy checkout D:
 * 1. inspect: the last snapshot (`base`), its parent (the local HEAD it was
 *    taken on), the container's HEAD and refs.
 * 2. attribute: D belongs to the chat repo (the spawn's worktree, then its
 *    repo) whose object store has `base` or `base^1`. None: D is KEPT where
 *    it is, untouched, and listed.
 * 3. snapshot: on the container, from a copy of D's own index (so the stat
 *    cache holds and nothing is re-hashed), `add -u` plus the untracked files
 *    under the caps, then `write-tree`. Nothing touches D's working tree or
 *    its real index. Same tree and nothing committed there: nothing to save.
 * 4. commit: `commit-tree` with pinned identity and dates, so a re-run makes
 *    the same sha. Its parent is the container's HEAD when every commit the
 *    transfer would bring has its parents in the pack or the local repo;
 *    otherwise (a shallow clone, history the local repo never had) it has no
 *    parent, so the local repo never gets a commit with a missing parent.
 * 5. transfer: `pack-objects --thin` there, excluding what the local repo
 *    has, into `index-pack --fix-thin` here; verified, then the local ref
 *    `refs/dispatch/rescue/proxmox/<chat>/<vmid>/<D>`.
 * 6. move: `mv <workDir>/D <workDir>.pre-0.2/D`. The copy goes with the
 *    container.
 *
 * Every step is idempotent and its outcome is in kv `rescue:<chat>`, so a
 * crash, a kill or a budget overrun anywhere is finished by the next run.
 * Nothing is merged into the local worktree: the chat gets a notice saying
 * where the ref is and how to take a file from it.
 */
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { PluginContext } from "@dispatch/plugin-sdk";
import { channelExit, errText, git, localHas, sq, type SshConnection } from "@dispatch-plugins/remote-core";

/** A shell on the container: what the rescue needs from it, and no more. */
export interface RescueRemote {
  /** Run a POSIX `sh` command to completion, optionally feeding it stdin. */
  exec(cmd: string, opts?: { input?: string | Buffer; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Run a command, piping its stdout bytes into `sink` as they come; `sink` is ended after. */
  pipe(cmd: string, sink: Writable, opts: { timeoutMs: number; onBytes?: (total: number) => void }): Promise<{ code: number | null; stderr: string }>;
  close?(): void;
}

export interface RescueCaps {
  /** An untracked file larger than this is left out (and listed). */
  fileBytes: number;
  /** Untracked files are taken, in path order, until they total this much... */
  totalBytes: number;
  /** ...or this many. The rest are left out and listed. */
  files: number;
  /** The pack sent back may not exceed this. */
  packBytes: number;
}

const MB = 1024 * 1024;
export const DEFAULT_CAPS: RescueCaps = { fileBytes: 50 * MB, totalBytes: 500 * MB, files: 20_000, packBytes: 1024 * MB };
export const RESCUE_BUDGET_MS = 10 * 60_000;

export type RescueStep = "inspect" | "attribute" | "snapshot" | "commit" | "transfer" | "move";

export interface RescueJob {
  chatId: string;
  vmid: number;
  /** The container's legacy checkout dir (the 0.1 `workDir` setting). */
  workDir: string;
  /** Local repos D may belong to, in order of preference: the spawn's worktreePath, then repoPath. */
  candidates: string[];
  /** An open shell on the chat's (running) container. Called once per run; closed after. */
  connect(): Promise<RescueRemote>;
}

export interface RescuedPath {
  /** git's name-status letter: M, A, D, T. */
  status: string;
  path: string;
}

export interface RescueEntry {
  /** The checkout's directory name under workDir. */
  d: string;
  /** `rescued`: saved locally, not yet moved aside. `moved`: done. `kept`: left in place, see `reason`. */
  state: "rescued" | "moved" | "kept";
  /** The local ref holding what was saved. Absent when there was nothing to save. */
  ref?: string;
  commit?: string;
  /** The local repo it was saved in. */
  repo?: string;
  /** What `paths` are relative to, as something the local repo can resolve. */
  diffFrom?: string;
  /** Changed paths (the first {@link PATHS_KEPT}), and how many in all. */
  paths?: RescuedPath[];
  pathCount?: number;
  /** Commits made in the container on top of the last sync. */
  commits?: number;
  /** Untracked files left out by the caps (the first {@link PATHS_KEPT}), and how many in all. */
  excluded?: Array<{ path: string; bytes: number }>;
  excludedCount?: number;
  /** Why a `kept` checkout was left alone. */
  reason?: string;
}

/** kv `rescue:<chatId>`. */
export interface RescueState {
  vmid: number;
  phase: "running" | "done" | "failed";
  startedAt: number;
  updatedAt: number;
  entries: Record<string, RescueEntry>;
  /** Consecutive failed runs. */
  failures: number;
  lastError?: string;
}

export interface RescueResult {
  entries: RescueEntry[];
  /** For the chat, with the next command's result. Undefined when there is nothing to say. */
  notice?: string;
}

export interface LegacyRescueOptions {
  kv?: PluginContext["kv"];
  log: PluginContext["log"];
  budgetMs?: number;
  caps?: Partial<RescueCaps>;
  /** Test seam: runs after each step; a throw there is a crash at that point. */
  afterStep?: (step: RescueStep, d: string) => void | Promise<void>;
}

const PATHS_KEPT = 50;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** snapshot.ts pins its commits to this date too. */
const FIXED_DATE = "1700000000 +0000";
const IDENTITY = {
  GIT_AUTHOR_NAME: "Dispatch",
  GIT_AUTHOR_EMAIL: "dispatch@localhost",
  GIT_COMMITTER_NAME: "Dispatch",
  GIT_COMMITTER_EMAIL: "dispatch@localhost",
};
const SHA = /^[0-9a-f]{40}$/;

export class LegacyRescue {
  private readonly jobs = new Map<string, Promise<RescueResult>>();
  private readonly live = new Map<string, { step: string; d?: string; bytes?: number }>();
  private readonly caps: RescueCaps;

  constructor(private readonly opts: LegacyRescueOptions) {
    this.caps = { ...DEFAULT_CAPS, ...opts.caps };
  }

  /**
   * Run the chat's rescue, or join the run already going. Resolves when every
   * legacy checkout is saved and moved aside (or kept); rejects on any
   * failure, with the reason — the next run carries on from what is done.
   */
  run(job: RescueJob): Promise<RescueResult> {
    const inflight = this.jobs.get(job.chatId);
    if (inflight) return inflight;
    const p = this.execute(job).finally(() => {
      this.jobs.delete(job.chatId);
      this.live.delete(job.chatId);
    });
    this.jobs.set(job.chatId, p);
    return p;
  }

  /** A run is going for the chat right now. */
  running(chatId: string): boolean {
    return this.jobs.has(chatId);
  }

  /** What the chat's run is doing, for a refusal: "rescuing the old container: copying repo, 120 MB". */
  describe(chatId: string): string {
    const l = this.live.get(chatId);
    if (!l) return "rescuing the old container";
    const what = l.d ? `${l.step} ${l.d}` : l.step;
    return `rescuing the old container: ${what}${l.bytes ? `, ${Math.round(l.bytes / MB)} MB` : ""}`;
  }

  /** The stored state of the chat's rescue, if one ever ran. */
  async state(chatId: string): Promise<RescueState | undefined> {
    return this.opts.kv?.get<RescueState>(`rescue:${chatId}`);
  }

  /* ---------------------------------------------------------------- run */

  private async execute(job: RescueJob): Promise<RescueResult> {
    const key = `rescue:${job.chatId}`;
    const kv = this.opts.kv;
    const prior = await kv?.get<RescueState>(key);
    // Another container's progress says nothing about this one.
    const state: RescueState =
      prior && prior.vmid === job.vmid
        ? { ...prior, phase: "running", updatedAt: Date.now() }
        : { vmid: job.vmid, phase: "running", startedAt: Date.now(), updatedAt: Date.now(), entries: {}, failures: prior?.failures ?? 0 };
    const save = async () => {
      state.updatedAt = Date.now();
      await kv?.set(key, state);
    };
    await save();
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.opts.budgetMs ?? RESCUE_BUDGET_MS);
    timer.unref?.();
    let remote: RescueRemote | undefined;
    try {
      this.live.set(job.chatId, { step: "connecting" });
      remote = await job.connect();
      const ctx: RunCtx = { job, remote, state, save, signal: budget.signal };
      const present = await this.listCheckouts(ctx);
      for (const d of present) {
        this.checkBudget(ctx);
        await this.rescueOne(ctx, d);
      }
      // Moved aside by an earlier run that died before it said so.
      for (const e of Object.values(state.entries)) if (e.state === "rescued" && !present.includes(e.d)) e.state = "moved";
      state.phase = "done";
      state.failures = 0;
      state.lastError = undefined;
      await save();
      const entries = Object.values(state.entries).sort((a, b) => a.d.localeCompare(b.d));
      return { entries, notice: noticeFor(job, entries) };
    } catch (err) {
      const why = budget.signal.aborted ? `it ran over its ${Math.round((this.opts.budgetMs ?? RESCUE_BUDGET_MS) / 60_000)}-minute budget` : errText(err);
      state.phase = "failed";
      state.failures++;
      state.lastError = why;
      await save().catch(() => {});
      this.opts.log.warn(`rescuing chat ${job.chatId}'s container ${job.vmid} failed (attempt ${state.failures}): ${why}`);
      throw new Error(`could not rescue the old checkouts on container ${job.vmid}: ${why}`);
    } finally {
      clearTimeout(timer);
      remote?.close?.();
    }
  }

  private checkBudget(ctx: RunCtx): void {
    if (ctx.signal.aborted) throw new Error("budget");
  }

  private async step(ctx: RunCtx, step: RescueStep, d: string): Promise<void> {
    this.checkBudget(ctx);
    await this.opts.afterStep?.(step, d);
  }

  private timeout(ctx: RunCtx, ms = 120_000): number {
    // Never past the budget; a command cut off there fails the run.
    return Math.max(1_000, Math.min(ms, ctx.state.startedAt + (this.opts.budgetMs ?? RESCUE_BUDGET_MS) - Date.now() + 1_000));
  }

  /** The git checkouts directly under workDir, by directory name. */
  private async listCheckouts(ctx: RunCtx): Promise<string[]> {
    this.live.set(ctx.job.chatId, { step: "looking" });
    const w = sq(ctx.job.workDir);
    const r = await ctx.remote.exec(
      `[ -d ${w} ] || exit 0; cd ${w} && for d in * .[!.]* ..?*; do [ -d "$d/.git" ] && [ ! -L "$d" ] && printf '%s\\0' "$d"; done; exit 0`,
      { timeoutMs: this.timeout(ctx) },
    );
    if (r.code !== 0) throw new Error(`listing ${ctx.job.workDir}: ${r.stderr.trim()}`);
    return r.stdout.split("\0").filter(Boolean).sort();
  }

  private async rescueOne(ctx: RunCtx, d: string): Promise<void> {
    const { job, remote, state } = ctx;
    const dir = sq(`${job.workDir}/${d}`);
    const sh = async (cmd: string, opts: { input?: string | Buffer; ms?: number; env?: Record<string, string> } = {}) => {
      const env = Object.entries(opts.env ?? {})
        .map(([k, v]) => `${k}=${sq(v)}`)
        .join(" ");
      const r = await remote.exec(`cd ${dir} && ${env ? `export ${env} && ` : ""}${cmd}`, { input: opts.input, timeoutMs: this.timeout(ctx, opts.ms) });
      if (r.code !== 0) throw new Error(`on the container, in ${d}: ${r.stderr.trim() || `exit ${r.code}`}`);
      return r.stdout;
    };
    const setLive = (step: string, bytes?: number) => this.live.set(job.chatId, { step, d, bytes });

    // 1. inspect
    setLive("inspecting");
    const info = parseInfo(
      await sh(
        [
          `echo "base=$(git rev-parse -q --verify 'refs/dispatch/snapshot^{commit}')"`,
          `echo "base1=$(git rev-parse -q --verify 'refs/dispatch/snapshot^1' 2>/dev/null)"`,
          `echo "head=$(git rev-parse -q --verify 'HEAD^{commit}')"`,
          `echo "refs=$(git for-each-ref --format='%(objectname)' | tr '\\n' ' ')"`,
          `echo "shallow=$(cat "$(git rev-parse --git-dir)/shallow" 2>/dev/null | tr '\\n' ' ')"`,
          `echo "date=$( (git log -1 --format=%cd --date=raw refs/dispatch/snapshot || git log -1 --format=%cd --date=raw HEAD) 2>/dev/null)"`,
        ].join("; "),
      ),
    );
    await this.step(ctx, "inspect", d);

    // 2. attribute
    setLive("matching");
    const asked = uniq([info.base, info.base1, info.head, ...info.refs]);
    const marks = uniq(info.base ? [info.base, info.base1] : [info.head]);
    let repo: string | undefined;
    let has: string[] = [];
    for (const cand of job.candidates) {
      const h = await localHas(cand, asked).catch(() => [] as string[]);
      if (marks.some((m) => h.includes(m))) {
        repo = cand;
        has = h;
        break;
      }
    }
    if (!repo) {
      state.entries[d] = {
        d,
        state: "kept",
        reason: info.base || info.head ? "it matches none of this chat's repositories" : "it holds no commit to match it by",
      };
      await ctx.save();
      await this.step(ctx, "attribute", d);
      return;
    }
    await this.step(ctx, "attribute", d);

    // 3. snapshot, without touching D's working tree or real index
    setLive("snapshotting");
    const untracked = parseSizes(
      await sh(`git ls-files -o --exclude-standard -z | xargs -0 -r stat --printf='%s\\t%n\\0' --`, { ms: 300_000 }),
    );
    const { take, left } = this.capped(untracked);
    const add = take.length ? `git --literal-pathspecs add --pathspec-from-file=- --pathspec-file-nul && ` : "";
    const tree = (
      await sh(
        `gd=$(git rev-parse --git-dir) && idx="$gd/dispatch-rescue-index" && rm -f "$idx" && ` +
          `{ [ ! -f "$gd/index" ] || cp -p "$gd/index" "$idx"; } && export GIT_INDEX_FILE="$idx" && ` +
          `git add -u && ${add}git write-tree; rc=$?; rm -f "$idx"; exit $rc`,
        { input: take.length ? take.map((f) => f.path).join("\0") + "\0" : undefined, ms: 600_000 },
      )
    ).trim();
    if (!SHA.test(tree)) throw new Error(`write-tree gave ${JSON.stringify(tree)}`);
    const from = info.base ?? info.head ?? EMPTY_TREE;
    const paths = parseNameStatus(await sh(`git diff-tree -r --no-renames --name-status -z ${from} ${tree}`, { ms: 300_000 }));
    const commits = info.base && info.head && info.head !== info.base ? Number((await sh(`git rev-list --count ${info.base}..${info.head}`)).trim()) || 0 : 0;
    await this.step(ctx, "snapshot", d);

    const entry: RescueEntry = {
      d,
      state: "rescued",
      repo,
      pathCount: paths.length,
      paths: paths.slice(0, PATHS_KEPT),
      commits,
      excludedCount: left.length,
      excluded: left.slice(0, PATHS_KEPT),
    };
    if (paths.length > 0 || commits > 0) {
      // 4. commit
      setLive("saving");
      const exclude = has;
      const parent = info.head && (await this.completeOver(sh, info, exclude)) ? info.head : undefined;
      const message =
        `dispatch rescue: chat ${job.chatId}, container ${job.vmid}, ${d}\n\n` +
        `last sync ${info.base ?? "none"}\ncontainer HEAD ${info.head ?? "none"}` +
        (parent ? "" : "\n(no parent: the container's history is not all in your repository)");
      const date = info.date ?? FIXED_DATE;
      const commit = (
        await sh(`git commit-tree ${tree}${parent ? ` -p ${parent}` : ""} -F -`, {
          input: message,
          env: { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        })
      ).trim();
      if (!SHA.test(commit)) throw new Error(`commit-tree gave ${JSON.stringify(commit)}`);
      await sh(`git update-ref refs/dispatch/rescue ${commit}`);
      await this.step(ctx, "commit", d);

      // 5. transfer
      const ref = rescueRef(job.chatId, job.vmid, d);
      const current = await git(repo, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).catch(() => "");
      if (current !== commit || !(await this.complete(repo, commit, exclude))) {
        setLive("copying", 0);
        await this.transfer(ctx, dir, repo, commit, exclude, (b) => setLive("copying", b));
        if (!(await this.complete(repo, commit, exclude))) throw new Error(`the copy of ${d} arrived incomplete`);
        await git(repo, ["update-ref", ref, commit]);
      }
      entry.ref = ref;
      entry.commit = commit;
      entry.diffFrom = info.base && (await localHas(repo, [info.base])).length ? info.base : "HEAD";
      state.entries[d] = entry;
      await ctx.save();
      await this.step(ctx, "transfer", d);
    } else {
      state.entries[d] = entry;
      await ctx.save();
    }

    // 6. move aside
    setLive("moving aside");
    const src = sq(`${job.workDir}/${d}`);
    const aside = sq(`${job.workDir}.pre-0.2`);
    const dst = `${job.workDir}.pre-0.2/${d}`;
    const r = await remote.exec(
      `if [ -e ${src} ]; then mkdir -p ${aside} && dst=${sq(dst)} && { [ ! -e "$dst" ] || dst="$dst.$(date +%s)"; } && mv ${src} "$dst"; fi`,
      { timeoutMs: this.timeout(ctx) },
    );
    if (r.code !== 0) throw new Error(`moving ${d} aside: ${r.stderr.trim()}`);
    entry.state = "moved";
    state.entries[d] = entry;
    await ctx.save();
    await this.step(ctx, "move", d);
  }

  /** Untracked files, in path order, split into what is taken and what the caps leave out. */
  private capped(files: Array<{ path: string; bytes: number }>): { take: Array<{ path: string; bytes: number }>; left: Array<{ path: string; bytes: number }> } {
    const take: Array<{ path: string; bytes: number }> = [];
    const left: Array<{ path: string; bytes: number }> = [];
    let total = 0;
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      // A directory entry is an untracked nested repository: its commit can't come along.
      if (f.path.endsWith("/") || f.bytes > this.caps.fileBytes || total + f.bytes > this.caps.totalBytes || take.length >= this.caps.files) {
        left.push(f);
        continue;
      }
      take.push(f);
      total += f.bytes;
    }
    return { take, left };
  }

  /**
   * Would a commit on the container's HEAD arrive whole? Every commit the pack
   * brings must have each parent either in the pack or in the local repo, and
   * none may be a shallow boundary (its parent isn't on the container at all).
   */
  private async completeOver(
    sh: (cmd: string, opts?: { ms?: number }) => Promise<string>,
    info: Info,
    exclude: string[],
  ): Promise<boolean> {
    const lines = (await sh(`git rev-list --parents ${info.head}${exclude.map((x) => ` ^${x}`).join("")}`, { ms: 300_000 }))
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" "));
    const inPack = new Set(lines.map((l) => l[0]));
    const local = new Set(exclude);
    const shallow = new Set(info.shallow);
    for (const [c, ...parents] of lines) {
      if (shallow.has(c!)) return false;
      if (parents.some((p) => !inPack.has(p) && !local.has(p))) return false;
    }
    return true;
  }

  /** Does the local repo have `commit` and everything it reaches (past what it already had)? */
  private async complete(repo: string, commit: string, exclude: string[]): Promise<boolean> {
    const out = await git(repo, ["rev-list", "--objects", "--missing=print", commit, ...exclude.map((x) => `^${x}`)]).catch(() => undefined);
    return out !== undefined && !out.split("\n").some((l) => l.startsWith("?"));
  }

  /** Pack `commit` there (thin, minus `exclude`) straight into the local repo's object store. */
  private async transfer(
    ctx: RunCtx,
    dir: string,
    repo: string,
    commit: string,
    exclude: string[],
    onBytes: (total: number) => void,
  ): Promise<void> {
    const local = spawn("git", ["index-pack", "--stdin", "--fix-thin"], {
      cwd: repo,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let localErr = "";
    local.stderr.on("data", (c: Buffer) => (localErr += c.toString()));
    const localDone = new Promise<number | null>((res, rej) => {
      local.on("error", rej);
      local.on("close", res);
    });
    let tooBig = false;
    const revs = [commit, ...exclude.map((x) => `^${x}`)].join(" ");
    const r = await ctx.remote
      .pipe(`cd ${dir} && printf '%s\\n' ${revs} | git pack-objects --revs --stdout --thin -q`, local.stdin, {
        timeoutMs: this.timeout(ctx, 3_600_000),
        onBytes: (total) => {
          onBytes(total);
          if (total > this.caps.packBytes && !tooBig) {
            tooBig = true;
            local.kill();
          }
        },
      })
      .catch((err: unknown) => {
        local.kill();
        throw err;
      });
    const code = await localDone;
    if (tooBig) throw new Error(`the copy of what changed there is over ${Math.round(this.caps.packBytes / MB)} MB`);
    if (r.code !== 0) throw new Error(`pack-objects on the container: ${r.stderr.trim() || `exit ${r.code}`}`);
    if (code !== 0) throw new Error(`index-pack here: ${localErr.trim() || `exit ${code}`}`);
  }
}

interface RunCtx {
  job: RescueJob;
  remote: RescueRemote;
  state: RescueState;
  save(): Promise<void>;
  signal: AbortSignal;
}

interface Info {
  base?: string;
  base1?: string;
  head?: string;
  refs: string[];
  shallow: string[];
  date?: string;
}

function parseInfo(out: string): Info {
  const kv = new Map<string, string>();
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const sha = (k: string) => (SHA.test(kv.get(k) ?? "") ? kv.get(k) : undefined);
  const list = (k: string) => (kv.get(k) ?? "").split(/\s+/).filter((s) => SHA.test(s));
  const date = kv.get("date");
  return {
    base: sha("base"),
    base1: sha("base1"),
    head: sha("head"),
    refs: list("refs"),
    shallow: list("shallow"),
    date: date && /^\d+ [+-]\d{4}$/.test(date) ? date : undefined,
  };
}

function parseSizes(out: string): Array<{ path: string; bytes: number }> {
  return out
    .split("\0")
    .filter(Boolean)
    .map((rec) => {
      const tab = rec.indexOf("\t");
      return { bytes: Number(rec.slice(0, tab)) || 0, path: rec.slice(tab + 1) };
    });
}

function parseNameStatus(out: string): RescuedPath[] {
  const parts = out.split("\0");
  const res: RescuedPath[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    res.push({ status: parts[i]!, path: parts[i + 1]! });
  }
  return res;
}

function uniq(xs: Array<string | undefined>): string[] {
  return [...new Set(xs.filter((x): x is string => !!x))];
}

/** One ref-name component: what `git check-ref-format` accepts. */
function component(s: string): string {
  const c = s
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\./, "_")
    .replace(/\.lock$/, "_lock")
    .replace(/\.$/, "_");
  return c || "_";
}

/** Where the rescue of checkout `d` of chat `chatId`'s container `vmid` is kept in the local repo. */
export function rescueRef(chatId: string, vmid: number, d: string): string {
  return `refs/dispatch/rescue/proxmox/${component(chatId)}/${vmid}/${component(d)}`;
}

const STATUS: Record<string, string> = { M: "modified", A: "new", D: "deleted", T: "type changed" };

/** What the chat is told, once, with the next command's result. */
export function noticeFor(job: Pick<RescueJob, "workDir">, entries: RescueEntry[]): string | undefined {
  const parts: string[] = [];
  for (const e of entries) {
    if (e.state === "kept") {
      parts.push(
        `The old checkout \`${job.workDir}/${e.d}\` on this chat's container was left where it is: ${e.reason}. ` +
          `Nothing in it was copied or changed.`,
      );
      continue;
    }
    if (!e.ref) continue;
    const shown = (e.paths ?? []).slice(0, 10).map((p) => `\`${p.path}\` (${STATUS[p.status] ?? p.status})`);
    const more = (e.pathCount ?? 0) - shown.length;
    const changed = e.pathCount
      ? `${e.pathCount} path${e.pathCount === 1 ? "" : "s"} there differed from your last sync: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`
      : "nothing there differed from your last sync";
    const commits = e.commits ? ` It also holds ${e.commits} commit${e.commits === 1 ? "" : "s"} made in the container.` : "";
    const left = e.excludedCount
      ? ` Left out by the size caps: ${(e.excluded ?? [])
          .slice(0, 5)
          .map((f) => `\`${f.path}\` (${Math.max(1, Math.round(f.bytes / MB))} MB)`)
          .join(", ")}${e.excludedCount > 5 ? `, and ${e.excludedCount - 5} more` : ""}; they stay in the container's \`${job.workDir}.pre-0.2/${e.d}\` until it is destroyed.`
      : "";
    parts.push(
      `Before moving this chat's container to the new sync, ${changed} (checkout \`${e.d}\`).${commits} Nothing here was changed. ` +
        `They are saved as \`${e.ref}\`. Use \`git diff ${e.diffFrom ?? "HEAD"} ${e.ref} --stat\` to look, ` +
        `\`git checkout ${e.ref} -- <path>\` to take one, and \`git update-ref -d ${e.ref}\` when you are done.${left}`,
    );
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/** {@link RescueRemote} over remote-core's SSH connection. */
export function sshRescueRemote(conn: SshConnection): RescueRemote {
  return {
    exec: (cmd, opts = {}) =>
      conn.exec(cmd, {
        timeoutMs: opts.timeoutMs,
        stdin:
          opts.input === undefined
            ? undefined
            : async (ch) => {
                ch.end(opts.input);
              },
      }),
    pipe: async (cmd, sink, opts) => {
      const ch = await conn.channel(cmd);
      return new Promise((resolve, reject) => {
        let bytes = 0;
        let stderr = "";
        const timer = setTimeout(() => {
          ch.close();
          reject(new Error(`timed out after ${opts.timeoutMs}ms: ${cmd.slice(0, 80)}`));
        }, opts.timeoutMs);
        ch.on("data", (c: Buffer) => {
          bytes += c.length;
          opts.onBytes?.(bytes);
        });
        ch.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
        ch.pipe(sink);
        ch.on("close", () => {
          clearTimeout(timer);
          resolve({ code: channelExit(ch)?.code ?? null, stderr });
        });
        ch.end();
      });
    },
  };
}
