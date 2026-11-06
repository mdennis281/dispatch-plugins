/**
 * `dispatch-host gui serve`: the GUI agent (Tier B). launchd runs it in the
 * user's login session (launchd.ts). Processes started from an SSH session
 * can't reach the window server or the session's services: headless
 * Playwright WebKit never finishes launching (cvx-mac, 2026-11-06), and UI
 * tests, the Simulator and safaridriver need the session too. So this agent
 * starts them on a chat's behalf and streams their output back.
 *
 * It answers on `<root>/run/gui.sock`:
 * - `run`: start a command in the session, stream its output, end it when
 *   the client goes away. A chat shell's `dispatch-gui run …` is one client.
 * - `sim`: the chat's own Simulator, cloned on first ask (sims.ts).
 * - `safari`: the ONE Safari lease. Real Safari runs one automation session
 *   at a time, so one chat holds it (safaridriver on a port of its own)
 *   until it releases it, goes idle, or stops renewing it.
 * - `release`: a chat went idle (its runs end, its Simulator shuts down, its
 *   Safari lease goes) or was deleted (its Simulator is deleted too).
 * - `status`: version, the login session, dialogs on screen, leases.
 *
 * **Upgrades** (launchd.ts): when `current.mjs` points at a newer build, it
 * exits once nothing it started is running, and launchd starts the new one.
 * Leases are on disk and survive; booted Simulators belong to CoreSimulator
 * and survive too.
 *
 * **Dead-man switch**, as Tier A's: no Dispatch instance has talked to this
 * machine (every instance's `contact` stamp) for `deadManMs`: its runs are
 * killed, Simulators shut down, Safari released, and the machine may sleep
 * again. After `bootoutMs` it removes its plist and boots itself out of
 * launchd: a plugin that was disabled or uninstalled leaves nothing running.
 * The next connect from a plugin installs it again.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpProbe } from "node:http";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { posix } from "node:path";
import { randomBytes } from "node:crypto";
import { assertId } from "../layout.js";
import { FrameDecoder, decodeJson, encodeFrame, encodeOutput } from "../protocol.js";
import { compareVersions } from "../runtime.js";
import { AGENT_VERSION } from "../version.js";
import { findDialogs, readScreen, type ScreenState } from "./dialogs.js";
import { Launchd, buildOf, guiPaths, runFile, versionOfBuild, type GuiPaths, type Run } from "./launchd.js";
import {
  GF,
  GUI_PROTOCOL_VERSION,
  type ChatRef,
  type GuiAgentStatus,
  type GuiErrorCode,
  type GuiReply,
  type GuiRequest,
  type RunExit,
  type SafariLease,
  type SimLease,
} from "./protocol.js";
import { Simctl, chatDeviceName, type SimCheck } from "./sims.js";

/** What the agent keeps on disk: `gui/state.json`. Only the agent writes it. */
export interface GuiState {
  v: 1;
  /** By `<instance>/<chat>`. */
  sims: Record<string, SimLease & ChatRef>;
  safari?: SafariLease;
}

export function leaseKey(r: ChatRef): string {
  return `${r.instance}/${r.chat}`;
}

export function readGuiState(file: string): GuiState {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<GuiState>;
    if (s && s.v === 1 && s.sims && typeof s.sims === "object") return { v: 1, sims: s.sims, ...(s.safari ? { safari: s.safari } : {}) };
  } catch {
    /* none yet, or unreadable: start empty */
  }
  return { v: 1, sims: {} };
}

/** A chat's Simulator, from the state file, for a session owner exporting `DISPATCH_SIM_UDID`. */
export function simFor(file: string, r: ChatRef): string | undefined {
  return readGuiState(file).sims[leaseKey(r)]?.udid;
}

/** The newest `contact` stamp of any instance under `root` (epoch ms), or undefined if none has one. */
export function lastAnyContact(root: string): number | undefined {
  let last: number | undefined;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const n of names) {
    try {
      const m = statSync(posix.join(root, n, "contact")).mtimeMs;
      if (last === undefined || m > last) last = m;
    } catch {
      /* not an instance */
    }
  }
  return last;
}

