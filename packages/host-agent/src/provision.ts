/**
 * `dispatch-host mcp-provision`: put an MCP server's packages, and the browser
 * it drives, on this machine. No sudo, nothing outside `~/.dispatch-host`:
 *
 * - The packages go into an npm prefix of their own,
 *   `mcp-packages/<hash of the exact set>/`, installed with the pinned
 *   runtime's own npm, scripts off. A prefix is built beside its final name
 *   and renamed into place, so a half-installed one is never used, and two
 *   instances asking at once take turns on a lock.
 * - The browser comes from that prefix's own `playwright-core` (`playwright
 *   install`), into `browsers/` (PLAYWRIGHT_BROWSERS_PATH), shared by every
 *   version. Playwright's chromium is Chrome for Testing, so the same download
 *   serves chrome-devtools-mcp too.
 *
 * An installed prefix is used as it is: everything in it is pinned.
 *
 * On Linux the browser also needs system libraries a minimal Debian lacks
 * (libnss3, libgbm1, …). They are checked with `ldd` after each install
 * check. Logged in as root, the missing ones are installed with Playwright's
 * own `install-deps` (apt-get). Otherwise the provision fails and names
 * them, rather than the browser failing at its first launch.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { browsersDir, mcpPackagesDir } from "./layout.js";
import { checkProvisionSpec, prefixFor, type ProvisionResult } from "./provision-spec.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProvisionDeps {
  root: string;
  /** The runtime that runs npm and the browser installer: this process's own node. */
  node: string;
  /** Run a program; tests fake it. */
  run(cmd: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string; timeoutMs: number }): Promise<RunResult>;
  /** Progress, for the log. */
  say(line: string): void;
  env: Record<string, string | undefined>;
  /**
   * The machine, for the browser's system libraries: on Linux they are
   * checked, and installed when `uid` is 0. Absent: not checked.
   */
  system?: { os: NodeJS.Platform; uid: number };
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** Longest one install may take: npm over a slow link, or a 150 MB browser. */
const STEP_MS = 15 * 60_000;
/** A lock older than this was left by an install that died. */
const STALE_LOCK_MS = 30 * 60_000;

export { prefixFor };

export async function provision(rawSpec: unknown, d: ProvisionDeps): Promise<ProvisionResult> {
  const spec = checkProvisionSpec(rawSpec);
  const prefix = prefixFor(d.root, spec);
  const browsersPath = browsersDir(d.root);
  const entry = join(prefix, "node_modules", spec.entry.name, spec.entry.bin);
  const installed: string[] = [];
  const env = baseEnv(d, browsersPath);

  if (!ready(prefix)) {
    await withLock(`${prefix}.lock`, d, async () => {
      if (ready(prefix)) return;
      const npmCli = join(dirname(dirname(d.node)), "lib", "node_modules", "npm", "bin", "npm-cli.js");
      if (!existsSync(npmCli)) throw new Error(`the runtime has no npm (${npmCli} is missing)`);
      const tmp = `${prefix}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const names = spec.packages.map((p) => `${p.name}@${p.version}`);
      d.say(`installing ${names.join(", ")}`);
      const r = await d.run(
        d.node,
        [npmCli, "install", "--prefix", tmp, "--no-audit", "--no-fund", "--ignore-scripts", "--omit=dev", "--no-package-lock", "--loglevel=error", ...names],
        { env, cwd: tmp, timeoutMs: STEP_MS },
      );
      if (r.code !== 0) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(`npm install ${names.join(" ")} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
      }
      if (!existsSync(join(tmp, "node_modules", spec.entry.name, spec.entry.bin))) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(`${spec.entry.name} installed, but has no ${spec.entry.bin}`);
      }
      writeFileSync(join(tmp, ".ready"), JSON.stringify({ packages: spec.packages, at: new Date().toISOString() }) + "\n");
      rmSync(prefix, { recursive: true, force: true });
      renameSync(tmp, prefix);
      installed.push(...names);
    });
  }
  if (!existsSync(entry)) throw new Error(`${entry} is missing from an installed prefix; delete ${prefix} to reinstall`);

  let executablePath: string | undefined;
  if (spec.browser) {
    const pwCli = join(prefix, "node_modules", "playwright-core", "cli.js");
    if (!existsSync(pwCli)) throw new Error(`none of ${spec.packages.map((p) => p.name).join(", ")} brings playwright-core, so no browser can be installed`);
    // Its own check is quick when the browser is there, and it repairs one a
    // newer version's cleanup removed. One at a time: two installers in one
    // browsers directory would both download into it.
    await withLock(join(browsersPath, ".install.lock"), d, async () => {
      mkdirSync(browsersPath, { recursive: true, mode: 0o700 });
      const r = await d.run(d.node, [pwCli, "install", spec.browser!], { env, cwd: prefix, timeoutMs: STEP_MS });
      if (r.code !== 0) throw new Error(`installing ${spec.browser} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`);
      if (/download|downloaded/i.test(r.stdout + r.stderr)) installed.push(spec.browser!);
    });
    const linux = d.system?.os === "linux";
    if (spec.executable || linux) {
      const r = await d.run(
        d.node,
        ["-e", `process.stdout.write(require(process.argv[1])[process.argv[2]].executablePath())`, join(prefix, "node_modules", "playwright-core"), spec.browser],
        { env, cwd: prefix, timeoutMs: 60_000 },
      );
      const found = r.stdout.trim();
      if (r.code === 0 && isAbsolute(found) && existsSync(found)) executablePath = found;
      else if (spec.executable) {
        throw new Error(`${spec.browser} is installed but its executable wasn't found: ${tail(r.stderr) || found || `exit ${r.code}`}`);
      }
      // Wanted only for its libraries: one that can't be found can't be checked, and the browser's own launch says why.
    }
    if (linux && executablePath) {
      const libs = await systemLibraries(spec.browser, executablePath, pwCli, prefix, env, d);
      if (libs) installed.push(libs);
    }
    if (!spec.executable) executablePath = undefined;
  }
  return { entry, browsersPath, ...(executablePath ? { executablePath } : {}), installed };
}

