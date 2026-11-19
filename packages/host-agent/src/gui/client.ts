/**
 * Talking to the GUI agent from outside it: the plugin's `dispatch-host gui …`
 * over SSH, and `dispatch-gui` in a chat shell.
 *
 * When the agent doesn't answer, `guiState` says why, in terms a human can
 * act on: nobody is logged in at the Mac (no `gui/<uid>` domain: "Tier A
 * only, log in at the Mac"), launchd doesn't have it, or it has it and it
 * isn't answering.
 */
import { existsSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { userInfo } from "node:os";
import { FrameDecoder, decodeJson, decodeOutput, encodeFrame } from "../protocol.js";
import { Launchd, consoleUser, guiPaths, placeAgent, runFile, type LinkAndPlist, type Run } from "./launchd.js";
import { GF, GUI_PROTOCOL_VERSION, type GuiAgentStatus, type GuiReply, type GuiRequest, type RunExit } from "./protocol.js";

/** What `dispatch-host gui status` (and `install`) print, and the probe carries as `gui`. */
export type GuiState =
  | { state: "running"; agent: GuiAgentStatus }
  /** Nobody is logged in at the screen as this user: there is no GUI session to run in. */
  | { state: "no-gui-session"; user: string; consoleUser: string | null; installed: boolean }
  /** There is a GUI session, but launchd doesn't have the agent (or couldn't load it). */
  | { state: "not-loaded"; user: string; installed: boolean; detail?: string }
  /** launchd has it, and it doesn't answer on its socket. */
  | { state: "not-answering"; user: string; pid?: number; detail?: string }
  /** Not a Mac. */
  | { state: "unsupported"; detail: string };

export type GuiInstallResult = GuiState & { install?: LinkAndPlist };

/** Connect to the agent's socket; undefined when nothing answers within `timeoutMs`. */
export function connectGui(path: string, timeoutMs = 2_000): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const s = connect(path);
    const t = setTimeout(() => {
      s.destroy();
      resolve(undefined);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("error", () => {
      clearTimeout(t);
      resolve(undefined);
    });
  });
}

type Req = GuiRequest extends infer R ? (R extends GuiRequest ? Omit<R, "v"> : never) : never;

