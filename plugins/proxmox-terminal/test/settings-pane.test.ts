/**
 * What the Settings pane (client.tsx) reads and does, through the server
 * half: the Proxmox API probe behind the backend's status, the overview, and
 * Skip rescue / Destroy without rescue for a pre-0.2 container — plus the
 * routes that carry them, through the SDK's own route table.
 */
import { describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { ProxmoxTerminal, SKIP_AFTER_FAILURES } from "../src/backend.js";
import { defineRoutes } from "../src/routes.js";
import { readSettings } from "../src/settings.js";
import { INSTANCE, emptyContainer, fakeProxmox, fakeRemoteHost, ours, rec, terminal } from "./fakes.js";

const failed = (vmid: number, failures: number) => ({
  vmid,
  phase: "failed",
  startedAt: 1,
  updatedAt: 2,
  entries: {},
  failures,
  lastError: "ssh: handshake failed",
});

describe("the Proxmox API probe", () => {
  it("goes offline after two misses in a row, says why, and back online at the first answer", async () => {
    const f = fakeProxmox();
    const { b, changes } = terminal(f);
    await b.probe();
    expect(b.status()).toEqual({ state: "online" });
    f.state.down = true;
    await b.probe();
    expect(b.status()).toEqual({ state: "online" }); // one miss is a blip
    await b.probe();
    expect(b.status()).toMatchObject({ state: "offline", detail: expect.stringMatching(/can't reach the Proxmox API: .*ECONNREFUSED/) });
    expect(changes()).toBe(1);
    f.state.down = false;
    await b.probe();
    expect(b.status()).toEqual({ state: "online" });
    expect(changes()).toBe(2);
  });

  it("is stopped by dispose (the backend unregistered)", async () => {
    const f = fakeProxmox();
    const { b } = terminal(f);
    await b.start();
    await b.forwarder.dispose();
    expect((b as unknown as { probeTimer?: unknown }).probeTimer).toBeUndefined();
  });
});

describe("overview", () => {
  it("lists pre-0.2 containers with their rescue state, and skips layout-2 ones", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped"), 9003: ours("c2", "running"), 9004: ours("c3", "stopped") });
    const { b } = terminal(f, {
      instance: INSTANCE,
      "chat:c1": rec(9002),
      "chat:c2": rec(9003, { layout: 2 }),
      "chat:c3": rec(9004, { hostname: "dt-c3" }),
      "rescue:c3": failed(9004, SKIP_AFTER_FAILURES),
      "rescue:c1": failed(8000, 5), // another container's: says nothing about this one
    });
    const o = await b.overview();
    expect(o.legacy).toEqual([
      { chatId: "c1", vmid: 9002, hostname: "h", status: "stopped", rescuing: false, failures: 0, canSkip: false },
      {
        chatId: "c3",
        vmid: 9004,
        hostname: "dt-c3",
        status: "stopped",
        rescuing: false,
        phase: "failed",
        failures: 3,
        lastError: "ssh: handshake failed",
        canSkip: true,
      },
    ]);
    expect(o.status).toEqual({ state: "online" });
    expect(o.hostKeyPinned).toBe(false);
    expect(o.range).toEqual({ start: 9001, end: 9099, size: 99, used: 3, warn: false });
  });

  it("warns past 80% of the vmid range, and says the key is pinned when it is", async () => {
    const cts = Object.fromEntries([9001, 9002, 9003, 9004, 9005].map((v) => [v, ours(`c${v}`, "stopped")]));
    const { b } = terminal(fakeProxmox(cts), undefined, { vmidStart: 9001, vmidEnd: 9006, templateHostKey: "SHA256:abc" });
    const o = await b.overview();
    expect(o.range).toMatchObject({ size: 6, used: 5, warn: true });
    expect(o.hostKeyPinned).toBe(true);
  });

  it("still lists kv's containers when the API is down, without their status", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    f.state.down = true;
    const o = await b.overview();
    expect(o.apiError).toMatch(/unreachable/);
    expect(o.legacy).toEqual([{ chatId: "c1", vmid: 9002, hostname: "h", rescuing: false, failures: 0, canSkip: false }]);
    expect(o.range.warn).toBe(false);
  });
});

describe("Skip rescue", () => {
  it(`is refused before ${SKIP_AFTER_FAILURES} failed rescues`, async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002), "rescue:c1": failed(9002, 2) });
    await expect(b.skipRescue("c1")).rejects.toThrow(/failed 2 time\(s\); Skip is offered after 3/);
  });

  it("marks the container layout 2 without touching it; the next spawn rescues nothing", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    let connects = 0;
    const { b, kvNow } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002), "rescue:c1": failed(9002, 3) }, {}, {
      rescueRemote: async () => {
        connects++;
        return emptyContainer();
      },
    });
    await b.skipRescue("c1");
    expect(kvNow()["chat:c1"]).toMatchObject({ vmid: 9002, layout: 2, rescueSkippedAt: expect.any(Number) });
    expect(kvNow()["rescue:c1"]).toBeUndefined();
    expect(f.cts.get(9002)?.status).toBe("stopped");
    await b.forwarder.spawn({ chatId: "c1", name: "main", cwd: "/w", worktreePath: "/w", repoPath: "/w", signal: new AbortController().signal });
    expect(connects).toBe(0);
  });

  it("the third failed rescue's refusal points at Settings", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002), "rescue:c1": failed(9002, 2) }, {}, {
      rescueRemote: async () => {
        throw new Error("ssh: handshake failed");
      },
    });
    await expect(
      b.forwarder.spawn({ chatId: "c1", name: "main", cwd: "/w", worktreePath: "/w", repoPath: "/w", signal: new AbortController().signal }),
    ).rejects.toThrow(/attempt 3; .*Skip rescue.*Destroy without rescue.*container 9002/);
  });
});