/** What `ldd` says `exe` needs and can't find: `libnss3.so`, …. Undefined: ldd couldn't tell (none, or not glibc). */
async function missingLibraries(exe: string, env: Record<string, string>, d: ProvisionDeps): Promise<string[] | undefined> {
  const r = await d.run("ldd", [exe], { env, cwd: dirname(exe), timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  const missing = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\S+)\s+=>\s+not found/);
    if (m) missing.add(m[1]!);
  }
  return [...missing].sort();
}

/**
 * The browser's system libraries on Linux. Missing ones are installed as root
 * (`playwright install-deps`, which runs apt-get), once, under the browsers
 * lock; otherwise the provision fails naming them. Says what it installed.
 */
async function systemLibraries(
  browser: string,
  exe: string,
  pwCli: string,
  prefix: string,
  env: Record<string, string>,
  d: ProvisionDeps,
): Promise<string | undefined> {
  const missing = await missingLibraries(exe, env, d);
  if (!missing?.length) return undefined;
  const list = missing.slice(0, 12).join(", ") + (missing.length > 12 ? `, and ${missing.length - 12} more` : "");
  if (d.system?.uid !== 0) {
    throw new Error(
      `${browser} is installed, but this machine lacks system libraries it needs (${list}), and only root can install them: ` +
        `run \`npx playwright install-deps ${browser}\` there as root, or install them with the system's package manager`,
    );
  }
  let error: string | undefined;
  await withLock(join(browsersDir(d.root), ".install.lock"), d, async () => {
    if (!(await missingLibraries(exe, env, d))?.length) return;
    d.say(`installing the system libraries ${browser} needs (${list})`);
    const r = await d.run(d.node, [pwCli, "install-deps", browser], {
      env: { ...env, DEBIAN_FRONTEND: "noninteractive" },
      cwd: prefix,
      timeoutMs: STEP_MS,
    });
    if (r.code !== 0) error = `installing them failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`;
  });
  const still = await missingLibraries(exe, env, d);
  if (still?.length) {
    throw new Error(`${browser} needs system libraries this machine lacks (${still.slice(0, 12).join(", ")}); ${error ?? "they are still missing after installing them"}`);
  }
  return `system libraries for ${browser}`;
}

function ready(prefix: string): boolean {
  return existsSync(join(prefix, ".ready"));
}

function baseEnv(d: ProvisionDeps, browsersPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]) {
    const v = d.env[k];
    if (v !== undefined) env[k] = v;
  }
  // npm runs `node` by name for some steps: this runtime's, first.
  env.PATH = `${dirname(d.node)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  env.npm_config_cache = join(mcpPackagesDir(d.root), ".npm-cache");
  env.npm_config_update_notifier = "false";
  env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return env;
}

/** The last few lines of a tool's complaint. */
function tail(text: string): string {
  return text.trim().split("\n").slice(-6).join(" | ").slice(0, 1_000);
}

/**
 * Hold `lock` (a directory) while `fn` runs. Another holder is waited for; one
 * whose process is gone, or that has held it implausibly long, is taken over.
 */
export async function withLock(lock: string, d: ProvisionDeps, fn: () => Promise<void>): Promise<void> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const until = now() + STEP_MS * 2;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  let said = false;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "owner"), `${process.pid}\n`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (lockAbandoned(lock, now())) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (now() > until) throw new Error(`another install has held ${lock} too long`);
    if (!said) d.say(`waiting for another install (${lock})`);
    said = true;
    await sleep(500);
  }
  try {
    await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function lockAbandoned(lock: string, now: number): boolean {
  try {
    if (now - statSync(lock).mtimeMs > STALE_LOCK_MS) return true;
    const pid = Number(readFileSync(join(lock, "owner"), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false; // being written: give it a moment
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

/** The real runner: a child process with no stdin, its output collected. */
export function runProgram(cmd: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout = (stdout + c.toString("utf8")).slice(-64_000)));
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-64_000)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n(killed after ${Math.round(opts.timeoutMs / 1000)} s)`;
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
