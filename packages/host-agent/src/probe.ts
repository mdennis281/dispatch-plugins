/**
 * `dispatch-host probe`: what the plugin needs to know about a host, as JSON.
 * Run on every connect. It feeds the backend's status, its label, and the
 * agent note. Every probe is bounded and independent; one that fails is
 * null, never an error for the whole probe.
 */
import { execFile } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { homedir, release, userInfo } from "node:os";
import { captureLoginEnv, loginShell, shellEnv } from "./env.js";
import { listInstances, type InstanceInfo } from "./lifecycle.js";
import { AGENT_VERSION } from "./version.js";

export interface ProbeResult {
  agentVersion: string;
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  os: { name?: string; version?: string; build?: string };
  kernel: string;
  user: string;
  home: string;
  /** Who is logged in at the screen (macOS). `root` means the login window: no GUI session. */
  consoleUser: string | null;
  freeDiskBytes: number | null;
  /** The PATH a chat shell gets (from the login shell, allow-listed). */
  path: string;
  loginEnvError?: string;
  tools: {
    git: string | null;
    node: string | null;
    pnpm: string | null;
    xcodebuild: string | null;
    /** `xcodebuild -checkFirstLaunchStatus` exited 0: the license is accepted and first launch done. */
    xcodeFirstLaunchDone: boolean | null;
  };
  /**
   * Every Dispatch instance with a namespace here: this one, the other one
   * sharing the machine, and any left behind (a data directory that moved, so
   * the instance got a new id). Older agents don't report it.
   */
  instances?: InstanceInfo[];
}

function out(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout).trim() });
    });
  });
}

async function firstLine(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await out(file, args, env);
  return r.code === 0 && r.stdout ? r.stdout.split("\n")[0]!.trim() : null;
}

function osRelease(): ProbeResult["os"] {
  try {
    const kv = Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map((m) => [m[1]!, m[2]!]),
    );
    return { name: kv.NAME, version: kv.VERSION_ID };
  } catch {
    return {};
  }
}

export async function probe(root?: string): Promise<ProbeResult> {
  let loginEnvError: string | undefined;
  const login = await captureLoginEnv({ shell: loginShell(process.env, process.platform), node: process.execPath }).catch(
    (e: unknown) => {
      loginEnvError = e instanceof Error ? e.message : String(e);
      return undefined;
    },
  );
  const env = shellEnv({ agentEnv: process.env, ...(login ? { login } : {}) });
  const darwin = process.platform === "darwin";

  const [name, version, build, consoleUser, git, node, pnpm, xcodebuild, firstLaunch] = await Promise.all([
    darwin ? firstLine("sw_vers", ["-productName"], env) : Promise.resolve(null),
    darwin ? firstLine("sw_vers", ["-productVersion"], env) : Promise.resolve(null),
    darwin ? firstLine("sw_vers", ["-buildVersion"], env) : Promise.resolve(null),
    darwin ? firstLine("stat", ["-f", "%Su", "/dev/console"], env) : Promise.resolve(null),
    firstLine("git", ["--version"], env),
    firstLine("node", ["--version"], env),
    firstLine("pnpm", ["--version"], env),
    darwin ? firstLine("xcodebuild", ["-version"], env) : Promise.resolve(null),
    darwin ? out("xcodebuild", ["-checkFirstLaunchStatus"], env) : Promise.resolve(null),
  ]);

  let freeDiskBytes: number | null = null;
  try {
    const s = statfsSync(homedir());
    freeDiskBytes = Number(s.bavail) * Number(s.bsize);
  } catch {
    /* unknown */
  }

  return {
    agentVersion: AGENT_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: darwin ? { ...(name ? { name } : {}), ...(version ? { version } : {}), ...(build ? { build } : {}) } : osRelease(),
    kernel: release(),
    user: userInfo().username,
    home: homedir(),
    consoleUser,
    freeDiskBytes,
    path: env.PATH ?? "",
    ...(loginEnvError ? { loginEnvError } : {}),
    tools: {
      git,
      node,
      pnpm,
      xcodebuild,
      xcodeFirstLaunchDone: firstLaunch ? firstLaunch.code === 0 : null,
    },
    ...(root ? { instances: listInstances(root) } : {}),
  };
}
