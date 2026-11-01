/**
 * Unit tests — no Proxmox, no SSH, no Dispatch. The Proxmox API and the SSH
 * connection are faked at the seams `BackendDeps` exposes; the git snapshot
 * runs against a real throwaway repository. What is not Proxmox (snapshots,
 * the sync before each command, port parsing, key pasting) is tested in
 * packages/remote-core.
 */
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import type { SshConnection } from "@dispatch-plugins/remote-core";
import plugin from "../src/server.js";
import { ProxmoxTerminalBackend, hostnameFor } from "../src/backend.js";
import { readSettings } from "../src/settings.js";
import { ProxmoxError, type Proxmox } from "../src/proxmox.js";

const dirs: string[] = [];
afterEach(() => {
  // Retries: on Windows a git child can still hold the directory for a moment.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pt-repo-"));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

describe("helpers", () => {
  it("makes DNS-safe hostnames", () => {
    expect(hostnameFor("aizKrtGZkh-aaPtvwa_4a")).toBe("dt-aizkrtgzkhaaptvw");
  });

  it("reads settings over defaults, coercing numbers", () => {
    const s = readSettings({ cores: "4", insecureTls: true, apiUrl: " https://pve:8006 " });
    expect(s).toMatchObject({ cores: 4, insecureTls: true, apiUrl: "https://pve:8006", templateVmid: 9000 });
  });
});

/* ------------------------------------------------------------ the backend */

class FakeChannel extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  written: string[] = [];
  readonly stdin = { write: (c: string) => void this.written.push(c) };
  cwd = "/root/work/repo";
  kill() {
    this.emit("exit", null);
  }
}

function fakes() {
  const calls: string[] = [];
  const state = { status: undefined as string | undefined, description: undefined as string | undefined };
  const api = {
    call: async (method: string, path: string, params?: Record<string, unknown>) => {
      calls.push(`${method} ${path}${params?.newid ? ` newid=${params.newid}` : ""}`);
      if (path === "/cluster/resources") return [{ vmid: 9001, type: "lxc", pool: "dispatch-terminals" }];
      if (path.endsWith("/config") && method === "GET") {
        if (!state.status) throw new ProxmoxError("Configuration file does not exist", 500);
        return { description: state.description };
      }
      if (path.endsWith("/clone")) {
        state.status = "stopped";
        state.description = String(params?.description);
        return "UPID:clone";
      }
      if (path.endsWith("/status/start")) {
        state.status = "running";
        return "UPID:start";
      }
      if (path.endsWith("/status/shutdown") || path.endsWith("/status/stop")) {
        state.status = "stopped";
        return "UPID:stop";
      }
      if (method === "DELETE") {
        state.status = undefined;
        return "UPID:destroy";
      }
      return null;
    },
    waitTask: async () => {},
    ipv4: async () => "10.0.12.200",
    status: async () => state.status,
  } as unknown as Proxmox;
  const remote: string[] = [];
  const shells: FakeChannel[] = [];
  const conn = Object.assign(new EventEmitter(), {
    isOpen: true,
    connect: async () => {},
    exec: async (cmd: string) => {
      remote.push(cmd);
      return { code: 0, stdout: cmd.includes("test -d") ? "" : "", stderr: "" };
    },
    run: async (cmd: string) => {
      remote.push(cmd);
      return "";
    },
    shell: async () => {
      const ch = new FakeChannel();
      shells.push(ch);
      return ch;
    },
    forward: async () => ({ localPort: 45000, close: () => {} }),
    close() {
      (this as { isOpen: boolean }).isOpen = false;
    },
  }) as unknown as SshConnection;
  return { api, conn, calls, remote, shells, state };
}

describe("ProxmoxTerminalBackend", () => {
  it("clones a free vmid on first spawn, sizes it, starts it, and hands back a shell in the mapped cwd", async () => {
    const repo = gitRepo();
    const f = fakes();
    const t = createTestContext({ id: "proxmox-terminal" });
    const backend = new ProxmoxTerminalBackend({
      ctx: t.ctx,
      kv: t.ctx.kv,
      settings: () => readSettings({ apiUrl: "https://pve:8006", node: "g" }),
      token: async () => "u@pve!t=x",
      sshAuth: async () => ({ privateKey: "k" }),
      proxmox: () => f.api,
      connect: () => f.conn,
    });
    const handle = await backend.spawn({ chatId: "c1", name: "main", cwd: repo, signal: new AbortController().signal });
    // 9001 is taken in the pool → 9002.
    expect(f.calls).toContain("POST /nodes/g/lxc/9000/clone newid=9002");
    expect(f.calls).toContain("PUT /nodes/g/lxc/9002/config");
    expect(f.calls).toContain("POST /nodes/g/lxc/9002/status/start");
    expect(t.kv.get("chat:c1")).toMatchObject({ vmid: 9002 });
    // Seeded (no GitHub origin → git init), then synced by pack.
    expect(f.remote.some((c) => c.includes("git init"))).toBe(true);
    expect(f.remote.some((c) => c.includes("git index-pack --stdin"))).toBe(true);
    expect(f.remote.some((c) => /git checkout -q --force --detach [0-9a-f]{40}/.test(c))).toBe(true);
    expect(handle.cwd).toBe("/root/work/repo");
    expect(backend.agentNote({ chatId: "c1" })).toContain("useless on Linux");
  });

  it("stops the container when the chat goes idle, and destroys it when the chat is deleted", async () => {
    const repo = gitRepo();
    const f = fakes();
    const t = createTestContext({ id: "proxmox-terminal" });
    const backend = new ProxmoxTerminalBackend({
      ctx: t.ctx,
      kv: t.ctx.kv,
      settings: () => readSettings({ apiUrl: "https://pve:8006", node: "g", idleStopMinutes: 0 }),
      token: async () => "u@pve!t=x",
      sshAuth: async () => ({ privateKey: "k" }),
      proxmox: () => f.api,
      connect: () => f.conn,
    });
    await backend.spawn({ chatId: "c1", name: "main", cwd: repo, signal: new AbortController().signal });
    backend.onChatIdle({ chatId: "c1" });
    await new Promise((r) => setTimeout(r, 50));
    expect(f.calls).toContain("POST /nodes/g/lxc/9002/status/shutdown");
    await backend.onChatDeleted({ chatId: "c1" });
    expect(f.calls).toContain("DELETE /nodes/g/lxc/9002");
    expect(t.kv.get("chat:c1")).toBeUndefined();
  });

  it("refuses loudly with no API URL or token, so Dispatch falls back to local and says why", async () => {
    const t = createTestContext({ id: "proxmox-terminal" });
    const backend = new ProxmoxTerminalBackend({
      ctx: t.ctx,
      kv: t.ctx.kv,
      settings: () => readSettings({}),
      token: async () => undefined,
      sshAuth: async () => ({}),
    });
    await expect(
      backend.spawn({ chatId: "c1", name: "main", cwd: process.cwd(), signal: new AbortController().signal }),
    ).rejects.toThrow(/no API URL/);
  });
});

describe("activate", () => {
  it("registers the proxmox backend", async () => {
    const t = createTestContext({ id: "proxmox-terminal", capabilities: ["terminals", "secrets", "kv"] });
    await plugin.activate(t.ctx);
    expect([...t.terminalBackends.keys()]).toEqual(["proxmox"]);
    expect(t.terminalBackends.get("proxmox")).toMatchObject({ label: "Proxmox container", shell: "bash" });
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
});
