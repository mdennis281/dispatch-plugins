/**
 * Fakes for 0.2's seams: Proxmox's API (stateful: containers with a status
 * and a config), remote-host's `machines@1` (its spawn calls the plugin's
 * real `provision`, as remote-host does), core's `ctx.dependencies`, and an
 * empty container shell for the legacy rescue.
 */
import { EventEmitter } from "node:events";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import type { TerminalBackend, TerminalBackendHandle } from "@dispatch/plugin-sdk";
import { ProxmoxTerminal, describe as describeClone } from "../src/backend.js";
import type { RescueRemote } from "../src/legacy-rescue.js";
import type { PluginDependencyState } from "@dispatch/plugin-sdk";
import type { MachineLease, MachinesV1, ProvisionedBackend, ProvisionedBackendOptions } from "@dispatch-plugins/remote-host-api";
import type { PluginDependencies } from "../src/remote-host-link.js";
import { ProxmoxError, type Proxmox } from "../src/proxmox.js";
import { readSettings } from "../src/settings.js";

export interface Ct {
  status: "running" | "stopped";
  hostname: string;
  description?: string;
  template?: number;
}

export function fakeProxmox(initial: Record<number, Ct> = {}) {
  const cts = new Map<number, Ct>(Object.entries(initial).map(([k, v]) => [Number(k), { ...v }]));
  const calls: string[] = [];
  const state = { down: false, waited: 0, ip: "10.0.12.200" };
  const call = async (method: string, path: string, params: Record<string, unknown> = {}) => {
    if (state.down) throw new ProxmoxError(`Proxmox API unreachable (pve:8006): connect ECONNREFUSED`);
    calls.push(`${method} ${path}${params.newid ? ` newid=${params.newid}` : ""}`);
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
      const newid = Number(params.newid);
      if (cts.has(newid)) throw new ProxmoxError(`CT ${newid} already exists`, 500);
      cts.set(newid, { status: "stopped", hostname: String(params.hostname), description: String(params.description) });
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
    ipv4: async () => state.ip,
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

/** A shell handle remote-host would hand back. */
export function fakeHandle(): TerminalBackendHandle {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write() {} },
    kill() {},
    cwd: "/root/.dispatch-host/x/chats/c/repo",
  }) as unknown as TerminalBackendHandle;
}

/**
 * remote-host's `machines@1` as proxmox-terminal sees it. `spawn` provisions
 * through the plugin (as the real one does) and records the lease. `revoke()`
 * makes every function that crossed inert: it does nothing and returns
 * undefined, as core's membrane does after revocation.
 */
export function fakeRemoteHost() {
  const calls: string[] = [];
  const leases: MachineLease[] = [];
  const machines = new Map<string, { chatId: string; machine: string; connected: boolean; shells: number; running: boolean }>();
  const st = { revoked: false, options: undefined as ProvisionedBackendOptions | undefined };
  const inert = <A extends unknown[], R>(fn: (...a: A) => R) => ((...a: A) => (st.revoked ? undefined : fn(...a))) as (...a: A) => R;
  const api: MachinesV1 = {
    contract: { name: "machines", major: 1, minor: 0 },
    createProvisionedBackend(opts) {
      st.options = opts;
      const backend: TerminalBackend = {
        id: opts.id,
        label: opts.label,
        shell: "bash",
        spawn: inert(async (info) => {
          const lease = await opts.provision({
            chatId: info.chatId,
            projectId: info.projectId,
            worktreePath: info.worktreePath,
            repoPath: info.repoPath,
            signal: info.signal as AbortSignal,
          });
          leases.push(lease);
          machines.set(info.chatId, { chatId: info.chatId, machine: lease.machine, connected: true, shells: 1, running: false });
          return fakeHandle();
        }),
        beforeRun: inert(async (info) => {
          calls.push(`beforeRun ${info.chatId}`);
          return { notices: ["synced"] };
        }),
        afterRun: inert(async () => undefined),
        agentNote: inert(() => "- remote-host's machine part"),
      };
      const p: ProvisionedBackend = {
        backend,
        endChat: inert(async (chatId: string) => {
          calls.push(`endChat ${chatId}`);
          machines.delete(chatId);
        }),
        forgetChat: inert(async (chatId: string) => {
          calls.push(`forgetChat ${chatId}`);
          machines.delete(chatId);
        }),
        machineGone: inert(async (machine: string) => void calls.push(`machineGone ${machine}`)),
        forgetAll: inert(async () => void calls.push("forgetAll")),
        dispose: inert(async () => {}),
        machines: inert(() => [...machines.values()]),
      };
      return p;
    },
  };
  return {
    api,
    calls,
    leases,
    machines,
    st,
    revoke: () => void (st.revoked = true),
  };
}

