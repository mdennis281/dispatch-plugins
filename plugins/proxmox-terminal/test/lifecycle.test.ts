/**
 * Cleanup lifecycle — what has to hold across a Dispatch restart, a Proxmox
 * outage and a chat that is gone. Proxmox is a stateful fake (containers with
 * a status and a config), so "it was stopped" and "it was never touched" are
 * claims about that state, not about which calls were made.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { ProxmoxTerminalBackend, describe as describeClone } from "../src/backend.js";
import { ProxmoxError, type Proxmox } from "../src/proxmox.js";
import { readSettings } from "../src/settings.js";
import type { SshConnection } from "../src/ssh.js";

interface Ct {
  status: "running" | "stopped";
  hostname: string;
  description?: string;
  template?: number;
}

function fakeProxmox(initial: Record<number, Ct> = {}) {
  const cts = new Map<number, Ct>(Object.entries(initial).map(([k, v]) => [Number(k), { ...v }]));
  const calls: string[] = [];
  const state = { down: false, waited: 0 };
  const call = async (method: string, path: string, params: Record<string, unknown> = {}) => {
    if (state.down) throw new ProxmoxError(`Proxmox API unreachable (pve:8006): connect ECONNREFUSED`);
    calls.push(`${method} ${path}`);
    // Like the real token: no Pool.Audit, so only /cluster/resources lists the pool.
    if (path.startsWith("/pools/")) throw new ProxmoxError("Permission check failed (/pool/dispatch-terminals, Pool.Audit)", 403);
    if (path === "/cluster/resources") {
      return [
        ...[...cts.keys()].map((vmid) => ({ vmid, type: "lxc", pool: "dispatch-terminals" })),
        { vmid: 9050, type: "lxc" }, // outside the pool: never listed as ours
        { vmid: 115, type: "qemu", pool: "dispatch-terminals" },
      ];
    }
    const m = path.match(/^\/nodes\/g\/lxc\/(\d+)(\/.*)?$/);
    if (!m) return null;
    const vmid = Number(m[1]);
    const rest = m[2] ?? "";
    if (rest === "/clone") {
      cts.set(Number(params.newid), { status: "stopped", hostname: String(params.hostname), description: String(params.description) });
      return "UPID:clone";
    }
    const ct = cts.get(vmid);
    if (!ct) throw new ProxmoxError(`Configuration file 'nodes/g/lxc/${vmid}.conf' does not exist`, 500);
    if (rest === "/config") return method === "GET" ? { hostname: ct.hostname, description: ct.description, template: ct.template } : null;
    if (rest === "/status/current") return { status: ct.status };
    if (rest === "/status/start") {
      ct.status = "running";
      return "UPID:start";
    }
    if (rest === "/status/shutdown" || rest === "/status/stop") {
      ct.status = "stopped";
      return "UPID:stop";
    }
    if (method === "DELETE" && rest === "") {
      if (ct.status === "running" && !params.force) throw new ProxmoxError("CT is running", 500);
      cts.delete(vmid);
      return "UPID:destroy";
    }
    return null;
  };
  const api = {
    call,
    waitTask: async () => {
      if (state.down) throw new ProxmoxError("Proxmox API unreachable");
      state.waited++;
    },
    ipv4: async () => "10.0.12.200",
    status: async (_n: string, vmid: number) => {
      try {
        return ((await call("GET", `/nodes/g/lxc/${vmid}/status/current`)) as { status: string }).status;
      } catch (err) {
        if (/does not exist/.test(String(err))) return undefined;
        throw err;
      }
    },
  } as unknown as Proxmox;
  return { api, cts, calls, state };
}

function fakeConn(): SshConnection {
  return Object.assign(new EventEmitter(), {
    isOpen: true,
    connect: async () => {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    run: async () => "",
    shell: async () =>
      Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} }, kill() {} }),
    forward: async () => ({ localPort: 45000, close: () => {} }),
    close() {
      (this as { isOpen: boolean }).isOpen = false;
    },
  }) as unknown as SshConnection;
}

const INSTANCE = "abc123abc123";

/** A backend over `kv` — pass the previous run's kv to simulate a Dispatch restart. */
function backend(
  f: ReturnType<typeof fakeProxmox>,
  kv: Record<string, unknown> = { instance: INSTANCE },
  settings: Record<string, unknown> = {},
) {
  const t = createTestContext({ id: "proxmox-terminal", kv });
  const b = new ProxmoxTerminalBackend({
    ctx: t.ctx,
    kv: t.ctx.kv,
    settings: () => readSettings({ apiUrl: "https://pve:8006", node: "g", ...settings }),
    token: async () => "u@pve!t=x",
    sshAuth: async () => ({ privateKey: "k" }),
    proxmox: () => f.api,
    connect: () => fakeConn(),
  });
  return { b, t, kvNow: () => Object.fromEntries(t.kv) as Record<string, unknown> };
}

