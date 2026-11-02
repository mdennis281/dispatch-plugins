/**
 * `dispatch-host session`: what sshd runs for every chat shell.
 *
 * A thin relay. It makes sure the session's owner (`serve`) is running,
 * starting it on a fresh session. Then it connects to the owner's socket,
 * writes one ATTACH frame, and pipes bytes both ways between the SSH channel
 * and the socket. It never parses the plugin's frames. When the connection
 * drops, the relay dies and the owner carries on. The next `session --resume`
 * attaches to the same shell.
 *
 * A session the host no longer has is never quietly started afresh on a
 * resume. The relay answers ERROR `gone` instead: a new shell would have lost
 * the cwd and env the agent set up, and the plugin has to say so.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { StreamLog, readRuns } from "./journal.js";
import { sessionPaths, type SessionRecord } from "./layout.js";
import { decodeEnvArg } from "./env.js";
import { NO_CWD_EXIT } from "./owner.js";
import { F, PROTOCOL_VERSION, encodeFrame, type ErrorCode, type ExitMsg, type ReadyMsg } from "./protocol.js";
import { listProcs } from "./procs.js";
import { claimRecord, ownerLive, readRecord, touchContact } from "./records.js";
import { replay } from "./session.js";
import { AGENT_VERSION } from "./version.js";

/** A claimed record whose owner never wrote back within this long was a start that died. */
const STARTING_STALE_MS = 30_000;

export interface RelayArgs {
  root: string;
  instance: string;
  chat: string;
  sid: string;
  cwd: string;
  /** Base64 JSON of extra environment variables. Passed through to `serve`. */
  envB64?: string;
  resume?: { out: number; err: number };
  heartbeatMs: number;
  deadManHours: number;
  /** This bundle's own path, to start `serve` with. */
  script: string;
  /** Where frames go: the SSH channel. */
  output: NodeJS.WritableStream;
  /** Where the plugin's frames come from. */
  input: NodeJS.ReadableStream;
}

/** Resolves with the exit code the relay should end with. */
export async function runRelay(a: RelayArgs): Promise<number> {
  const paths = sessionPaths(a.root, a.instance, a.sid);
  touchContact(a.root, a.instance);
  const send = (type: number, payload?: object) => a.output.write(encodeFrame(type, payload));
  const error = (code: ErrorCode, message: string): number => {
    send(F.error, { code, message });
    return code === "no-cwd" ? NO_CWD_EXIT : 1;
  };

  let rec = readRecord(paths.record);
  if (rec?.state === "exited") return replayExited(a, rec);

  let sock = await tryConnect(paths.socket);
  if (!sock) {
    const rows = await listProcs().catch(() => []);
    if (rec) {
      const starting = rec.state === "starting" && Date.now() - Date.parse(rec.startedAt) < STARTING_STALE_MS;
      if (starting || ownerLive(rows, rec)) {
        // Starting, or a socket that blinked: give it a moment.
        sock = await waitForSocket(paths.socket, paths.record, 20_000);
      } else {
        return error("gone", `session ${a.sid} is no longer on this host (its owner has exited)`);
      }
    } else if (a.resume) {
      return error("gone", `session ${a.sid} is not on this host`);
    } else {
      try {
        if (!statSync(a.cwd).isDirectory()) return error("no-cwd", `${a.cwd} is not a directory on this host`);
      } catch {
        return error("no-cwd", `${a.cwd} does not exist on this host`);
      }
      try {
        decodeEnvArg(a.envB64);
      } catch (e) {
        return error("bad-args", e instanceof Error ? e.message : String(e));
      }
      // Whoever creates the record starts the owner; a racing relay waits for it.
      const won = claimRecord(paths.record, {
        v: 1,
        instance: a.instance,
        chat: a.chat,
        sid: a.sid,
        agentVersion: AGENT_VERSION,
        cwd: a.cwd,
        ownerPid: 0,
        state: "starting",
        startedAt: new Date().toISOString(),
      });
      if (won) startOwner(a, paths.ownerLog, paths.dir);
      sock = await waitForSocket(paths.socket, paths.record, 20_000);
    }
  }
  if (!sock) {
    rec = readRecord(paths.record);
    if (rec?.state === "exited") {
      if (rec.exit?.detail === "no-cwd") return error("no-cwd", `${a.cwd} does not exist on this host`);
      if (rec.exit?.reason === "start-failed") return error("start", `the shell did not start: ${rec.exit.detail ?? "unknown"}`);
      return replayExited(a, rec);
    }
    return error("start", `the session's owner did not come up (see ${paths.ownerLog})`);
  }
  return pipe(a, sock);
}

