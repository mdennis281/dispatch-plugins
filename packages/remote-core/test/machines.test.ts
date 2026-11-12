/**
 * MachineLifecycle on its own: what a plugin that hands its machines to
 * someone else to run things on (proxmox-terminal 0.2, through remote-host)
 * relies on — records that keep the caller's fields, leases that win against
 * stops, a busy check it injects, a TTL it can veto per record, and `destroy:`
 * rows from an older version that are revived when their chat still exists.
 * The paths shared with RemoteChats (idle, destroy retries, adoption,
 * shutdown) are in lifecycle.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { MachineLifecycle, type ChatRecord, type DetachReason, type LeaseChat, type MachineLifecycleOptions } from "../src/index.js";
import { INSTANCE, fakeProvider, rec, type Machine, type Ref } from "./fakes.js";

const ours = (chatId: string, status: Machine["status"] = "running"): Machine => ({ chatId, instance: INSTANCE, status });
const DAY = 86_400_000;
const MARKER = "migrated-destroys";

function life(
  f: ReturnType<typeof fakeProvider>,
  kv: Record<string, unknown> = { instance: INSTANCE },
  extra: Partial<MachineLifecycleOptions<Ref>> & { idleStopMinutes?: number; destroyUnusedDays?: number } = {},
) {
  const t = createTestContext({ id: "test-life", kv });
  const detached: Array<[string, DetachReason]> = [];
  const { idleStopMinutes = 30, destroyUnusedDays = 7, ...rest } = extra;
  const l = new MachineLifecycle<Ref>({
    provider: f.provider,
    kv: t.ctx.kv,
    log: t.ctx.log,
    policy: () => ({ idleStopMinutes, destroyUnusedDays }),
    detach: (chatId, why) => void detached.push([chatId, why]),
    ...rest,
  });
  return { l, t, detached, kvNow: () => Object.fromEntries(t.kv) as Record<string, unknown> };
}

/** A bring-up that makes or starts the chat's machine through the fake provider, the way a real one would. */
const up = (f: ReturnType<typeof fakeProvider>) => async (chat: LeaseChat<Ref>) => {
  await f.provider.bringUp(chat, new AbortController().signal);
};

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

describe("records keep the caller's fields", () => {
  const extra = { layout: 2, machine: "2:1700000000000", rescue: [{ D: "repo", ref: "refs/dispatch/rescue/x" }] };

  it("an idle stop, a lease and a touch keep fields the lifecycle does not know", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "chat:c1": rec(2, extra) }, { idleStopMinutes: 0 });
    await l.start(); // no deadline, not leased here → boot stop
    expect(f.machines.get(2)?.status).toBe("stopped");
    expect(kvNow()["chat:c1"]).toMatchObject(extra);
    await l.lease("c1", up(f));
    expect(kvNow()["chat:c1"]).toMatchObject(extra);
    await l.touch("c1");
    await l.onChatIdle({ chatId: "c1" });
    await new Promise((r) => setTimeout(r, 50)); // the 0-minute idle stop fires
    expect(f.machines.get(2)?.status).toBe("stopped");
    expect(kvNow()["chat:c1"]).toMatchObject({ ...extra, id: 2 });
  });

  it("hands the stored record, caller fields included, to the bring-up", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l } = life(f, { instance: INSTANCE, "chat:c1": rec(2, extra) });
    const seen = await l.lease("c1", async (chat) => chat.record);
    expect(seen).toMatchObject({ id: 2, ...extra });
  });

  it("a new machine starts a fresh record: the old machine's fields do not carry over", async () => {
    const f = fakeProvider({ 2: ours("someone-else", "stopped") }); // c1's vmid now holds another chat's machine
    const { l, kvNow } = life(f, { instance: INSTANCE, "chat:c1": rec(2, { ...extra, createdAt: 5 }) });
    await l.lease("c1", up(f));
    const after = kvNow()["chat:c1"] as ChatRecord<Ref> & Record<string, unknown>;
    expect(after.id).not.toBe(2);
    expect(after.layout).toBeUndefined();
    expect(after.rescue).toBeUndefined();
    expect(after.createdAt).toBeGreaterThan(5);
  });

  it("patch merges into the record, and drops a write for a machine the chat no longer has", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "chat:c1": rec(2) });
    expect(await l.patch("c1", { layout: 2 }, { id: 2 })).toBe(true);
    expect(await l.patch("c1", { layout: 9 }, { id: 3 })).toBe(false);
    expect(await l.patch("nochat", { layout: 9 })).toBe(false);
    expect(kvNow()["chat:c1"]).toMatchObject({ id: 2, layout: 2 });
    expect(kvNow()["chat:nochat"]).toBeUndefined();
  });

  it("concurrent patches and lifecycle writes lose nothing", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "chat:c1": rec(2) });
    await Promise.all([
      l.patch("c1", { a: 1 }),
      l.onChatIdle({ chatId: "c1" }),
      l.patch("c1", { b: 2 }),
      l.touch("c1"),
      l.patch("c1", { c: 3 }),
    ]);
    expect(kvNow()["chat:c1"]).toMatchObject({ id: 2, a: 1, b: 2, c: 3 });
    expect((kvNow()["chat:c1"] as ChatRecord<Ref>).idleDeadline).toBeGreaterThan(Date.now());
  });
});

