/**
 * The checkout's foreground lock across every shell Dispatch runs, not only
 * this machine's (design §2.3; core E28, Dispatch #514).
 *
 * ChatSync's own lock keeps one chat's terminals on ONE machine from syncing
 * under each other. The same local files are also worked in by:
 * - a terminal on this computer (`local`) whose directory is inside them, of
 *   this chat or of another chat using the same files;
 * - this chat's terminals on another machine, or at another plugin's
 *   location, each syncing the same files around its own commands.
 *
 * Sync reads the files before a command (the push) and writes them after one
 * (the pull-back). While one of those runs a command, either can read a file
 * it is halfway through writing, or bring a change back over its work.
 *
 * What happens, per side:
 * - **Before a command here: refuse** (fail closed, the design's rule and
 *   what the per-machine lock does), naming the run that holds the files.
 *   Core gives no way to make that other shell wait, and waiting here could
 *   hang on a command that never ends. Between two of this plugin's machines
 *   the OLDER run keeps the files: both check, so two commands started
 *   together would otherwise refuse each other.
 * - **After a command here, before its pull-back: wait** for the other run
 *   to end, up to {@link AFTER_WAIT_MS}. A command on this computer can start
 *   while one runs there (nothing asks this plugin first), and the command
 *   here is already over, so nothing is left to refuse. Past the wait,
 *   nothing comes back yet, the agent is told, and the next command here
 *   brings it back.
 *
 * Background runs don't count, just as they don't take the per-machine lock:
 * a dev server would otherwise hold the files for as long as it serves.
 *
 * A Dispatch without `ctx.terminals.runs` (older than #514) has only the
 * per-machine lock.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/** One command a chat's shell runs now, anywhere: the fields of core's `TerminalRunInFlight` used here. */
export interface RunInFlight {
  runId: string;
  chatId: string;
  terminal: string;
  /** A backend id, or `local`. */
  backend: string;
  /** The shell's directory when the run started: a path on this computer for a `local` run. */
  cwd: string;
  /** Only for runs on this plugin's own backends. */
  command?: string;
  background: boolean;
  startedAt: number;
}

export interface RunsView {
  runs(): RunInFlight[];
  onRun?(fn: (e: { kind: "started" | "ended"; run: RunInFlight }) => void): () => void;
}

/** `ctx.terminals.runs` (and `onRun`), when this Dispatch has them (#514). Looked up, not assumed. */
export function runsOf(ctx: unknown): RunsView | undefined {
  const t = (ctx as { terminals?: { runs?: unknown; onRun?: unknown } } | undefined)?.terminals;
  if (!t || typeof t.runs !== "function") return undefined;
  const view = t as { runs(): RunInFlight[]; onRun?: RunsView["onRun"] };
  return {
    runs: () => view.runs(),
    ...(typeof view.onRun === "function" ? { onRun: (fn: Parameters<NonNullable<RunsView["onRun"]>>[0]) => view.onRun!(fn) } : {}),
  };
}

/** This plugin's backends. They check the lock too, so between them the older run keeps it. */
const OWN_PREFIX = "remote-host/";
/** How long a pull-back waits for another run in the files to end. */
export const AFTER_WAIT_MS = 2 * 60_000;
/** A wait this short isn't worth a notice. */
const WAIT_NOTICE_MS = 1_000;
/** How often a wait looks again, besides each run that ends (`onRun`). */
const POLL_MS = 500;

export interface CheckoutLockDeps {
  runs: RunsView;
  /** This machine's backend id: its own runs are ChatSync's per-machine lock. */
  self: string;
  /** A location by backend id, for messages: "this computer", a machine's name. */
  where(backend: string): string;
  /** Tests: the pull-back's wait. */
  afterWaitMs?: number;
}

export interface LockQuery {
  chatId: string;
  /** The chat's local files (a repository's top level). */
  root: string;
  /** This run, which is in flight too. */
  runId: string;
}

export interface WaitResult {
  waitedMs: number;
  /** What was waited for, if anything. */
  waitedFor: RunInFlight[];
  /** What still works in the files: the wait gave up (or was cancelled). */
  still: RunInFlight[];
}

export class CheckoutLock {
  constructor(private readonly d: CheckoutLockDeps) {}