export interface GuiTiming {
  /** How often it checks for a newer build. */
  upgradeEveryMs: number;
  /** How often it checks the dead-man switch, Safari's lease, and pending deletes. */
  tickMs: number;
  deadManMs: number;
  bootoutMs: number;
  /** A Safari lease not renewed for this long is dropped. */
  safariLeaseMs: number;
  /** How long `status` reuses what it last read off the screen. */
  screenCacheMs: number;
  /** How long `status` reuses the Simulator check. */
  simCheckCacheMs: number;
  /** A run whose client went away: SIGTERM, then SIGKILL after this long. */
  killGraceMs: number;
}

export const DEFAULT_GUI_TIMING: GuiTiming = {
  upgradeEveryMs: 15_000,
  tickMs: 60_000,
  deadManMs: 12 * 3_600_000,
  bootoutMs: 7 * 24 * 3_600_000,
  safariLeaseMs: 30 * 60_000,
  screenCacheMs: 5_000,
  simCheckCacheMs: 60_000,
  killGraceMs: 5_000,
};

export interface GuiServerOptions {
  root: string;
  home: string;
  /** This agent's own script, `agent/<build>/dispatch-host.mjs`. */
  script: string;
  run?: Run;
  now?: () => number;
  timing?: Partial<GuiTiming>;
  /** What the screen shows; tests pass a fake. */
  screen?: () => Promise<ScreenState>;
  simctl?: Simctl;
  launchd?: Launchd;
  /** Starts safaridriver; tests pass a fake. Resolves with the child once it answers on `port`. */
  safaridriver?: (port: number) => Promise<ChildProcess>;
  /** Holds off idle sleep while something runs; tests pass a fake. Returns its release. */
  caffeinate?: () => () => void;
  /** The process ending (an upgrade, a boot-out); tests pass a fake. */
  exit?: (code: number) => void;
  /** Base environment for simctl and for runs that bring none. */
  env?: NodeJS.ProcessEnv;
}

interface LiveRun {
  id: string;
  child: ChildProcess;
  chat?: ChatRef;
  sock: Socket;
  argv0: string;
  startedAt: number;
}

export class GuiServer {
  readonly paths: GuiPaths;
  private server?: Server;
  private readonly runs = new Map<string, LiveRun>();
  private state: GuiState;
  private safariChild?: ChildProcess;
  private releaseCaffeinate?: () => void;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private screenCache?: { at: number; s: ScreenState };
  private simCache?: { at: number; c: SimCheck };
  private simBusy = new Map<string, Promise<SimLease>>();
  private deadManFired = false;
  private stopping = false;
  readonly startedAt: number;
  readonly build: string;
  upgradePending?: string;
  private readonly t: GuiTiming;
  private readonly run: Run;
  private readonly now: () => number;
  private readonly simctl: Simctl;
  private readonly launchd: Launchd;

  constructor(private readonly o: GuiServerOptions) {
    this.paths = guiPaths(o.root, o.home);
    this.t = { ...DEFAULT_GUI_TIMING, ...o.timing };
    this.run = o.run ?? runFile;
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    this.build = buildOf(o.script) ?? "unknown";
    this.state = readGuiState(this.paths.state);
    this.simctl = o.simctl ?? new Simctl(this.run, () => this.o.env ?? process.env);
    this.launchd = o.launchd ?? new Launchd(userInfo().uid, this.run);
  }

  log(line: string): void {
    try {
      mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
      try {
        if (statSync(this.paths.log).size > 2 * 1024 * 1024) renameSync(this.paths.log, `${this.paths.log}.1`);
      } catch {
        /* no log yet */
      }
      appendFileSync(this.paths.log, `${new Date(this.now()).toISOString()} [${process.pid}] ${line}\n`, { mode: 0o600 });
    } catch {
      /* logging must never take the agent down */
    }
  }

  /** Listen on the socket. Rejects if another agent already answers there. */
  async start(): Promise<void> {
    const sock = this.paths.socket;
    mkdirSync(posix.dirname(sock), { recursive: true, mode: 0o700 });
    if (await answers(sock)) throw new Error(`another GUI agent already answers on ${sock}`);
    rmSync(sock, { force: true });
    const server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(sock, 0o600);
    this.server = server;
    this.log(`GUI agent ${AGENT_VERSION} (${this.build}) listening on ${sock}`);
    await this.processPending();
    this.timers.push(setInterval(() => void this.checkUpgrade(), this.t.upgradeEveryMs));
    this.timers.push(setInterval(() => void this.tick(), this.t.tickMs));
    for (const t of this.timers) t.unref?.();
  }

