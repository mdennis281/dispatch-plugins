/**
 * Installing and starting the GUI agent (Tier B) as a per-user LaunchAgent.
 *
 *   ~/Library/LaunchAgents/com.dispatch-host.gui.plist
 *       runs  <root>/runtime/node/bin/node <root>/gui/current.mjs gui serve --root <root>
 *   <root>/gui/current.mjs  → ../agent/<build>/dispatch-host.mjs   (a symlink)
 *   <root>/run/gui.sock      the agent's socket
 *
 * **One agent per user, shared by every Dispatch instance.** Stable and dev
 * share the machine and may run different plugin builds. The plist never
 * names a build: it names `current.mjs`, so it never has to change when the
 * agent does, and launchd never has to be told.
 *
 * **Upgrades go side by side and never downgrade.** `gui install` (run with a
 * plugin's own build) repoints `current.mjs` only at a NEWER version than
 * the one it points at. The running agent notices and restarts into it, but
 * only once nothing it started is still running (gui/server.ts); launchd's
 * KeepAlive brings it back on the new build. An older build installing
 * leaves everything as it is, and its client talks to the newer agent
 * (gui/protocol.ts says how both sides cope).
 *
 * **It lives in the Aqua session.** `LimitLoadToSessionType Aqua`: launchd
 * loads it whenever the user logs in at the screen, and it dies at logout.
 * With nobody logged in there is no `gui/<uid>` domain at all, so the
 * machine is "Tier A only" until someone logs in. FileVault rules out
 * auto-login, so after a reboot that is someone at the Mac.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { compareVersions } from "../runtime.js";

export const GUI_LABEL = "com.dispatch-host.gui";

/** Bumped when the plist's content changes. A plist of a newer format is never overwritten by an older build. */
export const PLIST_FORMAT = 1;

export interface GuiPaths {
  dir: string;
  /** The symlink the plist runs. */
  current: string;
  /** Leases, written only by the agent; read by session owners (`DISPATCH_SIM_UDID`). */
  state: string;
  /** The agent's own log. */
  log: string;
  /** What launchd captures (crashes before the log opens). */
  launchdLog: string;
  socket: string;
  /** Chats deleted while the agent was down, for it to clean up when it starts. */
  pending: string;
  plist: string;
  node: string;
}