  /**
   * Runs elsewhere that work in these files now, other than `q.runId`.
   * `before`: what refuses a command here. `after`: what a pull-back waits for.
   */
  async others(q: LockQuery, phase: "before" | "after"): Promise<RunInFlight[]> {
    let all: RunInFlight[];
    try {
      all = this.d.runs.runs();
    } catch {
      // Core's own state failing to read is no reason to stop every command:
      // the per-machine lock still holds.
      return [];
    }
    const me = all.find((r) => r.runId === q.runId);
    const out: RunInFlight[] = [];
    for (const r of all) {
      if (r.runId === q.runId || r.background || r.backend === this.d.self) continue;
      if (r.backend === "local") {
        if (await inFiles(q.root, r.cwd)) out.push(r);
      } else if (r.chatId === q.chatId) {
        // Another location's shell has its own directory there; what it shares
        // with this one is the chat's files here, which it syncs too.
        if (!r.backend.startsWith(OWN_PREFIX)) out.push(r);
        // Another of this plugin's machines can't have overlapped (the newer
        // one refused), and waiting on it after could wait on a wait.
        else if (phase === "before" && older(r, me)) out.push(r);
      }
    }
    return out;
  }

  /** Until nothing else works in the files, or the wait is up, or `signal` aborts. */
  async waitClear(q: LockQuery, signal: AbortSignal): Promise<WaitResult> {
    const max = this.d.afterWaitMs ?? AFTER_WAIT_MS;
    const start = Date.now();
    let waitedFor: RunInFlight[] = [];
    for (;;) {
      const still = await this.others(q, "after");
      if (still.length && !waitedFor.length) waitedFor = still;
      const waitedMs = Date.now() - start;
      if (!still.length || waitedMs >= max || signal.aborted) return { waitedMs, waitedFor, still };
      await this.next(signal, Math.min(POLL_MS, max - waitedMs));
    }
  }

  /** The command here was refused: why, and what to do. */
  refusal(runs: readonly RunInFlight[], chatId: string, label: string): string {
    return (
      `Not run: ${this.describe(runs, chatId)} running a command in this chat's files, and syncing them with ${label} now ` +
      `would read them while that command changes them, then bring changes back over its work. Wait for it to finish ` +
      `(or stop it), then run this again.`
    );
  }

  /** The pull-back waited, long enough to say. */
  waited(w: WaitResult, chatId: string, label: string): string | undefined {
    if (w.still.length || !w.waitedFor.length || w.waitedMs < WAIT_NOTICE_MS) return undefined;
    return (
      `[${label}] Waited ${age(w.waitedMs)} for ${this.describe(w.waitedFor, chatId, { verb: false, age: false })} to finish its command in this ` +
      `chat's files before bringing back what this one changed there.`
    );
  }

  /** The pull-back gave up waiting. */
  notBack(w: WaitResult, chatId: string, label: string): string {
    return (
      `[${label}] What the command changed there isn't brought back yet: ${this.describe(w.still, chatId)} still running a ` +
      `command in this chat's files. It comes back before the next command here.`
    );
  }

  /** `terminal "build" on this computer (for 12 s) is`: the first, what it runs when known, how long, and how many more. */
  private describe(runs: readonly RunInFlight[], chatId: string, o: { verb?: boolean; age?: boolean } = {}): string {
    const [r] = runs;
    if (!r) return "";
    const whose = r.chatId !== chatId ? " of another chat" : "";
    const facts = [r.command ? `\`${short(r.command)}\`` : "", o.age === false ? "" : `for ${age(Date.now() - r.startedAt)}`].filter(Boolean);
    const what = facts.length ? ` (${facts.join(", ")})` : "";
    const more = runs.length > 1 ? ` and ${runs.length - 1} more` : "";
    const verb = o.verb === false ? "" : more ? " are" : " is";
    return `terminal "${r.terminal}"${whose} on ${this.d.where(r.backend)}${what}${more}${verb}`;
  }

  /** The next run to end, or `ms`, or the abort: whichever is first. */
  private next(signal: AbortSignal, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let off: (() => void) | undefined;
      let over = false;
      const done = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        try {
          off?.();
        } catch {
          /* already gone */
        }
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      try {
        off = this.d.runs.onRun?.((e) => {
          if (e.kind === "ended") done();
        });
      } catch {
        /* the poll stands in */
      }
      if (over) off?.();
    });
  }
}

/** Whether `cwd` (a directory on this computer) is `root` or inside it, as given or as the real path. */
async function inFiles(root: string, cwd: string): Promise<boolean> {
  if (!cwd || !isAbsolute(cwd)) return false;
  const real = await realpath(cwd).catch(() => cwd);
  return [cwd, real].some((p) => {
    const rel = relative(root, p);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}

function older(r: RunInFlight, me: RunInFlight | undefined): boolean {
  // Not listed (a core that doesn't count a run until its command is written):
  // anything already running is older.
  if (!me) return true;
  return r.startedAt < me.startedAt || (r.startedAt === me.startedAt && r.runId < me.runId);
}

function short(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}
