/**
 * The Safari lease is kept while the chat holding it has a run in flight
 * here (core E28, `ctx.terminals.runs`), and said to lapse when this Dispatch
 * can't tell.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import type { GuiAgentStatus } from "@dispatch-plugins/host-agent";
import type { HostConfig } from "../src/hosts.js";
import { HostRegistry } from "../src/registry.js";
import { AGENT, FakeMachine, PROBE, fakeRuntime } from "./fake-machine.js";

const INSTANCE = "inst-1";
const ADDR = "10.0.4.5";
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

const AGENT_STATUS: GuiAgentStatus = {
  agentVersion: "0.4.0",
  protocol: 1,
  pid: 42,
  startedAt: "2026-11-06T00:00:00.000Z",
  build: "0.4.0-abcdef012345",
  session: { user: "dispatch", onConsole: true, screenLocked: false },
  dialogs: [],
  simulators: { usable: true },
  runs: 0,
  sims: 0,
  safari: { instance: INSTANCE, chat: "chat-1", port: 4444, since: "2026-11-06T00:00:00.000Z", expiresAt: "2026-11-06T00:30:00.000Z" },
  silentForMs: 0,
};

type Run = { runId: string; chatId: string; backend: string };

const registries: HostRegistry[] = [];
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose();
});

const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** `runs`: what core's E28 reports; undefined for a Dispatch from before it. */
async function setup(runs: Run[] | undefined) {
  const m = new FakeMachine({ [ADDR]: "ok" });
  m.probe = { ...PROBE, gui: { state: "running", agent: AGENT_STATUS } };
  const t = createTestContext({ id: "remote-host", secrets: { REMOTE_HOST_KEY_STUDIO: "PRIVATE" }, instance: { id: INSTANCE } });
  const asked: Array<{ backend?: string }> = [];
  if (runs) {
    (t.ctx.terminals as unknown as { runs: (f?: { backend?: string }) => Run[] }).runs = (f) => {
      asked.push(f ?? {});
      return runs.filter((r) => !f?.backend || r.backend === f.backend);
    };
  }
  const r = new HostRegistry({ ctx: t.ctx, instanceId: INSTANCE, agent: AGENT, runtime: fakeRuntime(), connect: m.connect, timing: { tickMs: 10, helloEveryMs: 1_000, backoffMs: [20] } });
  r.sync([HOST]);
  registries.push(r);
  await until(() => !!r.get("studio")?.link.connected && !!r.get("studio")?.link.probe);
  const renews = () => m.commands.filter((c) => c.includes("'gui' 'renew'")).map((c) => c.match(/'--chats' '([^']+)'/)?.[1]);
  const warns = () => t.log.filter((l) => l.level === "warn").map((l) => l.message);
  return { m, r, backend: r.get("studio")!.backend!, renews, asked, warns };
}

describe("the Safari lease", () => {
  it("is renewed for the chats with a run in flight on this machine, and only this one", async () => {
    const { backend, renews, asked } = await setup([
      { runId: "a", chatId: "chat-1", backend: "remote-host/studio" },
      { runId: "b", chatId: "chat-1", backend: "remote-host/studio" },
      { runId: "c", chatId: "chat-2", backend: "remote-host/studio" },
      { runId: "d", chatId: "chat-3", backend: "local" },
      { runId: "e", chatId: "chat-4", backend: "remote-host/other" },
    ]);
    await backend.keepLeases();
    expect(asked.length).toBeGreaterThan(0);
    expect(renews()).toEqual(["chat-1,chat-2"]);
  });

  it("isn't asked about when nothing runs there", async () => {
    const { backend, renews } = await setup([{ runId: "d", chatId: "chat-3", backend: "local" }]);
    await backend.keepLeases();
    expect(renews()).toEqual([]);
  });

  it("says once that it will lapse mid-test on a Dispatch without runs in flight (before E28)", async () => {
    const { backend, renews, warns } = await setup(undefined);
    await backend.keepLeases();
    await backend.keepLeases();
    expect(renews()).toEqual([]);
    expect(warns().filter((w) => /ctx\.terminals\.runs, core E28/.test(w))).toHaveLength(1);
  });
});
