/**
 * proxmox-terminal — run a Dispatch chat's managed terminals in a per-chat
 * Proxmox LXC. See README.md for what it does and how to set it up, and
 * Dispatch's docs/plugins.md → "Terminal backends" for the contract.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { definePlugin } from "@dispatch/plugin-sdk";
import { ProxmoxTerminalBackend } from "./backend.js";
import { readSettings } from "./settings.js";

const TOKEN = "PROXMOX_TERMINAL_API_TOKEN";
const KEY = "PROXMOX_TERMINAL_SSH_KEY";
const PASSWORD = "PROXMOX_TERMINAL_SSH_PASSWORD";

/**
 * A private key pasted into a secret card may arrive with its newlines
 * flattened, or base64-encoded so it survived a single-line input. Accept all
 * three; ssh2 wants the PEM/OpenSSH text.
 */
export function normaliseKey(raw: string): string {
  const t = raw.trim();
  // Header, body, footer — with whatever whitespace (or none) the paste left
  // between them. The body is base64, so any whitespace in it was a newline.
  const pem = t.match(/^(-----BEGIN [A-Z ]+-----)\s*([\s\S]*?)\s*(-----END [A-Z ]+-----)$/);
  if (pem) return `${pem[1]}\n${pem[2]!.replace(/\s+/g, "\n")}\n${pem[3]}\n`;
  const decoded = Buffer.from(t, "base64").toString("utf8");
  return decoded.includes("-----BEGIN") ? decoded.trim() + "\n" : t;
}

export default definePlugin({
  activate(ctx) {
    if (!ctx.terminals) {
      ctx.log.error("this Dispatch has no `terminals` capability — it predates terminal backends (#414); update Dispatch");
      return;
    }
    const settings = () => readSettings(ctx.settings.get());
    const backend = new ProxmoxTerminalBackend({
      ctx,
      kv: ctx.kv,
      settings,
      token: async () => (await ctx.secrets?.get(TOKEN))?.trim() || undefined,
      sshAuth: async () => {
        const password = (await ctx.secrets?.get(PASSWORD)) || undefined;
        const secretKey = await ctx.secrets?.get(KEY);
        if (secretKey) return { privateKey: normaliseKey(secretKey), password };
        const path = settings().sshKeyPath.replace(/^~(?=$|[\\/])/, homedir());
        if (path) {
          try {
            return { privateKey: await readFile(path, "utf8"), password };
          } catch (err) {
            if (!password) throw new Error(`cannot read the SSH key at ${path}: ${(err as Error).message}`);
          }
        }
        return { password };
      },
    });
    ctx.terminals.registerBackend(backend);
    ctx.log.info("registered terminal backend \"proxmox\"");
  },
});
