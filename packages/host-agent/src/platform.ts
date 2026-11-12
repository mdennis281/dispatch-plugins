/**
 * The operating system under dispatch-host, behind one seam. What differs
 * between a Mac and Linux (and, later, Windows) lives here. It is chosen once
 * per process, and the rest of the agent asks it.
 *
 * - **Processes.** macOS: `ps` and `pgrep -s`. Linux: /proc itself, for two
 *   reasons:
 *   - Its starttime (clock ticks since boot) is exact. `ps -o lstart` is
 *     worked out from the uptime on every call, so it drifts by a second
 *     (under lxcfs, by more). Then a live shell's owner looks like a stranger,
 *     and a sweep takes its session for dead.
 *   - A minimal Debian has no procps at all.
 * - **Listeners.** macOS: `lsof`. Linux: `ss -Htlnp` (iproute2), else
 *   /proc/net/tcp{,6} and the socket inodes under /proc/<pid>/fd. A minimal
 *   Debian has neither lsof nor ss.
 * - **Root.** Logged in as root (uid 0), a shell has nothing to ask for: no
 *   sudo shim, and `sudo` is the machine's own. Otherwise `sudo` asks the user
 *   through Dispatch (shims.ts).
 *
 * The parsers are pure and exported, so every format is tested on any OS.
 * A session's socket stays where layout.ts puts it (a unix socket under
 * `run/`) until a platform without them (Windows' named pipes) needs a say.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { endianness } from "node:os";
import { captureLoginEnv, loginShell } from "./env.js";
import { LSOF_ARGS, PS_ARGS, addListener, parseLsof, parsePs, type KillIo, type Listener, type ProcRow } from "./procs.js";

/**
 * How a chat shell gets root. `approval-helper`: `sudo` asks the user, and
 * Dispatch runs the command through the machine's root helper. `root`: the
 * login is root already. `none`: no way at all.
 */
export type ElevationMode = "approval-helper" | "root" | "none";

/** What finds the listening ports: `lsof` (macOS), `ss` (iproute2) or /proc (Linux without iproute2). */
export type PortsVia = "lsof" | "ss" | "proc";

export interface Platform {
  readonly os: NodeJS.Platform;
  readonly elevation: ElevationMode;
  /** Every process this account can see, with its identity (pid and start). */
  procs(): Promise<ProcRow[]>;
  /** One process's start, as {@link procs} reports it; undefined when it is gone. */
  procStart(pid: number): Promise<string | undefined>;
  /** The pids in session `sid`. */
  sessionMembers(sid: number): Promise<number[]>;
  /** The TCP listeners of the processes this account can see. */
  listeners(): Promise<Listener[]>;
  /** What {@link listeners} uses here; null when nothing can. */
  portsVia(): PortsVia | null;
  /** What killing a session's tree reads and signals (procs.ts's killTree). */
  readonly killIo: KillIo;
  /** The user's login environment, read from their login shell. */
  loginEnv(opts: { node: string; timeoutMs?: number }): Promise<Record<string, string>>;
}

/* ------------------------------------------------------------ the choice */

let chosen: Platform | undefined;

/** This machine's platform, chosen on first use. */
export function hostPlatform(): Platform {
  return (chosen ??= platformFor(process.platform, process.getuid?.() ?? -1));
}

/** The platform for `os`, logged in as `uid`. Linux reads /proc; anything else POSIX is asked through `ps` and `lsof`. */
export function platformFor(os: NodeJS.Platform, uid: number, proc = "/proc"): Platform {
  const elevation: ElevationMode = uid === 0 ? "root" : "approval-helper";
  const common = {
    os,
    elevation,
    loginEnv: (o: { node: string; timeoutMs?: number }) =>
      captureLoginEnv({ shell: loginShell(process.env, os), node: o.node, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }),
  };
  if (os === "linux") {
    const procs = async () => linuxProcs(proc);
    const members = async (sid: number) => linuxProcs(proc).filter((r) => r.sid === sid).map((r) => r.pid);
    return {
      ...common,
      procs,
      procStart: async (pid) => linuxProc(proc, pid)?.start,
      sessionMembers: members,
      listeners: () => linuxListeners(proc),
      portsVia: () => (ssPath() ? "ss" : existsSync(`${proc}/net/tcp`) ? "proc" : null),
      killIo: killIo(procs, members),
    };
  }
  const procs = async () => parsePs(await run("ps", PS_ARGS));
  const members = async (sid: number) => {
    // `pgrep` exits 1 when there are none.
    const out = await run("pgrep", ["-s", String(sid)], [0, 1]).catch(() => "");
    return out
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 1);
  };
  return {
    ...common,
    procs,
    procStart: async (pid) => (await procs().catch(() => [])).find((r) => r.pid === pid)?.start,
    sessionMembers: members,
    // TCP listeners of THIS user's processes (lsof shows no one else's without root). `lsof` exits 1 when there are none.
    listeners: async () => parseLsof(await run("lsof", LSOF_ARGS, [0, 1])),
    portsVia: () => (onPath("lsof") ? "lsof" : null),
    killIo: killIo(procs, members),
  };
}

