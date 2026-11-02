/**
 * Keeps Dispatch's backends in step with the paired machines in settings:
 * register one per machine, relabel in place, unregister a removed one.
 * Settings are shared by the stable and dev instances, so a machine paired
 * from one appears in the other within seconds (`ctx.settings.onChange`).
 */
import type { PluginContext, TerminalBackendStatusInput } from "@dispatch/plugin-sdk";
import { errText, type SshTarget } from "@dispatch-plugins/remote-core";
import type { ProbeResult } from "@dispatch-plugins/host-agent";
import type { AgentBundle, RuntimeSource } from "./agent.js";
import { HostBackend } from "./backend.js";
import { backendId, connectionChanged, keySecretName, type HostConfig } from "./hosts.js";
import { HostLink, type LinkConnection, type LinkTiming } from "./link.js";
import type { HostShellOptions } from "./session.js";

export interface RegistryDeps {
  ctx: PluginContext;
  instanceId: string;
  agent: AgentBundle;
  runtime: RuntimeSource;
  connect?: (target: SshTarget) => LinkConnection;
  timing?: Partial<LinkTiming>;
  shell?: Partial<HostShellOptions>;
}

export interface Entry {
  host: HostConfig;
  link: HostLink;
  backend: HostBackend;
}

/** One machine as the routes report it. */
export interface HostView extends HostConfig {
  id: string;
  status: TerminalBackendStatusInput;
  /** The address it answered at last. */
  address?: string;
  probe?: ProbeResult;
}

export class HostRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: RegistryDeps) {}

  /** Make the registered backends match `hosts`. Idempotent. */
  sync(hosts: readonly HostConfig[]): void {
    const { ctx } = this.deps;
    const terminals = ctx.terminals!;
    const wanted = new Set(hosts.map((h) => h.slug));
    for (const [slug, e] of this.entries) {
      if (wanted.has(slug)) continue;
      this.entries.delete(slug);
      // Shells first, while their connections are up to carry the KILL; then
      // the backend; the link last.
      void (async () => {
        await e.backend.killAll().catch(() => {});
        await terminals.unregisterBackend(backendId(slug)).catch((err: unknown) => {
          ctx.log.warn(`remote-host ${slug}: unregistering failed: ${errText(err)}`);
        });
        e.link.dispose();
      })();
      ctx.log.info(`remote-host: ${slug} removed`);
    }
    for (const host of hosts) {
      const e = this.entries.get(host.slug);
      if (!e) {
        this.add(host);
        continue;
      }
      const before = e.host;
      e.host = host;
      if (before.label !== host.label) {
        e.backend.label = host.label;
        try {
          terminals.updateBackend(backendId(host.slug), { label: host.label });
        } catch (err) {
          ctx.log.warn(`remote-host ${host.slug}: relabelling failed: ${errText(err)}`);
        }
      }
      e.link.update(host, connectionChanged(before, host));
    }
  }

  private add(host: HostConfig): void {
    const { ctx } = this.deps;
    const terminals = ctx.terminals!;
    const id = backendId(host.slug);
    const entry = { host } as Entry;
    entry.link = new HostLink(host, {
      instanceId: this.deps.instanceId,
      privateKey: async () => (await ctx.secrets?.get(keySecretName(host.slug)))?.trim() || undefined,
      agent: this.deps.agent,
      runtime: this.deps.runtime,
      setStatus: (s) => terminals.setStatus(id, s),
      log: ctx.log,
      ...(ctx.kv ? { kv: ctx.kv } : {}),
      ...(this.deps.connect ? { connect: this.deps.connect } : {}),
      ...(this.deps.timing ? { timing: this.deps.timing } : {}),
    });
    entry.backend = new HostBackend(id, {
      host: () => entry.host,
      link: entry.link,
      instanceId: this.deps.instanceId,
      log: ctx.log,
      ...(ctx.kv ? { kv: ctx.kv } : {}),
      ...(this.deps.shell ? { shell: this.deps.shell } : {}),
    });
    try {
      terminals.registerBackend(entry.backend);
    } catch (err) {
      ctx.log.error(`remote-host: could not register ${id}`, err);
      return;
    }
    this.entries.set(host.slug, entry);
    // Status right after registering (it resets on every registration), then
    // the link moves it as it connects.
    entry.link.start();
    ctx.log.info(`remote-host: registered ${id} (${host.label})`);
  }

  get(slug: string): Entry | undefined {
    return this.entries.get(slug);
  }

  list(): HostView[] {
    return [...this.entries.values()].map(({ host, link }) => ({
      ...host,
      id: backendId(host.slug),
      status: link.status,
      ...(link.address ? { address: link.address } : {}),
      ...(link.probe ? { probe: link.probe } : {}),
    }));
  }

  /** The plugin is going down: end the shells (KILL down their channels), then close every connection. */
  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((e) => e.backend.killAll().catch(() => {})));
    for (const e of entries) e.link.dispose();
  }
}
