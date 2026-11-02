/**
 * `dispatch-host <command>`. The bundle's entry point, run on the host as
 * `~/.dispatch-host/runtime/node/bin/node ~/.dispatch-host/agent/<build>/dispatch-host.mjs <command> …`.
 *
 *   session  --instance I --chat C --sid S --cwd D [--env B64] [--resume-out N --resume-err M]
 *            what sshd runs for a chat shell: framed stdio (protocol.ts)
 *   serve    (internal) the session's owner, started detached by `session`
 *   hello    --instance I              note contact; print the agent's identity
 *   probe                              print host facts (OS, tools, disk, console user)
 *   list     --instance I              print the instance's sessions
 *   ports    --instance I [--chat C]   print TCP listeners, attributed to sessions
 *   kill     --instance I (--sid S | --chat C | --all)
 *   sweep    --instance I [--dead-man-hours H]
 *   version
 *
 * Query commands print one line of JSON. `--root` (or DISPATCH_HOST_ROOT)
 * moves `~/.dispatch-host`; only tests use it.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertId, rootDir } from "./layout.js";
import { runOwner } from "./owner.js";
import { probe } from "./probe.js";
import { attribute, hostKillIo, killTree, listListeners, listProcs, pidAlive } from "./procs.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { listRecords, readRecord, touchContact, writeRecord } from "./records.js";
import { runRelay } from "./relay.js";
import { sweepInstance } from "./sweep.js";
import { AGENT_VERSION } from "./version.js";

export interface ParsedArgs {
  cmd: string;
  opts: Record<string, string>;
  flags: Set<string>;
}

/** `cmd --key value --flag …`. A key followed by another `--key` (or nothing) is a flag. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [cmd = "", ...rest] = argv;
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(a)}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags.add(key);
    else {
      opts[key] = next;
      i++;
    }
  }
  return { cmd, opts, flags };
}

export class UsageError extends Error {}

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_DEAD_MAN_HOURS = 12;

function need(opts: Record<string, string>, key: string): string {
  const v = opts[key];
  if (v === undefined || v === "") throw new UsageError(`--${key} is required`);
  return v;
}

function num(opts: Record<string, string>, key: string, dflt: number): number {
  const v = opts[key];
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${key} must be a non-negative number`);
  return n;
}

function decodeEnv(b64: string | undefined): Record<string, string> {
  if (!b64) return {};
  const parsed: unknown = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--env must be base64 JSON of an object");
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const { cmd, opts, flags } = parseArgs(argv);
  const root = opts.root ?? process.env.DISPATCH_HOST_ROOT ?? rootDir(homedir());
  const instance = () => assertId("instance", need(opts, "instance"));

  switch (cmd) {
    case "version":
      process.stdout.write(`${AGENT_VERSION}\n`);
      return 0;

    case "session": {
      const resumeOut = opts["resume-out"];
      const resumeErr = opts["resume-err"];
      return runRelay({
        root,
        instance: instance(),
        chat: assertId("chat", need(opts, "chat")),
        sid: assertId("sid", need(opts, "sid")),
        cwd: need(opts, "cwd"),
        ...(opts.env ? { envB64: opts.env } : {}),
        ...(resumeOut !== undefined || resumeErr !== undefined
          ? { resume: { out: num(opts, "resume-out", 0), err: num(opts, "resume-err", 0) } }
          : {}),
        heartbeatMs: num(opts, "heartbeat-ms", DEFAULT_HEARTBEAT_MS),
        deadManHours: num(opts, "dead-man-hours", DEFAULT_DEAD_MAN_HOURS),
        script: fileURLToPath(import.meta.url),
        input: process.stdin,
        output: process.stdout,
      });
    }

    case "serve":
      await runOwner({
        root,
        instance: instance(),
        chat: assertId("chat", need(opts, "chat")),
        sid: assertId("sid", need(opts, "sid")),
        cwd: need(opts, "cwd"),
        extraEnv: decodeEnv(opts.env),
        heartbeatMs: num(opts, "heartbeat-ms", DEFAULT_HEARTBEAT_MS),
        deadManMs: num(opts, "dead-man-hours", DEFAULT_DEAD_MAN_HOURS) * 3_600_000,
      });
      return -1; // keep running: the owner exits on its own

    case "hello": {
      const id = instance();
      touchContact(root, id);
      print({ agentVersion: AGENT_VERSION, protocol: PROTOCOL_VERSION, node: process.version, platform: process.platform, arch: process.arch, pid: process.pid });
      return 0;
    }

    case "probe":
      print(await probe());
      return 0;

    case "list": {
      const id = instance();
      touchContact(root, id);
      print(
        listRecords(root, id).map(({ rec }) => ({
          sid: rec.sid,
          chat: rec.chat,
          state: rec.state,
          ownerAlive: rec.state !== "exited" && pidAlive(rec.ownerPid),
          shellPid: rec.shellPid ?? null,
          cwd: rec.cwd,
          agentVersion: rec.agentVersion,
          startedAt: rec.startedAt,
          exit: rec.exit ?? null,
        })),
      );
      return 0;
    }

    case "ports": {
      const id = instance();
      touchContact(root, id);
      const live = listRecords(root, id).filter(({ rec }) => rec.state === "running" && pidAlive(rec.ownerPid));
      const [rows, listeners] = await Promise.all([listProcs(), listListeners()]);
      const att = attribute(
        listeners,
        rows,
        live.map(({ rec }) => ({ sid: rec.sid, chat: rec.chat, root: rec.shellPid, tracked: rec.tracked })),
      );
      const chat = opts.chat;
      print({
        sessions: att.sessions.filter((s) => !chat || s.chat === chat),
        unattributed: att.unattributed,
      });
      return 0;
    }

    case "kill": {
      const id = instance();
      touchContact(root, id);
      const all = flags.has("all");
      const sid = opts.sid;
      const chat = opts.chat;
      if (!all && !sid && !chat) throw new UsageError("kill needs --sid, --chat or --all");
      const killed: string[] = [];
      for (const { dir, rec } of listRecords(root, id)) {
        if (rec.state === "exited") continue;
        if (!all && rec.sid !== sid && rec.chat !== chat) continue;
        await killSession(join(dir, "session.json"), rec.ownerPid, rec.shellPid, rec.tracked);
        killed.push(rec.sid);
      }
      print({ killed });
      return 0;
    }

    case "sweep": {
      const id = instance();
      touchContact(root, id);
      print(
        await sweepInstance({
          root,
          instance: id,
          now: Date.now(),
          deadManMs: num(opts, "dead-man-hours", DEFAULT_DEAD_MAN_HOURS) * 3_600_000,
          self: process.pid,
          io: hostKillIo,
        }),
      );
      return 0;
    }

    default:
      throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
  }
}

/**
 * Ask the owner to end its session (SIGTERM: it kills the tree and records
 * `killed`). An owner that doesn't finish within 5 s, or is already gone, has
 * the tree killed from here and the record closed.
 */
async function killSession(
  recordFile: string,
  ownerPid: number,
  shellPid: number | undefined,
  tracked: ReadonlyArray<{ pid: number; start: string }> | undefined,
): Promise<void> {
  if (pidAlive(ownerPid)) {
    try {
      process.kill(ownerPid, "SIGTERM");
    } catch {
      /* gone */
    }
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      if (readRecord(recordFile)?.state === "exited") return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await killTree(hostKillIo, { root: shellPid, tracked, self: process.pid });
  try {
    process.kill(ownerPid, "SIGKILL");
  } catch {
    /* gone */
  }
  const rec = readRecord(recordFile);
  if (rec && rec.state !== "exited") {
    writeRecord(recordFile, {
      ...rec,
      state: "exited",
      exit: { code: null, signal: "SIGKILL", reason: "killed", detail: "dispatch-host kill", at: new Date().toISOString() },
    });
  }
}

/** Whether this module IS the program (the bundle run by node), not a module a test imported. */
function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}


if (isEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code < 0) return; // `serve` stays up
      process.exitCode = code;
      process.stdout.write("", () => process.exit(code));
    },
    (err: unknown) => {
      process.stderr.write(`dispatch-host: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