describe("Destroy without rescue", () => {
  it("destroys the container and forgets it; the chat's next spawn clones a new one", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b, kvNow, rh } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002), "rescue:c1": failed(9002, 1) });
    await b.destroyWithoutRescue("c1");
    expect(f.cts.has(9002)).toBe(false);
    expect(kvNow()["chat:c1"]).toBeUndefined();
    expect(kvNow()["rescue:c1"]).toBeUndefined();
    expect(kvNow()["destroy:9002"]).toBeUndefined();
    expect(rh.calls.some((c) => c.startsWith("forgetChat c1") || c.startsWith("machineGone"))).toBe(true);
    await b.forwarder.spawn({ chatId: "c1", name: "main", cwd: "/w", worktreePath: "/w", repoPath: "/w", signal: new AbortController().signal });
    expect(kvNow()["chat:c1"]).toMatchObject({ vmid: 9001, layout: 2 });
  });

  it("is refused for a container with nothing to rescue, one being rescued, and a chat with none", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeProxmox({ 9002: ours("c1", "stopped"), 9003: ours("c2", "stopped") });
    const { b } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002, { layout: 2 }), "chat:c2": rec(9003) }, {}, {
      rescueRemote: async () => {
        await gate;
        return emptyContainer();
      },
    });
    await expect(b.destroyWithoutRescue("c1")).rejects.toThrow(/nothing left to rescue/);
    await expect(b.destroyWithoutRescue("nope")).rejects.toThrow(/has no container/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(
      b.forwarder.spawn({ chatId: "c2", name: "main", cwd: "/w", worktreePath: "/w", repoPath: "/w", signal: ac.signal }),
    ).rejects.toThrow(/run the command again/);
    await expect(b.destroyWithoutRescue("c2")).rejects.toThrow(/wait for it to finish/);
    await expect(b.skipRescue("c2")).rejects.toThrow(/wait for it to finish/);
    expect(f.cts.has(9003)).toBe(true);
    release();
  });
});

describe("routes", () => {
  function routed(kv: Record<string, unknown>, f = fakeProxmox()) {
    const t = createTestContext({
      id: "proxmox-terminal",
      kv,
      capabilities: ["terminals", "secrets", "kv", "routes", "ui"],
      dependencies: { "remote-host": { machines: { 1: fakeRemoteHost().api } } },
      optionalDependencies: ["remote-host"],
    });
    const b = new ProxmoxTerminal({
      ctx: t.ctx,
      kv: t.ctx.kv,
      settings: () => readSettings({ apiUrl: "https://pve:8006", node: "g" }),
      token: async () => "u@pve!t=x",
      sshAuth: async () => ({ privateKey: "k" }),
      proxmox: () => f.api,
      dependencies: () => t.ctx.dependencies,
      rescueRemote: emptyContainer,
    });
    b.link.connect();
    t.ctx.routes!(defineRoutes(t.ctx, () => b));
    return { t, b, f };
  }

  it("serves the overview and the two actions, with the reason on a refusal", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped"), 9003: ours("c2", "stopped") });
    const { t } = routed({ instance: INSTANCE, "chat:c1": rec(9002), "chat:c2": rec(9003), "rescue:c2": failed(9003, 3) }, f);
    expect(t.routes.list().sort()).toEqual(["GET /overview", "POST /legacy/:chatId/destroy", "POST /legacy/:chatId/skip-rescue"]);
    const o = await t.routes.call("GET", "/overview");
    expect(o.status).toBe(200);
    expect((o.body as { legacy: unknown[] }).legacy).toHaveLength(2);
    const early = await t.routes.call("POST", "/legacy/c1/skip-rescue", { params: { chatId: "c1" } });
    expect(early).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Skip is offered after 3/) } });
    expect(await t.routes.call("POST", "/legacy/c2/skip-rescue", { params: { chatId: "c2" } })).toMatchObject({ status: 200 });
    expect(await t.routes.call("POST", "/legacy/c1/destroy", { params: { chatId: "c1" } })).toMatchObject({ status: 200 });
    expect(f.cts.has(9002)).toBe(false);
    expect(await t.routes.call("POST", "/legacy/c1/destroy", { params: { chatId: "c1" } })).toMatchObject({ status: 404 });
    expect(await t.routes.call("POST", "/legacy/x%2Fy/destroy", { params: { chatId: "x/y" } })).toMatchObject({ status: 400 });
  });
});