function killIo(procs: () => Promise<ProcRow[]>, members: (sid: number) => Promise<number[]>): KillIo {
  return {
    listProcs: procs,
    sessionMembers: members,
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function run(file: string, args: readonly string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      if (okCodes.includes(code)) resolve(stdout);
      else reject(err);
    });
  });
}

/* ------------------------------------------------------- Linux: processes */

export interface ProcStat {
  pid: number;
  comm: string;
  ppid: number;
  pgrp: number;
  session: number;
  /** Clock ticks after boot. */
  starttime: string;
}

/**
 * `/proc/<pid>/stat`. The command name is in parentheses and may itself hold
 * spaces and parentheses (`(sd-pam)`, `(my (odd) name)`), so the fields are
 * read after the LAST `)`. Field n of proc(5) is then `f[n - 3]`.
 */
export function parseProcStat(text: string): ProcStat | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const f = text.slice(close + 1).trim().split(/\s+/);
  const [ppid, pgrp, session] = [f[1], f[2], f[3]].map(Number);
  const starttime = f[19];
  if (![pid, ppid, pgrp, session].every((n) => Number.isInteger(n)) || !starttime || !/^\d+$/.test(starttime)) return undefined;
  return { pid, comm: text.slice(open + 1, close), ppid: ppid!, pgrp: pgrp!, session: session!, starttime };
}

/**
 * A process's start as Linux rows carry it: `@` and its starttime. The `@`
 * keeps it apart from `ps`'s lstart, which an agent before 0.5.0 recorded on
 * Linux (procs.ts compares only like with like).
 */
export function linuxStart(s: Pick<ProcStat, "starttime">): string {
  return `@${s.starttime}`;
}

function linuxProc(proc: string, pid: number): ProcRow | undefined {
  try {
    const s = parseProcStat(readFileSync(`${proc}/${pid}/stat`, "utf8"));
    return s && s.pid === pid ? rowOf(s) : undefined;
  } catch {
    return undefined; // gone
  }
}

function rowOf(s: ProcStat): ProcRow {
  return { pid: s.pid, ppid: s.ppid, pgid: s.pgrp, sid: s.session, start: linuxStart(s), command: s.comm };
}

/** Every process in /proc. One that ends while it is read is left out. */
export function linuxProcs(proc = "/proc"): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const r = linuxProc(proc, Number(name));
    if (r) rows.push(r);
  }
  return rows;
}

/* ------------------------------------------------------- Linux: listeners */

function sorted(found: Map<string, Listener>): Listener[] {
  return [...found.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** The `ss` that {@link parseSs} reads: TCP, listening, numeric, with processes, no header. */
export const SS_ARGS = ["-Htlnp"];

/**
 * Listeners from `ss -Htlnp`:
 *
 *     LISTEN 0 511   127.0.0.1:5173  0.0.0.0:*  users:(("node",pid=1234,fd=20))
 *     LISTEN 0 4096      [::1]:5173     [::]:*  users:(("node",pid=1234,fd=21),("node",pid=1240,fd=21))
 *
 * A socket of a process this account can't see has no `users:`, and is left out.
 */
export function parseSs(out: string): Listener[] {
  const found = new Map<string, Listener>();
  for (const raw of out.split("\n")) {
    const w = raw.trim().split(/\s+/);
    if (w.length < 5) continue;
    // The state column, when ss prints it.
    if (!/^\d+$/.test(w[0]!)) w.shift();
    const local = w[2];
    const users = w.slice(4).join(" ");
    if (!local || !users.startsWith("users:(")) continue;
    const cut = local.lastIndexOf(":");
    if (cut < 0) continue;
    const port = Number(local.slice(cut + 1));
    for (const m of users.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+),fd=\d+\)/g)) {
      addListener(found, Number(m[2]), m[1]!, local.slice(0, cut), port);
    }
  }
  return sorted(found);
}

