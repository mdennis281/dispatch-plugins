/**
 * proxmox-terminal — run a Dispatch chat's managed terminals in a per-chat
 * Proxmox LXC, through remote-host. See README.md for what it does and how to
 * set it up, and Dispatch's docs/plugins.md → "Terminal backends" and
 * "Dependencies" for the contracts.
 */
import { definePlugin, type PluginContext } from "@dispatch/plugin-sdk";
import { sshAuthFrom } from "@dispatch-plugins/remote-core";
import { BACKEND_ID, ProxmoxTerminal, type ShutdownReason } from "./backend.js";
import type { PluginDependencies } from "./remote-host-link.js";
import { readSettings } from "./settings.js";

const TOKEN = "PROXMOX_TERMINAL_API_TOKEN";
const KEY = "PROXMOX_TERMINAL_SSH_KEY";
const PASSWORD = "PROXMOX_TERMINAL_SSH_PASSWORD";

/**
 * The cleanup hooks core added after this plugin was first written (Dispatch
 * docs/plugins.md → "Cleanup lifecycle"), typed here rather than imported so
 * the plugin still builds and loads against an SDK that predates them. An
 * older core never calls them; the plugin's own kv-backed sweep does the same
 * job there, minus orphans it cannot see without the chat list.
 */
interface CleanupHooks {
  onShutdown(e: { reason: ShutdownReason; deadline: number; signal: AbortSignal }): Promise<void>;
  reconcile(e: { chats: Array<{ id: string }>; deadline: number; signal: AbortSignal }): Promise<void>;
}

/** The live plugin, for the module-level hooks. One per activation. */
let terminal: ProxmoxTerminal | undefined;

/** `ctx.dependencies`, on a core that has plugin dependencies (C2). Feature-detected, never assumed. */
function dependenciesOf(ctx: PluginContext): PluginDependencies | undefined {
  const d = ctx.dependencies;
  return d && typeof d.get === "function" ? d : undefined;
}

const plugin = definePlugin({
  deactivate() {
    terminal = undefined;
  },
  activate(ctx) {
    if (!ctx.terminals) {
      ctx.log.error("this Dispatch has no `terminals` capability — it predates terminal backends (#414); update Dispatch");
      return;
    }
    const terminals = ctx.terminals;
    const settings = () => readSettings(ctx.settings.get());
    const t = new ProxmoxTerminal({
      ctx,
      kv: ctx.kv,
      settings,
      token: async () => (await ctx.secrets?.get(TOKEN))?.trim() || undefined,
      sshAuth: sshAuthFrom({
        secret: async (name) => ctx.secrets?.get(name),
        keySecret: KEY,
        passwordSecret: PASSWORD,
        keyPath: () => settings().sshKeyPath,
      }),
      dependencies: () => dependenciesOf(ctx),
      statusChanged: () => terminals.setStatus?.(BACKEND_ID, t.status()),
    });
    terminal = t;
    // Registered before anything that could fail: with `fallback: "refuse"`,
    // a terminal is refused rather than run locally whatever happens next.
    terminals.registerBackend(t.forwarder);
    t.link.connect();
    terminals.setStatus?.(BACKEND_ID, t.status());
    const why = t.link.reason();
    if (why) ctx.log.warn(`terminals are refused: ${why}. Containers are still managed.`);
    else ctx.log.info('registered terminal backend "proxmox" (through remote-host)');
    // Not awaited: activation must not hang on a Proxmox that is down. The
    // sweep logs and retries every minute on its own, in refusing mode too.
    void t.start();
  },
});

const hooks: CleanupHooks = {
  async onShutdown(e) {
    await terminal?.onShutdown(e);
  },
  async reconcile(e) {
    await terminal?.reconcile({ chats: e.chats });
  },
};

export default Object.assign(plugin, hooks);
