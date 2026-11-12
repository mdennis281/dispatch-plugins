/**
 * Machines another plugin provisions (`machines@1`), against a scripted
 * machine: dialled only on demand, with the lease's addresses and key; the
 * incarnation token and hostname checked before anything runs there; the
 * records a chat leaves, and the caller's lifecycle calls (idle, delete,
 * destroyed, uninstall), which never dial. Shells and sync run in
 * e2e.posix.test.ts against a real dispatch-host.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalRunInfo } from "@dispatch/plugin-sdk";
import { hostKeyFingerprint } from "@dispatch-plugins/remote-core";
import type { MachineLease, ProvisionedBackendOptions } from "@dispatch-plugins/remote-host-api";
import type { MachineEngine } from "../src/engine.js";
import { machinesCode } from "../src/machines-error.js";
import { ProvisionedMachines, checkLease } from "../src/provisioned.js";
import { FRESH_LEASE_MS, ProvisionedLink } from "../src/provisioned-link.js";
import { AGENT, FakeMachine, fakeRuntime } from "./fake-machine.js";

const ADDR = "10.0.9.1";
const SECRET = "THE-SECRET-KEY-MATERIAL";
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET}\n-----END OPENSSH PRIVATE KEY-----\n`;
const HOST_KEY = Buffer.from("the template's host key");
const PIN = hostKeyFingerprint(HOST_KEY);
const BASE = "x/proxmox-terminal/proxmox";

const until = async (cond: () => boolean, ms = 5_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
});

function setup(o: { kv?: Record<string, unknown>; lease?: Partial<MachineLease>; auth?: () => Promise<{ privateKey?: string; password?: string }> } = {}) {
  const m = new FakeMachine({ [ADDR]: "ok" });
  m.hostKey = HOST_KEY;
  m.hostname = "dt-chat";
  const map = new Map<string, unknown>(Object.entries(o.kv ?? {}));
  const kv = {
    get: async <T>(k: string) => structuredClone(map.get(k)) as T | undefined,
    set: async (k: string, v: unknown) => void map.set(k, structuredClone(v)),
    delete: async (k: string) => void map.delete(k),
    list: async (prefix = "") => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
  const logs: string[] = [];
  const log = { info: (s: string) => void logs.push(s), warn: (s: string) => void logs.push(s), error: (s: string) => void logs.push(String(s)) };
  const caller = new AbortController();
  const state = {
    lease: { machine: "9001:1", addresses: [ADDR], user: "root", hostKey: { pin: [PIN] }, hostname: "dt-chat", ...o.lease } as Partial<MachineLease>,
    provisions: [] as string[],
    authCalls: 0,
  };
  const opts: ProvisionedBackendOptions = {
    id: "proxmox",
    label: "Proxmox container",
    io: { publishPort: () => () => {} },
    provision: async (req) => {
      state.provisions.push(req.chatId);
      return {
        ...state.lease,
        auth:
          o.auth ??
          (async () => {
            state.authCalls++;
            return { privateKey: KEY };
          }),
      } as MachineLease;
    },
  };
  const pm = new ProvisionedMachines(opts, {
    callerId: "proxmox-terminal",
    signal: caller.signal,
    instanceId: "inst-1",
    log: log as never,
    kv,
    agent: AGENT,
    runtime: fakeRuntime(),
    connect: m.connect,
    timing: { tickMs: 10, helloEveryMs: 1_000, idleSessionConnectionMs: 60_000 },
  });
  disposers.push(() => pm.dispose());
  /** A chat's machine as a spawn gets it, before the shell (which needs a real dispatch-host). */
  const attach = (chatId = "chat-1") =>
    (pm as unknown as { attach(i: object): Promise<{ link: ProvisionedLink; engine: MachineEngine }> }).attach({
      chatId,
      name: "main",
      cwd: "/repo",
      signal: new AbortController().signal,
    });
  const run = (chatId = "chat-1"): TerminalRunInfo =>
    ({ chatId, terminal: "main", command: "true", cwd: "/repo", runId: `r-${Math.random()}`, background: false, signal: new AbortController().signal }) as never;
  return { m, map, kv, logs, caller, state, pm, attach, run };
}

