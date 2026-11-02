/**
 * Putting dispatch-host on a machine, on every connect: one round trip
 * learns where things are and what is installed, and only what is missing or
 * older is sent. Both payloads go over exec stdin into host-agent's install
 * scripts, which check the SHA-256 again, take the install lock, and swap by
 * rename. Bytes that arrive through a pipe carry no quarantine attribute, so
 * Gatekeeper never prompts.
 */
import { createReadStream } from "node:fs";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ClientChannel } from "ssh2";
import type { ExecResult } from "@dispatch-plugins/remote-core";
import {
  INSTALL_EXIT,
  agentBuildId,
  agentPath,
  installAgentScript,
  installRuntimeScript,
  nodePath,
  rootDir,
  runtimeAction,
  shCommand,
  sq,
} from "@dispatch-plugins/host-agent";
import type { AgentBundle, RuntimeSource } from "./agent.js";

/** What running a command on the machine needs. `SshConnection` is one. */
export interface Exec {
  exec(command: string, opts?: { stdin?: (ch: ClientChannel) => Promise<void>; timeoutMs?: number }): Promise<ExecResult>;
}

export interface HostPaths {
  home: string;
  /** `~/.dispatch-host` */
  root: string;
  node: string;
  agent: string;
  /** `uname -s` / `uname -m`. */
  platform: string;
  arch: string;
}

export interface EnsureResult {
  paths: HostPaths;
  /** What was sent this time, for the log: `runtime v24.22.2`, `agent 0.1.0-abc…`. */
  installed: string[];
}

/** Long enough to push Node's ~50 MB tarball over a slow overlay link. */
const RUNTIME_UPLOAD_MS = 10 * 60_000;

export async function ensureAgent(
  conn: Exec,
  deps: { agent: AgentBundle; runtime: RuntimeSource; signal?: AbortSignal },
): Promise<EnsureResult> {
  const build = agentBuildId(deps.agent.version, deps.agent.sha256);
  const rel = `agent/${build}/dispatch-host.mjs`;
  const look = await conn.exec(
    shCommand(
      [
        "printf '%s\\n' \"$HOME\"",
        "uname -s",
        "uname -m",
        'R="$HOME/.dispatch-host"',
        'N="$R/runtime/node/bin/node"',
        `A="$R/${rel}"`,
        'if [ -x "$N" ]; then "$N" --version 2>/dev/null || echo broken; else echo none; fi',
        'if [ -x "$N" ] && [ -f "$A" ]; then "$N" "$A" version 2>/dev/null || echo broken; else echo none; fi',
      ].join("\n"),
    ),
    { timeoutMs: 30_000 },
  );
  const lines = look.stdout.split("\n").map((l) => l.trim());
  const [home, platform, arch, nodeVersion, agentVersion] = lines;
  if (look.code !== 0 || !home?.startsWith("/") || !platform || !arch) {
    throw new Error(`could not read the machine's layout (exit ${look.code}): ${look.stderr.trim() || look.stdout.trim() || "no output"}`);
  }
  const root = rootDir(home);
  const paths: HostPaths = {
    home,
    root,
    node: nodePath(root),
    agent: agentPath(root, deps.agent.version, deps.agent.sha256),
    platform,
    arch,
  };
  if (paths.agent !== posix.join(root, rel)) throw new Error("agent path mismatch"); // the two spellings must agree
  const installed: string[] = [];

  const installedNode = nodeVersion?.startsWith("v") ? nodeVersion : undefined;
  if (runtimeAction(installedNode) !== "keep") {
    const { path, tarball } = await deps.runtime.tarball(platform, arch, deps.signal);
    const r = await conn.exec(shCommand(installRuntimeScript(root, tarball)), {
      timeoutMs: RUNTIME_UPLOAD_MS,
      stdin: (ch) => pipeline(createReadStream(path), ch),
    });
    if (r.code !== 0) throw installError("Node runtime", r);
    installed.push(`runtime ${r.stdout.trim()}`);
  }

  if (agentVersion !== deps.agent.version) {
    const r = await conn.exec(shCommand(installAgentScript(root, deps.agent.version, deps.agent.sha256)), {
      timeoutMs: 120_000,
      stdin: async (ch) => {
        ch.end(Buffer.from(deps.agent.source, "utf8"));
      },
    });
    if (r.code !== 0) throw installError("dispatch-host", r);
    installed.push(`agent ${build} (${r.stdout.trim()})`);
    const v = await conn.exec(`${sq(paths.node)} ${sq(paths.agent)} version`, { timeoutMs: 30_000 });
    if (v.code !== 0 || v.stdout.trim() !== deps.agent.version) {
      throw new Error(`dispatch-host ${deps.agent.version} does not run on the machine: ${v.stderr.trim() || v.stdout.trim() || `exit ${v.code}`}`);
    }
  }
  return { paths, installed };
}

function installError(what: string, r: ExecResult): Error {
  const why = r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`;
  if (r.code === INSTALL_EXIT.checksum) return new Error(`installing ${what} failed its checksum on the machine: ${why}`);
  if (r.code === INSTALL_EXIT.locked) return new Error(`installing ${what}: another install holds the lock (${why})`);
  return new Error(`installing ${what} failed: ${why}`);
}

/** The command line that runs a dispatch-host command with the pinned runtime. */
export function agentCommand(paths: HostPaths, args: readonly string[]): string {
  return [paths.node, paths.agent, ...args].map(sq).join(" ");
}