/**
 * A hand-made `ctx.dependencies` with remote-host in a given state — for the
 * states the SDK's test context can't express (disabled, incompatible…). The
 * default in {@link terminal} is the SDK's own, over the host's real link.
 */
export function fakeDependencies(rh: ReturnType<typeof fakeRemoteHost>, initial: PluginDependencyState = "ok", detail = "") {
  const s = { state: initial, detail };
  const lost: Array<() => void> = [];
  const deps: PluginDependencies = {
    get: <T>(id: string, name: string, major: number) => {
      if (id !== "remote-host" || name !== "machines" || major !== 1) throw new Error(`not declared: ${id} ${name}@${major}`);
      return (s.state === "ok" ? rh.api : undefined) as T | undefined;
    },
    state: () => ({ id: "remote-host", uses: ["machines@1"], optional: true, ...s }),
    onLost: (_id, fn) => {
      lost.push(fn);
      return () => {};
    },
  };
  return {
    deps,
    lose: (next: PluginDependencyState = "disabled", why = "") => {
      s.state = next;
      s.detail = why;
      for (const fn of lost) fn();
    },
  };
}

/** A container with no legacy checkouts: the rescue finds nothing. */
export const emptyContainer = async (): Promise<RescueRemote> => ({
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  pipe: async () => ({ code: 0, stderr: "" }),
});

export const INSTANCE = "abc123abc123";

export const ours = (chatId: string, status: Ct["status"] = "running"): Ct => ({
  status,
  hostname: `dt-${chatId}`,
  description: describeClone(chatId, INSTANCE),
});

export const rec = (vmid: number, extra: Record<string, unknown> = {}) => ({ vmid, hostname: "h", createdAt: 1, lastUsedAt: Date.now(), ...extra });

/**
 * The plugin over `kv` — pass the previous run's kv to simulate a Dispatch
 * restart. By default remote-host is there through the SDK's own
 * `ctx.dependencies` (the host's real link: `t.revoke` / `t.lose` behave as in
 * production). `opts.deps`: a hand-made one instead; `null`: a core without
 * plugin dependencies.
 */
export function terminal(
  f: ReturnType<typeof fakeProxmox>,
  kv: Record<string, unknown> = { instance: INSTANCE },
  settings: Record<string, unknown> = {},
  opts: { deps?: PluginDependencies | null; rh?: ReturnType<typeof fakeRemoteHost>; rescueRemote?: () => Promise<RescueRemote> } = {},
) {
  const rh = opts.rh ?? fakeRemoteHost();
  const real = opts.deps === undefined;
  const t = createTestContext({
    id: "proxmox-terminal",
    kv,
    capabilities: ["terminals", "secrets", "kv"],
    ...(real ? { dependencies: { "remote-host": { machines: { 1: rh.api } } }, optionalDependencies: ["remote-host"] } : {}),
  });
  const deps = opts.deps === null ? undefined : real ? t.ctx.dependencies : opts.deps;
  let changed = 0;
  const b = new ProxmoxTerminal({
    ctx: t.ctx,
    kv: t.ctx.kv,
    settings: () => readSettings({ apiUrl: "https://pve:8006", node: "g", ...settings }),
    token: async () => "u@pve!t=x",
    sshAuth: async () => ({ privateKey: "k" }),
    proxmox: () => f.api,
    dependencies: () => deps,
    statusChanged: () => void changed++,
    rescueRemote: opts.rescueRemote ?? emptyContainer,
  });
  b.link.connect();
  return { b, t, rh, changes: () => changed, kvNow: () => Object.fromEntries(t.kv) as Record<string, unknown> };
}
