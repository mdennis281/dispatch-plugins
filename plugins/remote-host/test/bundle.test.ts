/**
 * The COMMITTED bundle, server/index.js, activated against the SDK's fake
 * host with this plugin's real manifest and settings schema: what Dispatch
 * would load. Build before testing (`pnpm build`), or this tests old code.
 */
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "@dispatch/plugin-sdk/testing";
import type { PluginCapability, PluginModule } from "@dispatch/plugin-sdk";
import { PluginManifestSchema, pluginSecretAllowed } from "@dispatch/plugin-sdk/manifest";
import { generateKeyPair } from "@dispatch-plugins/remote-core";
import { elevateSecretName, keySecretName } from "../src/hosts.js";

const dir = fileURLToPath(new URL("..", import.meta.url));
const manifest = readFileSync(`${dir}/plugin.yaml`, "utf8");
/** The `  - item` lines under a top-level `key:` in plugin.yaml, up to the next top-level key. */
const listUnder = (key: string) => {
  const after = manifest.split(new RegExp(`^${key}:\\s*$`, "m"))[1] ?? "";
  const block = after.split(/^(?=[A-Za-z])/m)[0] ?? "";
  return [...block.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]!);
};
const capabilities = listUnder("capabilities") as PluginCapability[];
const optionalCapabilities = listUnder("optionalCapabilities");
const manifestSecrets = listUnder("secrets");
const settingsSchema = JSON.parse(readFileSync(`${dir}/settings.schema.json`, "utf8")) as unknown;

async function load(): Promise<PluginModule> {
  const mod = (await import(pathToFileURL(`${dir}/server/index.js`).href)) as { default: PluginModule };
  return mod.default;
}

