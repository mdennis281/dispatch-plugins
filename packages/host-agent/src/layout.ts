/**
 * Where everything lives on a remote-host machine. These paths are POSIX paths
 * on the HOST, so they use `path.posix` even when the plugin computing them
 * runs on Windows.
 *
 *   ~/.dispatch-host/
 *     runtime/node/bin/node         the pinned Node, at a FIXED path (see runtime.ts)
 *     agent/<version>-<hash>/dispatch-host.mjs   side by side, one per agent build (install.ts)
 *     install.lock/                 held while anything installs (see install.ts)
 *     run/<hash>.sock               session sockets (short: macOS caps a socket path at 104 bytes)
 *     <instance>/                   one Dispatch instance (ctx.instance.id)
 *       contact                     touched whenever that instance talks to the host
 *       repos/<repoKey>.git         a bare repo shared by the instance's chats
 *       chats/<chatId>/<repo>       a `git worktree` of it per chat
 *       sessions/<sid>/             one shell: record, journal, owner log
 *
 * Everything per-instance sits under the instance id. Stable and dev share
 * Dispatch's config/ but not data/, and each has its own instance id, so
 * neither can reap or adopt the other's work.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

/** Ids that become path components. No `/`, no `.`, no `..`, nothing a shell needs quoted. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Throws unless `value` is safe as one path component. */
export function assertId(kind: string, value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`${kind} must match ${ID.source}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The directory holding everything, for a host user whose home is `home`. */
export function rootDir(home: string): string {
  return posix.join(home, ".dispatch-host");
}

export interface HostLayout {
  root: string;
  runtimeDir: string;
  /** The pinned Node. Replaced in place by rename, never by a versioned path. */
  nodeBin: string;
  agentsDir: string;
  installLock: string;
  runDir: string;
}

export function hostLayout(root: string): HostLayout {
  return {
    root,
    runtimeDir: posix.join(root, "runtime"),
    nodeBin: posix.join(root, "runtime", "node", "bin", "node"),
    agentsDir: posix.join(root, "agent"),
    installLock: posix.join(root, "install.lock"),
    runDir: posix.join(root, "run"),
  };
}


export interface InstanceLayout {
  dir: string;
  contactFile: string;
  reposDir: string;
  chatsDir: string;
  sessionsDir: string;
}

export function instanceLayout(root: string, instance: string): InstanceLayout {
  const dir = posix.join(root, assertId("instance", instance));
  return {
    dir,
    contactFile: posix.join(dir, "contact"),
    reposDir: posix.join(dir, "repos"),
    chatsDir: posix.join(dir, "chats"),
    sessionsDir: posix.join(dir, "sessions"),
  };
}

/** The bare repository a local repository's chats share on this host. */
export function repoPath(root: string, instance: string, repoKey: string): string {
  return posix.join(instanceLayout(root, instance).reposDir, `${assertId("repoKey", repoKey)}.git`);
}

/** A chat's worktree of repository `repo`. */
export function chatWorktreePath(root: string, instance: string, chatId: string, repo: string): string {
  return posix.join(instanceLayout(root, instance).chatsDir, assertId("chat", chatId), assertId("repo", repo));
}

export interface SessionPaths {
  dir: string;
  /** JSON {@link SessionRecord}. */
  record: string;
  /** One JSON line per run begin/end. */
  runs: string;
  /** The owner process's own stdout/stderr. */
  ownerLog: string;
  socket: string;
}

export function sessionPaths(root: string, instance: string, sid: string): SessionPaths {
  const dir = posix.join(instanceLayout(root, instance).sessionsDir, assertId("sid", sid));
  return {
    dir,
    record: posix.join(dir, "session.json"),
    runs: posix.join(dir, "runs.jsonl"),
    ownerLog: posix.join(dir, "owner.log"),
    socket: socketPath(root, instance, sid),
  };
}

/**
 * The session's socket. A hash, not the session directory: `sun_path` holds
 * 104 bytes on macOS, and `/Users/<user>/.dispatch-host/<uuid>/sessions/<sid>/sock`
 * gets close to that with a long user name.
 */
export function socketPath(root: string, instance: string, sid: string): string {
  const h = createHash("sha256").update(`${instance}\0${sid}`).digest("hex").slice(0, 20);
  return posix.join(root, "run", `${h}.sock`);
}

/** What a session leaves on disk, read by the relay, `list`, `ports` and `sweep`. */
export interface SessionRecord {
  v: 1;
  instance: string;
  chat: string;
  sid: string;
  agentVersion: string;
  cwd: string;
  /** The owner process. */
  ownerPid: number;
  /** The owner's start time as `ps -o lstart=` prints it: with the pid, its identity. */
  ownerStart?: string;
  /** The shell; also its session id and process group. */
  shellPid?: number;
  state: "starting" | "running" | "exited";
  startedAt: string;
  exit?: { code: number | null; signal: string | null; reason: string; detail?: string; at: string };
  /**
   * Processes the session started that left its process tree (a `setsid`, a
   * double fork). Kept so they can be killed after the owner is gone. Each is
   * checked against its start time first: a pid on its own can be reused.
   */
  tracked?: Array<{ pid: number; start: string }>;
}
