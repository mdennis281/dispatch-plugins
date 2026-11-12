/**
 * The machine engine on its own, with the spec a provisioned machine will
 * get (the plugin-dependencies design, §2.3): its records under a prefix of
 * its own, a paired machine's never taken or touched. And PairedBackend as
 * core's face of one engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { PairedBackend } from "../src/backend.js";
import { MachineEngine, type MachineSpec } from "../src/engine.js";
import type { HostConfig } from "../src/hosts.js";
import { HostLink } from "../src/link.js";
import { AGENT, FakeMachine, fakeRuntime } from "./fake-machine.js";

const INSTANCE = "inst-1";
const ADDR = "10.0.4.7";
const HOST: HostConfig = {
  slug: "lxc-101",
  label: "LXC 101",
  user: "dispatch",
  addresses: [ADDR],
  port: 22,
  hostKey: `SHA256:${"a".repeat(43)}`,
  hostKeyType: "ssh-ed25519",
  keyFingerprint: `SHA256:${"b".repeat(43)}`,
  allowFrom: ["10.0.4.1"],
  pairedAt: "2026-11-12T00:00:00.000Z",
};
/** Where a provisioned machine's records go: `x/<caller>/<backend>/<machine>`. */
const PREFIX = "x/proxmox-terminal/proxmox-terminal/101";
const SPEC: MachineSpec = {
  backendId: "proxmox-terminal/default",
  key: "lxc-101",
  kvPrefix: PREFIX,
  adoptLegacySync: false,
  host: () => HOST,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const until = async (cond: () => boolean, ms = 5_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(kv: Record<string, unknown>) {
  const m = new FakeMachine({ [ADDR]: "ok" });
  const t = createTestContext({ id: "remote-host", instance: { id: INSTANCE }, kv });
  let engine: MachineEngine | undefined;
  const link = new HostLink(HOST, {
    instanceId: INSTANCE,
    privateKey: async () => "PRIVATE",
    agent: AGENT,
    runtime: fakeRuntime(),
    setStatus: () => {},
    onConnected: () => engine?.onConnected(),
    log: t.ctx.log,
    kv: t.ctx.kv!,
    connect: m.connect,
    timing: { tickMs: 10, helloEveryMs: 1_000, backoffMs: [20] },
  });
  engine = new MachineEngine(SPEC, { link, instanceId: INSTANCE, log: t.ctx.log, kv: t.ctx.kv! });
  cleanups.push(() => {
    engine.dispose();
    link.dispose();
  });
  link.start();
  const connected = () => until(() => link.connected, 5_000, "the link");
  const forgot = () => m.commands.filter((c) => c.includes("'forget'")).map((c) => c.match(/'--chat' '([^']+)'/)?.[1] ?? "?");
  const records = () => [...t.kv.keys()].filter((k) => /^(served|sync):/.test(k)).sort();
  return { m, t, engine, connected, forgot, records };
}

describe("a provisioned machine's engine", () => {
  it("forgets a deleted chat's records under its own prefix, and leaves a paired machine's and the old per-chat one alone", async () => {
    const paired = { "served:studio:chat-1": { at: 1 }, "sync:studio:chat-1": { v: 1 }, "sync:chat-1": { v: 1 } };
    const { engine, connected, forgot, records } = setup({
      ...paired,
      [`served:${PREFIX}:chat-1`]: { at: 1 },
      [`sync:${PREFIX}:chat-1`]: { v: 1 },
    });
    await connected();
    await engine.chatDeleted("chat-1");
    expect(forgot()).toEqual(["chat-1"]);
    expect(records()).toEqual(Object.keys(paired).sort());
  });

  it("knows a chat by its own record only", async () => {
    const { engine } = setup({ "served:studio:chat-1": { at: 1 }, [`served:${PREFIX}:chat-2`]: { at: 1 } });
    expect(await engine.knowsChat("chat-1")).toBe(false);
    expect(await engine.knowsChat("chat-2")).toBe(true);
  });

  it("takes only its own records for orphans", async () => {
    const { engine, connected, forgot, records } = setup({ "served:studio:gone-1": { at: 1 }, [`served:${PREFIX}:gone-2`]: { at: 1 } });
    await connected();
    engine.reconcile(new Set(), Date.now());
    await until(() => forgot().length === 1, 5_000, "the orphan's forget");
    await new Promise((r) => setTimeout(r, 100));
    expect(forgot()).toEqual(["gone-2"]);
    expect(records()).toEqual(["served:studio:gone-1"]);
  });
});

describe("PairedBackend", () => {
  it("is core's face of one engine: the chat events and the label go through to it", async () => {
    const engine = { label: "Studio", chatIdle: vi.fn(async () => {}), chatDeleted: vi.fn(async () => {}), dispose: vi.fn() };
    const b = new PairedBackend("remote-host/studio", engine as unknown as MachineEngine);
    expect([b.id, b.label, b.shell, b.fallback]).toEqual(["remote-host/studio", "Studio", "bash", "refuse"]);
    b.label = "Studio Mac";
    expect(engine.label).toBe("Studio Mac");
    await b.onChatIdle({ chatId: "chat-1" } as never);
    await b.onChatDeleted({ chatId: "chat-2" } as never);
    b.dispose();
    expect(engine.chatIdle).toHaveBeenCalledWith("chat-1");
    expect(engine.chatDeleted).toHaveBeenCalledWith("chat-2");
    expect(engine.dispose).toHaveBeenCalledOnce();
  });
});
