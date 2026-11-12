/**
 * The plugin's HTTP surface, under `/api/plugins/remote-host/`, for the
 * Settings pane. Every write here is a human's edit, and these are the only
 * places settings are written.
 *
 *   GET    /hosts                 paired machines, with live status and the last probe
 *   POST   /pair/scan             { address, port? } → the host key, to confirm
 *   POST   /pair/start            { slug, label?, address, addresses?, port?, user, hostKey, hostKeyType?, allowFrom?, replace? }
 *   POST   /pair/finish           { pairingId, password? }
 *   POST   /pair/cancel           { pairingId }
 *   PUT    /hosts/:slug           { label?, addresses? }   rename, or change where to look
 *   POST   /hosts/:slug/check     reconnect and probe now
 *   DELETE /hosts/:slug           turn its elevation off, take the key off the machine, end this instance's sessions, forget it
 *
 * Root with approval (elevation-setup.ts):
 *   POST   /hosts/:slug/elevation/setup    mint its elevation key → the setup command to run there with sudo
 *   POST   /hosts/:slug/elevation/verify   prove it runs as root, then store the key (or re-check the stored one)
 *   DELETE /hosts/:slug/elevation          the helper's uninstall there, and the key goes here
 */
import type { PluginContext, PluginReply, PluginRequest, PluginRouter } from "@dispatch/plugin-sdk";
import { shCommand } from "@dispatch-plugins/host-agent";
import { errText, publicKeyOf } from "@dispatch-plugins/remote-core";
import { keyBlobOf, removeKeyScript } from "./authorized-keys.js";
import { HELPER_VERSION, MANUAL_UNINSTALL, removeElevation, verifyElevation, type ElevationSetups, type RemovedThere } from "./elevation-setup.js";
import { elevateSecretName, keySecretName, validAddress, type HostConfig } from "./hosts.js";
import { UserError, type Pairing } from "./pairing.js";
import { elevationSetupPossible, rootLogin } from "./remote-platform.js";
import type { HostRegistry } from "./registry.js";

export interface RoutesDeps {
  ctx: PluginContext;
  instanceId: string;
  registry: HostRegistry;
  pairing: Pairing;
  setups: ElevationSetups;
  hosts: () => HostConfig[];
  saveHosts: (hosts: HostConfig[]) => Promise<void>;
  /** Tests: the uid the helper's check must report (0, except where the test can't be root). */
  rootUid?: number;
}

/** What turning elevation off did, as the routes report it. */
export interface ElevationOff {
  there: RemovedThere;
  detail?: string;
  /** Run this at the machine, as an administrator, to finish taking it out. */
  manual?: string;
}

type Handler = (req: PluginRequest) => Promise<unknown> | unknown;

function wrap(log: PluginContext["log"], fn: Handler) {
  return async (req: PluginRequest, reply: PluginReply) => {
    try {
      return await fn(req);
    } catch (err) {
      const status = err instanceof UserError ? err.status : 500;
      if (status >= 500) log.warn(`remote-host ${req.method} ${req.url}: ${errText(err)}`);
      reply.code(status);
      return { error: errText(err) };
    }
  };
}