const ours = (chatId: string, status: Ct["status"] = "running"): Ct => ({
  status,
  hostname: `dt-${chatId}`,
  description: describeClone(chatId, INSTANCE),
});
const rec = (vmid: number, extra: Record<string, unknown> = {}) => ({ vmid, hostname: "h", createdAt: 1, lastUsedAt: Date.now(), ...extra });
// Not a git repo, so spawn fails fast right AFTER provisioning — which is all
// these tests are about. Snapshotting a real repo costs seconds on Windows.
const notARepo = mkdtempSync(join(tmpdir(), "pt-norepo-"));
afterAll(() => rmSync(notARepo, { recursive: true, force: true }));
const spawnInfo = (name = "main") => ({ chatId: "c1", name, cwd: notARepo, signal: new AbortController().signal });
const changing = (calls: string[]) => calls.filter((c) => /^DELETE|status\/(stop|shutdown|start)/.test(c));

describe("idle stop survives a restart", () => {
  it("stops a container whose persisted idle deadline passed while Dispatch was down", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002, { idleDeadline: Date.now() - 1_000 }) });
    await b.start();
    expect(f.cts.get(9002)?.status).toBe("stopped");
  });

  it("leaves one with an unexpired deadline running, and stops it when the deadline comes", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002, { idleDeadline: Date.now() + 150 }) });
    await b.start();
    expect(f.cts.get(9002)?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 400));
    expect(f.cts.get(9002)?.status).toBe("stopped");
    expect((kvNow()["chat:c1"] as { idleDeadline?: number }).idleDeadline).toBeUndefined();
  });

  it("stops a running clone with no deadline at boot — its chat was busy when Dispatch crashed", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    await b.start();
    expect(f.cts.get(9002)?.status).toBe("stopped");
  });

  it("writes the idle deadline to kv, so a restart picks up the timer the old process held", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const one = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) }, { idleStopMinutes: 30 });
    await one.b.onChatIdle({ chatId: "c1" });
    const deadline = (one.kvNow()["chat:c1"] as { idleDeadline: number }).idleDeadline;
    expect(deadline).toBeGreaterThan(Date.now() + 29 * 60_000);
    await one.b.dispose();
    expect(f.cts.get(9002)?.status).toBe("running");
    // Restart, with the clock past the deadline as far as kv is concerned.
    const after = { ...one.kvNow(), "chat:c1": { ...(one.kvNow()["chat:c1"] as object), idleDeadline: Date.now() - 1 } };
    await backend(f, after).b.start();
    expect(f.cts.get(9002)?.status).toBe("stopped");
  });

  it("a clean shutdown gives a busy chat a deadline, so the next boot does not stop it at once", async () => {
    const f = fakeProxmox();
    const { b, kvNow } = backend(f);
    await b.spawn(spawnInfo()).catch(() => {});
    const vmid = (kvNow()["chat:c1"] as { vmid: number }).vmid;
    expect(f.cts.get(vmid)?.status).toBe("running");
    await b.onShutdown({ reason: "restart", deadline: Date.now() + 5_000 });
    expect(f.cts.get(vmid)?.status).toBe("running");
    await backend(f, kvNow()).b.start();
    expect(f.cts.get(vmid)?.status).toBe("running");
  });
});

