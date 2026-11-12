/**
 * Unit tests — no Proxmox, no SSH, no Dispatch, no remote-host. Proxmox's API,
 * remote-host's `machines@1` and core's `ctx.dependencies` are faked at the
 * seams `BackendDeps` exposes (test/fakes.ts). What runs on the machine is
 * remote-host's, tested there; the rescue of pre-0.2 checkouts is in
 * legacy-rescue.posix.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import plugin from "../src/server.js";
import { hostnameFor } from "../src/backend.js";
import { NEEDS_NEWER_DISPATCH } from "../src/remote-host-link.js";
import { readSettings } from "../src/settings.js";
import { INSTANCE, fakeDependencies, fakeProxmox, fakeRemoteHost, ours, rec, terminal } from "./fakes.js";

const spawnInfo = (chatId = "c1", signal = new AbortController().signal) => ({
  chatId,
  name: "main",
  cwd: "/w/repo",
  worktreePath: "/w/repo",
  repoPath: "/w/repo",
  signal,
});
const run = (chatId = "c1") => ({ runId: "r1", chatId, terminal: "main", command: "ls", cwd: "/w/repo", background: false, signal: new AbortController().signal });

describe("helpers", () => {
  it("makes DNS-safe hostnames", () => {
    expect(hostnameFor("aizKrtGZkh-aaPtvwa_4a")).toBe("dt-aizkrtgzkhaaptvw");
  });

  it("reads settings over defaults, coercing numbers", () => {
    const s = readSettings({ cores: "4", insecureTls: true, apiUrl: " https://pve:8006 " });
    expect(s).toMatchObject({ cores: 4, insecureTls: true, apiUrl: "https://pve:8006", templateVmid: 9000, templateHostKey: "" });
  });
});

describe("with remote-host", () => {
  it("first spawn: clones a free vmid, sizes and starts it, and hands remote-host a lease to connect with", async () => {
    const f = fakeProxmox({ 9001: ours("someone-else", "stopped") });
    const { b, rh, kvNow } = terminal(f);
    const h = await b.forwarder.spawn(spawnInfo());
    expect(h).toBeDefined();
    expect(f.calls).toContain("POST /nodes/g/lxc/9000/clone newid=9002");
    expect(f.calls).toContain("PUT /nodes/g/lxc/9002/config");
    expect(f.calls).toContain("POST /nodes/g/lxc/9002/status/start");
    const recd = kvNow()["chat:c1"] as { vmid: number; createdAt: number; layout: number; machine: string };
    expect(recd).toMatchObject({ vmid: 9002, layout: 2, machine: `9002:${recd.createdAt}` });
    const lease = rh.leases[0]!;
    expect(lease).toMatchObject({
      machine: `9002:${recd.createdAt}`,
      addresses: ["10.0.12.200"],
      user: "root",
      hostKey: { trust: "provisioner" },
      hostname: "dt-c1",
      notices: [],
    });
    expect(await lease.auth()).toEqual({ privateKey: "k", password: undefined });
    expect(JSON.stringify(kvNow())).not.toContain('"k"'); // the key is never kept
  });

  it("pins the template's host key when it is set", async () => {
    const f = fakeProxmox();
    const { b, rh } = terminal(f, undefined, { templateHostKey: "SHA256:abc" });
    await b.forwarder.spawn(spawnInfo());
    expect(rh.leases[0]!.hostKey).toEqual({ pin: ["SHA256:abc"] });
  });

  it("registers with the caller's id and io, and forwards beforeRun, touching the unused clock", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b, rh, kvNow } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002, { layout: 2, lastUsedAt: 1 }) });
    expect(rh.st.options).toMatchObject({ id: "proxmox", label: "Proxmox container" });
    await b.forwarder.spawn(spawnInfo());
    (kvNow()["chat:c1"] as { lastUsedAt: number }).lastUsedAt = 1;
    expect(await b.forwarder.beforeRun(run())).toEqual({ notices: ["synced"] });
    expect(rh.calls).toContain("beforeRun c1");
    expect((kvNow()["chat:c1"] as { lastUsedAt: number }).lastUsedAt).toBeGreaterThan(Date.now() - 5_000);
  });

  it("idle: remote-host ends the chat's sessions, then the container stops; delete: it forgets, then the container goes", async () => {
    const f = fakeProxmox();
    const { b, rh, kvNow } = terminal(f, undefined, { idleStopMinutes: 0 });
    await b.forwarder.spawn(spawnInfo());
    const machine = (kvNow()["chat:c1"] as { machine: string }).machine;
    await b.forwarder.onChatIdle({ chatId: "c1" });
    await new Promise((r) => setTimeout(r, 50));
    expect(rh.calls).toContain("endChat c1");
    expect(f.cts.get(9001)?.status).toBe("stopped");
    await b.forwarder.onChatDeleted({ chatId: "c1" });
    expect(rh.calls).toContain("forgetChat c1");
    expect(rh.calls).toContain(`machineGone ${machine}`);
    expect(f.cts.has(9001)).toBe(false);
    expect(kvNow()["chat:c1"]).toBeUndefined();
  });

  it("a chat with a shell or a run on remote-host is busy: no TTL destroy, no boot stop", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const rh = fakeRemoteHost();
    rh.machines.set("c1", { chatId: "c1", machine: "9002:1", connected: true, shells: 0, running: true });
    const { b } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002, { layout: 2, lastUsedAt: Date.now() - 30 * 86_400_000 }) }, {}, { rh });
    await b.reconcile({ chats: ["c1"] });
    expect(f.cts.get(9002)?.status).toBe("running");
    rh.machines.clear();
    await b.sweep();
    expect(f.cts.has(9002)).toBe(false);
  });

  it("uninstall: remote-host forgets this plugin's machines, then every clone goes", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b, rh } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    await b.onShutdown({ reason: "uninstall", deadline: Date.now() + 5_000 });
    expect(rh.calls[0]).toBe("forgetAll");
    expect(f.cts.has(9002)).toBe(false);
  });

  it("an agent note is remote-host's machine part plus proxmox's lifecycle lines", async () => {
    const { b } = terminal(fakeProxmox());
    const note = b.forwarder.agentNote({ chatId: "c1" })!;
    expect(note).toContain("remote-host's machine part");
    expect(note).toContain("per-chat Proxmox container");
    expect(note).not.toContain("/root/work");
  });

  it("refuses loudly with no API URL or token, so Dispatch can say why", async () => {
    const t = terminal(fakeProxmox(), undefined, { apiUrl: "" });
    await expect(t.b.forwarder.spawn(spawnInfo())).rejects.toThrow(/no API URL/);
    expect(t.b.status()).toMatchObject({ state: "offline", detail: expect.stringContaining("not set up") });
  });
});

describe("pre-0.2 containers", () => {
  it("a legacy record is rescued once at its first spawn, then marked layout 2", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    let connects = 0;
    const { b, kvNow } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002) }, {}, {
      rescueRemote: async () => {
        connects++;
        return { exec: async () => ({ code: 0, stdout: "", stderr: "" }), pipe: async () => ({ code: 0, stderr: "" }) };
      },
    });
    await b.forwarder.spawn(spawnInfo());
    await b.forwarder.spawn(spawnInfo());
    expect(connects).toBe(1);
    expect(kvNow()["chat:c1"]).toMatchObject({ vmid: 9002, layout: 2, rescue: [] });
    expect(kvNow()["rescue:chat1"]).toBeUndefined();
    expect(kvNow()["rescue:c1"]).toMatchObject({ phase: "done" });
  });

  it("a rescue still running refuses the spawn with its progress; it keeps going, and the next spawn uses its result", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { b, kvNow } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002) }, {}, {
      rescueRemote: async () => {
        await gate;
        return { exec: async () => ({ code: 0, stdout: "", stderr: "" }), pipe: async () => ({ code: 0, stderr: "" }) };
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50); // the spawn's own budget runs out
    await expect(b.forwarder.spawn(spawnInfo("c1", ac.signal))).rejects.toThrow(/rescuing the old container.*run the command again/);
    expect(b.rescue.running("c1")).toBe(true);
    expect((kvNow()["chat:c1"] as { layout?: number }).layout).toBeUndefined();
    release();
    await new Promise((r) => setTimeout(r, 20));
    await b.forwarder.spawn(spawnInfo());
    expect(kvNow()["chat:c1"]).toMatchObject({ layout: 2 });
  });

  it("a failed rescue refuses the spawn with the reason and leaves the container as it is", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b, kvNow } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002) }, {}, {
      rescueRemote: async () => {
        throw new Error("ssh: handshake failed");
      },
    });
    await expect(b.forwarder.spawn(spawnInfo())).rejects.toThrow(/handshake failed.*attempt 1/);
    expect(f.cts.has(9002)).toBe(true);
    expect((kvNow()["chat:c1"] as { layout?: number }).layout).toBeUndefined();
  });
});

describe("refusing mode", () => {
  it("on a core without plugin dependencies: refuses with the reason, and still destroys a deleted chat's container", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b, kvNow } = terminal(f, { instance: INSTANCE, "chat:c1": rec(9002) }, {}, { deps: null });
    expect(b.status()).toEqual({ state: "offline", detail: NEEDS_NEWER_DISPATCH });
    await expect(b.forwarder.spawn(spawnInfo())).rejects.toThrow(/needs a newer Dispatch/);
    expect(await b.forwarder.beforeRun(run())).toEqual({ refuse: NEEDS_NEWER_DISPATCH });
    expect(b.forwarder.agentNote({ chatId: "c1" })).toContain("refused right now");
    await b.forwarder.onChatDeleted({ chatId: "c1" }); // resolves: no cleanup row
    expect(f.cts.has(9002)).toBe(false);
    expect(kvNow()["destroy:9002"]).toBeUndefined();
  });

  it("names why for a remote-host that is switched off, missing, or too old", async () => {
    const rh = fakeRemoteHost();
    for (const [state, want] of [
      ["disabled", /switched off/],
      ["missing", /not installed/],
      ["incompatible", /machines v1\) \(has 0\.9\.2\)\. Update/],
    ] as const) {
      const { b } = terminal(fakeProxmox(), undefined, {}, { deps: fakeDependencies(rh, state, state === "incompatible" ? "has 0.9.2" : undefined).deps });
      await expect(b.forwarder.spawn(spawnInfo())).rejects.toThrow(want);
    }
  });

  it("lost mid-run: refuses from then on, says so, and keeps managing containers", async () => {
    const f = fakeProxmox();
    const rh = fakeRemoteHost();
    const d = fakeDependencies(rh);
    const { b, changes } = terminal(f, undefined, { idleStopMinutes: 0 }, { rh, deps: d.deps });
    await b.forwarder.spawn(spawnInfo());
    d.lose("disabled");
    rh.revoke();
    expect(changes()).toBe(1);
    expect(b.status()).toMatchObject({ state: "offline", detail: expect.stringContaining("switched off") });
    await expect(b.forwarder.spawn(spawnInfo())).rejects.toThrow(/switched off/);
    await b.forwarder.onChatIdle({ chatId: "c1" });
    await new Promise((r) => setTimeout(r, 50));
    expect(f.cts.get(9001)?.status).toBe("stopped"); // the Proxmox lifecycle never stops
  });

  it("a call that went inert under us (revoked, not yet lost) is refused, never handed back as a shell", async () => {
    const rh = fakeRemoteHost();
    const { b } = terminal(fakeProxmox(), undefined, {}, { rh });
    rh.revoke();
    await expect(b.forwarder.spawn(spawnInfo())).rejects.toThrow(/went away/);
  });
});

describe("activate", () => {
  it("registers the proxmox backend first, with fallback refuse — refusing on a core without dependencies", async () => {
    const t = createTestContext({ id: "proxmox-terminal", capabilities: ["terminals", "secrets", "kv"] });
    await plugin.activate(t.ctx);
    expect([...t.terminalBackends.keys()]).toEqual(["proxmox"]);
    expect(t.terminalBackends.get("proxmox")).toMatchObject({ label: "Proxmox container", shell: "bash", fallback: "refuse" });
    expect(t.terminalStatus.get("proxmox")).toMatchObject({ state: "offline" });
    await plugin.deactivate?.();
  });

  it("goes online through ctx.dependencies when remote-host is there", async () => {
    const t = createTestContext({
      id: "proxmox-terminal",
      capabilities: ["terminals", "secrets", "kv"],
      settings: { apiUrl: "https://pve:8006", node: "g" },
    });
    Object.assign(t.ctx, { dependencies: fakeDependencies(fakeRemoteHost()).deps });
    await plugin.activate(t.ctx);
    expect(t.terminalStatus.get("proxmox")).toMatchObject({ state: "online" });
    await plugin.deactivate?.();
  });
});

describe("cleanup hooks on the module", () => {
  it("exposes onShutdown and reconcile beside activate, and they are no-ops before setup", async () => {
    const t = createTestContext({ id: "proxmox-terminal", capabilities: ["terminals", "secrets", "kv"] });
    await plugin.activate(t.ctx);
    const mod = plugin as unknown as {
      onShutdown(e: unknown): Promise<void>;
      reconcile(e: unknown): Promise<void>;
    };
    const signal = new AbortController().signal;
    await mod.reconcile({ chats: [], deadline: Date.now() + 1_000, signal });
    await mod.onShutdown({ reason: "restart", deadline: Date.now() + 1_000, signal });
    await plugin.deactivate?.();
  });
});

describe("the committed bundle", () => {
  // The URL installer copies server/index.js as-is, so it must load on its own
  // as an ES module — this caught ssh2's `__dirname` reference, which only
  // failed once the bundle was loaded from a plugin directory.
  it("imports and activates outside the source tree", async () => {
    // @ts-expect-error -- the built bundle ships no .d.ts; its shape is asserted here.
    const mod = (await import("../server/index.js")) as {
      default: { activate(ctx: unknown): unknown; onShutdown?: unknown; reconcile?: unknown };
    };
    const t = createTestContext({ id: "proxmox-terminal", capabilities: ["terminals", "secrets", "kv"] });
    await mod.default.activate(t.ctx);
    expect([...t.terminalBackends.keys()]).toEqual(["proxmox"]);
    expect(typeof mod.default.onShutdown).toBe("function");
    expect(typeof mod.default.reconcile).toBe("function");
  });

  it("inlines no remote-host code: its only way in is ctx.dependencies", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
    expect(src).not.toContain("dispatch-host session");
    expect(src).toContain("dependencies");
  });
});
