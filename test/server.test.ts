/**
 * Unit tests — no Proxmox, no SSH, no Dispatch. The Proxmox API and the SSH
 * connection are faked at the seams `BackendDeps` exposes; the git snapshot
 * runs against a real throwaway repository, because "the real index is
 * untouched" is a claim about git, not about this code.
 */
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import plugin, { normaliseKey } from "../src/server.js";
import { ProxmoxTerminalBackend, githubHttps, hostnameFor, parseListeners } from "../src/backend.js";
import { remotePathFor, snapshot } from "../src/snapshot.js";
import { readSettings } from "../src/settings.js";
import { ProxmoxError, type Proxmox } from "../src/proxmox.js";
import type { SshConnection } from "../src/ssh.js";

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
  it("parses ss listeners into the address to dial inside the container", () => {
    const out = [
      "LISTEN 0 4096   0.0.0.0:22      0.0.0.0:*",
      "LISTEN 0 511    [::1]:5173      [::]:*",
      "LISTEN 0 511    *:3000          *:*",
      "LISTEN 0 511    127.0.0.1:8080  0.0.0.0:*",
      "LISTEN 0 511    [::1]:8080      [::]:*",
    ].join("\n");
    expect([...parseListeners(out)]).toEqual([
      [5173, "::1"],
      [3000, "127.0.0.1"],
      [8080, "127.0.0.1"],
    ]);
  });

  it("normalises every spelling of a GitHub origin to https", () => {
    expect(githubHttps("git@github.com:mdennis281/dispatch.git")).toBe("https://github.com/mdennis281/dispatch.git");
    expect(githubHttps("https://github.com/mdennis281/dispatch")).toBe("https://github.com/mdennis281/dispatch.git");
    expect(githubHttps("https://x-token@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(githubHttps("https://gitlab.com/o/r.git")).toBeUndefined();
  });

  it("makes DNS-safe hostnames", () => {
    expect(hostnameFor("aizKrtGZkh-aaPtvwa_4a")).toBe("dt-aizkrtgzkhaaptvw");
  });

  it("maps a local cwd under the worktree onto the container's checkout", () => {
    const root = process.platform === "win32" ? "C:\\w\\repo" : "/w/repo";
    const sub = process.platform === "win32" ? "C:\\w\\repo\\packages\\server" : "/w/repo/packages/server";
    expect(remotePathFor(root, sub, "/root/work/repo")).toBe("/root/work/repo/packages/server");
    expect(remotePathFor(root, root, "/root/work/repo")).toBe("/root/work/repo");
    expect(remotePathFor(root, process.platform === "win32" ? "C:\\elsewhere" : "/elsewhere", "/r")).toBe("/r");
  });

  it("accepts a private key pasted multi-line, flattened to one line, or base64", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\n";
    expect(normaliseKey(pem)).toBe(pem);
    expect(normaliseKey(pem.replace(/\n/g, " "))).toBe(pem);
    expect(normaliseKey(Buffer.from(pem).toString("base64"))).toBe(pem);
  });

  it("reads settings over defaults, coercing numbers", () => {
    const s = readSettings({ cores: "4", insecureTls: true, apiUrl: " https://pve:8006 " });
    expect(s).toMatchObject({ cores: 4, insecureTls: true, apiUrl: "https://pve:8006", templateVmid: 9000 });
  });
});

describe("snapshot", () => {
  it("captures uncommitted and untracked files, skips ignored ones, and leaves the real index alone", () => {
    const dir = gitRepo();
    const indexBefore = readFileSync(join(dir, ".git", "index"));
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "big.js"), "ignored\n");
    return snapshot(dir).then((sha) => {
      const show = (p: string) => execFileSync("git", ["show", `${sha}:${p}`], { cwd: dir }).toString();
      expect(show("a.txt")).toBe("two\n");
      expect(show("new.txt")).toBe("untracked\n");
      expect(() => show("node_modules/big.js")).toThrow();
      // Real index byte-identical; nothing staged; HEAD unmoved.
      expect(readFileSync(join(dir, ".git", "index")).equals(indexBefore)).toBe(true);
      expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir }).toString().trim()).toBe("");
      expect(execFileSync("git", ["stash", "list"], { cwd: dir }).toString().trim()).toBe("");
    });
  });

  it("is deterministic: an unchanged tree on an unchanged HEAD is the same commit", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    expect(await snapshot(dir)).toBe(await snapshot(dir));
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

  it("re-syncs before a command but not before the sentinel probe", async () => {
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
    const packsBefore = f.remote.filter((c) => c.includes("index-pack")).length;
    writeFileSync(join(repo, "a.txt"), "edited locally\n");
    handle.stdin.write("cat a.txt\n");
    handle.stdin.write("__cm_ec=$?; printf ...\n");
    // A snapshot is real git work; on a loaded Windows box it takes a while.
    for (let i = 0; i < 100 && f.shells[0]!.written.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    expect(f.remote.filter((c) => c.includes("index-pack")).length).toBe(packsBefore + 1);
    expect(f.shells[0]!.written).toEqual(["cat a.txt\n", "__cm_ec=$?; printf ...\n"]);
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