function body(req: PluginRequest): Record<string, unknown> {
  return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

export function defineRoutes(deps: RoutesDeps): (r: PluginRouter<PluginRequest, PluginReply>) => void {
  const { ctx, registry, pairing } = deps;
  const h = (fn: Handler) => wrap(ctx.log, fn);

  const find = (req: PluginRequest): HostConfig => {
    const slug = String(req.params.slug ?? "");
    const host = deps.hosts().find((x) => x.slug === slug);
    if (!host) throw new UserError(`no paired machine called ${slug}`, 404);
    return host;
  };

  /**
   * Turn elevation off for `host`: the helper's uninstall there, with its own
   * key, then the key goes here whatever happened there (nothing here can use
   * it after this). When it couldn't be undone there, `manual` says how.
   */
  const elevationOff = async (host: HostConfig): Promise<ElevationOff> => {
    deps.setups.drop(host.slug);
    const name = elevateSecretName(host.slug);
    if (!(await ctx.secrets?.get(name))?.trim()) return { there: "not-set-up" };
    const e = registry.get(host.slug);
    const res = e ? await removeElevation(e.backend.elevation) : { there: "unreachable" as const };
    await ctx.secrets?.delete?.(name);
    await e?.backend.elevation.refresh();
    ctx.log.info(`remote-host ${host.slug}: elevation turned off (${res.there}${res.detail ? `: ${res.detail}` : ""})`);
    return { ...res, ...(res.there !== "removed" && res.there !== "not-set-up" ? { manual: MANUAL_UNINSTALL } : {}) };
  };

  return (r) => {
    r.get("/hosts", h(async () => {
      await registry.refreshElevation();
      return { hosts: registry.list() };
    }));

    r.post("/hosts/:slug/elevation/setup", h(async (req) => {
      const host = find(req);
      const entry = registry.get(host.slug);
      if (!entry) throw new UserError(`${host.slug} is not registered in this instance`, 409);
      // The setup script makes a hidden macOS account; a root login has nothing to elevate to.
      if (rootLogin(entry.link.probe, host.user)) throw new UserError(`${host.label}'s login is root already: there is nothing to set up`);
      if (!elevationSetupPossible(entry.link.probe, host.user)) {
        throw new UserError(`root with approval can only be set up on a Mac so far, and ${host.label} isn't one`);
      }
      // On already (the setup run again, to update the helper): the same key,
      // so the login that works keeps working whether or not Verify follows.
      // As stored, so verifying stores back exactly the same secret.
      const stored = await ctx.secrets?.get(elevateSecretName(host.slug));
      if (stored?.trim()) {
        try {
          return deps.setups.start(host, stored);
        } catch (err) {
          ctx.log.warn(`remote-host ${host.slug}: the stored elevation key can't be read (${errText(err)}); making a new one`);
        }
      }
      return deps.setups.start(host);
    }));

    r.post("/hosts/:slug/elevation/verify", h(async (req) => {
      const host = find(req);
      const e = registry.get(host.slug);
      if (!e) throw new UserError(`${host.slug} is not registered in this instance`, 409);
      const pending = deps.setups.key(host.slug);
      const name = elevateSecretName(host.slug);
      const key = pending ?? ((await ctx.secrets?.get(name))?.trim() || undefined);
      if (!key) throw new UserError(`make ${host.label}'s setup command first`, 409);
      const { version } = await verifyElevation(e.backend.elevation, key, host.label, deps.rootUid ?? 0);
      if (pending) {
        if (!ctx.secrets?.set) throw new Error("this Dispatch cannot store secrets for plugins (secrets:write); update Dispatch");
        await ctx.secrets.set(name, pending);
        deps.setups.drop(host.slug);
        ctx.log.info(`remote-host ${host.slug}: elevation is on (helper ${version})`);
      }
      await e.backend.elevation.refresh();
      // An older helper still works; the pane offers the setup again, which installs this plugin's.
      const outdated = version !== HELPER_VERSION;
      if (outdated) ctx.log.info(`remote-host ${host.slug}: its root helper is version ${version}; this plugin has ${HELPER_VERSION}`);
      return { on: true, version, current: HELPER_VERSION, outdated, canAsk: e.backend.elevation.canAsk };
    }));

    r.delete("/hosts/:slug/elevation", h(async (req) => elevationOff(find(req))));

    r.post("/pair/scan", h((req) => pairing.scan(body(req))));
    r.post("/pair/start", h((req) => pairing.start(body(req))));
    r.post("/pair/finish", h(async (req) => {
      const done = await pairing.finish(body(req));
      registry.sync(deps.hosts());
      return done;
    }));
    r.post("/pair/cancel", h((req) => pairing.cancel(body(req))));

    r.put("/hosts/:slug", h(async (req) => {
      const host = find(req);
      const b = body(req);
      const next: HostConfig = { ...host };
      if (b.label !== undefined) {
        const label = typeof b.label === "string" ? b.label.trim() : "";
        if (!label || label.length > 80) throw new UserError("label must be 1 to 80 characters");
        next.label = label;
      }
      if (b.addresses !== undefined) {
        const list = Array.isArray(b.addresses) ? [...new Set(b.addresses.map((a) => String(a).trim()).filter(Boolean))] : [];
        if (!list.length) throw new UserError("addresses must list at least one name or address");
        for (const a of list) if (!validAddress(a)) throw new UserError(`not a host name or address: ${a}`);
        next.addresses = list;
      }
      await deps.saveHosts(deps.hosts().map((x) => (x.slug === host.slug ? next : x)));
      registry.sync(deps.hosts());
      return { host: next };
    }));

    r.post("/hosts/:slug/check", h(async (req) => {
      const host = find(req);
      const e = registry.get(host.slug);
      if (!e) throw new UserError(`${host.slug} is not registered in this instance`, 409);
      const status = await e.link.checkNow();
      return { status, ...(e.link.probe ? { probe: e.link.probe } : {}) };
    }));

    r.delete("/hosts/:slug", h(async (req) => {
      const host = find(req);
      const e = registry.get(host.slug);
      const name = keySecretName(host.slug);
      // While the key still works: end this instance's sessions there and
      // take the key's line out of authorized_keys. The other instance's
      // sessions end on their own once it notices (its heartbeat stops).
      // Root first, with its own key: once the machine is forgotten here, nothing could take it out but the user.
      const elevation = await elevationOff(host);
      let keyLine: "removed" | "absent" | "unreachable" = "unreachable";
      let sessions = 0;
      const key = await ctx.secrets?.get(name);
      if (e && key) {
        try {
          // Patient: this is the one chance to take the key line out, so a
          // machine the link thinks is offline is dialled anyway.
          await e.link.ready(AbortSignal.timeout(20_000), { patient: true });
          const killed = await e.link
            .agent<{ killed?: string[] }>(["kill", "--instance", deps.instanceId, "--all"], 30_000)
            .catch(() => ({ killed: [] }));
          sessions = killed?.killed?.length ?? 0;
          const res = await e.link.exec(shCommand(removeKeyScript(keyBlobOf(publicKeyOf(key)))), { timeoutMs: 30_000 });
          keyLine = res.code === 0 ? (res.stdout.includes("removed") ? "removed" : "absent") : "unreachable";
        } catch (err) {
          ctx.log.warn(`remote-host ${host.slug}: removing its key on the machine failed: ${errText(err)}`);
        }
      }
      await deps.saveHosts(deps.hosts().filter((x) => x.slug !== host.slug));
      registry.sync(deps.hosts());
      await ctx.secrets?.delete?.(name);
      await ctx.kv?.delete(`host:${host.slug}`);
      // What this Dispatch knew of the machine's chats goes too: a machine
      // paired again under this name starts clean, and a sync record kept
      // from before would read its new, empty checkout against the old base.
      for (const prefix of [`sync:${host.slug}:`, `served:${host.slug}:`]) {
        for (const k of (await ctx.kv?.list(prefix).catch(() => [])) ?? []) await ctx.kv?.delete(k);
      }
      const notes = [
        ...(keyLine === "unreachable"
          ? [
              `The machine could not be reached, so its authorized_keys still lets this key in (it is deleted here, so ` +
                `nobody holds it). To tidy up, delete the line ending in "dispatch-remote-host:${host.slug}@…" from ` +
                `~${host.user}/.ssh/authorized_keys on it.`,
            ]
          : []),
        ...(elevation.manual
          ? [
              `Root with approval couldn't be taken out there (${elevation.detail ?? elevation.there}); its key is deleted ` +
                `here, so nothing can use it. To remove the hidden account and helper, run this there as an administrator: ` +
                elevation.manual,
            ]
          : []),
      ];
      return {
        removed: host.slug,
        keyLine,
        sessionsEnded: sessions,
        elevation: elevation.there,
        ...(notes.length ? { note: notes.join("\n\n") } : {}),
      };
    }));
  };
}