/** A port nothing listens on, so a connection there is refused at once. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

const host = (slug: string, port: number) => ({
  slug,
  label: slug.toUpperCase(),
  user: "dispatch",
  addresses: ["127.0.0.1"],
  port,
  hostKey: `SHA256:${"a".repeat(43)}`,
  hostKeyType: "ssh-ed25519",
  keyFingerprint: `SHA256:${"b".repeat(43)}`,
  allowFrom: ["127.0.0.1"],
  pairedAt: "2026-11-01T00:00:00.000Z",
});

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let active: { mod: PluginModule; t: TestContext } | undefined;
afterEach(async () => {
  await active?.mod.deactivate?.();
  active = undefined;
});

async function activate(opts: Parameters<typeof createTestContext>[0] = {}) {
  const mod = await load();
  const t = createTestContext({ id: "remote-host", capabilities, optionalCapabilities, manifestSecrets, settingsSchema, ...opts });
  await mod.activate(t.ctx);
  active = { mod, t };
  return t;
}

describe("the manifest", () => {
  it("asks for what the plugin uses and no more", () => {
    expect(capabilities).toEqual(["terminals", "secrets", "secrets:write", "kv", "routes", "ui"]);
    // Used where the host has them; an older Dispatch loads the plugin without them.
    expect(optionalCapabilities).toEqual(["approvals", "runner", "tools"]);
    expect(manifestSecrets).toEqual(["REMOTE_HOST_KEY_*", "REMOTE_HOST_ELEVATE_KEY_*"]);
    expect(manifest).toMatch(/^id: remote-host$/m);
    // What other plugins may use: machines@1 (proxmox-terminal's containers), and nothing else.
    expect(manifest).toMatch(/^provides:\n {2}machines: \[1\]\n(?! )/m);
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { version: string };
    expect(manifest).toContain(`version: ${pkg.version}`);
  });

  it("passes the host's manifest schema, and its secret pattern covers every machine's key", () => {
    const scalar = (key: string) => manifest.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1]?.replace(/^"(.*)"$/, "$1");
    const parsed = PluginManifestSchema.safeParse({
      id: scalar("id"),
      name: scalar("name"),
      version: scalar("version"),
      dispatch: scalar("dispatch"),
      description: "(folded text, not read here)",
      homepage: scalar("homepage"),
      server: scalar("server"),
      client: scalar("client"),
      settings: scalar("settings"),
      secrets: manifestSecrets,
      capabilities,
      optionalCapabilities,
      provides: { machines: [1] },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(pluginSecretAllowed(manifestSecrets, "REMOTE_HOST_KEY_CVX_MAC")).toBe(true);
    expect(pluginSecretAllowed(manifestSecrets, `REMOTE_HOST_KEY_${"A".repeat(48)}`)).toBe(true);
    expect(pluginSecretAllowed(manifestSecrets, "OTHER_SECRET")).toBe(false);
    // Each machine's elevation key too, under its own name.
    expect(pluginSecretAllowed(manifestSecrets, elevateSecretName("cvx-mac"))).toBe(true);
    expect(elevateSecretName("cvx-mac")).toBe("REMOTE_HOST_ELEVATE_KEY_CVX_MAC");
    expect(elevateSecretName("cvx-mac")).not.toBe(keySecretName("cvx-mac"));
  });
});

describe("activation", () => {
  it("registers each paired machine as a refusing bash backend, and reports it straight away", async () => {
    const port = await closedPort();
    const key = generateKeyPair("test").privateKey;
    const t = await activate({ settings: { hosts: [host("lab", port)] }, secrets: { REMOTE_HOST_KEY_LAB: key } });
    const b = t.terminalBackends.get("remote-host/lab");
    expect(b).toMatchObject({ id: "remote-host/lab", label: "LAB", shell: "bash", fallback: "refuse" });
    expect(t.terminalStatus.get("remote-host/lab")).toBeDefined();
    // With a real key it really dials the machine, and says why that failed.
    await until(() => t.terminalStatus.get("remote-host/lab")?.state === "offline");
    expect(t.terminalStatus.get("remote-host/lab")?.detail).toMatch(/connection refused/);
  });

  it("has the cleanup hooks core calls, and an uninstall with no machine to reach is well inside its budget", async () => {
    const t = await activate({ settings: { hosts: [] } });
    const mod = active!.mod;
    expect(mod.reconcile).toBeTypeOf("function");
    expect((await t.lifecycle.reconcile(mod, [{ id: "chat-1", projectId: "p" }])).overran).toBe(false);
    const r = await t.lifecycle.shutdown(mod, "uninstall");
    expect(r.overran).toBe(false);
    expect(r.error).toBeUndefined();
    active = undefined; // shutdown deactivated it
  });

  it("does nothing without an instance id to namespace its work by", async () => {
    const t = await activate({ instance: null, settings: { hosts: [host("lab", 1)] } });
    expect(t.terminalBackends.size).toBe(0);
    expect(t.log.some((l) => l.level === "error" && /instance id/.test(l.message))).toBe(true);
  });

  it("follows settings written elsewhere (the other instance pairing a machine)", async () => {
    const port = await closedPort();
    const t = await activate({ settings: { hosts: [] } });
    expect(t.terminalBackends.size).toBe(0);
    t.settings.set({ hosts: [host("lab", port)] });
    expect([...t.terminalBackends.keys()]).toEqual(["remote-host/lab"]);
    t.settings.set({ hosts: [] });
    await until(() => t.terminalBackends.size === 0);
  });
});

describe("routes", () => {
  it("serves the pane: list, pair, rename, check, remove", async () => {
    const port = await closedPort();
    const t = await activate({
      settings: { hosts: [host("lab", port)] },
      secrets: { REMOTE_HOST_KEY_LAB: "k" },
      // What it keeps of the machine's chats, and another machine's.
      kv: { "sync:lab:chat-1": { v: 1 }, "served:lab:chat-1": { at: 1 }, "sync:lab2:chat-1": { v: 1 }, "served:lab2:chat-2": { at: 1 } },
    });
    expect(t.routes.list().sort()).toEqual(
      [
        "DELETE /hosts/:slug",
        "DELETE /hosts/:slug/elevation",
        "GET /hosts",
        "POST /hosts/:slug/check",
        "POST /hosts/:slug/elevation/setup",
        "POST /hosts/:slug/elevation/verify",
        "POST /pair/cancel",
        "POST /pair/finish",
        "POST /pair/scan",
        "POST /pair/start",
        "PUT /hosts/:slug",
      ].sort(),
    );

    const list = await t.routes.call("GET", "/hosts");
    expect(list.status).toBe(200);
    expect((list.body as { hosts: Array<{ id: string }> }).hosts.map((h) => h.id)).toEqual(["remote-host/lab"]);

    const bad = await t.routes.call("POST", "/pair/start", { body: { slug: "Not OK", address: "x", user: "dispatch", hostKey: "x" } });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toMatch(/lowercase/);

    const taken = await t.routes.call("POST", "/pair/start", {
      body: { slug: "lab", address: "x", user: "dispatch", hostKey: `SHA256:${"c".repeat(43)}` },
    });
    expect(taken.status).toBe(409);

    const missing = await t.routes.call("PUT", "/hosts/:slug", { params: { slug: "nope" }, body: { label: "x" } });
    expect(missing.status).toBe(404);

    const renamed = await t.routes.call("PUT", "/hosts/:slug", { params: { slug: "lab" }, body: { label: "Garage Mac" } });
    expect(renamed.status).toBe(200);
    expect((t.settings.get().hosts as Array<{ label: string }>)[0]!.label).toBe("Garage Mac");
    expect(t.terminalUpdates.get("remote-host/lab")).toEqual({ label: "Garage Mac" });

    const removed = await t.routes.call("DELETE", "/hosts/:slug", { params: { slug: "lab" } });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removed: "lab", keyLine: "unreachable" });
    expect(t.settings.get().hosts).toEqual([]);
    expect(t.secrets.has("REMOTE_HOST_KEY_LAB")).toBe(false);
    // Paired again under this name, it starts clean: no old base to read a new, empty checkout against.
    expect([...t.kv.keys()].filter((k) => /^(sync|served):/.test(k)).sort()).toEqual(["served:lab2:chat-2", "sync:lab2:chat-1"]);
    await until(() => !t.terminalBackends.has("remote-host/lab"));
  });

  it("sets root with approval up, and takes it off a machine it can't reach without losing the way out", { timeout: 90_000 }, async () => {
    const port = await closedPort();
    const t = await activate({
      settings: { hosts: [host("lab", port)] },
      secrets: { REMOTE_HOST_KEY_LAB: "k" },
    });
    const listed = await t.routes.call("GET", "/hosts");
    // Granted (an optional capability this host knows), so this Dispatch can ask (core E31); not set up on the machine yet.
    expect((listed.body as { hosts: Array<{ elevation: unknown }> }).hosts[0]!.elevation).toEqual({ on: false, canAsk: true });

    const verifyFirst = await t.routes.call("POST", "/hosts/:slug/elevation/verify", { params: { slug: "lab" } });
    expect(verifyFirst.status).toBe(409);
    expect((verifyFirst.body as { error: string }).error).toMatch(/setup command first/);

    const setup = await t.routes.call("POST", "/hosts/:slug/elevation/setup", { params: { slug: "lab" } });
    expect(setup.status).toBe(200);
    const s = setup.body as { oneLiner: string; script: string; keyLine: string; allowFrom: string[] };
    expect(s.oneLiner).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 --decode \| gunzip \| sudo \/bin\/bash -s$/);
    expect(s.keyLine).toMatch(/^restrict,command="\/usr\/local\/libexec\/dispatch-elevate",from="127\.0\.0\.1" ssh-ed25519 /);
    expect(s.script).toContain(s.keyLine);
    // Nothing stored until it is proven.
    expect(t.secrets.has("REMOTE_HOST_ELEVATE_KEY_LAB")).toBe(false);
    const unreachable = await t.routes.call("POST", "/hosts/:slug/elevation/verify", { params: { slug: "lab" } });
    expect(unreachable.status).toBe(502);
    expect(t.secrets.has("REMOTE_HOST_ELEVATE_KEY_LAB")).toBe(false);

    // On (stored by an earlier verify), then the machine went away: turned off here anyway, with the command for there.
    t.secrets.set("REMOTE_HOST_ELEVATE_KEY_LAB", "an elevation key");
    expect(((await t.routes.call("GET", "/hosts")).body as { hosts: Array<{ elevation: unknown }> }).hosts[0]!.elevation).toEqual({
      on: true,
      canAsk: true,
    });
    const off = await t.routes.call("DELETE", "/hosts/:slug/elevation", { params: { slug: "lab" } });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ there: "unreachable", manual: "sudo /usr/local/libexec/dispatch-elevate uninstall" });
    expect(t.secrets.has("REMOTE_HOST_ELEVATE_KEY_LAB")).toBe(false);
    expect(((await t.routes.call("DELETE", "/hosts/:slug/elevation", { params: { slug: "lab" } })).body as { there: string }).there).toBe(
      "not-set-up",
    );

    // Remove machine turns it off first, and says how to finish when it couldn't.
    t.secrets.set("REMOTE_HOST_ELEVATE_KEY_LAB", "an elevation key");
    const removed = await t.routes.call("DELETE", "/hosts/:slug", { params: { slug: "lab" } });
    expect(removed.body).toMatchObject({ removed: "lab", elevation: "unreachable" });
    expect((removed.body as { note: string }).note).toMatch(/Root with approval couldn't be taken out there.*sudo \/usr\/local\/libexec\/dispatch-elevate uninstall/);
    expect(t.secrets.has("REMOTE_HOST_ELEVATE_KEY_LAB")).toBe(false);
  });

  it("runs on a Dispatch without its optional capabilities: no ctx.approvals, so Root can't ask, and forwards keep the default ports clear", async () => {
    // Such a host knows neither name (it is older than #512 / #517), or drops
    // the whole list (older than #518): either way neither is granted.
    const port = await closedPort();
    const t = await activate({ optionalCapabilities: [], settings: { hosts: [host("lab", port)] }, secrets: { REMOTE_HOST_KEY_LAB: "k" } });
    expect((t.ctx as { approvals?: unknown }).approvals).toBeUndefined();
    expect((t.ctx as { runner?: unknown }).runner).toBeUndefined();
    expect(t.terminalBackends.get("remote-host/lab")).toBeDefined();
    const listed = await t.routes.call("GET", "/hosts");
    expect((listed.body as { hosts: Array<{ elevation: unknown }> }).hosts[0]!.elevation).toEqual({ on: false, canAsk: false });
    // The agent is told root needs a newer Dispatch.
    const note = t.terminalBackends.get("remote-host/lab")!.agentNote?.({ chatId: "chat-1" } as never) ?? "";
    expect(note).toMatch(/Root: nothing can run as root on LAB: .*needs a newer Dispatch/);
    // No ctx.tools: no agent tools, and the note doesn't offer them.
    expect((t.ctx as { tools?: unknown }).tools).toBeUndefined();
    expect(t.tools.list()).toEqual([]);
    expect(note).not.toContain("remote_fetch");
  });

  it("gives the agent remote_fetch and machine_status where this Dispatch has ctx.tools, and its note names them", async () => {
    const port = await closedPort();
    const t = await activate({ settings: { hosts: [host("lab", port)] }, secrets: { REMOTE_HOST_KEY_LAB: "k" } });
    expect(t.tools.list()).toEqual(["machine_status", "remote_fetch"]);
    const note = t.terminalBackends.get("remote-host/lab")!.agentNote?.({ chatId: "chat-1" } as never) ?? "";
    expect(note).toContain("call remote-host's `remote_fetch` tool");
    // Nothing reachable: the tool says why instead of hanging.
    const r = await t.tools.call("machine_status", {}, { chatId: "chat-1" });
    expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^LAB \(terminal location remote-host\/lab\): /) });
  });
});
