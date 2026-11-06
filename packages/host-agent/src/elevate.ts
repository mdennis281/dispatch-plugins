/**
 * `dispatch-host elevate <command…>`, which chat shells know as
 * `dispatch-elevate` (and `sudo`, shims.ts): ask to run a command as root.
 *
 * It connects to its session's owner (the socket in DISPATCH_ELEVATE_SOCK),
 * sends the command and its directory, and waits. The owner passes it up to
 * Dispatch, which asks the user; on approval the command runs as root and its
 * output comes back here, then its exit code becomes this process's. On a
 * denial, a timeout, or anything else that stops it, it says why on stderr and
 * exits 1. Interrupted, it hangs up, and the owner withdraws the request.
 *
 * This process holds no secret and can elevate nothing by itself: whatever it
 * sends, the user sees before anything runs.
 */
import { connect, type Socket } from "node:net";
import { ELEVATE_SOCKET_ENV } from "./env.js";
import { F, FrameDecoder, checkElevate, decodeJson, encodeFrame, type ElevateEndMsg } from "./protocol.js";

export interface ElevateIo {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: { write(data: Buffer | string): unknown };
  stderr: { write(data: Buffer | string): unknown };
  /** Signals that end the wait (Ctrl-C, a kill). Returns the unsubscribe. */
  onSignal?: (fn: (signal: NodeJS.Signals) => void) => () => void;
  connect?: (path: string) => Socket;
}

const USAGE = "usage: dispatch-elevate <command> [args...]\n  Runs the command as root on this machine once the user approves it in Dispatch.\n";

export function runElevate(args: readonly string[], io: ElevateIo): Promise<number> {
  const argv = args[0] === "--" ? args.slice(1) : [...args];
  const say = (line: string) => io.stderr.write(`dispatch-elevate: ${line}\n`);
  if (!argv.length) {
    io.stderr.write(USAGE);
    return Promise.resolve(2);
  }
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    io.stdout.write(USAGE);
    return Promise.resolve(0);
  }
  const socket = io.env[ELEVATE_SOCKET_ENV];
  if (!socket) {
    say(`not in a Dispatch chat shell (${ELEVATE_SOCKET_ENV} is not set), so there is nobody to ask`);
    return Promise.resolve(1);
  }
  let msg;
  try {
    msg = checkElevate({ argv, cwd: io.cwd });
  } catch (e) {
    say(e instanceof Error ? e.message : String(e));
    return Promise.resolve(2);
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let off = () => {};
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      off();
      sock.destroy();
      resolve(code);
    };
    const sock = (io.connect ?? ((p: string) => connect(p)))(socket);
    const dec = new FrameDecoder();
    sock.on("connect", () => sock.write(encodeFrame(F.elevate, msg)));
    sock.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = dec.push(chunk);
      } catch (e) {
        say(`garbled answer from the session (${String(e)})`);
        return finish(1);
      }
      for (const f of frames) {
        if (f.type === F.elevateData && f.payload.length >= 1) {
          (f.payload.readUInt8(0) === 2 ? io.stderr : io.stdout).write(f.payload.subarray(1));
        } else if (f.type === F.elevateDone) {
          const end = decodeJson<Omit<ElevateEndMsg, "id">>(f.payload) ?? { code: null };
          if (end.error) say(end.error);
          return finish(typeof end.code === "number" ? end.code : end.signal ? 128 + signalNumber(end.signal) : 1);
        }
      }
    });
    sock.on("error", (e: Error) => {
      say(`can't reach this shell's session (${e.message})`);
      finish(1);
    });
    sock.on("close", () => {
      if (settled) return;
      say("the session went away before an answer came");
      finish(1);
    });
    off =
      io.onSignal?.((signal) => {
        say(`interrupted (${signal}); the request is withdrawn`);
        finish(128 + signalNumber(signal));
      }) ?? (() => {});
  });
}

function signalNumber(name: string): number {
  const n = ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[name.startsWith("SIG") ? name : `SIG${name}`];
  return n ?? 1;
}

/** Process-level signal wiring for the real command. */
export function processSignals(fn: (signal: NodeJS.Signals) => void): () => void {
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of sigs) process.on(s, fn);
  return () => {
    for (const s of sigs) process.off(s, fn);
  };
}
