/**
 * HostLink against a scripted machine: how it finds the machine, what it
 * installs, and what it reports, through connects, drops and failures.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalBackendStatusInput } from "@dispatch/plugin-sdk";
import type { HostConfig } from "../src/hosts.js";
import { CONTROL_EXECS, HostLink, SESSIONS_PER_CONNECTION, describeConnectError, statusFrom, type LinkTiming } from "../src/link.js";
import { AGENT, FakeMachine, PROBE, fakeRuntime, type AddressBehaviour, type FakeConn } from "./fake-machine.js";

const HOST: HostConfig = {
  slug: "cvx-mac",
  label: "CVX Mac",
  user: "dispatch",
  addresses: ["cvx-mac.lan", "10.0.10.16"],
  port: 22,
  hostKey: "SHA256:vH2I6HOzQ1J5PJs3HVEiIEM6IMfqsUr64kEVGUbAvrc",
  hostKeyType: "ssh-ed25519",
  keyFingerprint: "SHA256:rv7Q7s4pS26oiq0AK+3b++kytycm2xzKpoQJ9q+RxH8",
  allowFrom: ["10.0.4.1"],
  pairedAt: "2026-11-01T00:00:00.000Z",
};

const links: HostLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.dispose();
});

function link(
  machine: FakeMachine,
  opts: { key?: string | undefined; kv?: Map<string, unknown>; runtime?: ReturnType<typeof fakeRuntime>; timing?: Partial<LinkTiming> } = {},
) {
  const statuses: TerminalBackendStatusInput[] = [];
  const warns: string[] = [];
  const kvMap = opts.kv ?? new Map<string, unknown>();
  const runtime = opts.runtime ?? fakeRuntime();
  const l = new HostLink(HOST, {
    instanceId: "11111111-2222-3333-4444-555555555555",
    privateKey: async () => ("key" in opts ? opts.key : "PRIVATE"),
    agent: AGENT,
    runtime,
    setStatus: (s) => statuses.push(s),
    log: { info: () => {}, warn: (m: string) => void warns.push(m), error: () => {} },
    kv: {
      get: async <T>(k: string) => kvMap.get(k) as T | undefined,
      set: async (k: string, v: unknown) => void kvMap.set(k, v),
      delete: async (k: string) => void kvMap.delete(k),
      list: async () => [...kvMap.keys()],
    },
    connect: machine.connect,
    timing: { tickMs: 10, helloEveryMs: 40, probeEveryMs: 60_000, backoffMs: [20], ...opts.timing },
  });
  links.push(l);
  return { l, statuses, warns, kv: kvMap, runtime };
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const machine = (a: Record<string, AddressBehaviour>) => new FakeMachine(a);

describe("finding the machine", () => {
  it("skips an address that answers with another host key, and never trusts it", async () => {
    const m = machine({ "cvx-mac.lan": "wrong-key", "10.0.10.16": "ok" });
    const { l, statuses } = link(m);
    l.start();
    const linked = await l.ready();
    expect(linked.address).toBe("10.0.10.16");
    // Every attempt pinned the key AND the key type.
    for (const t of m.targets) {
      expect(t.algorithms?.serverHostKey).toEqual(["ssh-ed25519"]);
      expect(t.hostVerifier).toBeTypeOf("function");
      expect(t.password).toBeUndefined();
    }
    expect(statuses[0]).toEqual({ state: "degraded", detail: "connecting" });
    expect(statuses.at(-1)?.state).toBe("online");
  });

  it("tries the address that worked last time first", async () => {
    const m = machine({ "cvx-mac.lan": "timeout", "10.0.10.16": "ok" });
    const kv = new Map<string, unknown>([["host:cvx-mac", { lastAddress: "10.0.10.16" }]]);
    const { l } = link(m, { kv });
    l.start();
    await l.ready();
    expect(m.targets.map((t) => t.host)).toEqual(["10.0.10.16"]);
  });

  it("is offline with each address's reason when none answers, and tries again after a backoff", async () => {
    const m = machine({ "cvx-mac.lan": "refused", "10.0.10.16": "timeout" });
    const { l, statuses } = link(m);
    l.start();
    await expect(l.ready()).rejects.toThrow(/cvx-mac.lan: connection refused.*10\.0\.10\.16: no answer/);
    await until(() => statuses.some((s) => s.state === "offline"));
    const tries = m.targets.length;
    await until(() => m.targets.length > tries);
    m.addresses["10.0.10.16"] = "ok";
    await until(() => statuses.at(-1)?.state === "online");
  });

  it("says the key was refused rather than that the machine is down", async () => {
    expect(describeConnectError(new Error("All configured authentication methods failed"))).toMatch(/key was refused/);
    const m = machine({ "cvx-mac.lan": "bad-key", "10.0.10.16": "bad-key" });
    const { l } = link(m);
    await expect(l.ready()).rejects.toThrow(/key was refused/);
  });

  it("is offline, and says to pair again, without its key", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l } = link(m, { key: undefined });
    await expect(l.ready()).rejects.toThrow(/REMOTE_HOST_KEY_CVX_MAC secret is missing/);
    expect(m.targets).toEqual([]);
  });
});

describe("installing", () => {
  it("sends the pinned runtime and the agent when they are missing, over stdin, and verifies the agent runs", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    m.node = undefined;
    m.agent = undefined;
    const { l, runtime } = link(m);
    await l.ready();
    expect(runtime.calls).toBe(1);
    expect(m.stdin.map((s) => s.data)).toEqual([runtime.bytes, AGENT.source]);
    expect(m.commands.some((c) => /dispatch-host.mjs' '?version'?$/.test(c))).toBe(true);
  });

  it("sends nothing when the right versions are there", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l, runtime } = link(m);
    await l.ready();
    expect(runtime.calls).toBe(0);
    expect(m.stdin).toEqual([]);
  });

  it("never downgrades a newer runtime someone else installed", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    m.node = "v25.1.0";
    const { l, runtime } = link(m);
    await l.ready();
    expect(runtime.calls).toBe(0);
  });

  it("sweeps this instance's orphans, says hello, and probes on every connect", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l } = link(m);
    await l.ready();
    const agentCmds = m.commands.filter((c) => c.includes("dispatch-host.mjs'")).map((c) => c.split("dispatch-host.mjs' ")[1]);
    expect(agentCmds).toEqual([
      "'sweep' '--instance' '11111111-2222-3333-4444-555555555555'",
      "'hello' '--instance' '11111111-2222-3333-4444-555555555555'",
      "'probe'",
    ]);
    expect(l.probe?.os.version).toBe("13.5");
  });
});

describe("staying up", () => {
  it("goes offline when the connection drops, and comes back by itself", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l, statuses } = link(m);
    l.start();
    await l.ready();
    m.open()[0]!.close();
    expect(statuses.at(-1)).toMatchObject({ state: "offline", detail: "connection lost; reconnecting" });
    await until(() => statuses.at(-1)?.state === "online");
    expect(m.open()).toHaveLength(1);
  });

  it("drops a link whose hello goes unanswered", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l, statuses } = link(m);
    l.start();
    await l.ready();
    m.helloFails = true;
    await until(() => statuses.some((s) => s.state === "offline" && /no answer/.test(s.detail ?? "")));
  });

  it("reconnects when how to reach the machine changes, not when its label does", async () => {
    const m = machine({ "10.0.10.16": "ok", "cvx-mac.local": "ok" });
    const { l } = link(m);
    await l.ready();
    l.update({ ...HOST, label: "Garage Mac" }, false);
    expect(m.open()).toHaveLength(1);
    l.update({ ...HOST, addresses: ["cvx-mac.local"] }, true);
    await until(() => l.address === "cvx-mac.local");
  });
});

describe("shells", () => {
  it("go on their own connections, eight to each, so the control connection always has room", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l } = link(m);
    await l.ready();
    const control = m.open()[0]!;
    const chans = await Promise.all(Array.from({ length: 12 }, (_, i) => l.openSession(`exec shell ${i}`)));
    expect(chans).toHaveLength(12);
    expect(l.sessionConnections).toBe(2);
    expect(control.live()).toBe(0);
    const pool = m.open().filter((c) => c !== control);
    expect(pool.map((c) => c.live()).sort()).toEqual([4, SESSIONS_PER_CONNECTION]);
    // Each extra connection pins the machine's key like the first.
    for (const c of pool) {
      expect(c.target.host).toBe("10.0.10.16");
      expect(c.target.hostVerifier).toBeTypeOf("function");
      expect(c.target.algorithms?.serverHostKey).toEqual(["ssh-ed25519"]);
    }
    await expect(l.agent(["hello"])).resolves.toBeTruthy();
  });

  it("reuse room a closed shell left, and an idle extra connection is closed", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l } = link(m, { timing: { idleSessionConnectionMs: 30 } });
    l.start();
    await l.ready();
    const chans = await Promise.all(Array.from({ length: SESSIONS_PER_CONNECTION }, () => l.openSession("exec shell")));
    (chans[0] as unknown as { close(): void }).close();
    await l.openSession("exec shell");
    expect(l.sessionConnections).toBe(1);
    for (const c of m.open()) for (const ch of c.channels) ch.close();
    await until(() => l.sessionConnections === 0);
    expect(m.open()).toHaveLength(1);
  });

  it("have their directories made a few at a time, so a burst of spawns never hits sshd's limit", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l } = link(m);
    await l.ready();
    const control = m.open()[0]!;
    const made = await Promise.all(Array.from({ length: 20 }, (_, i) => l.exec(`mkdir -p /chats/${i}`)));
    expect(made.every((r) => r.code === 0)).toBe(true);
    expect(control.peak).toBeGreaterThan(1);
    expect(control.peak).toBeLessThanOrEqual(CONTROL_EXECS);
  });

  it("are refused, not left waiting, while the machine is offline", async () => {
    const m = machine({ "10.0.10.16": "refused" });
    const { l } = link(m);
    await expect(l.openSession("exec shell")).rejects.toThrow(/connection refused/);
  });
});

describe("races", () => {
  it("throws away a connect that finishes after the settings changed", async () => {
    const m = machine({ "10.0.10.16": "ok", "cvx-mac.local": "ok" });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    m.hold = (a) => (a === "10.0.10.16" ? held : Promise.resolve());
    const { l, statuses } = link(m);
    const stale = l.ready();
    stale.catch(() => {});
    l.update({ ...HOST, addresses: ["cvx-mac.local"] }, true);
    await until(() => l.address === "cvx-mac.local");
    release();
    await expect(stale).rejects.toThrow(/settings changed/);
    expect(l.address).toBe("cvx-mac.local");
    expect(m.conns.filter((c: FakeConn) => c.target.host === "10.0.10.16" && c.isOpen)).toEqual([]);
    expect(statuses.at(-1)?.state).toBe("online");
  });

  it("Check probes a live machine without dropping its connection", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l } = link(m);
    await l.ready();
    const conn = m.open()[0]!;
    const made = m.conns.length;
    m.probe = { ...PROBE, freeDiskBytes: 1024 ** 3 };
    const s = await l.checkNow();
    expect(s).toMatchObject({ state: "degraded", detail: "low disk: 1.0 GB free" });
    expect(conn.isOpen).toBe(true);
    expect(m.conns).toHaveLength(made);
  });

  it("keeps the link when the control connection is full, rather than calling the machine gone", async () => {
    const m = machine({ "10.0.10.16": "ok" });
    const { l, statuses, warns } = link(m);
    l.start();
    await l.ready();
    m.maxSessions = 0;
    await until(() => warns.some((w) => /could not open a channel/.test(w)));
    expect(m.open()).toHaveLength(1);
    expect(statuses.at(-1)?.state).toBe("online");
  });
});

describe("statusFrom", () => {
  it("is online when nothing is wrong, degraded with the reason otherwise", () => {
    expect(statusFrom(PROBE, 5)).toEqual({ state: "online", lastSeenAt: 5 });
    expect(statusFrom({ ...PROBE, freeDiskBytes: 2 * 1024 ** 3 }, 5)).toEqual({ state: "degraded", detail: "low disk: 2.0 GB free", lastSeenAt: 5 });
    expect(statusFrom({ ...PROBE, tools: { ...PROBE.tools, git: null } }, 5).detail).toBe("git not found");
  });
});
