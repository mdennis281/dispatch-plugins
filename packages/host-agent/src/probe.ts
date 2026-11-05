/**
 * `dispatch-host probe`: what the plugin needs to know about a host, as JSON.
 * Run on every connect. It feeds the backend's status, its label, and the
 * agent note. Every probe is bounded and independent; one that fails is
 * null, never an error for the whole probe.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync, statfsSync } from "node:fs";
import { homedir, release, userInfo } from "node:os";
import { posix } from "node:path";
import { captureLoginEnv, loginShell, shellEnv } from "./env.js";
import { XCODE_DEVELOPER_DIR, gitEnv } from "./git-env.js";
import { listInstances, type InstanceInfo } from "./lifecycle.js";
import { AGENT_VERSION } from "./version.js";

/** The git the plugin's own git work runs (sync, forget, gc), and whether it runs. */
export interface GitCheck {
  /** Where `git` is on that PATH; null: nowhere. */
  path: string | null;
  /** macOS: the developer directory `/usr/bin/git` runs from (`xcode-select -p`); null: none (no developer tools). */
  developerDir?: string | null;
  /** `git --version`'s exit code; null when it wasn't run. 69 on macOS: Xcode's license isn't accepted. */
  exitCode: number | null;
  /** `git version …`, when it ran. */
  version: string | null;
  /** Why it didn't run: git's own first line, or why it wasn't tried. */
  error?: string;
}

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
   * The git sync runs: on the agent's own PATH (what a plain SSH command
   * gets), without `DEVELOPER_DIR` (see git-env.ts). `tools.git` is the chat
   * shell's. Older agents don't report it.
   */
  syncGit?: GitCheck;
  /**
   * Every Dispatch instance with a namespace here: this one, the other one
   * sharing the machine, and any left behind (a data directory that moved, so
   * the instance got a new id). Older agents don't report it.
   */
  instances?: InstanceInfo[];
}

function out(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
}

async function firstLine(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await out(file, args, env);
  return r.code === 0 && r.stdout ? r.stdout.split("\n")[0]!.trim() : null;
}

/** Where `name` is on `path` (the first executable file of that name), or null. */
export function which(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(":")) {
    if (!dir) continue;
    const p = posix.join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** macOS: the developer directory `xcode-select` chose, or null when there is none (no developer tools). */
export async function developerDir(env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await out("xcode-select", ["-p"], env);
  return r.code === 0 && r.stdout ? r.stdout.split("\n")[0]!.trim() : null;
}

/**
 * On macOS the developer tools in `/usr/bin` are stubs. Run one while no
 * developer directory is chosen (none set in `env` either) and it opens
 * "install the command line developer tools?" on the Mac's screen: never
 * run one then.
 */
function wouldPrompt(path: string | null, env: NodeJS.ProcessEnv, mac: { developerDir: string | null } | undefined): boolean {
  return !!mac && mac.developerDir === null && !env.DEVELOPER_DIR && !!path?.startsWith("/usr/bin/");
}

/**
 * Which git `env` runs, and whether it runs. `mac`: the host is a Mac, whose
 * `xcode-select` chose `developerDir`.
 */
export async function checkGit(env: NodeJS.ProcessEnv, mac?: { developerDir: string | null }): Promise<GitCheck> {
  const path = which("git", env.PATH);
  const dev = mac ? { developerDir: mac.developerDir } : {};
  if (!path) return { path: null, ...dev, exitCode: null, version: null };
  if (wouldPrompt(path, env, mac)) {
    return { path, ...dev, exitCode: null, version: null, error: "no developer tools; install the Command Line Tools (xcode-select --install)" };
  }
  const r = await out(path, ["--version"], env);
  const version = r.code === 0 && r.stdout ? r.stdout.split("\n")[0]!.trim() : null;
  const error = version ? undefined : (r.stderr || r.stdout).split("\n")[0]!.trim() || undefined;
  return { path, ...dev, exitCode: r.code, version, ...(error ? { error } : {}) };
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
  const forGit = gitEnv(process.env);
  const mac = darwin ? { developerDir: await developerDir(forGit) } : undefined;
  // Xcode's tools run with Xcode's developer directory, the way the agent is
  // told to run them: the chosen one is the Command Line Tools, which have no
  // xcodebuild.
  const xenv = env.DEVELOPER_DIR || !existsSync(XCODE_DEVELOPER_DIR) ? env : { ...env, DEVELOPER_DIR: XCODE_DEVELOPER_DIR };
  const xcode = darwin && !wouldPrompt(which("xcodebuild", xenv.PATH), xenv, mac);
  const shellGit = wouldPrompt(which("git", env.PATH), env, mac) ? Promise.resolve(null) : firstLine("git", ["--version"], env);

  const [name, version, build, consoleUser, git, node, pnpm, xcodebuild, firstLaunch, syncGit] = await Promise.all([
    darwin ? firstLine("sw_vers", ["-productName"], env) : Promise.resolve(null),
    darwin ? firstLine("sw_vers", ["-productVersion"], env) : Promise.resolve(null),
    darwin ? firstLine("sw_vers", ["-buildVersion"], env) : Promise.resolve(null),
    darwin ? firstLine("stat", ["-f", "%Su", "/dev/console"], env) : Promise.resolve(null),
    shellGit,
    firstLine("node", ["--version"], env),
    firstLine("pnpm", ["--version"], env),
    xcode ? firstLine("xcodebuild", ["-version"], xenv) : Promise.resolve(null),
    xcode ? out("xcodebuild", ["-checkFirstLaunchStatus"], xenv) : Promise.resolve(null),
    checkGit(forGit, mac),
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
    syncGit,
    ...(root ? { instances: listInstances(root) } : {}),
  };
}
