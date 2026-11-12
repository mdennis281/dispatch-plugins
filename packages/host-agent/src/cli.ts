/**
 * `dispatch-host <command>`. The bundle's entry point, run on the host as
 * `~/.dispatch-host/runtime/node/bin/node ~/.dispatch-host/agent/<build>/dispatch-host.mjs <command> …`.
 *
 *   session  --instance I --chat C --sid S --cwd D [--env B64 | --env-file F] [--exec B64] [--resume-out N --resume-err M]
 *            what sshd runs for a chat shell: framed stdio (protocol.ts). With
 *            --exec, the session runs that program (an MCP server) instead of bash
 *   mcp-provision --spec B64           install an MCP server's packages and browser (provision.ts)
 *   serve    (internal) the session's owner, started detached by `session`
 *   hello    --instance I              note contact; print the agent's identity
 *   probe                              print host facts (OS, tools, disk, console user)
 *   list     --instance I              print the instance's sessions
 *   ports    --instance I [--chat C]   print TCP listeners, attributed to sessions
 *   kill     --instance I (--sid S | --chat C | --all)
 *   sweep    --instance I [--dead-man-hours H]
 *   forget   --instance I (--chat C | --all)   the chat was deleted / the plugin uninstalled (lifecycle.ts)
 *   chats    --instance I              print the instance's chat directories
 *   gc       --instance I [--repo-idle-days N]
 *   elevate  <command…>                 ask the user to run a command as root (elevate.ts); chat shells call it `dispatch-elevate`
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
import { collectGarbage, forgetChat, forgetInstance, listChats } from "./lifecycle.js";
import { probe } from "./probe.js";
import { decodeEnvArg, decodeExecArg, takeSessionEnv } from "./env.js";
import { provision, runProgram } from "./provision.js";
import { processSignals, runElevate } from "./elevate.js";
import { hostPlatform } from "./platform.js";
import { attribute, killTree, type KillTarget } from "./procs.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { listRecords, ownerLive, readRecord, touchContact, writeRecord } from "./records.js";
import type { SessionRecord } from "./layout.js";
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

/** A byte offset: a whole number. `1.5` would reach a read as a fractional position. */
function offset(opts: Record<string, string>, key: string): number {
  const n = num(opts, key, 0);
  if (!Number.isSafeInteger(n)) throw new UsageError(`--${key} must be a whole number of bytes`);
  return n;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  // Its arguments are a command line of its own, not `--key value` options.
  if (argv[0] === "elevate") {
    return runElevate(argv.slice(1), {
      env: process.env,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      onSignal: processSignals,
    });
  }
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
        ...(opts["env-file"] ? { envFile: opts["env-file"] } : {}),
        ...(opts.exec ? { execB64: opts.exec } : {}),
        ...(resumeOut !== undefined || resumeErr !== undefined
          ? { resume: { out: offset(opts, "resume-out"), err: offset(opts, "resume-err") } }
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
        extraEnv: decodeEnvArg(takeSessionEnv() ?? opts.env),
        ...(opts.exec ? { exec: decodeExecArg(opts.exec) } : {}),
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
      print(await probe(root));
      return 0;

    case "list": {
      const id = instance();
      touchContact(root, id);
      const rows = await hostPlatform().procs().catch(() => []);
      print(
        listRecords(root, id).map(({ rec }) => ({
          sid: rec.sid,
          chat: rec.chat,
          state: rec.state,
          ownerAlive: ownerLive(rows, rec),
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
      const [rows, listeners] = await Promise.all([hostPlatform().procs(), hostPlatform().listeners()]);
      // A hosted process (an MCP server's browser) is not a dev server the chat started.
      const live = listRecords(root, id).filter(({ rec }) => rec.state === "running" && rec.kind !== "process" && ownerLive(rows, rec));
      const att = attribute(
        listeners,
        rows,
        live.map(({ rec }) => ({ sid: rec.sid, chat: rec.chat, root: rec.shellPid, rootStart: rec.shellStart, tracked: rec.tracked })),
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
        await killSession(join(dir, "session.json"), rec);
        killed.push(rec.sid);
      }
      print({ killed });
      return 0;
    }

    case "forget": {
      const id = instance();
      touchContact(root, id);
      if (flags.has("all")) {
        print(await forgetInstance({ root, instance: id, kill: killSession }));
        return 0;
      }
      const chat = need(opts, "chat");
      const r = await forgetChat({ root, instance: id, chat, kill: killSession });
      print(r);
      // Not done: say why, and fail, so the plugin's delete fails and core tries it again.
      if (r.errors?.length) {
        process.stderr.write(`dispatch-host: could not delete chat ${chat}'s refs: ${r.errors.join("; ")}\n`);
        return 1;
      }
      return 0;
    }

    case "mcp-provision": {
      let spec: unknown;
      try {
        spec = JSON.parse(Buffer.from(need(opts, "spec"), "base64").toString("utf8"));
      } catch {
        throw new UsageError("--spec must be base64 JSON");
      }
      print(
        await provision(spec, {
          root,
          node: process.execPath,
          run: runProgram,
          say: (line) => process.stderr.write(`dispatch-host: ${line}\n`),
          env: process.env,
          system: { os: process.platform, uid: process.getuid?.() ?? -1 },
        }),
      );
      return 0;
    }

    case "chats": {
      const id = instance();
      touchContact(root, id);
      print(listChats(root, id));
      return 0;
    }

    case "gc": {
      const id = instance();
      touchContact(root, id);
      print(await collectGarbage({ root, instance: id, now: Date.now(), repoIdleMs: num(opts, "repo-idle-days", 7) * 86_400_000 }));
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
          io: hostPlatform().killIo,
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
export async function killSession(recordFile: string, rec: SessionRecord): Promise<void> {
  // Only signal the owner while it is provably still that process: a pid
  // alone may have been reused by something of the user's.
  const owner = async () => ownerLive(await hostPlatform().procs(), rec);
  if (await owner()) {
    try {
      process.kill(rec.ownerPid, "SIGTERM");
    } catch {
      /* gone */
    }
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      if (readRecord(recordFile)?.state === "exited") return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const target: KillTarget = { root: rec.shellPid, rootStart: rec.shellStart, tracked: rec.tracked, self: process.pid };
  await killTree(hostPlatform().killIo, target);
  if (await owner()) {
    try {
      process.kill(rec.ownerPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  const now = readRecord(recordFile);
  if (now && now.state !== "exited") {
    writeRecord(recordFile, {
      ...now,
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
      // Both drained first: on macOS a pipe is written asynchronously, and an
      // elevated command's last lines (or why it was refused) would be lost.
      process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
    },
    (err: unknown) => {
      process.stderr.write(`dispatch-host: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
