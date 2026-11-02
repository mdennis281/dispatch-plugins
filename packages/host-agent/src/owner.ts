/**
 * `dispatch-host serve`: the process that owns one chat shell.
 *
 * The relay starts it detached (its own session, via setsid). sshd tearing down
 * a dropped connection, or launchd reaping that connection's job, therefore
 * can't take it along. It starts bash in yet another new session (so the
 * shell's pid is that session's id and its process group), journals what bash
 * writes, and serves clients on a unix socket. It exits once the shell is over:
 * the shell ended, it was killed, or Dispatch went silent.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { appendRun, StreamLog } from "./journal.js";
import { sessionPaths, type SessionRecord } from "./layout.js";
import { captureLoginEnv, loginShell, shellEnv } from "./env.js";
import { FrameDecoder, F, decodeJson, type AttachMsg, type ExitMsg } from "./protocol.js";
import { escapees, hostKillIo, killTree, signalTree, sessionMembers, listProcs } from "./procs.js";
import { lastContact, readRecord, touchContact, writeRecord } from "./records.js";
import { Session, type Client } from "./session.js";
import { sweepInstance } from "./sweep.js";
import { AGENT_VERSION } from "./version.js";

export interface OwnerArgs {
  root: string;
  instance: string;
  chat: string;
  sid: string;
  cwd: string;
  extraEnv: Record<string, string>;
  heartbeatMs: number;
  deadManMs: number;
}

/** Exit code when the working directory is missing. remote-core's `NO_CWD_EXIT`. */
export const NO_CWD_EXIT = 97;

/** At most this many escapees are tracked per session. */
const MAX_TRACKED = 256;

/** bash, which core's probe and wrapping are written for: /bin/bash is there on macOS (3.2) and Linux. */
function bashPath(): string {
  for (const p of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) if (existsSync(p)) return p;
  return "bash";
}

