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
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { posix } from "node:path";
import { performance } from "node:perf_hooks";
import { appendRun, StreamLog } from "./journal.js";
import { sessionPaths, type SessionRecord } from "./layout.js";
import { shellEnv } from "./env.js";
import { hasCommandLineTools } from "./git-env.js";
import { FrameDecoder, F, checkElevate, decodeJson, encodeFrame, type AttachMsg, type ExitMsg } from "./protocol.js";
import { ensureShims } from "./shims.js";
import { bashPath, hostPlatform } from "./platform.js";
import { escapees, killTree, sameProcess, signalTree } from "./procs.js";
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
  /** Run this program (an MCP server) instead of bash. Same journal, heartbeat and kill. */
  exec?: string[];
  heartbeatMs: number;
  deadManMs: number;
}

/** Exit code when the working directory is missing. remote-core's `NO_CWD_EXIT`. */
export const NO_CWD_EXIT = 97;

/** At most this many escapees are tracked per session (dead ones are pruned first). */
const MAX_TRACKED = 256;

/** A RESUME point is two whole, non-negative byte offsets; anything else is a fresh attach. */
function attachMsg(payload: Buffer): AttachMsg {
  const m = decodeJson<AttachMsg>(payload);
  const r = m?.resume;
  const ok = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (r !== undefined && !(ok(r.out) && ok(r.err))) throw new Error("ATTACH with a malformed resume point");
  return { v: Number(m?.v) || 0, ...(r ? { resume: { out: r.out, err: r.err } } : {}) };
}

export async function runOwner(a: OwnerArgs): Promise<void> {
  const paths = sessionPaths(a.root, a.instance, a.sid);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(`${a.root}/run`, { recursive: true, mode: 0o700 });
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

  // One owner per session. The relay's exclusive claim on the record should
  // make a second impossible, but a second must never journal into the same
  // files or take over the socket.
  const prev = readRecord(paths.record);
  if (prev && prev.state === "running" && prev.ownerPid !== process.pid) {
    const rows = await hostPlatform().procs().catch(() => []);
    if (sameProcess(rows, prev.ownerPid, prev.ownerStart)) {
      log(`session ${a.sid} already has an owner (${prev.ownerPid}); exiting`);
      process.exit(0);
    }
  }

  const rec: SessionRecord = {
    v: 1,
    instance: a.instance,
    chat: a.chat,
    sid: a.sid,
    agentVersion: AGENT_VERSION,
    cwd: a.cwd,
    ownerPid: process.pid,
    state: "starting",
    ...(a.exec ? { kind: "process" as const } : {}),
    startedAt: new Date().toISOString(),
  };
  const save = () => writeRecord(paths.record, rec);
  const fail = (code: number, reason: string, detail: string): never => {
    rec.state = "exited";
    rec.exit = { code, signal: null, reason, detail, at: new Date().toISOString() };
    try {
      save();
    } catch {
      /* nothing more to do */
    }
    log(`not started: ${detail}`);
    process.exit(code);
  };

  try {
    save();
    let isDir = false;
    try {
      isDir = statSync(a.cwd).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) fail(NO_CWD_EXIT, "start-failed", "no-cwd");
    await serve(a, paths, rec, save, log);
  } catch (e) {
    fail(1, "start-failed", e instanceof Error ? e.message : String(e));
  }
}

