/**
 * What a machine is told when a chat goes idle or is deleted, when Dispatch
 * reconciles after a restart, and when the plugin is uninstalled: the
 * registry against a scripted machine, driven the way core drives it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import type { HostConfig } from "../src/hosts.js";
import { HostRegistry } from "../src/registry.js";
import { AGENT, FakeMachine, PROBE, fakeRuntime, type AddressBehaviour } from "./fake-machine.js";

const INSTANCE = "inst-1";
const ADDR = "10.0.10.16";
const HOST: HostConfig = {
  slug: "studio",
  label: "Studio",
  user: "dispatch",
  addresses: [ADDR],
  port: 22,
  hostKey: `SHA256:${"a".repeat(43)}`,
  hostKeyType: "ssh-ed25519",
  keyFingerprint: `SHA256:${"b".repeat(43)}`,
  allowFrom: ["10.0.4.1"],
  pairedAt: "2026-11-04T00:00:00.000Z",
};

const registries: HostRegistry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose();
});

const until = async (cond: () => boolean, ms = 5_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(opts: { address?: AddressBehaviour; kv?: Record<string, unknown>; previous?: string } = {}) {
  const m = new FakeMachine({ [ADDR]: opts.address ?? "ok" });
  const t = createTestContext({
    id: "remote-host",
    secrets: { REMOTE_HOST_KEY_STUDIO: "PRIVATE" },
    instance: { id: INSTANCE },
    kv: opts.kv ?? {},
  });
  const r = new HostRegistry({
    ctx: t.ctx,
    instanceId: INSTANCE,
    ...(opts.previous ? { previousInstanceId: opts.previous } : {}),
    agent: AGENT,
    runtime: fakeRuntime(),
    connect: m.connect,
    timing: { tickMs: 10, helloEveryMs: 1_000, backoffMs: [20] },
  });
  r.sync([HOST]);
  registries.push(r);
  const connected = () => until(() => !!r.get("studio")?.link.connected, 5_000, "the link");
  /** The chats dispatch-host was told to forget, in order. */
  const forgot = () => m.commands.filter((c) => c.includes("'forget'")).map((c) => c.match(/'--chat' '([^']+)'/)?.[1] ?? (c.includes("'--all'") ? "*all*" : "?"));
  return { m, t, r, connected, forgot };
}

describe("a deleted chat", () => {
  it("costs nothing on a machine it never ran on, even one that is off", async () => {
    const { t, forgot } = setup({ address: "refused" });
    await expect(t.terminals.chatDeleted("chat-1")).resolves.toBeUndefined();
    expect(forgot()).toEqual([]);
  });

  it("is forgotten there, and its records here go", async () => {
    const { t, connected, forgot } = setup({ kv: { "served:studio:chat-1": { at: 1 }, "sync:chat-1": { v: 1 }, "served:studio:chat-2": { at: 1 } } });
    await connected();
    await t.terminals.chatDeleted("chat-1");
    expect(forgot()).toEqual(["chat-1"]);
    expect([...t.kv.keys()].filter((k) => k.startsWith("served:") || k.startsWith("sync:"))).toEqual(["served:studio:chat-2"]);
    // Core may retry a delete; the machine's side is idempotent, and here nothing is left to do.
    await t.terminals.chatDeleted("chat-1");
    expect(forgot()).toEqual(["chat-1"]);
  });

  it("is refused while the machine can't be reached, and goes the moment it is back, ahead of core's retry", async () => {
    const { m, t, forgot, connected } = setup({ address: "refused", kv: { "served:studio:chat-1": { at: 1 } } });
    await expect(t.terminals.chatDeleted("chat-1")).rejects.toThrow(/refused/);
    expect(t.kv.has("served:studio:chat-1")).toBe(true);
    expect(forgot()).toEqual([]);
    m.addresses[ADDR] = "ok";
    // No retry from core (its next is a minute away, then 5, 15, 60): the reconnect itself forgets it.
    await connected();
    await until(() => !t.kv.has("served:studio:chat-1"), 5_000, "the delete on reconnect");
    expect(forgot()).toEqual(["chat-1"]);
    // Core's retry, when it comes, finds nothing left to do.
    await t.terminals.chatDeleted("chat-1");
    expect(forgot()).toEqual(["chat-1"]);
  });

  it("is not forgotten on reconnect when the machine was up and refused it (core's retry has that)", async () => {
    const { m, t, forgot, connected } = setup({ kv: { "served:studio:chat-1": { at: 1 } } });
    await connected();
    // Up, but forget itself fails (dispatch-host exits non-zero): nothing to wait for a reconnect for.
    const run = m.run.bind(m);
    m.run = async (command, opts) => (command.includes("'forget'") ? { code: 1, stdout: "", stderr: "boom" } : run(command, opts));
    await expect(t.terminals.chatDeleted("chat-1")).rejects.toThrow(/forget exited 1: boom/);
    m.run = run;
    // A reconnect doesn't forget it on its own.
    m.open()[0]!.close();
    await connected();
    await new Promise((r) => setTimeout(r, 100));
    expect(forgot()).toEqual([]);
    expect(t.kv.has("served:studio:chat-1")).toBe(true);
  });
});

