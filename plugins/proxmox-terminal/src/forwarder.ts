/**
 * The `proxmox` terminal backend in 0.2: proxmox-terminal's OWN registration,
 * forwarding what runs on the container to remote-host's provisioned backend
 * and keeping the container lifecycle hooks for itself (design §2.2).
 *
 * - spawn / spawnProcess / beforeRun / afterRun / agentNote go to remote-host.
 *   While it is away they are refused with the reason, never run locally
 *   (`fallback: "refuse"`); so is an `undefined` from a call that went inert.
 * - beforeRun also restarts the chat's unused clock.
 * - onChatIdle / onChatDeleted are proxmox's: a best-effort word to
 *   remote-host, then its own idle deadline or destroy. A rejection from
 *   onChatDeleted only ever means "a Proxmox destroy is pending", so core's
 *   cleanup rows never pile up because remote-host is off.
 */
import type {
  PluginContext,
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
import type { MachineLifecycle } from "@dispatch-plugins/remote-core";
import type { ContainerRef } from "./backend.js";
import type { RemoteHostLink } from "./remote-host-link.js";
import type { Settings } from "./settings.js";

export const BACKEND_ID = "proxmox";
export const LABEL = "Proxmox container";

export class ProxmoxForwarder implements TerminalBackend {
  readonly id = BACKEND_ID;
  readonly label = LABEL;
  readonly shell = "bash" as const;
  /** A Proxmox chat's command must never run in a local Windows shell against a different tree. */
  readonly fallback = "refuse" as const;

  constructor(
    private readonly o: {
      link: RemoteHostLink;
      life: MachineLifecycle<ContainerRef>;
      settings: () => Settings;
      log: PluginContext["log"];
      /** Core unregistered the backend: let go of the lifecycle (timers, sessions). */
      dispose?: () => Promise<void>;
    },
  ) {}

  async dispose(): Promise<void> {
    await this.o.dispose?.();
  }

  get spawnTimeoutMs(): number {
    return Math.max(30, this.o.settings().spawnTimeoutSeconds) * 1_000;
  }

  private refusal(): Error {
    return new Error(this.o.link.reason() || "Remote host went away during the call");
  }

  async spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle> {
    const p = this.o.link.get();
    if (!p) throw this.refusal();
    const h = await p.backend.spawn(info);
    if (!h) throw this.refusal(); // the call went inert: revoked under us
    return h;
  }

  async spawnProcess(info: TerminalProcessSpawnInfo): Promise<TerminalProcessHandle> {
    const p = this.o.link.get();
    if (!p) throw this.refusal();
    if (!p.backend.spawnProcess) throw new Error("this Remote host cannot run processes on a machine; update it");
    const h = await p.backend.spawnProcess(info);
    if (!h) throw this.refusal();
    return h;
  }

  async beforeRun(info: TerminalRunInfo): Promise<TerminalBeforeRunResult | void> {
    const p = this.o.link.get();
    if (!p) return { refuse: this.o.link.reason() };
    // The chat is using its container: the unused-days TTL starts over.
    await this.o.life.touch(info.chatId).catch((err: unknown) => this.o.log.warn(`touching chat ${info.chatId}: ${String(err)}`));
    const r = await p.backend.beforeRun?.(info);
    // Lost while it ran: whatever came back is from a call that went inert.
    if (!this.o.link.get()) return { refuse: this.o.link.reason() };
    return r;
  }

  async afterRun(info: TerminalAfterRunInfo): Promise<TerminalAfterRunResult | void> {
    return this.o.link.get()?.backend.afterRun?.(info);
  }

  agentNote(info: { chatId: string; projectId?: string }): string | undefined {
    const p = this.o.link.get();
    let machine: string | undefined;
    if (p) {
      try {
        machine = p.backend.agentNote?.(info) ?? undefined;
      } catch {
        machine = undefined;
      }
    }
    const own = [
      `- This terminal's machine is a per-chat Proxmox container (Debian; you are root). It stops when the chat goes idle — ` +
        `the next command starts it again, possibly on a new address — and is destroyed when the chat is deleted. ` +
        `Only installs and build output live only there.`,
    ];
    if (!p) own.unshift(`- Terminal commands are refused right now: ${this.o.link.reason()}.`);
    return [machine, ...own].filter(Boolean).join("\n");
  }

  async onChatIdle(e: TerminalChatEvent): Promise<void> {
    await this.o.link.quietly(`ending chat ${e.chatId}'s sessions`, (p) => p.endChat(e.chatId));
    await this.o.life.onChatIdle(e);
  }

  async onChatDeleted(e: TerminalChatEvent): Promise<void> {
    await this.o.link.quietly(`forgetting chat ${e.chatId}`, (p) => p.forgetChat(e.chatId));
    await this.o.life.onChatDeleted(e);
  }
}
