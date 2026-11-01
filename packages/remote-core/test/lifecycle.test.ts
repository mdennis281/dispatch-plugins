/**
 * RemoteChats' cleanup lifecycle against a fake provider — what has to hold
 * across a Dispatch restart, a provider outage and a chat that is gone,
 * whatever makes the machines. proxmox-terminal's own lifecycle tests run the
 * same paths through its Proxmox provider.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INSTANCE, chats, fakeProvider, rec, type Machine } from "./fakes.js";

const ours = (chatId: string, status: Machine["status"] = "running"): Machine => ({ chatId, instance: INSTANCE, status });
// Not a git repo, so spawn fails fast right AFTER bring-up — which is all
// these tests are about.
const notARepo = mkdtempSync(join(tmpdir(), "rc-norepo-"));
afterAll(() => rmSync(notARepo, { recursive: true, force: true }));
const spawnInfo = (name = "main") => ({ chatId: "c1", name, cwd: notARepo, signal: new AbortController().signal });
const changing = (calls: string[]) => calls.filter((c) => /^(destroy|stop|start|release) /.test(c));

describe("idle stop survives a restart", () => {
  it("stops a machine whose persisted idle deadline passed while Dispatch was down", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c } = chats(f, { instance: INSTANCE, "chat:c1": rec(2, { idleDeadline: Date.now() - 1_000 }) });
    await c.start();
    expect(f.machines.get(2)?.status).toBe("stopped");
  });

  it("leaves one with an unexpired deadline running, and stops it when the deadline comes", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": rec(2, { idleDeadline: Date.now() + 150 }) });
    await c.start();
    expect(f.machines.get(2)?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 400));
    expect(f.machines.get(2)?.status).toBe("stopped");
    expect((kvNow()["chat:c1"] as { idleDeadline?: number }).idleDeadline).toBeUndefined();
  });

  it("stops a running machine with no deadline at boot — its chat was busy when Dispatch crashed", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) });
    await c.start();
    expect(f.machines.get(2)?.status).toBe("stopped");
  });

  it("writes the idle deadline to kv, so a restart picks up the timer the old process held", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const one = chats(f, { instance: INSTANCE, "chat:c1": rec(2) }, { idleStopMinutes: 30 });
    await one.c.onChatIdle({ chatId: "c1" });
    const deadline = (one.kvNow()["chat:c1"] as { idleDeadline: number }).idleDeadline;
    expect(deadline).toBeGreaterThan(Date.now() + 29 * 60_000);
    await one.c.dispose();
    expect(f.machines.get(2)?.status).toBe("running");
    const after = { ...one.kvNow(), "chat:c1": { ...(one.kvNow()["chat:c1"] as object), idleDeadline: Date.now() - 1 } };
    await chats(f, after).c.start();
    expect(f.machines.get(2)?.status).toBe("stopped");
  });

  it("a clean shutdown gives a busy chat a deadline, so the next boot does not stop it at once", async () => {
    const f = fakeProvider();
    const { c, kvNow } = chats(f);
    await c.spawn(spawnInfo()).catch(() => {});
    const id = (kvNow()["chat:c1"] as { id: number }).id;
    expect(f.machines.get(id)?.status).toBe("running");
    await c.onShutdown({ reason: "restart", deadline: Date.now() + 5_000 });
    expect(f.machines.get(id)?.status).toBe("running");
    await chats(f, kvNow()).c.start();
    expect(f.machines.get(id)?.status).toBe("running");
  });

  it("a negative idleStopMinutes never stops anything", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) }, { idleStopMinutes: -1 });
    await c.onChatIdle({ chatId: "c1" });
    expect((kvNow()["chat:c1"] as { idleDeadline?: number }).idleDeadline).toBeUndefined();
    expect(f.machines.get(2)?.status).toBe("running");
  });
});

describe("destroy retries", () => {
  it("rejects when the provider is unreachable, keeps the destroy pending, and finishes it after a restart", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) });
    f.state.down = true;
    await expect(c.onChatDeleted({ chatId: "c1" })).rejects.toThrow(/unreachable/);
    expect(kvNow()["destroy:2"]).toMatchObject({ chatId: "c1", id: 2, attempts: 1 });
    expect(kvNow()["chat:c1"]).toBeUndefined();
    f.state.down = false;
    const kv = kvNow();
    (kv["destroy:2"] as { nextAt: number }).nextAt = 0; // due
    const next = chats(f, kv);
    await next.c.start();
    expect(f.machines.has(2)).toBe(false);
    expect(next.kvNow()["destroy:2"]).toBeUndefined();
  });

  it("backs off between attempts", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) });
    f.state.down = true;
    await c.onChatDeleted({ chatId: "c1" }).catch(() => {});
    expect((kvNow()["destroy:2"] as { nextAt: number }).nextAt).toBeGreaterThan(Date.now() + 20_000);
    f.state.down = false;
    await c.sweep(); // not due yet → not attempted
    expect(f.machines.has(2)).toBe(true);
    expect((kvNow()["destroy:2"] as { attempts: number }).attempts).toBe(1);
  });

  it("a core retry of onChatDeleted finishes the earlier failed destroy", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) });
    f.state.down = true;
    await c.onChatDeleted({ chatId: "c1" }).catch(() => {});
    f.state.down = false;
    await c.onChatDeleted({ chatId: "c1" });
    expect(f.machines.has(2)).toBe(false);
    expect(kvNow()["destroy:2"]).toBeUndefined();
  });

  it("drops a pending destroy that names no machine, and the sweep still does the rest", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c, kvNow } = chats(f, {
      instance: INSTANCE,
      "destroy:junk": { chatId: "x", attempts: 3, nextAt: 0 },
      "chat:c1": rec(2, { idleDeadline: Date.now() - 1 }),
    });
    await c.start();
    expect(kvNow()["destroy:junk"]).toBeUndefined();
    expect(f.machines.get(2)?.status).toBe("stopped");
  });

  it("resolves for a chat that never had a machine, touching nothing", async () => {
    const f = fakeProvider();
    await chats(f).c.onChatDeleted({ chatId: "never" });
    expect(f.calls).toEqual([]);
  });
});

describe("reconcile", () => {
  it("destroys machines whose chat is gone — including one whose kv record was lost — and stops idle ones", async () => {
    const f = fakeProvider({ 2: ours("gone"), 3: ours("alive"), 4: ours("lostrecord") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:gone": rec(2), "chat:alive": rec(3) });
    await c.reconcile({ chats: ["alive"] });
    expect(f.machines.has(2)).toBe(false);
    expect(f.machines.has(4)).toBe(false);
    expect(f.machines.get(3)?.status).toBe("stopped");
    expect(Object.keys(kvNow()).filter((k) => k.startsWith("chat:") || k.startsWith("destroy:"))).toEqual(["chat:alive"]);
  });

  it("re-adopts a tagged machine of a live chat when its kv record was lost", async () => {
    const f = fakeProvider({ 4: ours("alive", "stopped") });
    const { c, kvNow } = chats(f);
    await c.reconcile({ chats: [{ id: "alive" }] });
    expect(f.machines.has(4)).toBe(true);
    expect(kvNow()["chat:alive"]).toMatchObject({ id: 4 });
  });

  it("queues a second machine for a chat that already has one as a stray", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped"), 5: ours("c1", "stopped") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) });
    await c.reconcile({ chats: ["c1"] });
    expect(kvNow()["chat:c1"]).toMatchObject({ id: 2 });
    expect(f.machines.has(2)).toBe(true);
    expect(f.machines.has(5)).toBe(false); // recorded, then destroyed by the same sweep
  });

  it("leaves the other instance's machines alone", async () => {
    const f = fakeProvider({ 1: { chatId: "livechat", instance: "otherinstance", status: "running" } });
    await chats(f).c.reconcile({ chats: [] });
    expect(f.machines.get(1)?.status).toBe("running");
    expect(changing(f.calls)).toEqual([]);
  });

  it("destroys a machine no terminal has used for destroyUnusedDays, though its chat lives on", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { c } = chats(f, { instance: INSTANCE, "chat:c1": rec(2, { lastUsedAt: Date.now() - 8 * 86_400_000 }) });
    await c.reconcile({ chats: ["c1"] });
    expect(f.machines.has(2)).toBe(false);
  });

  it("starts the unused clock at upgrade for a record that predates it", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": { id: 2, createdAt: 1 } });
    await c.reconcile({ chats: ["c1"] });
    expect(f.machines.has(2)).toBe(true);
    expect((kvNow()["chat:c1"] as { lastUsedAt: number }).lastUsedAt).toBeGreaterThan(Date.now() - 5_000);
  });

  it("does nothing at all until the provider is configured", async () => {
    const f = fakeProvider({ 2: ours("gone") });
    f.state.configured = false;
    await chats(f, { instance: INSTANCE, "chat:gone": rec(2) }).c.reconcile({ chats: [] });
    expect(f.calls).toEqual([]);
  });
});

describe("onShutdown", () => {
  it("stop: releases each running machine, and only through the provider", async () => {
    const f = fakeProvider({ 2: ours("c1"), 3: ours("c2", "stopped") });
    const { c } = chats(f, { instance: INSTANCE, "chat:c1": rec(2), "chat:c2": rec(3) });
    await c.onShutdown({ reason: "stop", deadline: Date.now() + 5_000 });
    expect(changing(f.calls)).toEqual(["release 2"]);
  });

  it("uninstall: destroys every machine this instance made, and only those", async () => {
    const f = fakeProvider({
      1: { chatId: "theirs", instance: "otherinstance", status: "running" },
      2: ours("c1"),
      4: ours("lostrecord", "stopped"),
    });
    const { c, kvNow } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) });
    await c.onShutdown({ reason: "uninstall", deadline: Date.now() + 5_000 });
    expect([...f.machines.keys()]).toEqual([1]);
    expect(Object.keys(kvNow()).filter((k) => k.startsWith("chat:") || k.startsWith("destroy:"))).toEqual([]);
  });

  it("restart: touches no machine", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { c } = chats(f, { instance: INSTANCE, "chat:c1": rec(2) });
    await c.onShutdown({ reason: "restart", deadline: Date.now() + 5_000 });
    expect(f.calls).toEqual([]);
  });
});

describe("races", () => {
  it("an idle stop decided before a new spawn does not stop the machine under it", async () => {
    const f = fakeProvider();
    const { c, kvNow } = chats(f, { instance: INSTANCE }, { idleStopMinutes: 0 });
    await c.spawn(spawnInfo()).catch(() => {});
    const id = (kvNow()["chat:c1"] as { id: number }).id;
    const idle = c.onChatIdle({ chatId: "c1" });
    const spawn = c.spawn(spawnInfo("two")).catch(() => {});
    await Promise.all([idle, spawn]);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.machines.get(id)?.status).toBe("running");
  });

  it("an instance id is minted once and kept", async () => {
    const f = fakeProvider();
    const { c, kvNow } = chats(f, {});
    const [a, b] = await Promise.all([c.instanceId(), c.instanceId()]);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(b).toBe(a);
    expect(kvNow().instance).toBe(a);
  });
});
