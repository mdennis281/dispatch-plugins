/**
 * The environment a chat's shell gets on the host.
 *
 * A command run over SSH gets sshd's bare environment: `/usr/bin:/bin` and no
 * Homebrew. So the PATH the user's own login shell would give is captured from
 * `$SHELL -l`. Only an ALLOW-LISTED part of it is kept, never the whole
 * thing: a `.zprofile` that exports `GITHUB_TOKEN` or `NPM_TOKEN` must not end
 * up in the agent's transcripts.
 */
import { spawn } from "node:child_process";
import { CLT_DEVELOPER_DIR } from "./git-env.js";

/** Login-shell variables a chat's shell may inherit. */
export const LOGIN_ENV_ALLOW: readonly RegExp[] = [
  /^PATH$/,
  /^HOMEBREW_[A-Z0-9_]+$/,
  /^LANG$/,
  /^LC_[A-Z_]+$/,
  /^DEVELOPER_DIR$/,
  /^JAVA_HOME$/,
];

/** Taken from the agent's own environment (sshd sets them), never from the login shell. */
export const BASE_ENV: readonly string[] = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"];

/** A PATH that finds the system tools and Homebrew when the login shell can't be read. */
export const FALLBACK_PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The allow-listed part of a captured login environment. */
export function filterLoginEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && LOGIN_ENV_ALLOW.some((re) => re.test(k))) out[k] = v;
  }
  return out;
}

/**
 * The shell's environment: the base variables from `agentEnv`, the
 * allow-listed login variables, then `extra` from the plugin. A login
 * environment that could not be read leaves {@link FALLBACK_PATH}.
 *
 * `clt`: the Mac has the Command Line Tools. Unless the login shell or the
 * plugin chose one, `DEVELOPER_DIR` is then theirs, so the agent's own git in
 * this shell works whatever `xcode-select` chose, Xcode's license or not
 * (git-env.ts). The agent is told to run Xcode's tools with Xcode's, per
 * command.
 */
export function shellEnv(opts: {
  agentEnv: Record<string, string | undefined>;
  login?: Record<string, string>;
  extra?: Record<string, string>;
  clt?: boolean;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV) {
    const v = opts.agentEnv[k];
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, opts.login ? filterLoginEnv(opts.login) : {});
  if (!env.PATH) env.PATH = FALLBACK_PATH;
  if (opts.clt && !env.DEVELOPER_DIR) env.DEVELOPER_DIR = CLT_DEVELOPER_DIR;
  for (const [k, v] of Object.entries(opts.extra ?? {})) {
    if (!NAME.test(k)) throw new Error(`not an environment variable name: ${JSON.stringify(k)}`);
    env[k] = String(v);
  }
  return env;
}

/**
 * The plugin's extra variables, as `--env` carries them: base64 of a JSON
 * object of name → string. Throws on anything else, or on a bad name, so the
 * relay refuses it before an owner ever starts.
 */
export function decodeEnvArg(b64: string | undefined): Record<string, string> {
  if (!b64) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error("--env must be base64 JSON of an object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--env must be base64 JSON of an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!NAME.test(k)) throw new Error(`not an environment variable name: ${JSON.stringify(k)}`);
    out[k] = String(v);
  }
  return out;
}

/** Printed by the capture command before the JSON, so a chatty `.zprofile` can't corrupt it. */
const MARK = "__DISPATCH_HOST_ENV__";

/**
 * Pull the environment out of the capture command's stdout: the JSON after the
 * LAST marker line. Anything a profile printed before it is ignored.
 */
export function parseCapturedEnv(stdout: string): Record<string, string> {
  const at = stdout.lastIndexOf(`${MARK}\n`);
  if (at < 0) throw new Error("the login shell printed no environment");
  const parsed: unknown = JSON.parse(stdout.slice(at + MARK.length + 1).trim());
  if (!parsed || typeof parsed !== "object") throw new Error("the login shell's environment was not an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Run `shell -l` and have it print its environment as JSON, through `node`
 * (this very runtime) rather than `env`, whose output can't carry a newline in
 * a value. stdin is /dev/null, so a profile that prompts reads EOF.
 */
export function captureLoginEnv(opts: {
  shell: string;
  node: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<Record<string, string>> {
  const script = `printf '\\n%s\\n' ${MARK}; exec "$0" -e 'process.stdout.write(JSON.stringify(process.env))'`;
  return new Promise((resolve, reject) => {
    const child = spawn(opts.shell, ["-l", "-c", script, opts.node], {
      stdio: ["ignore", "pipe", "ignore"],
      env: opts.env as NodeJS.ProcessEnv | undefined,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${opts.shell} -l took longer than ${(opts.timeoutMs ?? 10_000) / 1000}s`));
    }, opts.timeoutMs ?? 10_000);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${opts.shell} -l exited ${code}`));
      try {
        resolve(parseCapturedEnv(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** The user's login shell: `$SHELL` when it is an absolute path, else the platform's default. */
export function loginShell(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  const s = env.SHELL;
  if (s && s.startsWith("/")) return s;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}
