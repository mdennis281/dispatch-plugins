/**
 * remote-host: run a Dispatch chat's managed terminals on your own machines.
 * See README.md for what it does and how to pair a machine, and
 * docs/design/remote-host.md (in the repository) for why it is built this way.
 */
import { definePlugin } from "@dispatch/plugin-sdk";
import { errText } from "@dispatch-plugins/remote-core";
import { bundledAgent, nodejsOrgRuntime } from "./agent.js";
import { approvalsOf } from "./elevation.js";
import { ElevationSetups } from "./elevation-setup.js";
import { readHosts, type HostConfig } from "./hosts.js";
import { MachinesService } from "./machines.js";
import { Pairing } from "./pairing.js";
import { reservedPortsOf } from "./ports.js";
import { HostRegistry } from "./registry.js";
import { defineRoutes } from "./routes.js";
import { runsOf } from "./sync/run-lock.js";
import { provisionedMachine, registerTools, toolsOf } from "./tools/index.js";

/** What one activation holds, for `deactivate`. */
let live: { registry: HostRegistry; machines: MachinesService; pairing: Pairing; setups: ElevationSetups; off: () => void } | undefined;

export default definePlugin({
  activate(ctx) {
    if (!ctx.terminals) {
      ctx.log.error("this Dispatch has no `terminals` capability; update Dispatch");
      return;
    }
    // Everything this plugin leaves on a machine is namespaced by instance, so
    // stable's cleanup can never reap dev's sessions. Without an id there is
    // no safe namespace, so nothing runs.
    const instanceId = ctx.instance?.id;
    if (!instanceId) {
      ctx.log.error("this Dispatch does not report its instance id (ctx.instance); update Dispatch to use remote-host");
      return;
    }
    const hosts = (): HostConfig[] => readHosts(ctx.settings.get().hosts, (m) => ctx.log.warn(`remote-host: ${m}`));
    const saveHosts = async (next: HostConfig[]) => {
      if (!ctx.settings.set) throw new Error("this Dispatch cannot store plugin settings (ctx.settings.set); update Dispatch");
      await ctx.settings.set({ hosts: next });
    };
    const agent = bundledAgent();
    const runtime = nodejsOrgRuntime();
    // Machines other plugins provision (`machines@1`), and the paired ones: one
    // lock across them, since a chat's runs on either sync its files.
    let machines: MachinesService | undefined = undefined;
    const registry = new HostRegistry({
      ctx,
      instanceId,
      ...(ctx.instance?.previousId ? { previousInstanceId: ctx.instance.previousId } : {}),
      agent,
      runtime,
      mine: (backend) => machines!.mine(backend),
      otherLabel: (backend) => (machines!.serves(backend) ? machines!.where(backend) : undefined),
    });
    const runs = runsOf(ctx);
    const reservedPorts = reservedPortsOf(ctx);
    const provides = (ctx as { provides?: { dependents?: () => Array<{ id: string }> } }).provides;
    machines = new MachinesService({
      instanceId,
      log: ctx.log,
      ...(ctx.kv ? { kv: ctx.kv } : {}),
      agent,
      runtime,
      ...(runs ? { runs } : {}),
      ...(reservedPorts ? { reservedPorts } : {}),
      ...(toolsOf(ctx) ? { agentTools: true } : {}),
      where: (backend) => registry.label(backend),
      paired: (backend) => registry.isPaired(backend),
      ...(typeof provides?.dependents === "function" ? { dependents: () => provides.dependents!() } : {}),
    });
    // Only while activate runs: core seals the exports when it returns.
    machines.serve(ctx);
    const pairing = new Pairing({
      hosts,
      saveHosts,
      secrets: {
        get: async (name) => ctx.secrets?.get(name),
        set: async (name, value) => {
          if (!ctx.secrets?.set) throw new Error("this Dispatch cannot store secrets for plugins (secrets:write); update Dispatch");
          await ctx.secrets.set(name, value);
        },
        delete: async (name) => (await ctx.secrets?.delete?.(name)) ?? false,
      },
      log: ctx.log,
    });

    // Register every paired machine now, synchronously: each reports
    // "connecting" until its link says otherwise.
    registry.sync(hosts());
    const off = ctx.settings.onChange(() => {
      try {
        registry.sync(hosts());
      } catch (err) {
        ctx.log.error(`remote-host: applying new settings failed: ${errText(err)}`, err);
      }
    });
    const setups = new ElevationSetups();
    ctx.routes?.(defineRoutes({ ctx, instanceId, registry, pairing, setups, hosts, saveHosts }));
    // The agent's tools (remote_fetch, machine_status), where this Dispatch has `ctx.tools` (#519).
    const approvals = approvalsOf(ctx);
    const offTools = registerTools(toolsOf(ctx), {
      registry,
      log: ctx.log,
      ...(approvals ? { approvals } : {}),
      provisioned: (chatId) => machines!.forChat(chatId).map((pm) => provisionedMachine(pm, chatId)),
    });
    live = {
      registry,
      machines,
      pairing,
      setups,
      off: () => {
        offTools();
        off();
      },
    };
  },

  /**
   * After every activation Dispatch lists the chats that exist; whatever a
   * machine holds for any other chat was deleted while the plugin wasn't
   * listening. Each machine does that in the background, now or when it is
   * next reachable, so this returns at once.
   */
  reconcile(e) {
    const chats = new Set(e.chats.map((c) => c.id));
    live?.registry.reconcile(chats);
    // Records only, here: in the background, like the machines'.
    void live?.machines.reconcile(chats);
  },

  /**
   * Uninstall: nothing will reconcile this instance's work again, so every
   * reachable machine ends its sessions and deletes its files now, and root
   * with approval is taken out wherever it is on. Disable, stop and restart
   * keep everything: a session left without Dispatch ends itself when its
   * heartbeat stops.
   */
  async onShutdown(e) {
    if (e.reason !== "uninstall" || !live) return;
    await live.registry.forgetAll(Math.max(500, e.deadline - Date.now() - 250));
  },

  async deactivate() {
    const l = live;
    live = undefined;
    l?.off();
    l?.pairing.clear();
    l?.setups.clear();
    await l?.machines.dispose();
    await l?.registry.dispose();
  },
});