describe("a provisioned machine's connection", () => {
  it("dials only when needed, with the lease, and marks the machine as this chat's before anything runs there", async () => {
    const { m, map, state, pm, attach } = setup();
    const slot = await attach();
    expect(m.conns).toHaveLength(0);
    await slot.link.ready();
    expect(m.commands[0]).toContain("incarnation-none");
    expect(m.commands[1]).toContain("set -C");
    expect(m.incarnation).toMatch(/^9001:1 [0-9a-f]{32}$/);
    expect(map.get(`ptoken:${BASE}/9001:1`)).toEqual({ token: m.incarnation!.split(" ")[1] });
    expect(map.get(`pchat:${BASE}:chat-1`)).toMatchObject({ machine: "9001:1" });
    expect(m.targets[0]).toMatchObject({ host: ADDR, port: 22, username: "root", privateKey: KEY });
    expect(state.authCalls).toBe(1);
    expect(pm.machines()).toEqual([{ chatId: "chat-1", machine: "9001:1", connected: true, shells: 0, running: false, address: ADDR }]);
  });

  it("runs nothing on another chat's machine answering at a stale address", async () => {
    const { m, attach } = setup({ kv: { [`ptoken:${BASE}/9001:1`]: { token: "a".repeat(32) } } });
    m.incarnation = `9002:7 ${"b".repeat(32)}`;
    const slot = await attach();
    const err = await slot.link.ready().catch((e: unknown) => e);
    expect(machinesCode(err)).toBe("wrong-machine");
    expect(String(err)).toMatch(/another chat's machine.*nothing was run there/);
    // Only the look at who answered: no install, no sweep, no session.
    expect(m.commands).toHaveLength(1);
    expect(m.open()).toEqual([]);
    expect(m.incarnation).toBe(`9002:7 ${"b".repeat(32)}`);
  });

  it("runs nothing on this incarnation's address answered with another token", async () => {
    const { m, attach } = setup({ kv: { [`ptoken:${BASE}/9001:1`]: { token: "a".repeat(32) } } });
    m.incarnation = `9001:1 ${"c".repeat(32)}`;
    const err = await (await attach()).link.ready().catch((e: unknown) => e);
    expect(machinesCode(err)).toBe("wrong-machine");
    expect(m.commands).toHaveLength(1);
  });

  it("runs nothing on a new machine at a reused address: it has no token, and this chat's machine was given one", async () => {
    const { m, attach } = setup({ kv: { [`ptoken:${BASE}/9001:1`]: { token: "a".repeat(32) } } });
    const err = await (await attach()).link.ready().catch((e: unknown) => e);
    expect(machinesCode(err)).toBe("wrong-machine");
    expect(String(err)).toMatch(/no incarnation token/);
    expect(m.incarnation).toBeUndefined();
    expect(m.commands).toHaveLength(1);
  });

  it("takes the machine's word for its token when the record here was lost, for this incarnation only", async () => {
    const { m, map, attach } = setup();
    m.incarnation = `9001:1 ${"d".repeat(32)}`;
    await (await attach()).link.ready();
    expect(map.get(`ptoken:${BASE}/9001:1`)).toEqual({ token: "d".repeat(32) });
  });

  it("checks the hostname the lease gives, short or full", async () => {
    const wrong = setup({ lease: { hostname: "dt-other" } });
    const err = await (await wrong.attach()).link.ready().catch((e: unknown) => e);
    expect(machinesCode(err)).toBe("wrong-machine");
    expect(String(err)).toMatch(/hostname is "dt-chat", not "dt-other"/);
    expect(wrong.m.incarnation).toBeUndefined();

    const full = setup({ lease: { hostname: "dt-chat.lan" } });
    await (await full.attach()).link.ready();
    expect(full.pm.machines()[0]!.connected).toBe(true);
  });

  it("says host-key-mismatch for a key the lease doesn't pin, and unreachable when nothing answers", async () => {
    const other = setup({ lease: { hostKey: { pin: [hostKeyFingerprint(Buffer.from("another key"))] } } });
    const e1 = await (await other.attach()).link.ready().catch((e: unknown) => e);
    expect(machinesCode(e1)).toBe("host-key-mismatch");

    const off = setup({ lease: { addresses: ["10.0.9.99"] } });
    const e2 = await (await off.attach()).link.ready().catch((e: unknown) => e);
    expect(machinesCode(e2)).toBe("unreachable");
    expect(String(e2)).toMatch(/10\.0\.9\.99: no answer/);
  });

  it("trusts the provisioner's word for the key when told to, and still checks the token", async () => {
    const { m, attach } = setup({ lease: { hostKey: { trust: "provisioner" } } });
    m.hostKey = Buffer.from("whatever key the clone has");
    await (await attach()).link.ready();
    expect(m.incarnation).toMatch(/^9001:1 /);
  });

  it("sends a password only to a pinned key", async () => {
    const trusted = setup({ lease: { hostKey: { trust: "provisioner" } }, auth: async () => ({ password: "hunter2" }) });
    const err = await (await trusted.attach()).link.ready().catch((e: unknown) => e);
    expect(machinesCode(err)).toBe("bad-lease");
    expect(trusted.m.conns).toHaveLength(0);

    const pinned = setup({ auth: async () => ({ password: "hunter2" }) });
    await (await pinned.attach()).link.ready();
    expect(pinned.m.targets[0]).toMatchObject({ password: "hunter2" });
    expect(pinned.m.targets[0]!.privateKey).toBeUndefined();
  });

  it("stays down when the connection drops, until something needs the machine, which provisions again", async () => {
    const { m, state, attach } = setup();
    const slot = await attach();
    await slot.link.ready();
    expect(state.provisions).toHaveLength(1);
    m.open()[0]!.close();
    expect(slot.link.connected).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(state.provisions).toHaveLength(1);
    expect(m.conns).toHaveLength(1);
    await slot.link.ready();
    expect(state.provisions).toHaveLength(2);
    expect(slot.link.connected).toBe(true);
    // The same incarnation: its token read back, not written again.
    expect(m.commands.filter((c) => c.includes("set -C"))).toHaveLength(1);
  });

  it("refuses to dial again when the provisioner has made the machine anew under the chat", async () => {
    const { m, state, attach } = setup();
    const slot = await attach();
    await slot.link.ready();
    m.open()[0]!.close();
    state.lease = { ...state.lease, machine: "9001:2" };
    await expect(slot.link.ready()).rejects.toThrow(/made again.*open the terminal again/);
  });

  it("asks again after a drop, even when another spawn provisioned while it was up", async () => {
    const { m, state, attach } = setup();
    const slot = await attach();
    await slot.link.ready();
    // A second terminal: provisioned, but the connection it would have used is already up.
    await attach();
    await slot.link.ready();
    expect(state.provisions).toHaveLength(2);
    m.open()[0]!.close();
    // The machine was stopped since, say: only the provisioner starts it and says where it is.
    await slot.link.ready();
    expect(state.provisions).toHaveLength(3);
  });

  it("uses a spawn's lease only for the connect right after it", async () => {
    const m = new FakeMachine({ [ADDR]: "ok" });
    m.hostKey = HOST_KEY;
    m.hostname = "dt-chat";
    let clock = 1_000_000;
    let provisions = 0;
    const lease = { machine: "9001:1", addresses: [ADDR], user: "root", hostKey: { pin: [PIN] }, auth: async () => ({ privateKey: KEY }) } as MachineLease;
    let token: string | undefined;
    const link = new ProvisionedLink("9001:1", {
      instanceId: "inst-1",
      label: "Proxmox container",
      agent: AGENT,
      runtime: fakeRuntime(),
      log: { info: () => {}, warn: () => {}, error: () => {} } as never,
      provision: async () => {
        provisions++;
        return lease;
      },
      token: { get: async () => token, set: async (t) => void (token = t) },
      connect: m.connect,
      timing: { tickMs: 10, helloEveryMs: 1_000, idleSessionConnectionMs: 60_000 },
      now: () => clock,
    });
    disposers.push(async () => link.dispose());
    link.use(lease);
    await link.ready();
    expect(provisions).toBe(0);
    link.close();
    // A spawn that provisioned, then failed before dialling: its lease goes stale.
    link.use(lease);
    clock += FRESH_LEASE_MS;
    await link.ready();
    expect(provisions).toBe(1);
    // Closing drops one not yet used: what it named may be gone with the connection.
    link.use(lease);
    link.close();
    await link.ready();
    expect(provisions).toBe(2);
  });
});

describe("leases", () => {
  const ok = { machine: "9001:1", addresses: [ADDR], user: "root", auth: async () => ({ privateKey: KEY }), hostKey: { pin: [PIN] } };

  it("are checked before anything is dialled", () => {
    expect(checkLease(ok)).toMatchObject({ machine: "9001:1", addresses: [ADDR], user: "root", hostKey: { pin: [PIN] } });
    const bad = (l: unknown, why: RegExp) => {
      let err: unknown;
      try {
        checkLease(l);
      } catch (e) {
        err = e;
      }
      expect(machinesCode(err)).toBe("bad-lease");
      expect(String(err)).toMatch(why);
    };
    bad(null, /isn't an object/);
    bad({ ...ok, machine: "" }, /machine/);
    bad({ ...ok, machine: "has space" }, /machine/);
    bad({ ...ok, addresses: [] }, /addresses/);
    bad({ ...ok, addresses: ["10.0.0.1; rm -rf /"] }, /addresses/);
    bad({ ...ok, port: 70_000 }, /port/);
    bad({ ...ok, user: "root; id" }, /user/);
    bad({ ...ok, auth: "key" }, /auth/);
    bad({ ...ok, hostKey: { pin: ["not a fingerprint"] } }, /pin/);
    bad({ ...ok, hostKey: { trust: "anyone" } }, /hostKey/);
    bad({ ...ok, hostname: "a b" }, /hostname/);
  });
});

describe("a provisioned machine's lifecycle, as its caller drives it", () => {
  it("starts afresh on a machine made again: the old one's records go, and the next command says so once", async () => {
    const old = `${BASE}/9001:1`;
    const { map, pm, attach, run } = setup({
      lease: { machine: "9001:2" },
      kv: {
        [`pchat:${BASE}:chat-1`]: { machine: "9001:1", at: 1 },
        [`served:${old}:chat-1`]: { at: 1 },
        [`sync:${old}:chat-1`]: { v: 1 },
        [`ptoken:${old}`]: { token: "a".repeat(32) },
      },
    });
    await attach();
    expect([...map.keys()].filter((k) => k.includes("9001:1"))).toEqual([`ptoken:${old}`]);
    expect(map.get(`pchat:${BASE}:chat-1`)).toMatchObject({ machine: "9001:2" });
    const first = await pm.beforeRun(run());
    expect(first.notices).toEqual([
      "[Proxmox container] this chat's machine was made again: what was installed or built on the old one is gone, and your files go to the new one",
    ]);
    expect((await pm.beforeRun(run())).notices).toBeUndefined();
  });

  it("shows the lease's notices once, with the next command's result", async () => {
    const { pm, attach, run } = setup({ lease: { notices: ["restored from a snapshot"] } });
    await attach();
    expect((await pm.beforeRun(run())).notices).toEqual(["[Proxmox container] restored from a snapshot"]);
    expect((await pm.beforeRun(run())).notices).toBeUndefined();
  });

  it("ends an idle chat's sessions there and closes the connection; a stopped machine is never dialled for it", async () => {
    const up = setup();
    await (await up.attach()).link.ready();
    // What a spawn there records first.
    up.map.set(`served:${BASE}/9001:1:chat-1`, { at: 1 });
    await up.pm.endChat("chat-1");
    expect(up.m.commands.some((c) => c.includes("'kill'") && c.includes("'--chat' 'chat-1'"))).toBe(true);
    expect(up.m.open()).toEqual([]);
    expect(up.pm.machines()).toEqual([]);

    const down = setup();
    await down.attach();
    await down.pm.endChat("chat-1");
    expect(down.m.conns).toHaveLength(0);
    expect(down.state.provisions).toHaveLength(1);
  });

  it("forgets a deleted chat here only, never contacting the machine", async () => {
    const { m, map, pm, attach } = setup();
    await (await attach()).link.ready();
    map.set(`served:${BASE}/9001:1:chat-1`, { at: 1 });
    map.set(`sync:${BASE}/9001:1:chat-1`, { v: 1 });
    const ran = m.commands.length;
    const conns = m.conns.length;
    await pm.forgetChat("chat-1");
    expect(m.commands).toHaveLength(ran);
    expect(m.conns).toHaveLength(conns);
    expect([...map.keys()]).toEqual([`ptoken:${BASE}/9001:1`]);
    expect(pm.machines()).toEqual([]);
  });

  it("forgets every chat on a destroyed machine, and its token", async () => {
    const { map, pm, attach } = setup();
    await (await attach("chat-1")).link.ready();
    await (await attach("chat-2")).link.ready();
    map.set(`sync:${BASE}/9001:1:chat-2`, { v: 1 });
    map.set(`pchat:${BASE}:chat-3`, { machine: "9009:1", at: 1 });
    await pm.machineGone("9001:1");
    expect([...map.keys()]).toEqual([`pchat:${BASE}:chat-3`]);
    expect(pm.machines()).toEqual([]);
  });

  it("forgets everything this backend kept on uninstall, and nothing of anyone else's", async () => {
    const others = {
      "served:cvx-mac:chat-1": { at: 1 },
      "sync:cvx-mac:chat-1": { v: 1 },
      "pchat:x/other-plugin/box:chat-9": { machine: "m", at: 1 },
      "sync:x/proxmox-terminal/proxmox2/9:chat-1": { v: 1 },
    };
    const { map, pm, attach } = setup({ kv: others });
    await (await attach()).link.ready();
    map.set(`sync:${BASE}/9001:1:chat-1`, { v: 1 });
    await pm.forgetAll();
    expect(Object.fromEntries(map)).toEqual(others);
  });

  it("never keeps, logs or says the key", async () => {
    const { m, map, logs, pm, attach } = setup();
    await (await attach()).link.ready();
    await pm.endChat("chat-1");
    await (await attach()).link.ready();
    // A connect that fails says why, not with what.
    m.addresses[ADDR] = "bad-key";
    m.open().forEach((c) => c.close());
    const err = await (await attach()).link.ready().catch((e: unknown) => e);
    expect(String(err)).not.toContain(SECRET);
    await pm.forgetChat("chat-1");
    const everything = JSON.stringify([...map.entries()]) + logs.join("\n") + JSON.stringify(pm.machines());
    expect(everything).not.toContain(SECRET);
  });

  it("ends what it made for a caller that went away, and serves it nothing more", async () => {
    const { m, caller, pm, attach } = setup();
    await (await attach()).link.ready();
    caller.abort();
    await until(() => m.open().length === 0, 2_000, "the connection to close");
    const err = await attach().catch((e: unknown) => e);
    expect(machinesCode(err)).toBe("revoked");
    expect(pm.machines()).toEqual([]);
  });
});