describe("a deleted chat, when git won't run there", () => {
  it("is refused with dispatch-host's reason, keeping its records, so core retries until git works", async () => {
    const { m, t, connected, forgot } = setup({ kv: { "served:studio:chat-1": { at: 1 }, "sync:chat-1": { v: 1 } } });
    await connected();
    m.forgetFails = "p.git: You have not agreed to the Xcode license agreements.";
    await expect(t.terminals.chatDeleted("chat-1")).rejects.toThrow(/forget exited 1: .*Xcode license/);
    expect(t.kv.has("served:studio:chat-1")).toBe(true);
    expect(t.kv.has("sync:chat-1")).toBe(true);
    m.forgetFails = undefined;
    await t.terminals.chatDeleted("chat-1");
    expect(forgot()).toEqual(["chat-1", "chat-1"]);
    expect(t.kv.has("served:studio:chat-1")).toBe(false);
  });
});

describe("an idle chat", () => {
  it("has its sessions there ended, its checkout kept", async () => {
    const { m, t, connected, forgot } = setup({ kv: { "served:studio:chat-1": { at: 1 } } });
    await connected();
    await t.terminals.chatIdle("chat-1");
    expect(m.commands.filter((c) => c.includes("'kill'") && c.includes("'--chat' 'chat-1'"))).toHaveLength(1);
    expect(forgot()).toEqual([]);
    await t.terminals.chatIdle("chat-other");
    expect(m.commands.filter((c) => c.includes("'chat-other'"))).toEqual([]);
  });
});

describe("reconcile", () => {
  it("forgets chats deleted while Dispatch wasn't listening: by record, and by an old directory; never a live or new one", async () => {
    const now = Date.now();
    const { m, t, r, connected, forgot } = setup({
      kv: { "served:studio:gone-1": { at: 1 }, "served:studio:live": { at: 1 } },
    });
    m.chatDirs = [
      { chat: "gone-2", mtimeMs: now - 3_600_000 },
      { chat: "live", mtimeMs: now - 3_600_000 },
      // Made around the listing (a chat started since): never an orphan, record or not.
      { chat: "brand-new", mtimeMs: now - 60_000 },
    ];
    await connected();
    r.reconcile(new Set(["live"]), now);
    await until(() => forgot().length === 2, 5_000, "two forgets");
    expect(forgot().sort()).toEqual(["gone-1", "gone-2"]);
    expect(t.kv.has("served:studio:gone-1")).toBe(false);
    expect(t.kv.has("served:studio:live")).toBe(true);
  });

  it("goes on past an orphan it can't forget, and tries that one again at the next connect", async () => {
    const { m, t, r, connected, forgot } = setup({ kv: { "served:studio:bad": { at: 1 }, "served:studio:good": { at: 1 } } });
    await connected();
    const run = m.run.bind(m);
    m.run = async (command, opts) =>
      command.includes("'forget'") && command.includes("'bad'") ? { code: 1, stdout: "", stderr: "p.git: git won't run" } : run(command, opts);
    r.reconcile(new Set(), Date.now());
    await until(() => forgot().includes("good"), 5_000, "the good orphan");
    expect(t.kv.has("served:studio:good")).toBe(false);
    expect(t.kv.has("served:studio:bad")).toBe(true);
    // git works again; the next connect finishes the pass.
    m.run = run;
    m.open()[0]!.close();
    await connected();
    await until(() => forgot().includes("bad"), 5_000, "the bad orphan, retried");
    expect(t.kv.has("served:studio:bad")).toBe(false);
  });

  it("waits for a machine that is off, and cleans up once it is back", async () => {
    const { m, r, forgot } = setup({ address: "refused", kv: { "served:studio:gone": { at: 1 } } });
    r.reconcile(new Set(), Date.now());
    await new Promise((res) => setTimeout(res, 100));
    expect(forgot()).toEqual([]);
    m.addresses[ADDR] = "ok";
    await until(() => forgot().length === 1, 5_000, "the forget after reconnecting");
    expect(forgot()).toEqual(["gone"]);
  });
});

describe("uninstall", () => {
  it("has every reachable machine forget this instance, and only this one", async () => {
    const { r, connected, forgot, m } = setup();
    await connected();
    await r.forgetAll(2_000);
    expect(forgot()).toEqual(["*all*"]);
    expect(m.commands.find((c) => c.includes("'forget'"))).toContain(`'--instance' '${INSTANCE}'`);
  });
});

describe("the previous instance id", () => {
  it("shows what this Dispatch left there under its old id, and nothing for any other instance", async () => {
    const { m, r, connected } = setup({ previous: "old-id" });
    m.probe = {
      ...PROBE,
      instances: [
        { id: "old-id", contactAt: 1_700_000_000_000, running: 2 },
        { id: INSTANCE, contactAt: Date.now(), running: 0 },
        { id: "the-other-dispatch", contactAt: Date.now(), running: 3 },
      ],
    };
    await connected();
    expect(r.list()[0]!.abandoned).toEqual({ id: "old-id", contactAt: 1_700_000_000_000, running: 2 });
  });

  it("shows nothing when the id never changed", async () => {
    const { m, r, connected } = setup();
    m.probe = { ...PROBE, instances: [{ id: "old-id", contactAt: 1, running: 0 }] };
    await connected();
    expect(r.list()[0]!.abandoned).toBeUndefined();
  });
});
