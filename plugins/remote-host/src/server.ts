/**
 * remote-host: run a Dispatch chat's managed terminals on your own machines.
 * See README.md for what it does and how to pair a machine, and
 * docs/design/remote-host.md (in the repository) for why it is built this way.
 */
import { definePlugin } from "@dispatch/plugin-sdk";
import { errText } from "@dispatch-plugins/remote-core";
import { bundledAgent, nodejsOrgRuntime } from "./agent.js";
import { readHosts, type HostConfig } from "./hosts.js";
import { Pairing } from "./pairing.js";
import { HostRegistry } from "./registry.js";
import { defineRoutes } from "./routes.js";

/** What one activation holds, for `deactivate`. */
let live: { registry: HostRegistry; pairing: Pairing; off: () => void } | undefined;

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
    const registry = new HostRegistry({
      ctx,
      instanceId,
      ...(ctx.instance?.previousId ? { previousInstanceId: ctx.instance.previousId } : {}),
      agent: bundledAgent(),
      runtime: nodejsOrgRuntime(),
    });
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
    ctx.routes?.(defineRoutes({ ctx, instanceId, registry, pairing, hosts, saveHosts }));
    live = { registry, pairing, off };
  },

  /**
   * After every activation Dispatch lists the chats that exist; whatever a
   * machine holds for any other chat was deleted while the plugin wasn't
   * listening. Each machine does that in the background, now or when it is
   * next reachable, so this returns at once.
   */
  reconcile(e) {
    live?.registry.reconcile(new Set(e.chats.map((c) => c.id)));
  },

  /**
   * Uninstall: nothing will reconcile this instance's work again, so every
   * reachable machine ends its sessions and deletes its files now. Disable,
   * stop and restart keep everything: a session left without Dispatch ends
   * itself when its heartbeat stops.
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
    await l?.registry.dispose();
  },
});
