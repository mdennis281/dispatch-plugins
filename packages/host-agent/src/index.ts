/**
 * @dispatch-plugins/host-agent: what the remote-host plugin needs to drive
 * `dispatch-host` from the Dispatch side. That covers the wire protocol, where
 * things live on the host, the pinned runtime, the install scripts, and the
 * parsers for what the agent prints.
 *
 * The agent itself is `src/cli.ts`, built to `dist/dispatch-host.mjs`. Nothing
 * here imports it, so a plugin bundling this index never bundles the agent's
 * process code by accident.
 */
export * from "./protocol.js";
export {
  assertId,
  browsersDir,
  chatMcpPath,
  chatWorktreePath,
  mcpDirName,
  mcpPackagesDir,
  mcpTmpPath,
  hostLayout,
  instanceLayout,
  repoPath,
  rootDir,
  sessionPaths,
  socketPath,
  type HostLayout,
  type InstanceLayout,
  type SessionPaths,
  type SessionRecord,
} from "./layout.js";
export { BASE_ENV, ELEVATE_SOCKET_ENV, FALLBACK_PATH, LOGIN_ENV_ALLOW, decodeExecArg, encodeEnvArg, encodeExecArg, filterLoginEnv } from "./env.js";
export { checkProvisionSpec, prefixFor, type ProvisionResult, type ProvisionSpec } from "./provision-spec.js";
export { NODE_RUNTIME, compareVersions, nodeTarball, runtimeAction, type NodeDist, type NodeTarball } from "./runtime.js";
export { INSTALL_EXIT, agentBuildId, agentPath, installAgentScript, installRuntimeScript, nodePath, shCommand, sq } from "./install.js";
export { attribute, parseLsof, parsePs, type Attribution, type Listener, type ProcRow } from "./procs.js";
export type { ElevationMode, PortsVia } from "./platform.js";
export type { BrewCheck, GitCheck, ProbeResult } from "./probe.js";
export { CLT_DEVELOPER_DIR, GIT_SH_ENV, XCODE_DEVELOPER_DIR, gitEnv, hasCommandLineTools } from "./git-env.js";
export type { ChatDir, ForgetResult, GcResult, InstanceInfo } from "./lifecycle.js";
export type { RunEntry } from "./journal.js";
export { AGENT_VERSION } from "./version.js";
