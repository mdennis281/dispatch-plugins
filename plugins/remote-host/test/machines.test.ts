/**
 * `machines@1` as a caller gets it: served through the SDK's provider side
 * of core's plugin dependencies (`t.callAs`, `t.revoke`), so the membrane is
 * the host's. Who may use it, what a caller's link closing does, and what
 * remote-host's reconcile tidies of callers' records.
 */
import { describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { isPluginCallError, isPluginRevokedError, type PluginCapability } from "@dispatch/plugin-sdk";
import type { MachinesV1, ProvisionedBackendOptions } from "@dispatch-plugins/remote-host-api";
import { CALLER_GONE_RECONCILES, MachinesService } from "../src/machines.js";
import { provisionedMachine } from "../src/tools/index.js";
import { AGENT, fakeRuntime } from "./fake-machine.js";

const opts = (id = "proxmox"): ProvisionedBackendOptions => ({
  id,
  label: "Proxmox container",
  io: { publishPort: () => () => {} },
  provision: async () => {
    throw new Error("not in these tests");
  },
});

function setup(o: { kv?: Record<string, unknown>; dependents?: string[] } = {}) {
  const t = createTestContext({
    id: "remote-host",
    provides: { machines: [1] },
    kv: o.kv ?? {},
    ...(o.dependents ? { dependents: o.dependents.map((id) => ({ id, installed: true as const, status: "active" as never, uses: ["machines@1"] })) } : {}),
  });
  const service = new MachinesService({
    instanceId: "inst-1",
    log: t.ctx.log,
    kv: t.ctx.kv!,
    agent: AGENT,
    runtime: fakeRuntime(),
    paired: (b) => b === "remote-host/cvx-mac",
    where: (b) => (b === "remote-host/cvx-mac" ? "CVX Mac" : undefined),
    dependents: () => t.ctx.provides!.dependents(),
  });
  expect(service.serve(t.ctx)).toBe(true);
  const as = (caller: string, capabilities: PluginCapability[] = ["terminals"]) => t.callAs<MachinesV1>(caller, "machines", 1, { capabilities });
  return { t, service, as };
}

describe("machines@1", () => {
  it("is served where this Dispatch has plugin dependencies, and nowhere else", () => {
    const { t } = setup();
    expect([...t.served.keys()]).toEqual(["machines@1"]);
    const old = new MachinesService({ instanceId: "i", log: t.ctx.log, agent: AGENT, runtime: fakeRuntime() });
    expect(old.serve(createTestContext({ id: "remote-host" }).ctx)).toBe(false);
  });

  it("says which contract it is", () => {
    expect(setup().as("proxmox-terminal").contract).toEqual({ name: "machines", major: 1, minor: 0 });
  });

  it("refuses a caller that may not run terminals", () => {
    const { as } = setup();
    let err: unknown;
    try {
      as("snoop", []).createProvisionedBackend(opts());
    } catch (e) {
      err = e;
    }
    expect(isPluginCallError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("forbidden");
    expect(String(err)).toMatch(/may not run terminals/);
  });

  it("gives a caller its own backend: plain functions, the caller's id, refusing, bash", () => {
    const { service, as } = setup();
    const pb = as("proxmox-terminal").createProvisionedBackend(opts());
    expect(pb.backend).toMatchObject({ id: "proxmox", label: "Proxmox container", shell: "bash", fallback: "refuse" });
    expect(typeof pb.backend.spawn).toBe("function");
    expect(pb.machines()).toEqual([]);
    // The lock counts its runs as remote-host's, with the paired machines'.
    expect(service.mine("proxmox")).toBe(true);
    expect(service.mine("remote-host/cvx-mac")).toBe(true);
    expect(service.mine("other-plugin/box")).toBe(false);
    expect(service.where("proxmox")).toBe("Proxmox container");
    expect(service.where("remote-host/cvx-mac")).toBe("CVX Mac");
  });

  it("refuses options it can't serve: a bad id, one already served, a paired machine's", () => {
    const { as } = setup();
    const api = as("proxmox-terminal");
    expect(() => api.createProvisionedBackend({ ...opts(), id: "Not An Id" })).toThrow(/isn't a backend id/);
    expect(() => api.createProvisionedBackend({ ...opts(), id: "local" })).toThrow(/isn't a backend id/);
    expect(() => api.createProvisionedBackend({ ...opts(), id: "remote-host/cvx-mac" })).toThrow(/already served/);
    expect(() => api.createProvisionedBackend({ ...opts(), label: "" })).toThrow(/label/);
    api.createProvisionedBackend(opts());
    expect(() => api.createProvisionedBackend(opts())).toThrow(/already served/);
  });

  it("ends a caller's backend when its link closes: what it holds goes inert, the factory refuses", async () => {
    const { t, service, as } = setup();
    const api = as("proxmox-terminal");
    const pb = api.createProvisionedBackend(opts());
    t.revoke("proxmox-terminal");
    expect(service.serves("proxmox")).toBe(false);
    // Inert, not throwing: core's code that holds the backend never expected a throw.
    expect(pb.machines()).toBeUndefined();
    let err: unknown;
    try {
      api.createProvisionedBackend(opts());
    } catch (e) {
      err = e;
    }
    expect(isPluginRevokedError(err)).toBe(true);
  });
});

describe("remote-host's reconcile, for callers' records", () => {
  const records = (caller: string, chat: string) => ({
    [`pchat:x/${caller}/proxmox:${chat}`]: { machine: "9001:1", at: 1 },
    [`served:x/${caller}/proxmox/9001:1:${chat}`]: { at: 1 },
    [`sync:x/${caller}/proxmox/9001:1:${chat}`]: { v: 1 },
    [`ptoken:x/${caller}/proxmox/9001:1`]: { token: "t" },
  });

  it("drops a deleted chat's records, whether or not its caller is running, and keeps a live chat's", async () => {
    const paired = { "served:cvx-mac:gone": { at: 1 } };
    const { t, service } = setup({ kv: { ...records("proxmox-terminal", "gone"), ...records("proxmox-terminal", "live"), ...paired }, dependents: ["proxmox-terminal"] });
    await service.reconcile(new Set(["live"]));
    expect([...t.kv.keys()].sort()).toEqual(
      [...Object.keys(records("proxmox-terminal", "live")), ...Object.keys(paired)].sort(),
    );
  });

  it(`forgets a caller only once it has been gone for ${CALLER_GONE_RECONCILES} reconciles in a row`, async () => {
    const kept = records("proxmox-terminal", "chat-1");
    const { t, service } = setup({ kv: { ...kept, ...records("old-plugin", "chat-1") }, dependents: ["proxmox-terminal"] });
    const live = new Set(["chat-1"]);
    for (let i = 1; i < CALLER_GONE_RECONCILES; i++) {
      await service.reconcile(live);
      expect([...t.kv.keys()].filter((k) => k.includes("x/old-plugin/"))).toHaveLength(4);
    }
    await service.reconcile(live);
    expect([...t.kv.keys()].sort()).toEqual(Object.keys(kept).sort());
  });

  it("starts the count again for a caller that comes back (mid-update, say)", async () => {
    const t1 = setup({ kv: records("proxmox-terminal", "chat-1"), dependents: [] });
    await t1.service.reconcile(new Set(["chat-1"]));
    await t1.service.reconcile(new Set(["chat-1"]));
    expect(t1.t.kv.get("pgone:proxmox-terminal")).toEqual({ n: 2 });
    const back = new MachinesService({
      instanceId: "inst-1",
      log: t1.t.ctx.log,
      kv: t1.t.ctx.kv!,
      agent: AGENT,
      runtime: fakeRuntime(),
      dependents: () => [{ id: "proxmox-terminal" }],
    });
    await back.reconcile(new Set(["chat-1"]));
    expect(t1.t.kv.has("pgone:proxmox-terminal")).toBe(false);
    expect([...t1.t.kv.keys()].filter((k) => k.includes("proxmox-terminal"))).toHaveLength(4);
  });

  it("keeps everything when it can't tell who is installed", async () => {
    const t = createTestContext({ id: "remote-host", kv: records("old-plugin", "chat-1") });
    const service = new MachinesService({ instanceId: "i", log: t.ctx.log, kv: t.ctx.kv!, agent: AGENT, runtime: fakeRuntime() });
    for (let i = 0; i < 5; i++) await service.reconcile(new Set(["chat-1"]));
    expect(t.kv.size).toBe(4);
  });
});

describe("the agent's tools on a provisioned machine", () => {
  it("are refused while it is stopped, with how to start it, and never start it", () => {
    const pm = {
      id: "proxmox",
      label: "Proxmox container",
      key: "proxmox",
      slot: () => undefined,
      lastSeen: () => undefined,
    };
    const m = provisionedMachine(pm, "chat-1");
    expect(m.engine).toBeUndefined();
    expect(m.stopped).toBe("Proxmox container for this chat is stopped. A terminal command starts it; the tools never do.");
    expect(m.view().status).toEqual({ state: "offline", detail: "stopped (a terminal command starts it)" });
    expect(m.ownChat).toBe(true);
  });
});