async function serve(
  a: OwnerArgs,
  paths: ReturnType<typeof sessionPaths>,
  rec: SessionRecord,
  save: () => void,
  log: (line: string) => void,
): Promise<void> {
  const platform = hostPlatform();
  const login = await platform.loginEnv({ node: process.execPath }).catch(
    (err: unknown) => {
      log(`login environment not read (${String(err)}); using the fallback PATH`);
      return undefined;
    },
  );
  // `sudo` and `dispatch-elevate` for the shell, next to this agent build. A
  // hosted process is no shell: nothing in it asks for root. Nor does a root
  // login's shell: it is root, and its `sudo` is the machine's own.
  let elevate: { binDir: string; socket: string } | undefined;
  const script = process.argv[1];
  if (script && !a.exec && platform.elevation === "approval-helper") {
    const binDir = posix.join(posix.dirname(script), "bin");
    try {
      ensureShims(binDir, process.execPath, script);
      elevate = { binDir, socket: paths.socket };
    } catch (e) {
      log(`elevation shims not written (${String(e)}); sudo in this shell is the machine's own`);
    }
  }
  const env = shellEnv({ agentEnv: process.env, ...(login ? { login } : {}), extra: a.extraEnv, clt: hasCommandLineTools(), ...(elevate ? { elevate } : {}) });

  // Its own session (detached), so its pid is the group every kill takes down.
  const [program, args] = a.exec ? [a.exec[0]!, a.exec.slice(1)] : [bashPath() ?? "bash", ["--noprofile", "--norc"]];
  const shell = spawn(program, args, { cwd: a.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  if (!shell.pid) {
    const err = await new Promise<Error>((r) => shell.once("error", r));
    throw new Error(`${a.exec ? program : "bash"} did not start: ${err.message}`);
  }
  // A write racing the shell's exit must not crash the owner.
  shell.stdin.on("error", () => {});
  rec.shellPid = shell.pid;
  rec.state = "running";
  const [ownerStart, shellStart] = await Promise.all([platform.procStart(process.pid), platform.procStart(shell.pid)]).catch(() => []);
  rec.ownerStart = ownerStart;
  rec.shellStart = shellStart;
  save();
  log(`session ${a.sid} for chat ${a.chat}: ${a.exec ? `process ${JSON.stringify(a.exec).slice(0, 300)}` : "bash"} ${shell.pid} in ${a.cwd}`);

  const out = StreamLog.open(paths.dir, "out");
  const err = StreamLog.open(paths.dir, "err");
  const target = () => ({ root: rec.shellPid, rootStart: rec.shellStart, tracked: rec.tracked, self: process.pid });

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
    journalRun: (e) => {
      try {
        appendRun(paths.runs, e);
      } catch (x) {
        log(`runs journal: ${String(x)}`);
      }
    },
    now: () => performance.now(),
    heartbeatMs: a.heartbeatMs,
    killTree: async () => {
      await killTree(platform.killIo, target());
    },
    signal: (name) => signalTree(platform.killIo, target(), `SIG${name}` as NodeJS.Signals),
    onContact: contact,
    log,
    onExit: (exit: ExitMsg) => {
      rec.state = "exited";
      rec.exit = { ...exit, at: new Date().toISOString() };
      try {
        save();
      } catch (x) {
        log(`record: ${String(x)}`);
      }
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
    // The relay (Dispatch) attaches; `dispatch-elevate`, from inside the shell, asks once and waits.
    let kind: "new" | "relay" | "elevate" = "new";
    sock.on("data", (chunk: Buffer) => {
      try {
        for (const f of dec.push(chunk)) {
          if (kind === "new") {
            if (f.type === F.elevate) {
              kind = "elevate";
              let msg;
              try {
                msg = checkElevate(decodeJson(f.payload));
              } catch (e) {
                sock.end(encodeFrame(F.elevateDone, { code: null, error: e instanceof Error ? e.message : String(e) }));
                return;
              }
              const id = session.elevate(client, msg);
              if (id) log(`elevation ${id} asked: ${JSON.stringify(msg.argv).slice(0, 300)}`);
              continue;
            }
            if (f.type !== F.attach) throw new Error(`first frame 0x${f.type.toString(16)} is not ATTACH`);
            kind = "relay";
            contact();
            session.attach(client, attachMsg(f.payload));
          } else if (kind === "elevate") {
            continue; // it has nothing more to say; it only waits
          } else if (!session.handle(client, f)) {
            throw new Error("the client sent a frame it could not have meant");
          }
        }
      } catch (e) {
        // One confused client must not end the session: drop it, keep the shell.
        log(`dropping a client: ${String(e)}`);
        if (kind === "elevate") session.elevateGone(client);
        else session.detachClient(client);
        sock.destroy();
      }
    });
    sock.on("close", () => (kind === "elevate" ? session.elevateGone(client) : session.detachClient(client)));
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
  // later sweep, if this owner dies first) still finds them. Dead ones are
  // pruned, so a burst of short-lived detached processes can't push out a
  // long-lived one.
  timers.push(
    setInterval(() => {
      if (!rec.shellPid || session.exited) return;
      void (async () => {
        const now = await platform.procs();
        const kept = (rec.tracked ?? []).filter((t) => sameProcess(now, t.pid, t.start));
        const known = new Set(kept.map((t) => `${t.pid}@${t.start}`));
        const fresh = escapees(now, rec.shellPid!, await platform.sessionMembers(rec.shellPid!)).filter((t) => !known.has(`${t.pid}@${t.start}`));
        if (!fresh.length && kept.length === (rec.tracked ?? []).length) return;
        rec.tracked = [...kept, ...fresh].slice(-MAX_TRACKED);
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
          io: platform.killIo,
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