describe("destroy retries", () => {
  it("rejects when Proxmox is unreachable, keeps the destroy pending, and finishes it after a restart", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    f.state.down = true;
    await expect(b.onChatDeleted({ chatId: "c1" })).rejects.toThrow(/unreachable/);
    expect(kvNow()["destroy:9002"]).toMatchObject({ chatId: "c1", attempts: 1 });
    expect(kvNow()["chat:c1"]).toBeUndefined();
    f.state.down = false;
    const kv = kvNow();
    (kv["destroy:9002"] as { nextAt: number }).nextAt = 0; // due
    const next = backend(f, kv);
    await next.b.start();
    expect(f.cts.has(9002)).toBe(false);
    expect(next.kvNow()["destroy:9002"]).toBeUndefined();
  });

  it("backs off between attempts", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    f.state.down = true;
    await b.onChatDeleted({ chatId: "c1" }).catch(() => {});
    expect((kvNow()["destroy:9002"] as { nextAt: number }).nextAt).toBeGreaterThan(Date.now() + 20_000);
    f.state.down = false;
    await b.sweep(); // not due yet → not attempted
    expect(f.cts.has(9002)).toBe(true);
    expect((kvNow()["destroy:9002"] as { attempts: number }).attempts).toBe(1);
  });

  it("a core retry of onChatDeleted finishes the earlier failed destroy", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    f.state.down = true;
    await b.onChatDeleted({ chatId: "c1" }).catch(() => {});
    f.state.down = false;
    await b.onChatDeleted({ chatId: "c1" });
    expect(f.cts.has(9002)).toBe(false);
    expect(kvNow()["destroy:9002"]).toBeUndefined();
  });

  it("resolves for a chat that never had a container, touching nothing", async () => {
    const f = fakeProxmox();
    await backend(f).b.onChatDeleted({ chatId: "never" });
    expect(f.calls).toEqual([]);
  });
});

describe("never touches what is not ours", () => {
  it("refuses the template, out-of-range vmids, and a vmid that now holds another chat", async () => {
    const f = fakeProxmox({
      9000: { status: "stopped", hostname: "dispatch-term-tpl", template: 1 },
      100: ours("c2"),
      9003: ours("someone-else"),
    });
    const { b } = backend(f, { instance: INSTANCE, "chat:c1": rec(9000), "chat:c2": rec(100), "chat:c3": rec(9003) });
    await b.onChatDeleted({ chatId: "c1" });
    await b.onChatDeleted({ chatId: "c2" });
    await b.onChatDeleted({ chatId: "c3" });
    expect([...f.cts.keys()].sort()).toEqual([100, 9000, 9003]);
    expect(changing(f.calls)).toEqual([]);
  });

  it("reconcile leaves the other instance's running clones alone", async () => {
    // 9001 is the stable instance's live chat; this instance never heard of it.
    const f = fakeProxmox({ 9001: { ...ours("livechat"), description: describeClone("livechat", "otherinstance") } });
    await backend(f).b.reconcile({ chats: [] });
    expect(f.cts.get(9001)?.status).toBe("running");
    expect(changing(f.calls)).toEqual([]);
  });

  it("a remembered vmid that now holds another chat is not reused by spawn", async () => {
    const f = fakeProxmox({ 9002: ours("someone-else") });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    await b.spawn(spawnInfo()).catch(() => {});
    expect((kvNow()["chat:c1"] as { vmid: number }).vmid).not.toBe(9002);
    expect(f.cts.get(9002)?.description).toContain("someone-else");
  });
});

