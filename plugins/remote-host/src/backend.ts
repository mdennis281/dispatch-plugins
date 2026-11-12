/**
 * One paired machine as a terminal backend, `remote-host/<slug>`: core's
 * face of the machine's one MachineEngine (engine.ts), which does the work.
 *
 * A Mac command must never become a PowerShell one, so the backend refuses
 * rather than falls back (`fallback: "refuse"`).
 */
import type {
  TerminalAfterRunInfo,
  TerminalAfterRunResult,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalBeforeRunResult,
  TerminalChatEvent,
  TerminalProcessHandle,
  TerminalProcessSpawnInfo,
  TerminalRunInfo,
  TerminalSpawnInfo,
} from "@dispatch/plugin-sdk";
import type { MachineEngine } from "./engine.js";

// Tests and older importers find these here, where they were before the engine split.
export { HEARTBEAT_TIMEOUT_MS, chatDir, newSid, repoTop, sessionCommand, token, within } from "./engine.js";

export class PairedBackend implements TerminalBackend {
  readonly shell = "bash" as const;
  readonly fallback = "refuse" as const;
  /** The first connect to a machine may push Node's ~50 MB runtime before the shell starts. */
  readonly spawnTimeoutMs = 5 * 60_000;
  /** A chat's first sync sends its whole worktree; it resumes if cut short, but give it room. */
  readonly runHookTimeoutMs = 30 * 60_000;

  constructor(
    readonly id: string,
    readonly engine: MachineEngine,
  ) {}

  /** The machine's label, which the engine's messages use too. */
  get label(): string {
    return this.engine.label;
  }
  set label(v: string) {
    this.engine.label = v;
  }

  spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle> {
    return this.engine.spawn(info);
  }

  spawnProcess(info: TerminalProcessSpawnInfo): Promise<TerminalProcessHandle> {
    return this.engine.spawnProcess(info);
  }

  beforeRun(info: TerminalRunInfo): Promise<TerminalBeforeRunResult> {
    return this.engine.beforeRun(info);
  }

  afterRun(info: TerminalAfterRunInfo): Promise<TerminalAfterRunResult> {
    return this.engine.afterRun(info);
  }

  agentNote(info: { chatId: string }): string {
    return this.engine.agentNote(info);
  }

  onChatIdle(e: TerminalChatEvent): Promise<void> {
    return this.engine.chatIdle(e.chatId);
  }

  onChatDeleted(e: TerminalChatEvent): Promise<void> {
    return this.engine.chatDeleted(e.chatId);
  }

  /** Core unregistered the backend (the machine was removed, or the plugin is going down). */
  dispose(): void {
    this.engine.dispose();
  }
}
