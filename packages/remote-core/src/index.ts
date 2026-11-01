/**
 * @dispatch-plugins/remote-core — what a Dispatch terminal backend that runs a
 * chat's terminals on another machine needs, whatever makes the machine.
 *
 * Consumed as `workspace:*` and BUNDLED into each plugin's server/index.js;
 * never imported at runtime. A plugin that uses it builds with
 * `withSsh2(...)` from `@dispatch-plugins/remote-core/vite`.
 */
export { SshConnection, type ExecResult, type SshAuth, type SshTarget } from "./ssh/connection.js";
export { hostKeyFingerprint, pinnedHostKey, tofuHostKey, trustProvisioner, type HostVerifier } from "./ssh/host-verifier.js";
export { RemoteShell, remoteShellCommand } from "./shell/remote-shell.js";
export { sq } from "./shell/quote.js";
export { git, localHas, pack, remotePathFor, repoInfo, snapshot, type RepoInfo } from "./sync/snapshot.js";
export { RemoteCheckouts, githubHttps, type RemoteCheckoutsOptions } from "./sync/remote-repo.js";
export { PortWatch, parseListeners, type PortWatchOptions } from "./ports/watch.js";
export {
  RemoteChats,
  type ChatRecord,
  type ChatState,
  type MachineRef,
  type PendingDestroy,
  type Provider,
  type RemoteChatsOptions,
  type ShutdownReason,
} from "./lifecycle/chats.js";
export { errText, withDeadline } from "./lifecycle/deadline.js";
export { coerceSettings, normaliseKey, sshAuthFrom } from "./plugin/helpers.js";
