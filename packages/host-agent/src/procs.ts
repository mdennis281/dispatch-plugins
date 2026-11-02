/**
 * The host's process table, as `ps` and `lsof` print it. Kept as pure parsing
 * and planning functions so they can be tested anywhere. The few calls that
 * run `ps`, `pgrep` and `lsof` sit at the bottom.
 *
 * WHAT A SESSION OWNS. The shell is started with `setsid`, so its pid is its
 * session id and its process group. It owns:
 * - its descendants by parent pid;
 * - every process in its process group, which has the shell's pid as its id.
 *   A non-interactive bash runs every job there, and the group outlives the
 *   shell, so this finds a background job reparented to launchd after the
 *   shell died. (Measured: macOS `pgrep -s` doesn't find those once the
 *   session leader is gone.);
 * - every process still in its session (`pgrep -s`), where that works;
 * - every process the owner saw in its tree and recorded with its start
 *   time ("tracked"), which catches one that left the session with `setsid`
 *   or a double fork;
 * - the descendants of all of those.
 *
 * Process groups are killed as well as pids, so a child forked between the
 * listing and the kill still goes.
 */
import { execFile } from "node:child_process";

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps -o lstart=`, e.g. `Sun Nov  1 12:00:00 2026`. With the pid, a process's identity. */
  start: string;
  command: string;
}

/** The `ps` that {@link parsePs} reads. `-A` means "every process" on both macOS and Linux. */
export const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,lstart=,command="];

/** Rows of `ps -A -o pid=,ppid=,pgid=,lstart=,command=`. `lstart` is always five words. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const w = line.trim().split(/\s+/);
    if (w.length < 8) continue;
    const [pid, ppid, pgid] = w.slice(0, 3).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    rows.push({ pid: pid!, ppid: ppid!, pgid: pgid!, start: w.slice(3, 8).join(" "), command: w.slice(8).join(" ") });
  }
  return rows;
}

/** `roots` and every process descended from one of them. Roots not in `rows` are left out. */
export function descendantsOf(rows: readonly ProcRow[], roots: Iterable<number>): Set<number> {
  const children = new Map<number, number[]>();
  const alive = new Set<number>();
  for (const r of rows) {
    alive.add(r.pid);
    const list = children.get(r.ppid);
    if (list) list.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const out = new Set<number>();
  const stack = [...roots].filter((p) => alive.has(p));
  while (stack.length) {
    const pid = stack.pop()!;
    if (out.has(pid) || pid <= 1) continue;
    out.add(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

/**
 * Whether `pid` is still the process that was recorded with start time
 * `start`. With no recorded start (an older record), a live pid is taken on
 * trust.
 */
export function sameProcess(rows: readonly ProcRow[], pid: number | undefined, start: string | undefined): boolean {
  if (!pid) return false;
  const r = rows.find((x) => x.pid === pid);
  return Boolean(r) && (!start || r!.start === start);
}

/**
 * Whether the pid recorded as a session's shell now belongs to some OTHER
 * process. Then neither it nor its session id (`pgrep -s`) is ours: a kernel
 * doesn't hand out a pid while a session or group still carries it, so the
 * shell's old session must be empty.
 */
export function rootReused(rows: readonly ProcRow[], root: number | undefined, rootStart: string | undefined): boolean {
  if (!root || !rootStart) return false;
  const r = rows.find((x) => x.pid === root);
  return Boolean(r) && r!.start !== rootStart;
}

/** Processes in the shell's process group (its pid), unless that pid is someone else's now. */
export function groupOf(rows: readonly ProcRow[], root: number | undefined, rootStart?: string): number[] {
  if (!root || rootReused(rows, root, rootStart)) return [];
  return rows.filter((r) => r.pgid === root).map((r) => r.pid);
}

/** The tracked processes that are still the SAME process: their pid is alive with the start time recorded. */
export function liveTracked(rows: readonly ProcRow[], tracked: ReadonlyArray<{ pid: number; start: string }>): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return tracked.filter((t) => byPid.get(t.pid)?.start === t.start).map((t) => t.pid);
}

export interface KillPlan {
  pids: number[];
  pgids: number[];
}

/**
 * What to signal to end the session rooted at `root`. Never the agent itself
 * (`self`), never its process group, and never pid 0 or 1.
 */
export function killPlan(
  rows: readonly ProcRow[],
  opts: {
    root?: number;
    /** The shell's start time. A root alive with a different one is someone else's process, and is left alone. */
    rootStart?: string;
    sessionMembers?: readonly number[];
    tracked?: ReadonlyArray<{ pid: number; start: string }>;
    self: number;
  },
): KillPlan {
  const selfPgid = rows.find((r) => r.pid === opts.self)?.pgid;
  const reused = rootReused(rows, opts.root, opts.rootStart);
  const seeds = new Set<number>([
    ...(opts.root && !reused ? [opts.root] : []),
    ...groupOf(rows, opts.root, opts.rootStart),
    ...(reused ? [] : (opts.sessionMembers ?? [])),
    ...liveTracked(rows, opts.tracked ?? []),
  ]);
  const pids = descendantsOf(rows, seeds);
  pids.delete(opts.self);
  const pgid = new Map(rows.map((r) => [r.pid, r.pgid]));
  const pgids = new Set<number>();
  for (const p of pids) {
    const g = pgid.get(p);
    if (g !== undefined && g > 1 && g !== selfPgid && g !== opts.self) pgids.add(g);
  }
  return { pids: [...pids].sort((a, b) => a - b), pgids: [...pgids].sort((a, b) => a - b) };
}

/**
 * Processes in the tree that are not the shell or its plain descendants. They
 * are the ones a kill of the session could miss once their parent is gone, so
 * the owner records them.
 */
export function escapees(rows: readonly ProcRow[], root: number, sessionMembers: readonly number[]): Array<{ pid: number; start: string }> {
  const plain = descendantsOf(rows, [root]);
  const all = descendantsOf(rows, [root, ...groupOf(rows, root), ...sessionMembers]);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out: Array<{ pid: number; start: string }> = [];
  for (const pid of all) {
    const r = byPid.get(pid);
    if (!r) continue;
    // Out of the shell's process group, or reparented away from it.
    if (r.pgid !== root || !plain.has(pid)) out.push({ pid, start: r.start });
  }
  return out;
}

/* ------------------------------------------------------------------- ports */

export interface Listener {
  pid: number;
  command: string;
  /** Where to dial it ON the host: a wildcard listener is reached on 127.0.0.1. */
  host: string;
  port: number;
}

/** The `lsof` that {@link parseLsof} reads: TCP listeners, numeric, in field form. */
export const LSOF_ARGS = ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"];

/**
 * Listeners from `lsof -nP -iTCP -sTCP:LISTEN -F pcn`. A port held on several
 * addresses by one process is listed once, preferring 127.0.0.1, then a
 * wildcard. Vite's `localhost` on a resolver that prefers IPv6 binds only
 * `[::1]`, and that must be dialled on ::1.
 */
export function parseLsof(out: string): Listener[] {
  const found = new Map<string, Listener>();
  let pid = 0;
  let command = "";
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      pid = Number(val);
      command = "";
    } else if (tag === "c") {
      command = val;
    } else if (tag === "n" && pid) {
      const cut = val.lastIndexOf(":");
      if (cut < 0) continue;
      const port = Number(val.slice(cut + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const addr = val.slice(0, cut).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
      const host = addr === "*" || addr === "0.0.0.0" || addr === "::" ? "127.0.0.1" : addr;
      const key = `${pid}:${port}`;
      const prev = found.get(key);
      if (!prev || host === "127.0.0.1") found.set(key, { pid, command, host, port });
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

export interface SessionTree {
  sid: string;
  chat: string;
  root?: number;
  rootStart?: string;
  tracked?: ReadonlyArray<{ pid: number; start: string }>;
}

export interface Attribution {
  sessions: Array<{ sid: string; chat: string; ports: Listener[] }>;
  /** Listeners no session of this instance started: AirPlay, another chat's other instance, the user's own. Never forwarded. */
  unattributed: Listener[];
}

/** Which session's process tree each listener belongs to. */
export function attribute(listeners: readonly Listener[], rows: readonly ProcRow[], sessions: readonly SessionTree[]): Attribution {
  const owner = new Map<number, number>();
  sessions.forEach((s, i) => {
    const root = s.root && !rootReused(rows, s.root, s.rootStart) ? [s.root] : [];
    const seeds = [...root, ...groupOf(rows, s.root, s.rootStart), ...liveTracked(rows, s.tracked ?? [])];
    for (const pid of descendantsOf(rows, seeds)) if (!owner.has(pid)) owner.set(pid, i);
  });
  const out: Attribution = { sessions: sessions.map((s) => ({ sid: s.sid, chat: s.chat, ports: [] })), unattributed: [] };
  for (const l of listeners) {
    const i = owner.get(l.pid);
    if (i === undefined) out.unattributed.push(l);
    else out.sessions[i]!.ports.push(l);
  }
  return out;
}

/* ---------------------------------------------------------------- the host */

function run(file: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      if (okCodes.includes(code)) resolve(stdout);
      else reject(err);
    });
  });
}

export async function listProcs(): Promise<ProcRow[]> {
  return parsePs(await run("ps", PS_ARGS));
}

/** Pids in session `sid`. `pgrep` exits 1 when there are none. */
export async function sessionMembers(sid: number): Promise<number[]> {
  const out = await run("pgrep", ["-s", String(sid)], [0, 1]).catch(() => "");
  return out
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 1);
}

/** TCP listeners of THIS user's processes (lsof shows no one else's without root). `lsof` exits 1 when there are none. */
export async function listListeners(): Promise<Listener[]> {
  return parseLsof(await run("lsof", LSOF_ARGS, [0, 1]));
}

/** Whether `pid` exists (signal 0). EPERM means it exists but isn't ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface KillIo {
  listProcs(): Promise<ProcRow[]>;
  sessionMembers(sid: number): Promise<number[]>;
  /** `pid` < 0 signals a process group. */
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

export const hostKillIo: KillIo = {
  listProcs,
  sessionMembers,
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * SIGKILL the whole tree, groups first, then pids. Looks again, up to three
 * times, for anything forked in between. Resolves with how many processes it
 * signalled.
 */
export interface KillTarget {
  root?: number;
  rootStart?: string;
  tracked?: ReadonlyArray<{ pid: number; start: string }>;
  self: number;
}

export async function killTree(io: KillIo, target: KillTarget): Promise<number> {
  let signalled = 0;
  for (let pass = 0; pass < 3; pass++) {
    const rows = await io.listProcs();
    const members = target.root && !rootReused(rows, target.root, target.rootStart) ? await io.sessionMembers(target.root) : [];
    const plan = killPlan(rows, { ...target, sessionMembers: members });
    if (!plan.pids.length) break;
    for (const g of plan.pgids) io.kill(-g, "SIGKILL");
    for (const p of plan.pids) io.kill(p, "SIGKILL");
    signalled += plan.pids.length;
    await io.sleep(100);
  }
  return signalled;
}

/** Deliver `signal` to every process of the session, as `pkill -<SIG> -s` would, plus tracked escapees. */
export async function signalTree(io: KillIo, target: KillTarget, signal: NodeJS.Signals): Promise<void> {
  const rows = await io.listProcs();
  const members = target.root && !rootReused(rows, target.root, target.rootStart) ? await io.sessionMembers(target.root) : [];
  for (const p of killPlan(rows, { ...target, sessionMembers: members }).pids) io.kill(p, signal);
}