/** TCP_LISTEN in /proc/net/tcp's `st` column. */
const TCP_LISTEN = "0A";

/** One address of /proc/net/tcp{,6}: 32-bit words in the host's byte order, as hex. */
export function procNetAddress(hex: string, le = endianness() === "LE"): string | undefined {
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return undefined;
  const words = hex.match(/.{8}/g);
  if (!words || words.join("") !== hex || (words.length !== 1 && words.length !== 4)) return undefined;
  const bytes = words.flatMap((w) => {
    const b = w.match(/../g)!.map((x) => parseInt(x, 16));
    return le ? b.reverse() : b;
  });
  if (bytes.length === 4) return bytes.join(".");
  // IPv4-mapped, written as ss writes it, so it is dialled as the IPv4 address.
  if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return `::ffff:${bytes.slice(12).join(".")}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  // WHATWG URL writes an IPv6 address in its shortest form.
  return new URL(`http://[${groups.join(":")}]/`).hostname.replace(/^\[|\]$/g, "");
}

/** Listening sockets in /proc/net/tcp or tcp6: their inode, address and port. */
export function parseProcNetTcp(text: string, le?: boolean): Array<{ inode: string; address: string; port: number }> {
  const out: Array<{ inode: string; address: string; port: number }> = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== TCP_LISTEN) continue;
    const [addr, port] = f[1]!.split(":");
    const address = addr ? procNetAddress(addr, le) : undefined;
    const inode = f[9]!;
    if (!address || !port || !/^\d+$/.test(inode) || inode === "0") continue;
    out.push({ inode, address, port: parseInt(port, 16) });
  }
  return out;
}

/**
 * Listeners from /proc: the listening sockets of /proc/net/tcp{,6}, matched
 * to the processes that hold them through the `socket:[inode]` links under
 * /proc/<pid>/fd. Only processes this account may look into are found, as
 * with lsof and ss.
 */
export function procListeners(proc = "/proc"): Listener[] {
  const sockets = new Map<string, Array<{ address: string; port: number }>>();
  for (const file of ["net/tcp", "net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(`${proc}/${file}`, "utf8");
    } catch {
      continue; // no IPv6
    }
    for (const s of parseProcNetTcp(text)) {
      const list = sockets.get(s.inode);
      if (list) list.push(s);
      else sockets.set(s.inode, [s]);
    }
  }
  const found = new Map<string, Listener>();
  if (!sockets.size) return [];
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`${proc}/${name}/fd`);
    } catch {
      continue; // not ours to look into, or gone
    }
    let comm: string | undefined;
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`${proc}/${name}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];
      const at = inode ? sockets.get(inode) : undefined;
      if (!at) continue;
      comm ??= readComm(proc, name);
      for (const s of at) addListener(found, Number(name), comm, s.address, s.port);
    }
  }
  return sorted(found);
}

function readComm(proc: string, pid: string): string {
  try {
    return readFileSync(`${proc}/${pid}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

/** Whether `name` is on the agent's PATH or in the system directories sshd's PATH may leave out. */
function onPath(name: string): boolean {
  const dirs = [...(process.env.PATH ?? "").split(":"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return dirs.some((d) => d && existsSync(`${d}/${name}`));
}

/** The bash a chat shell runs: /bin/bash is there on macOS (3.2) and Linux. Null: none in the usual places. */
export function bashPath(): string | null {
  return ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find((p) => existsSync(p)) ?? null;
}

/** Where `ss` is, if iproute2 is installed. sshd's PATH may not have /sbin. */
function ssPath(): string | undefined {
  return ["/usr/bin/ss", "/bin/ss", "/usr/sbin/ss", "/sbin/ss"].find((p) => existsSync(p));
}

/** `ss` when it is there and answers; /proc otherwise. */
async function linuxListeners(proc: string): Promise<Listener[]> {
  const ss = proc === "/proc" ? ssPath() : undefined;
  if (ss) {
    try {
      return parseSs(await run(ss, SS_ARGS));
    } catch {
      /* netlink refused (a sandbox), say: /proc still answers */
    }
  }
  return procListeners(proc);
}