/** One request, one reply. Undefined when the agent doesn't answer at all. */
export async function guiCall<T = Record<string, unknown>>(path: string, req: Req, timeoutMs = 60_000): Promise<GuiReply<T> | undefined> {
  const s = await connectGui(path);
  if (!s) return undefined;
  return new Promise((resolve) => {
    const dec = new FrameDecoder();
    let done = false;
    const finish = (r: GuiReply<T> | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      s.destroy();
      resolve(r);
    };
    const t = setTimeout(() => finish({ ok: false, code: "internal", error: `the GUI agent didn't answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    s.on("data", (chunk: Buffer) => {
      for (const f of dec.push(chunk)) if (f.type === GF.reply) finish(decodeJson<GuiReply<T>>(f.payload));
    });
    s.once("close", () => finish(undefined));
    s.once("error", () => finish(undefined));
    s.write(encodeFrame(GF.request, { v: GUI_PROTOCOL_VERSION, ...req }));
  });
}

export interface RunIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** The run's stdin, when it was asked for (`stdin: true`): sent as it comes, its end as EOF. */
  stdin?: NodeJS.ReadableStream;
  /** Signals to pass on to the run; the client registers handlers for them. */
  onSignal?: (forward: (sig: NodeJS.Signals) => void) => void;
}

/**
 * Run a command in the GUI session and stream it here. Resolves with the exit
 * code to end with: the command's, 128 + its signal, or {@link GUI_UNAVAILABLE}
 * when the agent isn't there.
 */
export async function guiRun(path: string, req: Omit<Extract<GuiRequest, { op: "run" }>, "v">, io: RunIo): Promise<number | { error: string; code: number }> {
  const s = await connectGui(path);
  if (!s) return { error: "the GUI agent isn't answering", code: GUI_UNAVAILABLE };
  return new Promise((resolve) => {
    const dec = new FrameDecoder();
    let done = false;
    const finish = (r: number | { error: string; code: number }) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(r);
    };
    io.onSignal?.((sig) => {
      if (!s.destroyed) s.write(encodeFrame(GF.signal, { signal: sig }));
    });
    if (req.stdin && io.stdin) {
      const input = io.stdin;
      input.on("data", (d: Buffer | string) => {
        const b = Buffer.isBuffer(d) ? d : Buffer.from(d);
        // A frame holds at most MAX_FRAME; a pipe's chunks are far smaller, but don't count on it.
        for (let at = 0; at < b.length; at += 1 << 19) if (!s.destroyed) s.write(encodeFrame(GF.stdin, b.subarray(at, at + (1 << 19))));
      });
      input.once("end", () => {
        if (!s.destroyed) s.write(encodeFrame(GF.stdinEnd));
      });
      input.on("error", () => {});
    }
    s.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = dec.push(chunk);
      } catch {
        return finish({ error: "the GUI agent sent something unreadable", code: 1 });
      }
      for (const f of frames) {
        if (f.type === GF.stdout) io.stdout.write(decodeOutput(f.payload).data);
        else if (f.type === GF.stderr) io.stderr.write(decodeOutput(f.payload).data);
        else if (f.type === GF.reply) {
          const r = decodeJson<GuiReply>(f.payload);
          if (!r.ok) return finish({ error: r.error, code: r.code === "spawn-failed" ? 127 : 1 });
        } else if (f.type === GF.exit) {
          const e = decodeJson<RunExit>(f.payload);
          return finish(e.code ?? 128 + signalNumber(e.signal));
        }
      }
    });
    s.once("close", () => finish({ error: "the GUI agent went away mid-run (restarted, or the Mac logged out)", code: GUI_UNAVAILABLE }));
    s.write(encodeFrame(GF.request, { v: GUI_PROTOCOL_VERSION, ...req }));
  });
}

/** `dispatch-gui`'s exit code when there is no GUI agent to ask (EX_TEMPFAIL). */
export const GUI_UNAVAILABLE = 75;

function signalNumber(sig: string | null): number {
  const n: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return (sig && n[sig]) || 1;
}

/** Why there is (or isn't) a GUI agent to talk to. Asks launchd when the socket doesn't answer. */
/**
 * `DISPATCH_HOST_GUI=off` in the agent's environment: no GUI agent here, and
 * launchd is never touched. For tests on a machine whose own login session
 * must not get a LaunchAgent (a CI runner).
 */
function turnedOff(): GuiState | undefined {
  return process.env.DISPATCH_HOST_GUI === "off" ? { state: "unsupported", detail: "turned off on this machine (DISPATCH_HOST_GUI=off)" } : undefined;
}

export async function guiState(o: { root: string; home: string; run?: Run; platform?: NodeJS.Platform }): Promise<GuiState> {
  const off = turnedOff();
  if (off) return off;
  if ((o.platform ?? process.platform) !== "darwin") return { state: "unsupported", detail: "the GUI agent is macOS-only for now" };
  const p = guiPaths(o.root, o.home);
  const r = await guiCall<GuiAgentStatus>(p.socket, { op: "status" }, 30_000);
  if (r?.ok) {
    const { ok: _ok, ...agent } = r;
    return { state: "running", agent: agent as GuiAgentStatus };
  }
  const run = o.run ?? runFile;
  const user = userInfo().username;
  const ld = new Launchd(userInfo().uid, run);
  const installed = existsSync(p.plist);
  if (!(await ld.hasGuiDomain())) return { state: "no-gui-session", user, consoleUser: await consoleUser(run), installed };
  const svc = await ld.service_();
  if (!svc.loaded) return { state: "not-loaded", user, installed };
  return {
    state: "not-answering",
    user,
    ...(svc.pid ? { pid: svc.pid } : {}),
    detail: r && !r.ok ? r.error : svc.pid ? `running as pid ${svc.pid} but not answering` : `not running (${svc.state ?? "?"}, last exit ${svc.lastExit ?? "?"})`,
  };
}

/**
 * `dispatch-host gui install`: put this build in place (never backwards),
 * write the plist, and load it into the GUI session if there is one. Without
 * one, the plist waits there and launchd loads it at the next login.
 */
export async function installGui(o: { root: string; home: string; script: string; run?: Run }): Promise<GuiInstallResult> {
  const off = turnedOff();
  if (off) return off;
  if (process.platform !== "darwin") return { state: "unsupported", detail: "the GUI agent is macOS-only for now" };
  const run = o.run ?? runFile;
  const install = await placeAgent(o);
  const p = guiPaths(o.root, o.home);
  const ld = new Launchd(userInfo().uid, run);
  if (!(await ld.hasGuiDomain())) {
    return { state: "no-gui-session", user: userInfo().username, consoleUser: await consoleUser(run), installed: true, install };
  }
  let svc = await ld.service_();
  if (!svc.loaded) {
    const err = await ld.bootstrap(p.plist);
    if (err) return { state: "not-loaded", user: userInfo().username, installed: true, detail: err, install };
    svc = await ld.service_();
  }
  // Give a fresh start a moment to open its socket.
  const until = Date.now() + 10_000;
  for (;;) {
    const s = await guiState({ root: o.root, home: o.home, run });
    if (s.state === "running" || Date.now() > until) return { ...s, install };
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** `dispatch-host gui uninstall`: boot it out and remove the plist and link. Leases' devices are left. */
export async function uninstallGui(o: { root: string; home: string; run?: Run }): Promise<{ bootout?: string; removed: boolean }> {
  const p = guiPaths(o.root, o.home);
  const removed = existsSync(p.plist);
  rmSync(p.plist, { force: true });
  const err = process.platform === "darwin" ? await new Launchd(userInfo().uid, o.run ?? runFile).bootout() : undefined;
  rmSync(p.current, { force: true });
  rmSync(p.socket, { force: true });
  return { ...(err ? { bootout: err } : {}), removed };
}

export type { LinkAndPlist };