  /** Stop listening and end everything it started (not leases on disk). */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const r of [...this.runs.values()]) this.killRun(r, "SIGKILL");
    this.stopSafariDriver();
    this.releaseCaffeinate?.();
    this.releaseCaffeinate = undefined;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    rmSync(this.paths.socket, { force: true });
  }

  get runCount(): number {
    return this.runs.size;
  }

  // ---------------------------------------------------------------- requests

  private accept(sock: Socket): void {
    const dec = new FrameDecoder();
    let handled = false;
    let run: LiveRun | undefined;
    sock.on("error", () => {});
    sock.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = dec.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const f of frames) {
        if (!handled && f.type === GF.request) {
          handled = true;
          let req: GuiRequest;
          try {
            req = decodeJson<GuiRequest>(f.payload);
          } catch {
            this.reply(sock, { ok: false, code: "bad-request", error: "the request isn't JSON" });
            return;
          }
          void this.handle(req, sock).then((r) => {
            run = r;
          });
        } else if (f.type === GF.signal && run) {
          const sig = (decodeJson<{ signal?: string }>(f.payload).signal ?? "SIGINT") as NodeJS.Signals;
          if (/^SIG[A-Z0-9]+$/.test(sig)) this.signalRun(run, sig);
        }
      }
    });
  }

  private reply(sock: Socket, r: { ok: boolean; [k: string]: unknown }): void {
    if (sock.destroyed) return;
    sock.end(encodeFrame(GF.reply, r));
  }

  private fail(sock: Socket, code: GuiErrorCode, error: string): undefined {
    this.reply(sock, { ok: false, code, error });
    return undefined;
  }

  private async handle(req: GuiRequest, sock: Socket): Promise<LiveRun | undefined> {
    try {
      switch (req?.op) {
        case "status":
          this.reply(sock, { ok: true, ...(await this.status()) });
          return undefined;
        case "run":
          return this.startRun(req, sock);
        case "sim": {
          const ref = chatRef(req);
          const lease = await this.simLease(ref);
          this.reply(sock, { ok: true, ...lease });
          return undefined;
        }
        case "safari": {
          const ref = chatRef(req);
          if (req.release) {
            const had = this.dropSafari(ref);
            this.reply(sock, { ok: true, released: had });
          } else {
            this.reply(sock, { ...(await this.safariLease(ref)) });
          }
          return undefined;
        }
        case "renew": {
          const instance = assertId("instance", req.instance);
          const chats = Array.isArray(req.chats) ? req.chats.map((c) => assertId("chat", c)) : [];
          this.reply(sock, { ok: true, ...this.renewSafari(instance, chats) });
          return undefined;
        }
        case "release": {
          const instance = assertId("instance", req.instance);
          const chat = req.chat === undefined ? undefined : assertId("chat", req.chat);
          this.reply(sock, { ok: true, ...(await this.release(instance, chat, !!req.forget)) });
          return undefined;
        }
        default:
          return this.fail(sock, "unknown-op", `this GUI agent (${AGENT_VERSION}) doesn't know ${JSON.stringify((req as { op?: unknown })?.op)}`);
      }
    } catch (e) {
      const code: GuiErrorCode = e instanceof GuiError ? e.code : "internal";
      return this.fail(sock, code, e instanceof Error ? e.message : String(e));
    }
  }

  // ---------------------------------------------------------------- status

  async status(): Promise<GuiAgentStatus> {
    const now = this.now();
    if (!this.screenCache || now - this.screenCache.at > this.t.screenCacheMs) {
      const s = await (this.o.screen ?? (() => readScreen(this.run)))().catch(
        (e: unknown): ScreenState => ({ session: null, windows: null, error: String(e) }),
      );
      this.screenCache = { at: now, s };
    }
    const screen = this.screenCache.s;
    const sims = await this.simCheck();
    const contact = lastAnyContact(this.o.root);
    return {
      agentVersion: AGENT_VERSION,
      protocol: GUI_PROTOCOL_VERSION,
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      build: this.build,
      ...(this.upgradePending ? { upgradePending: this.upgradePending } : {}),
      session: screen.session,
      dialogs: screen.windows ? findDialogs(screen.windows) : null,
      ...(screen.error ? { dialogsError: screen.error } : {}),
      simulators: sims.usable
        ? { usable: true, runtime: sims.choice.runtime.name, deviceType: sims.choice.deviceType.name }
        : { usable: false, reason: sims.reason },
      runs: this.runs.size,
      sims: Object.keys(this.state.sims).length,
      ...(this.state.safari ? { safari: this.state.safari } : {}),
      silentForMs: contact === undefined ? now - this.startedAt : Math.max(0, now - contact),
    };
  }

  private async simCheck(): Promise<SimCheck> {
    const now = this.now();
    if (this.simCache && now - this.simCache.at <= this.t.simCheckCacheMs) return this.simCache.c;
    const c = await this.simctl.check().catch((e: unknown): SimCheck => ({ usable: false, reason: String(e) }));
    this.simCache = { at: now, c };
    return c;
  }

  // ---------------------------------------------------------------- runs

  private startRun(req: Extract<GuiRequest, { op: "run" }>, sock: Socket): LiveRun | undefined {
    if (!Array.isArray(req.argv) || !req.argv.length || !req.argv.every((a) => typeof a === "string")) {
      return this.fail(sock, "bad-request", "run needs argv: a non-empty list of strings");
    }
    if (typeof req.cwd !== "string" || !req.cwd.startsWith("/")) return this.fail(sock, "bad-request", "run needs an absolute cwd");
    let chat: ChatRef | undefined;
    try {
      chat = req.instance && req.chat ? { instance: assertId("instance", req.instance), chat: assertId("chat", req.chat) } : undefined;
    } catch (e) {
      return this.fail(sock, "bad-request", String(e));
    }
    const env = runEnv(req.env, this.o.env ?? process.env);
    if (chat && !env.DISPATCH_SIM_UDID) {
      const udid = this.state.sims[leaseKey(chat)]?.udid;
      if (udid) env.DISPATCH_SIM_UDID = udid;
    }
    let child: ChildProcess;
    try {
      // Its own process group, so the whole tree it starts can be signalled.
      child = spawn(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return this.fail(sock, "spawn-failed", e instanceof Error ? e.message : String(e));
    }
    const id = `${this.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const r: LiveRun = { id, child, ...(chat ? { chat } : {}), sock, argv0: req.argv[0]!, startedAt: this.now() };
    let started = false;
    child.once("error", (e) => {
      if (!started) {
        this.fail(sock, "spawn-failed", `${req.argv[0]}: ${e.message}`);
        this.runs.delete(id);
        this.updateCaffeinate();
      }
    });
    child.once("spawn", () => {
      started = true;
      sock.write(encodeFrame(GF.started, { runId: id, pid: child.pid! }));
    });
    let out = 0;
    let err = 0;
    // The pipes may close before or after `exit`: count them from the start.
    let pipesOpen = 2;
    let onPipesClosed: (() => void) | undefined;
    const pipeClosed = () => {
      if (--pipesOpen === 0) onPipesClosed?.();
    };
    child.stdout!.once("close", pipeClosed);
    child.stderr!.once("close", pipeClosed);
    child.stdout!.on("data", (d: Buffer) => {
      for (const f of encodeOutput(GF.stdout, out, d)) if (!sock.destroyed) sock.write(f);
      out += d.length;
    });
    child.stderr!.on("data", (d: Buffer) => {
      for (const f of encodeOutput(GF.stderr, err, d)) if (!sock.destroyed) sock.write(f);
      err += d.length;
    });
    child.once("exit", (code, signal) => {
      // Something it started may hold its pipes open; don't wait on that for long.
      let sent = false;
      const finish = () => {
        if (sent) return;
        sent = true;
        this.runs.delete(id);
        this.updateCaffeinate();
        const e: RunExit = { code, signal };
        if (!sock.destroyed) sock.end(encodeFrame(GF.exit, e));
        this.log(`run ${id} (${r.argv0}) ended: ${signal ?? `exit ${code}`}`);
      };
      if (pipesOpen === 0) return finish();
      onPipesClosed = finish;
      setTimeout(finish, 2_000).unref?.();
    });
    // The client went away (Ctrl-C'd, its shell killed): so does the run.
    sock.once("close", () => {
      if (this.runs.has(id)) this.killRun(r, "SIGTERM");
    });
    this.runs.set(id, r);
    this.updateCaffeinate();
    this.log(`run ${id} for ${chat ? leaseKey(chat) : "no chat"}: ${req.argv.join(" ").slice(0, 300)} in ${req.cwd}`);
    return r;
  }

  private signalRun(r: LiveRun, sig: NodeJS.Signals): void {
    try {
      process.kill(-r.child.pid!, sig);
    } catch {
      /* gone */
    }
  }

  /** SIGTERM (then SIGKILL after the grace) to the run's whole process group. */
  private killRun(r: LiveRun, sig: NodeJS.Signals = "SIGTERM"): void {
    this.signalRun(r, sig);
    // Then SIGKILL whatever is left in its group, the leader or stragglers.
    if (sig !== "SIGKILL") setTimeout(() => this.signalRun(r, "SIGKILL"), this.t.killGraceMs).unref?.();
  }

  private updateCaffeinate(): void {
    const busy = this.runs.size > 0 || !!this.state.safari;
    if (busy && !this.releaseCaffeinate && !this.stopping) {
      this.releaseCaffeinate = (this.o.caffeinate ?? caffeinate)();
    } else if (!busy && this.releaseCaffeinate) {
      this.releaseCaffeinate();
      this.releaseCaffeinate = undefined;
    }
  }

  // ---------------------------------------------------------------- Simulator

  async simLease(ref: ChatRef): Promise<SimLease> {
    const key = leaseKey(ref);
    const busy = this.simBusy.get(key);
    if (busy) return busy;
    const p = this.makeSim(ref).finally(() => this.simBusy.delete(key));
    this.simBusy.set(key, p);
    return p;
  }

  private async makeSim(ref: ChatRef): Promise<SimLease> {
    const key = leaseKey(ref);
    const have = this.state.sims[key];
    if (have) {
      const devices = await this.simctl.devices().catch(() => undefined);
      // Deleted by hand (or by Xcode): make a new one. Unknown (simctl failing): keep what we have.
      if (!devices || devices.some((d) => d.udid === have.udid)) return have;
      this.log(`sim ${have.udid} of ${key} is gone; cloning a new one`);
    }
    this.simCache = undefined;
    const check = await this.simCheck();
    if (!check.usable) throw new GuiError("sim-unavailable", `no Simulator for this chat: ${check.reason}`);
    const base = await this.simctl.base(check.choice);
    const name = chatDeviceName(ref.instance, ref.chat);
    const udid = await this.simctl.clone(base, name);
    const lease: SimLease & ChatRef = {
      ...ref,
      udid,
      name,
      runtime: check.choice.runtime.name,
      deviceType: check.choice.deviceType.name,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.state.sims[key] = lease;
    this.save();
    this.log(`sim ${udid} (${name}) cloned for ${key}`);
    return lease;
  }

  // ---------------------------------------------------------------- Safari

  private async safariLease(ref: ChatRef): Promise<GuiReply<SafariLease & { renewed: boolean }>> {
    const now = this.now();
    const held = this.state.safari;
    if (held && leaseKey(held) !== leaseKey(ref) && Date.parse(held.expiresAt) > now) {
      return {
        ok: false,
        code: "leased",
        error: `Safari is leased to another chat (${held.chat}${held.instance === ref.instance ? "" : ", from another Dispatch"}) since ${held.since}, until ${held.expiresAt} unless it renews`,
      };
    }
    const expiresAt = new Date(now + this.t.safariLeaseMs).toISOString();
    if (held && leaseKey(held) === leaseKey(ref) && this.safariChild && this.safariChild.exitCode === null) {
      this.state.safari = { ...held, expiresAt };
      this.save();
      return { ok: true, ...this.state.safari, renewed: true };
    }
    if (held) this.dropSafari(held);
    const port = await freePort();
    const child = await (this.o.safaridriver ?? startSafaridriver)(port);
    this.safariChild = child;
    child.once("exit", () => {
      if (this.safariChild === child) this.safariChild = undefined;
    });
    this.state.safari = { ...ref, port, since: new Date(now).toISOString(), expiresAt };
    this.save();
    this.updateCaffeinate();
    this.log(`Safari leased to ${leaseKey(ref)}: safaridriver on 127.0.0.1:${port}`);
    return { ok: true, ...this.state.safari, renewed: false };
  }

  /** Push the Safari lease's expiry out if one of `chats` (of `instance`) holds it. Starts nothing. */
  renewSafari(instance: string, chats: readonly string[]): { renewed: boolean; expiresAt?: string } {
    const held = this.state.safari;
    if (!held || held.instance !== instance || !chats.includes(held.chat)) return { renewed: false };
    const expiresAt = new Date(this.now() + this.t.safariLeaseMs).toISOString();
    this.state.safari = { ...held, expiresAt };
    this.save();
    return { renewed: true, expiresAt };
  }

  /** Drop the Safari lease if `ref` holds it. */
  private dropSafari(ref: ChatRef): boolean {
    const held = this.state.safari;
    if (!held || leaseKey(held) !== leaseKey(ref)) return false;
    this.stopSafariDriver();
    delete this.state.safari;
    this.save();
    this.updateCaffeinate();
    this.log(`Safari lease of ${leaseKey(ref)} released`);
    return true;
  }

  private stopSafariDriver(): void {
    const c = this.safariChild;
    this.safariChild = undefined;
    if (c && c.exitCode === null) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  }

  // ---------------------------------------------------------------- release

  async release(instance: string, chat: string | undefined, forget: boolean): Promise<{ runs: number; sims: string[]; safari: boolean; errors?: string[] }> {
    const mine = (r: ChatRef) => r.instance === instance && (chat === undefined || r.chat === chat);
    let runs = 0;
    for (const r of [...this.runs.values()]) {
      if (r.chat && mine(r.chat)) {
        this.killRun(r);
        runs++;
      }
    }
    const safari = this.state.safari && mine(this.state.safari) ? this.dropSafari(this.state.safari) : false;
    const sims: string[] = [];
    const errors: string[] = [];
    for (const [key, lease] of Object.entries(this.state.sims)) {
      if (!mine(lease)) continue;
      try {
        if (forget) {
          await this.simctl.delete(lease.udid);
          delete this.state.sims[key];
        } else {
          await this.simctl.shutdown(lease.udid);
        }
        sims.push(lease.udid);
      } catch (e) {
        errors.push(`${lease.udid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (forget) this.save();
    if (runs || sims.length || safari) {
      this.log(`${forget ? "forgot" : "released"} ${chat ? `${instance}/${chat}` : `all of ${instance}`}: ${runs} run(s), ${sims.length} sim(s)${safari ? ", Safari" : ""}`);
    }
    return { runs, sims, safari, ...(errors.length ? { errors } : {}) };
  }

  /** Chats deleted while the agent wasn't running: `forget` left a file for each. */
  private async processPending(): Promise<void> {
    let names: string[] = [];
    try {
      names = readdirSync(this.paths.pending);
    } catch {
      return;
    }
    for (const n of names) {
      const m = n.match(/^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64}|\*)$/);
      if (m) {
        const r = await this.release(m[1]!, m[2] === "*" ? undefined : m[2], true).catch((e: unknown) => ({ errors: [String(e)] }));
        if (r.errors?.length) {
          this.log(`pending delete ${n}: ${r.errors.join("; ")}`);
          continue; // try again at the next tick
        }
      }
      rmSync(posix.join(this.paths.pending, n), { force: true });
    }
  }

  // ---------------------------------------------------------------- timers

  /** Restart into a newer build, once nothing of ours is running. */
  async checkUpgrade(): Promise<boolean> {
    if (this.stopping) return false;
    let target: string;
    let mine: string;
    try {
      target = realpathSync(this.paths.current);
      mine = realpathSync(this.o.script);
    } catch {
      return false; // no link (uninstalled under us) or our own file gone: stay as we are
    }
    if (target === mine) return false;
    const want = buildOf(target);
    const tv = versionOfBuild(want);
    if (!want || !tv || compareVersions(tv, AGENT_VERSION) <= 0) return false; // never back
    if (this.upgradePending !== want) this.log(`a newer build is installed (${want}); restarting into it once idle`);
    this.upgradePending = want;
    if (this.runs.size || this.state.safari || this.simBusy.size) return false;
    this.log(`restarting into ${want}`);
    await this.stop();
    (this.o.exit ?? process.exit)(0);
    return true;
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    // Safari: a lease nobody renewed.
    const s = this.state.safari;
    if (s && Date.parse(s.expiresAt) <= now) {
      this.log(`Safari lease of ${leaseKey(s)} expired`);
      this.dropSafari(s);
    }
    await this.processPending();
    await this.deadMan(now);
  }

  private async deadMan(now: number): Promise<void> {
    const contact = lastAnyContact(this.o.root) ?? this.startedAt;
    const silent = now - contact;
    if (silent <= this.t.deadManMs) {
      this.deadManFired = false;
      return;
    }
    if (!this.deadManFired) {
      this.deadManFired = true;
      this.log(`dead-man: no Dispatch contact for ${Math.round(silent / 3_600_000)}h; ending runs, shutting Simulators down, releasing Safari`);
      for (const r of [...this.runs.values()]) this.killRun(r);
      if (this.state.safari) this.dropSafari(this.state.safari);
      for (const lease of Object.values(this.state.sims)) await this.simctl.shutdown(lease.udid).catch(() => {});
      this.updateCaffeinate();
    }
    if (silent > this.t.bootoutMs) {
      this.log(`dead-man: no Dispatch contact for ${Math.round(silent / 86_400_000)} days; removing the LaunchAgent and booting out`);
      rmSync(this.paths.plist, { force: true });
      await this.stop();
      const err = await this.launchd.bootout();
      // bootout ends this process; reaching here means it didn't.
      if (err) this.log(err);
      (this.o.exit ?? process.exit)(0);
    }
  }

  private save(): void {
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.paths.state}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.paths.state);
  }
}