export function guiPaths(root: string, home: string): GuiPaths {
  const dir = posix.join(root, "gui");
  return {
    dir,
    current: posix.join(dir, "current.mjs"),
    state: posix.join(dir, "state.json"),
    log: posix.join(dir, "agent.log"),
    launchdLog: posix.join(dir, "launchd.log"),
    socket: posix.join(root, "run", "gui.sock"),
    pending: posix.join(dir, "pending"),
    plist: posix.join(home, "Library", "LaunchAgents", `${GUI_LABEL}.plist`),
    node: posix.join(root, "runtime", "node", "bin", "node"),
  };
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The LaunchAgent's plist. Names no build, so every build writes the same bytes. */
export function plistXml(root: string, p: GuiPaths): string {
  const args = [p.node, p.current, "gui", "serve", "--root", root];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- dispatch-host GUI agent, plist format ${PLIST_FORMAT}. Written by \`dispatch-host gui install\`; removed by its uninstall. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${GUI_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    `  </array>`,
    `  <key>LimitLoadToSessionType</key><string>Aqua</string>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `  <key>ProcessType</key><string>Interactive</string>`,
    `  <key>ThrottleInterval</key><integer>10</integer>`,
    `  <key>StandardOutPath</key><string>${xml(p.launchdLog)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(p.launchdLog)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** The format a plist on disk says it is; 0 when it says nothing (not ours, or hand-made). */
export function plistFormat(text: string): number {
  const m = text.match(/plist format (\d+)/);
  return m ? Number(m[1]) : 0;
}

/** `agent/<version>-<hash>/dispatch-host.mjs` → `<version>-<hash>`; undefined for anything else. */
export function buildOf(script: string): string | undefined {
  const dir = posix.basename(posix.dirname(script.split("\\").join("/")));
  return /^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(dir) ? dir : undefined;
}

export function versionOfBuild(build: string | undefined): string | undefined {
  return build?.match(/^(\d+\.\d+\.\d+)-/)?.[1];
}

/**
 * Where `current.mjs` should point, given where it points now (`now`, the
 * build id, or undefined when missing or dangling) and the build installing
 * (`mine`). Only ever forward.
 */
export function decideLink(now: string | undefined, mine: string): "install" | "upgrade" | "keep" {
  if (!now) return "install";
  const a = versionOfBuild(now);
  const b = versionOfBuild(mine);
  if (!a || !b) return "upgrade"; // something that isn't a build of ours
  return compareVersions(b, a) > 0 ? "upgrade" : "keep";
}

/** The build `current.mjs` points at, when it points at an agent that is there. */
export function currentBuild(p: GuiPaths): string | undefined {
  try {
    const target = readlinkSync(p.current);
    if (!existsSync(p.current)) return undefined; // dangling
    return buildOf(target);
  } catch {
    return undefined;
  }
}

/** Point `current.mjs` at `script`, atomically: a new link beside it, renamed over. */
export function pointCurrent(p: GuiPaths, script: string): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const rel = posix.relative(p.dir, script);
  const tmp = `${p.current}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(rel, tmp);
  renameSync(tmp, p.current);
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (file: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv) => Promise<Ran>;

export const runFile: Run = (file, args, timeoutMs = 15_000, env) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** launchd, for one user. Every call is a `launchctl` the `dispatch` account may make: no sudo anywhere. */
export class Launchd {
  constructor(
    readonly uid: number,
    private readonly run: Run = runFile,
  ) {}

  get domain(): string {
    return `gui/${this.uid}`;
  }

  get service(): string {
    return `${this.domain}/${GUI_LABEL}`;
  }

  /** Whether the user has a GUI login session (someone is logged in at the screen as them). */
  async hasGuiDomain(): Promise<boolean> {
    // `print` of a whole domain is large; asking for a service that is surely
    // absent tells the same thing: 113 "could not find service" when the
    // domain is there, 125 or similar when it isn't.
    const r = await this.run("/bin/launchctl", ["print", `${this.domain}/${GUI_LABEL}.probe-absent`]);
    if (r.code === 0) return true;
    return r.code === 113 || /could not find service/i.test(r.stderr + r.stdout);
  }

  /** The service, when launchd has it: its pid (if running) and state. */
  async service_(): Promise<{ loaded: boolean; pid?: number; state?: string; lastExit?: string }> {
    const r = await this.run("/bin/launchctl", ["print", this.service]);
    if (r.code !== 0) return { loaded: false };
    const pid = r.stdout.match(/^\s*pid = (\d+)/m)?.[1];
    const state = r.stdout.match(/^\s*state = (.+)$/m)?.[1]?.trim();
    const lastExit = r.stdout.match(/^\s*last exit code = (.+)$/m)?.[1]?.trim();
    return { loaded: true, ...(pid ? { pid: Number(pid) } : {}), ...(state ? { state } : {}), ...(lastExit ? { lastExit } : {}) };
  }

  /** Load the plist into the GUI domain. Undefined on success, else launchctl's complaint. */
  async bootstrap(plist: string): Promise<string | undefined> {
    // A service the user (or an old bootout) disabled won't load: enable first. Harmless when it isn't.
    await this.run("/bin/launchctl", ["enable", this.service]);
    const r = await this.run("/bin/launchctl", ["bootstrap", this.domain, plist]);
    if (r.code === 0) return undefined;
    // Already loaded (a race with launchd's own load at login, or another installer): that's fine.
    if (r.code === 37 || /already (loaded|bootstrapped)|in progress/i.test(r.stderr + r.stdout)) return undefined;
    return `launchctl bootstrap ${this.domain} exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`.trim();
  }

  async bootout(): Promise<string | undefined> {
    const r = await this.run("/bin/launchctl", ["bootout", this.service]);
    if (r.code === 0 || r.code === 113 || /could not find|no such process/i.test(r.stderr + r.stdout)) return undefined;
    return `launchctl bootout exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`;
  }
}

/** Who is at the screen: `root` (or null) means the login window, so nobody. */
export async function consoleUser(run: Run = runFile): Promise<string | null> {
  const r = await run("/usr/bin/stat", ["-f", "%Su", "/dev/console"]);
  const u = r.code === 0 ? r.stdout.trim() : "";
  return u || null;
}

/**
 * Take the machine-wide install lock (the same directory the shell installers
 * use, install.ts), waiting up to `waitMs`. Returns its release.
 */
export async function takeInstallLock(root: string, waitMs = 60_000): Promise<() => void> {
  const l = posix.join(root, "install.lock");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(l);
      writeFileSync(posix.join(l, "pid"), `${process.pid}\n`);
      return () => rmSync(l, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(l).mtimeMs > 30 * 60_000) {
        rmSync(l, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // released between the two calls
    }
    if (Date.now() > until) throw new Error(`another install holds ${l}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface LinkAndPlist {
  /** What happened to `current.mjs`. */
  link: "install" | "upgrade" | "keep";
  /** The build it points at now. */
  current: string | undefined;
  plist: "written" | "kept" | "newer";
}

/**
 * Point `current.mjs` forward (never back) and write the plist if it differs,
 * unless the one there is of a newer format. Under the install lock. Touches
 * nothing in launchd.
 */
export async function placeAgent(o: { root: string; home: string; script: string }): Promise<LinkAndPlist> {
  const p = guiPaths(o.root, o.home);
  const mine = buildOf(o.script);
  if (!mine) throw new Error(`${o.script} is not an installed agent build (agent/<version>-<hash>/dispatch-host.mjs)`);
  const script = realpathSync(o.script);
  const release = await takeInstallLock(o.root);
  try {
    const now = currentBuild(p);
    const link = decideLink(now, mine);
    if (link !== "keep") pointCurrent(p, script);
    const want = plistXml(o.root, p);
    let have: string | undefined;
    try {
      have = readFileSync(p.plist, "utf8");
    } catch {
      /* none */
    }
    let plist: LinkAndPlist["plist"] = "kept";
    if (have !== want) {
      if (have !== undefined && plistFormat(have) > PLIST_FORMAT) plist = "newer";
      else {
        mkdirSync(posix.dirname(p.plist), { recursive: true });
        const tmp = `${p.plist}.${process.pid}.tmp`;
        writeFileSync(tmp, want, { mode: 0o644 });
        renameSync(tmp, p.plist);
        plist = "written";
      }
    }
    return { link, current: link === "keep" ? now : mine, plist };
  } finally {
    release();
  }
}
