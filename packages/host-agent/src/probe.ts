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
import { XCODE_DEVELOPER_DIR, gitEnv, hasCommandLineTools } from "./git-env.js";
import { listInstances, type InstanceInfo } from "./lifecycle.js";
import { guiState, type GuiState } from "./gui/client.js";
import { AGENT_VERSION } from "./version.js";

/** The git the plugin's own git work runs (sync, forget, gc), and whether it runs. */
export interface GitCheck {
  /** Where `git` is on that PATH; null: nowhere. */
  path: string | null;
  /**
   * macOS: the developer directory `/usr/bin/git` runs from: the Command Line
   * Tools' when they're installed (git runs with `DEVELOPER_DIR` set to
   * them), else the one `xcode-select` chose; null: none (no developer tools).
   */
  developerDir?: string | null;
  /** `git --version`'s exit code; null when it wasn't run. 69 on macOS: Xcode's license isn't accepted. */
  exitCode: number | null;
  /** `git version …`, when it ran. */
  version: string | null;
  /** Why it didn't run: git's own first line, or why it wasn't tried. */
  error?: string;
}

/** Homebrew on the chat shell's PATH, and whether it runs. */
export interface BrewCheck {
  path: string;
  /** `brew --version`'s first line. It answers even when brew runs nothing else. */
  version: string | null;
  /** Why every other brew command stops at once; absent when brew runs. */
  blocked?: string;
  /**
   * This account can install with it: Homebrew's prefix (its Cellar, and its
   * bin) is writable. False for a Homebrew another account owns, shared
   * through /etc/paths.d: usable, but every `brew install` fails.
   */
  writable: boolean;
  /**
   * macOS: Homebrew's own check says the Command Line Tools are older than it
   * needs on this macOS, and this is the ones it asks for ("Command Line Tools
   * for Xcode 27.0"). Bottles still install; building a formula from source
   * stops. Not a fault. Absent when they're new enough, brew is blocked, or
   * brew didn't say. Agents older than 0.2.5 don't report it.
   */
  cltTooOld?: string;
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
   * gets), in `gitEnv()` (see git-env.ts). `tools.git` is the chat shell's.
   * Agents older than 0.2.2 don't report it.
   */
  syncGit?: GitCheck;
  /** Homebrew, when the chat shell's PATH has it. Agents older than 0.2.4 don't report it. */
  brew?: BrewCheck;
  /**
   * Every Dispatch instance with a namespace here: this one, the other one
   * sharing the machine, and any left behind (a data directory that moved, so
   * the instance got a new id). Older agents don't report it.
   */
  instances?: InstanceInfo[];
  /**
   * The GUI agent (Tier B), or why there is none: nobody logged in at the
   * screen, not loaded, not answering. macOS only; agents older than 0.5.0
   * don't report it.
   */
  gui?: GuiState;
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
 * `xcode-select` chose `developerDir`; the one reported is `env`'s
 * `DEVELOPER_DIR` when it sets one (the Command Line Tools), since that wins.
 */
export async function checkGit(env: NodeJS.ProcessEnv, mac?: { developerDir: string | null }): Promise<GitCheck> {
  const path = which("git", env.PATH);
  const dev = mac ? { developerDir: env.DEVELOPER_DIR || mac.developerDir } : {};
  if (!path) return { path: null, ...dev, exitCode: null, version: null };
  if (wouldPrompt(path, env, mac)) {
    return { path, ...dev, exitCode: null, version: null, error: "no developer tools; install the Command Line Tools (xcode-select --install)" };
  }
  const r = await out(path, ["--version"], env);
  const version = r.code === 0 && r.stdout ? r.stdout.split("\n")[0]!.trim() : null;
  const error = version ? undefined : (r.stderr || r.stdout).split("\n")[0]!.trim() || undefined;
  return { path, ...dev, exitCode: r.code, version, ...(error ? { error } : {}) };
}

/**
 * The `brew` on `env`'s PATH, if any, and whether it runs.
 *
 * On a Mac, `bin/brew` re-runs itself under `env -i` with a fixed list of
 * variables, and DEVELOPER_DIR isn't on it. Then, before every command but a
 * few (`--version`, `--prefix`, `list`), brew.sh runs `/usr/bin/xcrun --find
 * clang`. That gets `xcode-select`'s developer directory whatever the shell
 * set. When that is an Xcode whose license isn't accepted, brew stops with
 * "You have not agreed to the Xcode license" (cvx-mac, 2026-11-05). The
 * Command Line Tools' DEVELOPER_DIR, which saves git, can't save brew; only
 * `xcode-select` can. So run brew's check the way brew does: with no
 * DEVELOPER_DIR, and only when `xcode-select` chose a directory. brew skips the
 * check when none is chosen, and the stub would open the install dialog.
 *
 * Once brew runs, its own minimum for the Command Line Tools on this macOS is
 * asked of brew itself (`brew doctor check_clt_minimum_version`), not
 * guessed from a table here. Older ones still pour bottles but build nothing
 * from source: cvx-mac, 2026-11-06, Command Line Tools 14.3.1 on macOS 27.2.
 * `xcrun` is a parameter for the tests.
 */
