/**
 * proxmox-terminal — run a Dispatch chat's managed terminals in a per-chat
 * Proxmox LXC. See README.md for what it does and how to set it up, and
 * Dispatch's docs/plugins.md → "Terminal backends" for the contract.
 */
import { definePlugin } from "@dispatch/plugin-sdk";
import { sshAuthFrom } from "@dispatch-plugins/remote-core";
import { ProxmoxTerminalBackend, type ShutdownReason } from "./backend.js";
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

/** The live backend, for the module-level hooks. One per activation. */
let backend: ProxmoxTerminalBackend | undefined;

const plugin = definePlugin({
  deactivate() {
    backend = undefined;
  },
  activate(ctx) {
    if (!ctx.terminals) {
      ctx.log.error("this Dispatch has no `terminals` capability — it predates terminal backends (#414); update Dispatch");
      return;
    }
    const settings = () => readSettings(ctx.settings.get());
    backend = new ProxmoxTerminalBackend({
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
    });
    ctx.terminals.registerBackend(backend);
    ctx.log.info("registered terminal backend \"proxmox\"");
    // Not awaited: activation must not hang on a Proxmox that is down. The
    // sweep logs and retries every minute on its own.
    void backend.start();
  },
});

const hooks: CleanupHooks = {
  async onShutdown(e) {
    await backend?.onShutdown(e);
  },
  async reconcile(e) {
    await backend?.reconcile({ chats: e.chats });
  },
};

export default Object.assign(plugin, hooks);
