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

const dir = fileURLToPath(new URL("..", import.meta.url));
const manifest = readFileSync(`${dir}/plugin.yaml`, "utf8");
/** The `  - item` lines under a top-level `key:` in plugin.yaml, up to the next top-level key. */
const listUnder = (key: string) => {
  const after = manifest.split(new RegExp(`^${key}:\\s*$`, "m"))[1] ?? "";
  const block = after.split(/^(?=[A-Za-z])/m)[0] ?? "";
  return [...block.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]!);
};
const capabilities = listUnder("capabilities") as PluginCapability[];
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
  const t = createTestContext({ id: "remote-host", capabilities, manifestSecrets, settingsSchema, ...opts });
  await mod.activate(t.ctx);
  active = { mod, t };
  return t;
}

describe("the manifest", () => {
  it("asks for what the plugin uses and no more", () => {
    expect(capabilities).toEqual(["terminals", "secrets", "secrets:write", "kv", "routes", "ui"]);
    expect(manifestSecrets).toEqual(["REMOTE_HOST_KEY_*"]);
    expect(manifest).toMatch(/^id: remote-host$/m);
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
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(pluginSecretAllowed(manifestSecrets, "REMOTE_HOST_KEY_CVX_MAC")).toBe(true);
    expect(pluginSecretAllowed(manifestSecrets, `REMOTE_HOST_KEY_${"A".repeat(48)}`)).toBe(true);
    expect(pluginSecretAllowed(manifestSecrets, "OTHER_SECRET")).toBe(false);
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
    const t = await activate({ settings: { hosts: [host("lab", port)] }, secrets: { REMOTE_HOST_KEY_LAB: "k" } });
    expect(t.routes.list().sort()).toEqual(
      [
        "DELETE /hosts/:slug",
        "GET /hosts",
        "POST /hosts/:slug/check",
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
    await until(() => !t.terminalBackends.has("remote-host/lab"));
  });
});