function startOwner(a: RelayArgs, ownerLog: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(ownerLog, "a", 0o600);
  const args = [
    a.script,
    "serve",
    "--root", a.root,
    "--instance", a.instance,
    "--chat", a.chat,
    "--sid", a.sid,
    "--cwd", a.cwd,
    "--heartbeat-ms", String(a.heartbeatMs),
    "--dead-man-hours", String(a.deadManHours),
    ...(a.envB64 ? ["--env", a.envB64] : []),
  ];
  // Detached: its own session, so nothing that happens to this relay (or to
  // sshd's job for this connection) reaches it.
  spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], cwd: dir }).unref();
}

function tryConnect(path: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.removeAllListeners("error");
      resolve(s);
    });
    s.once("error", () => resolve(undefined));
  });
}

/** Poll for the owner's socket until `ms` runs out or the record says it exited. */
async function waitForSocket(path: string, record: string, ms: number): Promise<Socket | undefined> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = await tryConnect(path);
    if (s) return s;
    if (readRecord(record)?.state === "exited") return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

/** Bytes both ways until either side closes. Backpressure in both directions. */
function pipe(a: RelayArgs, sock: Socket): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(0);
    };
    // The channel closed (Dispatch is gone, or detached). Half-close, so
    // frames it sent last (a KILL, say) still reach the owner, then finish
    // when the owner closes its side. The owner keeps the shell.
    const hangUp = () => {
      sock.end();
      setTimeout(finish, 2_000).unref();
    };
    sock.write(encodeFrame(F.attach, { v: PROTOCOL_VERSION, ...(a.resume ? { resume: a.resume } : {}) }));
    a.input.on("data", (c: Buffer) => {
      if (!sock.write(c)) {
        a.input.pause();
        sock.once("drain", () => a.input.resume());
      }
    });
    a.input.on("end", hangUp);
    a.input.on("error", hangUp);
    sock.on("data", (c: Buffer) => {
      if (!a.output.write(c)) {
        sock.pause();
        a.output.once("drain", () => sock.resume());
      }
    });
    sock.on("close", finish);
    sock.on("error", finish);
    a.output.on("error", finish);
  });
}

/**
 * The session is over and its owner gone. Its journal and record are still
 * here, so the client gets what it missed and the real exit, not a guess.
 */
function replayExited(a: RelayArgs, rec: SessionRecord): number {
  const paths = sessionPaths(a.root, a.instance, a.sid);
  const out = StreamLog.open(paths.dir, "out");
  const err = StreamLog.open(paths.dir, "err");
  const from = a.resume ?? { out: 0, err: 0 };
  const gap: ReadyMsg["gap"] = {};
  if (out.start > from.out) gap.out = out.start;
  if (err.start > from.err) gap.err = err.start;
  const ready: ReadyMsg = {
    v: PROTOCOL_VERSION,
    sid: rec.sid,
    pid: rec.shellPid ?? 0,
    agentVersion: rec.agentVersion,
    cwd: rec.cwd,
    out: out.offset,
    err: err.offset,
    resumed: true,
    ...(gap.out !== undefined || gap.err !== undefined ? { gap } : {}),
  };
  a.output.write(encodeFrame(F.ready, ready));
  for (const f of replay(out, from.out, F.stdout)) a.output.write(f);
  for (const f of replay(err, from.err, F.stderr)) a.output.write(f);
  for (const e of readRuns(paths.runs)) {
    if (e.t === "end" && e.out > from.out) a.output.write(encodeFrame(F.runEnd, { runId: e.runId, exitCode: e.exitCode, cwd: e.cwd }));
  }
  const exit: ExitMsg = {
    code: rec.exit?.code ?? null,
    signal: rec.exit?.signal ?? null,
    reason: (rec.exit?.reason as ExitMsg["reason"]) ?? "exited",
    ...(rec.exit?.detail ? { detail: rec.exit.detail } : {}),
  };
  a.output.write(encodeFrame(F.exit, exit));
  return 0;
}
