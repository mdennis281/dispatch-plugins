/**
 * The plugin's HTTP surface, under `/api/plugins/proxmox-terminal/`, for the
 * Settings pane (client.tsx):
 *
 *   GET  /overview                          status, host-key trust, the vmid range's use, pre-0.2 containers
 *   POST /legacy/:chatId/skip-rescue         go on without saving the old checkouts (offered after 3 failed rescues)
 *   POST /legacy/:chatId/destroy             destroy the container without rescuing it
 *
 * Both actions are a human's, from the pane's confirm; neither is reachable
 * from a chat.
 */
import type { PluginContext, PluginReply, PluginRequest, PluginRouter } from "@dispatch/plugin-sdk";
import { errText } from "@dispatch-plugins/remote-core";
import { ActionError, type ProxmoxTerminal } from "./backend.js";

type Handler = (req: PluginRequest) => Promise<unknown> | unknown;

function wrap(log: PluginContext["log"], fn: Handler) {
  return async (req: PluginRequest, reply: PluginReply) => {
    try {
      return await fn(req);
    } catch (err) {
      const status = err instanceof ActionError ? err.status : 500;
      if (status >= 500) log.warn(`proxmox-terminal ${req.method} ${req.url}: ${errText(err)}`);
      reply.code(status);
      return { error: errText(err) };
    }
  };
}

const chatOf = (req: PluginRequest): string => {
  const id = String((req.params as Record<string, unknown> | undefined)?.chatId ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ActionError("not a chat id", 400);
  return id;
};

export function defineRoutes(ctx: PluginContext, t: () => ProxmoxTerminal | undefined): (r: PluginRouter<PluginRequest, PluginReply>) => void {
  const live = (): ProxmoxTerminal => {
    const it = t();
    if (!it) throw new ActionError("the plugin is not running", 503);
    return it;
  };
  const h = (fn: Handler) => wrap(ctx.log, fn);
  return (r) => {
    r.get("/overview", h(() => live().overview()));
    r.post("/legacy/:chatId/skip-rescue", h(async (req) => {
      await live().skipRescue(chatOf(req));
      return { ok: true };
    }));
    r.post("/legacy/:chatId/destroy", h(async (req) => {
      await live().destroyWithoutRescue(chatOf(req));
      return { ok: true };
    }));
  };
}