describe("lease", () => {
  it("bumps lastUsedAt and clears an idle deadline", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "chat:c1": rec(2, { lastUsedAt: 1, idleDeadline: Date.now() + 60_000 }) });
    await l.lease("c1", up(f));
    const r = kvNow()["chat:c1"] as ChatRecord<Ref>;
    expect(r.lastUsedAt).toBeGreaterThan(Date.now() - 5_000);
    expect(r.idleDeadline).toBeUndefined();
    expect(f.machines.get(2)?.status).toBe("running");
  });

  it("a boot sweep racing a lease in flight does not stop the machine", async () => {
    const f = fakeProvider({ 2: ours("c1") }); // running, no deadline: what a crash leaves
    const { l } = life(f, { instance: INSTANCE, "chat:c1": rec(2) });
    const g = gate();
    const leased = l.lease("c1", async (chat) => {
      await g.p;
      return up(f)(chat);
    });
    await new Promise((r) => setTimeout(r, 10));
    const boot = l.start();
    await new Promise((r) => setTimeout(r, 10));
    g.open();
    await Promise.all([leased, boot]);
    expect(f.machines.get(2)?.status).toBe("running");
    expect(f.calls.filter((c) => c.startsWith("stop"))).toEqual([]);
  });

  it("a later boot-style sweep (reconcile) leaves a machine leased by this process alone", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l } = life(f, { instance: INSTANCE, "chat:c1": rec(2) });
    await l.lease("c1", up(f));
    await l.reconcile({ chats: ["c1"] });
    expect(f.machines.get(2)?.status).toBe("running");
  });

  it("an idle stop decided before a lease is dropped", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l } = life(f, { instance: INSTANCE, "chat:c1": rec(2) }, { idleStopMinutes: 0 });
    await l.lease("c1", up(f));
    await l.onChatIdle({ chatId: "c1" }); // arms a 0 ms stop under the current generation
    await l.lease("c1", up(f)); // bumps it
    await new Promise((r) => setTimeout(r, 50));
    expect(f.machines.get(2)?.status).toBe("running");
  });

  it("detaches before a stop, and before a destroy", async () => {
    const f = fakeProvider({ 2: ours("c1"), 3: ours("c2") });
    const { l, detached } = life(f, { instance: INSTANCE, "chat:c1": rec(2, { idleDeadline: Date.now() - 1 }), "chat:c2": rec(3) });
    await l.start();
    await l.onChatDeleted({ chatId: "c2" });
    expect(detached).toEqual(expect.arrayContaining([["c1", "stop"], ["c2", "destroy"]]));
  });
});