export class GuiError extends Error {
  constructor(
    readonly code: GuiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function chatRef(req: { instance?: unknown; chat?: unknown }): ChatRef {
  try {
    return { instance: assertId("instance", req.instance), chat: assertId("chat", req.chat) };
  } catch (e) {
    throw new GuiError("bad-request", e instanceof Error ? e.message : String(e));
  }
}

/**
 * A run's environment: the client's own (a chat shell's PATH, DEVELOPER_DIR,
 * …), minus what only made sense in its SSH session. TMPDIR falls back to the
 * agent's: the login session's per-user temporary directory.
 */
export function runEnv(fromClient: unknown, agentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  if (fromClient && typeof fromClient === "object") {
    for (const [k, v] of Object.entries(fromClient as Record<string, unknown>)) {
      if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (/^SSH_/.test(k)) continue;
      env[k] = v;
    }
  }
  for (const k of ["HOME", "USER", "LOGNAME", "TMPDIR", "PATH"]) {
    if (!env[k] && agentEnv[k]) env[k] = agentEnv[k]!;
  }
  return env;
}

/** Whether something answers on the unix socket `path`. */
export function answers(path: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(path)) return resolve(false);
    const s = connect(path);
    const done = (v: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** A TCP port free on loopback right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createHttpProbe();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** safaridriver on `port`, once it answers `/status`. */
async function startSafaridriver(port: number): Promise<ChildProcess> {
  const child = spawn("/usr/bin/safaridriver", ["-p", String(port)], { stdio: "ignore" });
  const until = Date.now() + 15_000;
  let exited: string | undefined;
  child.once("exit", (code, sig) => {
    exited = sig ?? `exit ${code}`;
  });
  child.once("error", (e) => {
    exited = e.message;
  });
  while (Date.now() < until) {
    if (exited) throw new Error(`safaridriver ended at once (${exited})`);
    const ok = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGKILL");
  throw new Error("safaridriver didn't answer within 15 s");
}

/** `caffeinate -i` tied to this process: no idle sleep while it runs. */
function caffeinate(): () => void {
  const c = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  c.on("error", () => {});
  return () => {
    try {
      c.kill("SIGTERM");
    } catch {
      /* gone */
    }
  };
}