describe("reconcile", () => {
  it("destroys clones whose chat is gone — including one whose kv record was lost — and stops idle ones", async () => {
    const f = fakeProxmox({ 9002: ours("gone"), 9003: ours("alive"), 9004: ours("lostrecord") });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:gone": rec(9002), "chat:alive": rec(9003) });
    await b.reconcile({ chats: ["alive"] });
    expect(f.cts.has(9002)).toBe(false);
    expect(f.cts.has(9004)).toBe(false);
    expect(f.cts.get(9003)?.status).toBe("stopped");
    expect(Object.keys(kvNow()).filter((k) => k.startsWith("chat:") || k.startsWith("destroy:"))).toEqual(["chat:alive"]);
  });

  it("re-adopts a tagged clone of a live chat when its kv record was lost", async () => {
    const f = fakeProxmox({ 9004: ours("alive", "stopped") });
    const { b, kvNow } = backend(f);
    await b.reconcile({ chats: [{ id: "alive" }] });
    expect(f.cts.has(9004)).toBe(true);
    expect(kvNow()["chat:alive"]).toMatchObject({ vmid: 9004 });
  });

  it("destroys a clone no terminal has used for destroyUnusedDays, though its chat lives on", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002, { lastUsedAt: Date.now() - 8 * 86_400_000 }) });
    await b.reconcile({ chats: ["c1"] });
    expect(f.cts.has(9002)).toBe(false);
  });

  it("starts the unused clock at upgrade for a record that predates it", async () => {
    const f = fakeProxmox({ 9002: ours("c1", "stopped") });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:c1": { vmid: 9002, hostname: "h", createdAt: 1 } });
    await b.reconcile({ chats: ["c1"] });
    expect(f.cts.has(9002)).toBe(true);
    expect((kvNow()["chat:c1"] as { lastUsedAt: number }).lastUsedAt).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe("onShutdown", () => {
  it("stop: asks each running clone to shut down without waiting on the tasks", async () => {
    const f = fakeProxmox({ 9002: ours("c1"), 9003: ours("c2", "stopped") });
    const { b } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002), "chat:c2": rec(9003) });
    await b.onShutdown({ reason: "stop", deadline: Date.now() + 5_000 });
    expect(changing(f.calls)).toEqual(["POST /nodes/g/lxc/9002/status/shutdown"]);
    expect(f.state.waited).toBe(0);
  });

  it("uninstall: destroys every clone this instance made, and only those", async () => {
    const f = fakeProxmox({
      9000: { status: "stopped", hostname: "tpl", template: 1 },
      9001: { ...ours("theirs"), description: describeClone("theirs", "otherinstance") },
      9002: ours("c1"),
      9004: ours("lostrecord", "stopped"),
    });
    const { b, kvNow } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    await b.onShutdown({ reason: "uninstall", deadline: Date.now() + 5_000 });
    expect([...f.cts.keys()].sort()).toEqual([9000, 9001]);
    expect(Object.keys(kvNow()).filter((k) => k.startsWith("chat:") || k.startsWith("destroy:"))).toEqual([]);
  });

  it("restart: touches no container", async () => {
    const f = fakeProxmox({ 9002: ours("c1") });
    const { b } = backend(f, { instance: INSTANCE, "chat:c1": rec(9002) });
    await b.onShutdown({ reason: "restart", deadline: Date.now() + 5_000 });
    expect(f.calls).toEqual([]);
  });
});

describe("races", () => {
  it("an idle stop decided before a new spawn does not stop the container under it", async () => {
    const f = fakeProxmox();
    const { b, kvNow } = backend(f, { instance: INSTANCE }, { idleStopMinutes: 0 });
    await b.spawn(spawnInfo()).catch(() => {});
    const vmid = (kvNow()["chat:c1"] as { vmid: number }).vmid;
    const idle = b.onChatIdle({ chatId: "c1" });
    const spawn = b.spawn(spawnInfo("two")).catch(() => {});
    await Promise.all([idle, spawn]);
    await new Promise((r) => setTimeout(r, 50));
    expect(f.cts.get(vmid)?.status).toBe("running");
  });
});
