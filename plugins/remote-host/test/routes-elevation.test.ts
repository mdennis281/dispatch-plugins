/**
 * The elevation routes against a stand-in for the machine's helper, for what
 * the bundle test can't reach (it has no machine): Check telling an older
 * helper from this plugin's, and the setup made again for an update keeping
 * the key elevation is on with.
 */
import { describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { generateKeyPair, publicKeyOf } from "@dispatch-plugins/remote-core";
import { ElevationSetups, HELPER_VERSION, type SetupStart } from "../src/elevation-setup.js";
import type { HelperResult } from "../src/elevation.js";
import type { HostConfig } from "../src/hosts.js";
import type { Pairing } from "../src/pairing.js";
import type { HostRegistry } from "../src/registry.js";
import type { ProbeResult } from "@dispatch-plugins/host-agent";
import { PROBE } from "./fake-machine.js";
import { defineRoutes } from "../src/routes.js";

const HOST: HostConfig = {
  slug: "lab",
  label: "Lab Mac",
  user: "dispatch",
  addresses: ["10.0.4.5"],
  port: 22,
  hostKey: `SHA256:${"a".repeat(43)}`,
  hostKeyType: "ssh-ed25519",
  keyFingerprint: `SHA256:${"b".repeat(43)}`,
  allowFrom: ["10.0.4.1"],
  pairedAt: "2026-11-06T00:00:00.000Z",
};

/** The routes over one registered machine whose helper answers `check` with `answer`, as last probed. */
function rig(answer: () => string, secrets: Record<string, string> = {}, probe: ProbeResult | undefined = PROBE) {
  const t = createTestContext({
    id: "remote-host",
    capabilities: ["routes", "secrets", "secrets:write"],
    manifestSecrets: ["REMOTE_HOST_KEY_*", "REMOTE_HOST_ELEVATE_KEY_*"],
    secrets,
  });
  const checkedWith: string[] = [];
  const elevation = {
    canAsk: true,
    helper: async (verb: string, key?: string): Promise<HelperResult> => {
      checkedWith.push(`${verb} ${key ?? "(stored)"}`);
      return { code: 0, stdout: answer(), stderr: "" };
    },
    refresh: async () => {},
  };
  const registry = {
    get: (slug: string) => (slug === HOST.slug ? { host: HOST, link: { probe }, backend: { elevation } } : undefined),
  } as unknown as HostRegistry;
  t.ctx.routes!(
    defineRoutes({
      ctx: t.ctx,
      instanceId: "inst",
      registry,
      pairing: {} as Pairing,
      setups: new ElevationSetups({ dispatchName: "pc" }),
      hosts: () => [HOST],
      saveHosts: async () => {},
    }),
  );
  return { t, checkedWith };
}

describe("the elevation routes", () => {
  it("say when the helper there is older than this plugin's, and that it still works", async () => {
    const key = generateKeyPair("k@test").privateKey;
    let version = "1";
    const { t } = rig(() => `dispatch-elevate ${version} uid=0\n`, { REMOTE_HOST_ELEVATE_KEY_LAB: key });
    const old = await t.routes.call("POST", "/hosts/:slug/elevation/verify", { params: { slug: "lab" } });
    expect(old.status).toBe(200);
    expect(old.body).toMatchObject({ on: true, version: "1", current: HELPER_VERSION, outdated: true });
    version = HELPER_VERSION;
    const now = await t.routes.call("POST", "/hosts/:slug/elevation/verify", { params: { slug: "lab" } });
    expect(now.body).toMatchObject({ on: true, version: HELPER_VERSION, current: HELPER_VERSION, outdated: false });
  });

  it("make the setup command again with the key elevation is on with, and verify keeps that key", async () => {
    const key = generateKeyPair("k@test").privateKey;
    const { t, checkedWith } = rig(() => `dispatch-elevate ${HELPER_VERSION} uid=0\n`, { REMOTE_HOST_ELEVATE_KEY_LAB: key });
    const setup = await t.routes.call("POST", "/hosts/:slug/elevation/setup", { params: { slug: "lab" } });
    expect(setup.status).toBe(200);
    const s = setup.body as SetupStart;
    // The same key line the machine already has: the login that works keeps working.
    expect(s.keyLine.endsWith(` ${publicKeyOf(key)}`)).toBe(true);
    expect(s.script).toContain(`VERSION='${HELPER_VERSION}'`);
    const v = await t.routes.call("POST", "/hosts/:slug/elevation/verify", { params: { slug: "lab" } });
    expect(v.status).toBe(200);
    expect(checkedWith).toEqual([`check ${key}`]);
    expect(t.secrets.get("REMOTE_HOST_ELEVATE_KEY_LAB")).toBe(key);
  });

  it("make no setup command for a machine that isn't a Mac, or whose login is root", async () => {
    const linux = rig(() => "", {}, { ...PROBE, platform: "linux", uid: 1000 });
    const l = await linux.t.routes.call("POST", "/hosts/:slug/elevation/setup", { params: { slug: "lab" } });
    expect(l.status).toBe(400);
    expect(l.body).toMatchObject({ error: expect.stringMatching(/only be set up on a Mac so far, and Lab Mac isn't one/) });
    const root = rig(() => "", {}, { ...PROBE, uid: 0 });
    const r = await root.t.routes.call("POST", "/hosts/:slug/elevation/setup", { params: { slug: "lab" } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: expect.stringMatching(/login is root already/) });
    // Not probed yet: offered, as before.
    expect((await rig(() => "", {}, undefined).t.routes.call("POST", "/hosts/:slug/elevation/setup", { params: { slug: "lab" } })).status).toBe(200);
  });

  it("mint a new key when none is stored, or the stored one can't be read", async () => {
    const fresh = rig(() => `dispatch-elevate ${HELPER_VERSION} uid=0\n`);
    const a = (await fresh.t.routes.call("POST", "/hosts/:slug/elevation/setup", { params: { slug: "lab" } })).body as SetupStart;
    expect(a.keyLine).toMatch(/ ssh-ed25519 \S+ dispatch-elevate:lab@pc$/);

    const broken = rig(() => `dispatch-elevate ${HELPER_VERSION} uid=0\n`, { REMOTE_HOST_ELEVATE_KEY_LAB: "not a key" });
    const b = await broken.t.routes.call("POST", "/hosts/:slug/elevation/setup", { params: { slug: "lab" } });
    expect(b.status).toBe(200);
    expect((b.body as SetupStart).keyLine).toMatch(/ ssh-ed25519 \S+ dispatch-elevate:lab@pc$/);
  });
});