export async function checkBrew(
  env: NodeJS.ProcessEnv,
  mac?: { developerDir: string | null },
  xcrun = "/usr/bin/xcrun",
): Promise<BrewCheck | undefined> {
  const path = which("brew", env.PATH);
  if (!path) return undefined;
  // Both answer before brew's check, so even a blocked brew says where it lives.
  const [v, p] = await Promise.all([out(path, ["--version"], env), out(path, ["--prefix"], env)]);
  const version = v.code === 0 && v.stdout ? v.stdout.split("\n")[0]!.trim() : null;
  const said = p.code === 0 ? p.stdout.split("\n")[0]!.trim() : "";
  const prefix = said.startsWith("/") && isDir(said) ? said : posix.dirname(posix.dirname(path));
  const writable = brewWritable(prefix);
  let blocked: string | undefined;
  let cltTooOld: string | undefined;
  if (mac?.developerDir) {
    // Started beside brew's own check; its answer counts only if brew runs.
    const doctor = out(path, ["doctor", "check_clt_minimum_version"], env);
    const r = await out(xcrun, ["--find", "clang"], { HOME: env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    if (r.code !== 0 && /license/i.test(`${r.stderr}\n${r.stdout}`)) {
      blocked = `Xcode's license isn't accepted (exit ${r.code}), and Homebrew ignores DEVELOPER_DIR, so it uses xcode-select's ${mac.developerDir}`;
    }
    const d = await doctor;
    if (!blocked) cltTooOld = cltWanted(d.code, `${d.stdout}\n${d.stderr}`);
  }
  return { path, version, ...(blocked ? { blocked } : {}), writable, ...(cltTooOld ? { cltTooOld } : {}) };
}

/**
 * What `brew doctor check_clt_minimum_version` asks for when it fails: "Your
 * Command Line Tools are too outdated. … You should download the Command Line
 * Tools for Xcode 27.0." Exit 1 alone isn't enough: a brew without that check
 * also exits 1 ("No check available by the name"), as does one that couldn't
 * start, so the warning has to be about the Command Line Tools.
 */
function cltWanted(code: number, text: string): string | undefined {
  if (code !== 1 || !/Command Line Tools/.test(text) || /No check available/i.test(text)) return undefined;
  return text.match(/Command Line Tools for Xcode [\d.]*\d/)?.[0] ?? "newer Command Line Tools";
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether `brew install` can write where it installs: the Cellar (the prefix
 * itself before the first install made one) and bin, where it links. Not the
 * prefix alone: an Intel Mac's /usr/local is root's, its Homebrew directories
 * the user's.
 */
function brewWritable(prefix: string): boolean {
  const cellar = posix.join(prefix, "Cellar");
  const bin = posix.join(prefix, "bin");
  return [isDir(cellar) ? cellar : prefix, ...(isDir(bin) ? [bin] : [])].every((d) => {
    try {
      accessSync(d, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
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
  const clt = hasCommandLineTools();
  // The chat shell's environment, as owner.ts makes it.
  const env = shellEnv({ agentEnv: process.env, ...(login ? { login } : {}), clt });
  const darwin = process.platform === "darwin";
  const forGit = gitEnv(process.env, clt);
  // What xcode-select chose, asked with no DEVELOPER_DIR in the way.
  const mac = darwin ? { developerDir: await developerDir(gitEnv(process.env, false)) } : undefined;
  // Xcode's tools run with Xcode's developer directory, the way the agent is
  // told to run them: the shell's is the Command Line Tools', which have no
  // xcodebuild. One the login shell chose itself stands.
  const xenv = login?.DEVELOPER_DIR || !existsSync(XCODE_DEVELOPER_DIR) ? env : { ...env, DEVELOPER_DIR: XCODE_DEVELOPER_DIR };
  const xcode = darwin && !wouldPrompt(which("xcodebuild", xenv.PATH), xenv, mac);
  const shellGit = wouldPrompt(which("git", env.PATH), env, mac) ? Promise.resolve(null) : firstLine("git", ["--version"], env);

  const [name, version, build, consoleUser, git, node, pnpm, xcodebuild, firstLaunch, syncGit, brew] = await Promise.all([
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
    checkBrew(env, mac),
  ]);
  const gui = darwin && root ? await guiState({ root, home: homedir() }).catch(() => undefined) : undefined;

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
    ...(brew ? { brew } : {}),
    ...(root ? { instances: listInstances(root) } : {}),
    ...(gui ? { gui } : {}),
  };
}
