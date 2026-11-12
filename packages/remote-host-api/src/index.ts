/**
 * remote-host's `machines@1`: what a plugin that PROVISIONS machines (a
 * container per chat, say) calls so that remote-host runs what happens on
 * them: the chat's shells, its synced checkout, forwarded ports, MCP servers
 * and the agent's tools there.
 *
 * Types, and one inert constant ({@link MACHINES}). Import it with
 * `import type`; nothing here runs. The export itself is reached through
 * core's plugin dependencies:
 *
 * ```ts
 * // plugin.yaml: dependencies: { remote-host: { uses: [machines@1], version: ">=0.11.0 <1" } }
 * const machines = ctx.dependencies?.get<MachinesV1>("remote-host", "machines", 1);
 * ```
 *
 * Minor additions are found at run time (`machines.contract.minor`, or
 * `typeof x === "function"`); anything that would break a caller is a new
 * major, served beside this one while callers move.
 *
 * The caller owns its machines' lifecycle (idle, delete, reconcile,
 * uninstall) and registers its OWN terminal backend, which forwards to
 * {@link ProvisionedBackend.backend}: its backend id, pins and remembered
 * fallback never depend on remote-host being there.
 */
import type { TerminalBackend, TerminalBackendUpdate, TerminalPortForwardInput } from "@dispatch/plugin-sdk";

/** The export a caller asks for, and the plugin that serves it. */
export const MACHINES = { plugin: "remote-host", name: "machines", major: 1 } as const;

export interface MachinesV1 {
  readonly contract: { name: "machines"; major: 1; minor: number };
  /**
   * One terminal backend's worth of provisioned machines. Throws `forbidden`
   * for a caller that wasn't granted `terminals`. Call it once per backend
   * the caller registers, in `activate`.
   */
  createProvisionedBackend(opts: ProvisionedBackendOptions): ProvisionedBackend;
}

export interface ProvisionedBackendOptions {
  /** The backend id the CALLER registers its own backend under ("proxmox"). Runs under it count as this one's. */
  id: string;
  /** What messages and the agent note call these machines ("Proxmox container"). */
  label: string;
  /** Closures over the CALLER's `ctx.terminals` for `id`: forwarded ports are the caller's to publish. */
  io: {
    publishPort(p: TerminalPortForwardInput): () => void;
    updateBackend?(u: TerminalBackendUpdate): void;
  };
  /**
   * Bring the chat's machine up and say how to reach it. Called for a spawn
   * and a spawnProcess, and to dial again when the connection dropped (a
   * shell resuming, a command's sync). Never from a tool, never in the
   * background: a machine that is stopped stays stopped until the chat runs
   * something. `signal` aborts when the request that asked is cancelled.
   */
  provision(req: ProvisionRequest): Promise<MachineLease>;
}

export interface ProvisionRequest {
  chatId: string;
  projectId?: string;
  worktreePath?: string;
  repoPath?: string;
  signal: AbortSignal;
}

export interface MachineLease {
  /**
   * The machine's INCARNATION: the same for its whole life, and new if it is
   * ever destroyed and made again ("9001:1731398400000"). A chat whose lease
   * names a different one starts afresh there, push-only, with a notice; its
   * records of the old one are dropped.
   */
  machine: string;
  /** Where to reach it, tried in order. For THIS connect only: remote-host remembers no address. */
  addresses: string[];
  /** Default 22. */
  port?: number;
  /** The login. `root` is allowed here (a disposable machine): no sudo shim, no approval-gated root. */
  user: string;
  /**
   * The credential, asked for on every connect and never kept: it goes
   * straight into that connection and nowhere else (no kv, log, notice or
   * status). A password is refused unless {@link hostKey} is a pin.
   */
  auth(): Promise<{ privateKey?: string; password?: string }>;
  /**
   * How to know the machine: the SHA256 fingerprints its host key may have
   * (`SHA256:…`; linked clones of one template share it), or the provisioner's
   * word for it. The key checked is the one the machine offers for the type
   * ssh2 prefers, its ed25519 key where it has one: pin that one. Either way,
   * every connect then checks the incarnation token
   * remote-host wrote there (`~/.dispatch-host/incarnation`), so an address
   * that now belongs to another machine with the same key runs nothing
   * (`wrong-machine`).
   */
  hostKey: { pin: string[] } | { trust: "provisioner" };
  /** Its hostname (`hostname`, short or full), checked after every connect when given ("dt-<slug>"). */
  hostname?: string;
  /** Shown once, with the next command's result in this chat. */
  notices?: string[];
}

export interface ProvisionedBackend {
  /**
   * What the caller's own registered backend forwards to: `spawn`,
   * `spawnProcess`, `beforeRun`, `afterRun` and `agentNote`. NOT
   * `onChatIdle`/`onChatDeleted`: the caller's lifecycle calls
   * {@link endChat} / {@link forgetChat} instead.
   */
  readonly backend: TerminalBackend;
  /** The chat went idle: end its sessions there (if the machine is connected) and close the connection. Never dials. */
  endChat(chatId: string): Promise<void>;
  /** The chat was deleted: drop what remote-host keeps for it here. Never contacts the machine; destroying it is the caller's. */
  forgetChat(chatId: string): Promise<void>;
  /** The machine was destroyed: forget every chat on that incarnation, as {@link forgetChat} does. */
  machineGone(machine: string): Promise<void>;
  /** The caller is being uninstalled: forget everything kept for it. */
  forgetAll(): Promise<void>;
  /** End every connection. Runs by itself when the caller goes down (its `caller.signal`). */
  dispose(): Promise<void>;
  /** What is live now, chat by chat: for the caller's idle sweep ("busy" = connected with shells, or running). */
  machines(): ProvisionedMachine[];
}

export interface ProvisionedMachine {
  chatId: string;
  machine: string;
  /** A verified connection is up. */
  connected: boolean;
  /** Live shells there. */
  shells: number;
  /** A command is running in one of its shells, or an MCP server is up there. */
  running: boolean;
  address?: string;
}

/**
 * `err.code` on what remote-host throws. Match it with the SDK's
 * `isPluginCallError(err) && err.code === …`, never `instanceof`.
 * - `forbidden`: the caller wasn't granted `terminals`.
 * - `bad-lease`: the lease can't be used as it is (no address, a password with no pin, …).
 * - `unreachable`: no address answered.
 * - `host-key-mismatch`: an address answered with a key the lease doesn't pin.
 * - `wrong-machine`: what answered isn't this incarnation (token or hostname); nothing ran there.
 * - `revoked`: the link to remote-host closed (core's `PluginRevokedError`).
 */
export type MachinesErrorCode = "forbidden" | "bad-lease" | "unreachable" | "host-key-mismatch" | "wrong-machine" | "revoked";