export async function runOwner(a: OwnerArgs): Promise<void> {
  const paths = sessionPaths(a.root, a.instance, a.sid);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(`${a.root}/run`, { recursive: true, mode: 0o700 });
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

  const rec: SessionRecord = {
    v: 1,
    instance: a.instance,
    chat: a.chat,
    sid: a.sid,
    agentVersion: AGENT_VERSION,
    cwd: a.cwd,
    ownerPid: process.pid,
    state: "starting",
    startedAt: new Date().toISOString(),
  };
  const save = () => writeRecord(paths.record, rec);
  const fail = (code: number, reason: string, detail: string): never => {
    rec.state = "exited";
    rec.exit = { code, signal: null, reason, detail, at: new Date().toISOString() };
    save();
    log(`not started: ${detail}`);
    process.exit(code);
  };
  save();

  let isDir = false;
  try {
    isDir = statSync(a.cwd).isDirectory();
  } catch {
    /* missing */
  }
  if (!isDir) fail(NO_CWD_EXIT, "start-failed", "no-cwd");

  const login = await captureLoginEnv({ shell: loginShell(process.env, process.platform), node: process.execPath }).catch(
    (err: unknown) => {
      log(`login environment not read (${String(err)}); using the fallback PATH`);
      return undefined;
    },
  );
  const env = shellEnv({ agentEnv: process.env, ...(login ? { login } : {}), extra: a.extraEnv });

  const shell = spawn(bashPath(), ["--noprofile", "--norc"], { cwd: a.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  if (!shell.pid) {
    await new Promise<void>((r) => shell.once("error", () => r()));
    fail(1, "start-failed", "bash did not start");
  }
  rec.shellPid = shell.pid;
  rec.state = "running";
  rec.ownerStart = (await listProcs().catch(() => [])).find((r) => r.pid === process.pid)?.start;
  save();
  log(`session ${a.sid} for chat ${a.chat}: bash ${shell.pid} in ${a.cwd}`);

  const out = StreamLog.open(paths.dir, "out");
  const err = StreamLog.open(paths.dir, "err");
  const target = () => ({ root: rec.shellPid, tracked: rec.tracked, self: process.pid });

  let lastTouch = 0;
  const contact = () => {
    const now = Date.now();
    if (now - lastTouch < 30_000) return;
    lastTouch = now;
    try {
      touchContact(a.root, a.instance);
    } catch {
      /* best effort */
    }
  };
  contact();

  const timers: Array<ReturnType<typeof setInterval>> = [];
  const server = createServer();
  const session = new Session({
    sid: a.sid,
    agentVersion: AGENT_VERSION,
    cwd: a.cwd,
    shell,
    out,
    err,
    journalRun: (e) => appendRun(paths.runs, e),
    now: () => performance.now(),
    heartbeatMs: a.heartbeatMs,
    killTree: async () => {
      await killTree(hostKillIo, target());
    },
    signal: (name) => signalTree(hostKillIo, target(), `SIG${name}` as NodeJS.Signals),
    onContact: contact,
    log,
    onExit: (exit: ExitMsg) => {
      rec.state = "exited";
      rec.exit = { ...exit, at: new Date().toISOString() };
      save();
      log(`session over: ${exit.reason} (code ${exit.code ?? "none"}${exit.detail ? `, ${exit.detail}` : ""})`);
      for (const t of timers) clearInterval(t);
      server.close();
      rmSync(paths.socket, { force: true });
      out.close();
      err.close();
      // Let the last frames reach a client that is still attached.
      setTimeout(() => process.exit(0), 500).unref();
    },
  });

  server.on("connection", (sock: Socket) => {
    const client: Client = sock;
    const dec = new FrameDecoder();
    let attached = false;
    sock.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = dec.push(chunk);
      } catch (e) {
        log(`bad frame from a client: ${String(e)}`);
        sock.destroy();
        return;
      }
      for (const f of frames) {
        if (!attached) {
          if (f.type !== F.attach) {
            sock.destroy();
            return;
          }
          attached = true;
          contact();
          session.attach(client, decodeJson<AttachMsg>(f.payload));
        } else {
          session.handle(client, f);
        }
      }
    });
    sock.on("close", () => session.detachClient(client));
    sock.on("error", () => {
      /* the relay went away; close follows */
    });
  });
  rmSync(paths.socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => resolve());
  });
  chmodSync(paths.socket, 0o600);

  // The heartbeat watchdog. Monotonic time: a Mac that slept doesn't count its sleep against it.
  timers.push(setInterval(() => session.tick(), 1_000));

  // Escapees: processes that left the shell's tree. Recorded so a kill (or a
  // later sweep, if this owner dies first) still finds them.
  timers.push(
    setInterval(() => {
      if (!rec.shellPid || session.exited) return;
      void (async () => {
        const rows = await listProcs();
        const found = escapees(rows, rec.shellPid!, await sessionMembers(rec.shellPid!));
        const known = new Set((rec.tracked ?? []).map((t) => `${t.pid}@${t.start}`));
        const fresh = found.filter((t) => !known.has(`${t.pid}@${t.start}`));
        if (!fresh.length) return;
        rec.tracked = [...(rec.tracked ?? []), ...fresh].slice(-MAX_TRACKED);
        if (!session.exited) save();
      })().catch(() => {});
    }, 5_000),
  );

  // Reap crashed siblings, and enforce the dead-man switch on this session too.
  timers.push(
    setInterval(() => {
      void (async () => {
        const r = await sweepInstance({
          root: a.root,
          instance: a.instance,
          now: Date.now(),
          deadManMs: a.deadManMs,
          self: process.pid,
          selfSid: a.sid,
          io: hostKillIo,
        });
        if (r.reaped.length || r.deadMan.length) log(`sweep: reaped ${r.reaped.join(",") || "none"}; dead-man ${r.deadMan.join(",") || "none"}`);
        const last = lastContact(a.root, a.instance);
        if (last !== undefined && Date.now() - last > a.deadManMs) {
          await session.terminate("dead-man", `no Dispatch contact for ${Math.round((Date.now() - last) / 3_600_000)}h`);
        }
      })().catch((e: unknown) => log(`sweep: ${String(e)}`));
    }, 60_000),
  );

  // A dropped connection is not the session's end. SIGTERM (from `kill`, or the OS) is.
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => void session.terminate("killed", "SIGTERM"));
  for (const t of timers) t.unref?.();
  // The server keeps the process alive until onExit closes it.
}


/** Whether a session's record says it exists and its owner might still be serving it. */
export function recordFor(root: string, instance: string, sid: string): SessionRecord | undefined {
  return readRecord(sessionPaths(root, instance, sid).record);
}
