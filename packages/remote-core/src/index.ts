/**
 * @dispatch-plugins/remote-core — what a Dispatch terminal backend that runs a
 * chat's terminals on another machine needs, whatever makes the machine.
 *
 * Consumed as `workspace:*` and BUNDLED into each plugin's server/index.js;
 * never imported at runtime. A plugin that uses it builds with
 * `withSsh2(...)` from `@dispatch-plugins/remote-core/vite`.
 */
export { SshConnection, channelExit, type ChannelExit, type ExecResult, type SshAuth, type SshTarget } from "./ssh/connection.js";
export { hostKeyFingerprint, pinnedHostKey, tofuHostKey, trustProvisioner, type HostVerifier } from "./ssh/host-verifier.js";
export { generateKeyPair, publicKeyOf, type SshKeyPair } from "./ssh/keys.js";
export { keyTypeOf, scanHostKey, type HostKeyScan } from "./ssh/scan.js";
export { NO_CWD_EXIT, RemoteShell, ShellStartError, remoteShellCommand, signalName } from "./shell/remote-shell.js";
export { sq } from "./shell/quote.js";
export { copyIndex, git, localHas, pack, remotePathFor, repoInfo, snapshot, type RepoInfo } from "./sync/snapshot.js";
export { RemoteCheckouts, githubHttps, type RemoteCheckoutsOptions } from "./sync/remote-repo.js";
export { PortWatch, parseListeners, type PortWatchOptions } from "./ports/watch.js";
export {
  MachineLifecycle,
  type ChatRecord,
  type DetachReason,
  type LeaseChat,
  type MachineLifecycleOptions,
  type MachineProvider,
  type MachineRef,
  type PendingDestroy,
  type ShutdownReason,
} from "./lifecycle/machines.js";
export { RemoteChats, type ChatState, type Provider, type RemoteChatsOptions } from "./lifecycle/chats.js";
export { errText, withDeadline } from "./lifecycle/deadline.js";
export { coerceSettings, normaliseKey, sshAuthFrom } from "./plugin/helpers.js";