describe("busy and the unused TTL", () => {
  const stale = (extra: Record<string, unknown> = {}) => rec(2, { lastUsedAt: Date.now() - 8 * DAY, ...extra });

  it("a long-running chat is not TTL-destroyed while the injected busy says so", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    let running = true;
    const { l } = life(f, { instance: INSTANCE, "chat:c1": stale() }, { busy: () => running });
    await l.reconcile({ chats: ["c1"] });
    expect(f.machines.has(2)).toBe(true);
    expect(f.machines.get(2)?.status).toBe("running"); // not boot-stopped either
    running = false;
    await l.sweep();
    expect(f.machines.has(2)).toBe(false);
  });

  it("a busy check that throws counts as busy", async () => {
    const f = fakeProvider({ 2: ours("c1") });
    const { l } = life(f, { instance: INSTANCE, "chat:c1": stale() }, {
      busy: () => {
        throw new Error("remote-host revoked");
      },
    });
    await l.reconcile({ chats: ["c1"] });
    expect(f.machines.get(2)?.status).toBe("running");
  });

  it("a touch restarts the unused clock", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "chat:c1": stale() });
    await l.patch("c1", {}); // loads the chat
    await l.touch("c1");
    await l.sweep();
    expect(f.machines.has(2)).toBe(true);
    expect((kvNow()["chat:c1"] as ChatRecord<Ref>).lastUsedAt).toBeGreaterThan(Date.now() - 5_000);
  });

  it("mayExpire vetoes the TTL per record — but not a deleted chat, nor a chat that no longer exists", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped"), 3: ours("c2", "stopped"), 4: ours("c3", "stopped"), 5: ours("c4", "stopped") });
    const { l, kvNow } = life(
      f,
      {
        instance: INSTANCE,
        "chat:c1": stale(), // legacy: no layout
        "chat:c2": { ...stale({ layout: 2 }), id: 3 },
        "chat:c3": { ...stale(), id: 4 },
        "chat:c4": { ...stale(), id: 5 },
      },
      { mayExpire: (r) => r.layout === 2 },
    );
    await l.reconcile({ chats: ["c1", "c2", "c3"] });
    expect(f.machines.has(2)).toBe(true); // legacy, unused 8 days: kept
    expect(f.machines.has(3)).toBe(false); // new layout, unused: destroyed
    expect(f.machines.has(5)).toBe(false); // chat gone: destroyed, legacy or not
    expect(kvNow()["chat:c1"]).toBeDefined();
    await l.onChatDeleted({ chatId: "c3" });
    expect(f.machines.has(4)).toBe(false); // chat deleted: destroyed, legacy or not
  });
});

describe("reviving destroys an older version queued for live chats", () => {
  const opts = { reviveLiveDestroys: { marker: MARKER } };
  const row = (id: number, chatId: string) => ({ chatId, id, attempts: 2, nextAt: 0, lastError: "unreachable" });

  it("turns a live chat's destroy row back into its record, and destroys a dead chat's", async () => {
    const f = fakeProvider({ 2: ours("live", "stopped"), 3: ours("dead", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "destroy:2": row(2, "live"), "destroy:3": row(3, "dead") }, opts);
    await l.reconcile({ chats: ["live"] });
    expect(f.machines.has(2)).toBe(true);
    expect(f.machines.has(3)).toBe(false);
    const k = kvNow();
    expect(k["destroy:2"]).toBeUndefined();
    expect(k["destroy:3"]).toBeUndefined();
    expect(k["chat:live"]).toMatchObject({ id: 2 });
    expect((k["chat:live"] as ChatRecord<Ref>).lastUsedAt).toBeGreaterThan(Date.now() - 5_000);
    expect(k[MARKER]).toBe(true);
  });

  it("the boot sweep before the first reconcile destroys nothing from the queue", async () => {
    const f = fakeProvider({ 2: ours("live", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "destroy:2": row(2, "live") }, opts);
    await l.start();
    expect(f.machines.has(2)).toBe(true);
    expect(kvNow()["destroy:2"]).toBeDefined();
    await l.reconcile({ chats: ["live"] });
    expect(f.machines.has(2)).toBe(true);
    expect(kvNow()["destroy:2"]).toBeUndefined();
  });

  it("a chat deleted before the first reconcile is still destroyed by its own delete", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l } = life(f, { instance: INSTANCE, "destroy:2": row(2, "c1") }, opts);
    await l.start();
    await l.onChatDeleted({ chatId: "c1" });
    expect(f.machines.has(2)).toBe(false);
  });

  it("a stray (the chat has another machine) is destroyed as queued", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped"), 3: ours("c1", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, "chat:c1": { ...rec(3) }, "destroy:2": row(2, "c1") }, opts);
    await l.reconcile({ chats: ["c1"] });
    expect(f.machines.has(2)).toBe(false);
    expect(f.machines.has(3)).toBe(true);
    expect(kvNow()["chat:c1"]).toMatchObject({ id: 3 });
  });

  it("runs once: after the marker, a live chat's new destroy row goes ahead", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l, kvNow } = life(f, { instance: INSTANCE, [MARKER]: true, "destroy:2": row(2, "c1") }, opts);
    await l.reconcile({ chats: ["c1"] });
    expect(f.machines.has(2)).toBe(false);
    expect(kvNow()["chat:c1"]).toBeUndefined();
  });

  it("without the option, the queue is worked from the first sweep, as before", async () => {
    const f = fakeProvider({ 2: ours("c1", "stopped") });
    const { l } = life(f, { instance: INSTANCE, "destroy:2": row(2, "c1") });
    await l.start();
    expect(f.machines.has(2)).toBe(false);
  });
});
