/**
 * proxmox-terminal's handle on remote-host: everything that runs ON a
 * container (the supervisor, sync, ports, MCP) is remote-host's, reached
 * through core's plugin dependencies as `machines@1` (design §1.7, §2.2).
 *
 * The dependency is OPTIONAL: proxmox-terminal keeps its own Proxmox
 * lifecycle (idle stops, destroys, TTL, uninstall) running whether or not
 * remote-host is there. Without it, terminals are refused with the reason
 * ("refusing mode") — never run locally.
 */
import type { PluginContext, PluginDependencyStatus } from "@dispatch/plugin-sdk";
import { errText } from "@dispatch-plugins/remote-core";
import type { MachinesV1, ProvisionedBackend, ProvisionedBackendOptions } from "@dispatch-plugins/remote-host-api";

/** `ctx.dependencies`: absent on a core without plugin dependencies (before Dispatch ed2ac93). */
export type PluginDependencies = NonNullable<PluginContext["dependencies"]>;

/**
 * remote-host's `machines@1`. A literal, not the API package's `MACHINES`:
 * that package is types-only at run time, so nothing of it is bundled here.
 */
const MACHINES = { plugin: "remote-host", name: "machines", major: 1 } as const;

export const NEEDS_NEWER_DISPATCH =
  "proxmox-terminal 0.2 needs a newer Dispatch (one with plugin dependencies) to run terminals; until then they are refused";

/** Why terminals are refused, for a dependency in `state`. */
export function reasonFor(s: Pick<PluginDependencyStatus, "state" | "detail"> | undefined): string {
  const detail = s?.detail ? ` (${s.detail})` : "";
  switch (s?.state) {
    case "missing":
      return "Remote host is not installed. proxmox-terminal needs it to run terminals: install it from the same collection";
    case "invalid":
      return `Remote host's install is not usable${detail}. proxmox-terminal needs it to run terminals`;
    case "disabled":
      return "Remote host is switched off. proxmox-terminal needs it to run terminals";
    case "incompatible":
      return `This Remote host does not offer what proxmox-terminal needs (machines v1)${detail}. Update Remote host`;
    case "failed":
      return `Remote host failed to start${detail}. proxmox-terminal needs it to run terminals`;
    case "ok":
      return "Remote host went away";
    default:
      return `Remote host is unavailable: ${s?.state ?? "unknown"}${detail}. proxmox-terminal needs it to run terminals`;
  }
}

export class RemoteHostLink {
  private provisioned?: ProvisionedBackend;
  private why = "Remote host has not been looked up yet";

  constructor(
    private readonly o: {
      /** `ctx.dependencies`, when this core has them. */
      deps: () => PluginDependencies | undefined;
      options: () => ProvisionedBackendOptions;
      log: PluginContext["log"];
      /** Availability changed (lost). */
      changed: () => void;
    },
  ) {}

  /** Look remote-host up and make this plugin's provisioned backend. Once, from activate. Never throws. */
  connect(): void {
    const deps = this.o.deps();
    if (!deps) {
      this.why = NEEDS_NEWER_DISPATCH;
      return;
    }
    let api: MachinesV1 | undefined;
    try {
      api = deps.get<MachinesV1>(MACHINES.plugin, MACHINES.name, MACHINES.major);
    } catch (err) {
      this.why = `Remote host could not be reached: ${errText(err)}`;
      return;
    }
    if (!api) {
      this.why = reasonFor(safeState(deps));
      return;
    }
    try {
      this.provisioned = api.createProvisionedBackend(this.o.options());
    } catch (err) {
      this.why = `Remote host refused proxmox-terminal's machines: ${errText(err)}`;
      return;
    }
    this.why = "";
    deps.onLost(MACHINES.plugin, () => {
      this.provisioned = undefined;
      this.why = reasonFor(safeState(deps));
      this.o.log.warn(`remote-host went away: ${this.why}; terminals are refused, containers are still managed`);
      this.o.changed();
    });
  }

  /** The provisioned backend while remote-host is there. */
  get(): ProvisionedBackend | undefined {
    return this.provisioned;
  }

  /** Why terminals are refused; empty while remote-host is there. */
  reason(): string {
    return this.provisioned ? "" : this.why;
  }

  /**
   * A best-effort call into remote-host: never throws, and does nothing while
   * it is away. An inert call (after revocation) just returns undefined.
   */
  async quietly(what: string, fn: (p: ProvisionedBackend) => Promise<unknown> | unknown): Promise<void> {
    const p = this.provisioned;
    if (!p) return;
    try {
      await fn(p);
    } catch (err) {
      this.o.log.warn(`remote-host ${what}: ${errText(err)}`);
    }
  }
}

function safeState(deps: PluginDependencies): PluginDependencyStatus | undefined {
  try {
    return deps.state(MACHINES.plugin);
  } catch {
    return undefined;
  }
}
