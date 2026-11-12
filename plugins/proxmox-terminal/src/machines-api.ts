/**
 * STAND-IN TYPES until their real homes land. Copied from the plugin-deps
 * design (C:\Users\Michael\scratch\plugin-deps-design-2026-11-12.md):
 * - §2.1, remote-host's `machines@1`: will be `import type` from
 *   `@dispatch-plugins/remote-host-api` (P0+P3).
 * - §1.7, the consumer side of core's plugin dependencies (`ctx.dependencies`):
 *   will come from `@dispatch/plugin-sdk` (core C2).
 * Types only, apart from {@link MACHINES}. When the real ones land, delete
 * this file and fix the imports; any drift shows up as type errors.
 */
import type { TerminalBackend, TerminalBackendUpdate, TerminalPortForwardInput } from "@dispatch/plugin-sdk";

/** What proxmox-terminal uses: remote-host's `machines` export, major 1. */
export const MACHINES = { plugin: "remote-host", name: "machines", major: 1 } as const;

export interface MachinesV1 {
  readonly contract: { name: "machines"; major: 1; minor: number };
  createProvisionedBackend(opts: ProvisionedBackendOptions): ProvisionedBackend;
}

export interface ProvisionRequest {
  chatId: string;
  projectId?: string;
  worktreePath?: string;
  repoPath?: string;
  signal: AbortSignal;
}

export interface ProvisionedBackendOptions {
  /** The id the CALLER registers under ("proxmox"). */
  id: string;
  label: string;
  /** Closures over the caller's ctx.terminals for `id`. */
  io: {
    publishPort(p: TerminalPortForwardInput): () => void;
    updateBackend?(u: TerminalBackendUpdate): void;
  };
  /** Bring the chat's machine up and say how to reach it. Called on spawn, spawnProcess, and to reconnect. */
  provision(req: ProvisionRequest): Promise<MachineLease>;
}

export interface MachineLease {
  /** INCARNATION key, new if the machine is ever re-created ("9001:1731398400000"). */
  machine: string;
  /** Used for THIS connect only: remote-host keeps no address memory. */
  addresses: string[];
  port?: number;
  user: string;
  /** Called per connect; never cached. */
  auth(): Promise<{ privateKey?: string; password?: string }>;
  hostKey: { pin: string[] } | { trust: "provisioner" };
  /** Checked after connect when given ("dt-<slug>"). */
  hostname?: string;
  /** Shown once with the next command's result. */
  notices?: string[];
}

export interface ProvisionedBackend {
  /** spawn, spawnProcess, beforeRun, afterRun, agentNote — NOT onChatIdle/onChatDeleted. */
  readonly backend: TerminalBackend;
  /** Idle: end sessions there, close the connection. */
  endChat(chatId: string): Promise<void>;
  /** Delete: drop records here; never contacts the machine. */
  forgetChat(chatId: string): Promise<void>;
  /** Destroyed: forget every chat on that incarnation. */
  machineGone(machine: string): Promise<void>;
  /** Caller uninstalling. */
  forgetAll(): Promise<void>;
  dispose(): Promise<void>;
  machines(): Array<{ chatId: string; machine: string; connected: boolean; shells: number; running: boolean; address?: string }>;
}

/** `err.code` on what remote-host throws. */
export type MachinesErrorCode = "forbidden" | "bad-lease" | "unreachable" | "host-key-mismatch" | "wrong-machine" | "revoked";

export type DependencyState = "ok" | "missing" | "disabled" | "incompatible" | "blocked" | "failed" | "not-served" | "cycle";

/** `ctx.dependencies` (core C2): absent on a core without plugin dependencies. */
export interface PluginDependencies {
  /** The export, or undefined unless the dependency is `ok` right now. Throws for a use the manifest doesn't list. */
  get<T>(id: string, name: string, major: number): T | undefined;
  state(id: string): { state: DependencyState; detail?: string };
  /** Optional dependencies: it went away while we run. */
  onLost(id: string, fn: () => void): void;
}
