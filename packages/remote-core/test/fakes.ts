/**
 * Fakes at remote-core's two seams: the SSH connection and the machine
 * provider. The provider is stateful (machines with an owner, an instance tag
 * and a status), so "it was stopped" and "it was never touched" are claims
 * about that state, not about which calls were made.
 */
import { EventEmitter } from "node:events";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { RemoteChats, type Provider, type SshConnection } from "../src/index.js";

/** A shell handle that records what was written to it. */
export class FakeShell extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  written: string[] = [];
  readonly stdin = { write: (c: string) => void this.written.push(c) };
  constructor(readonly cwd: string) {
    super();
  }
  kill() {
    this.emit("exit", null);
  }
}

export interface FakeConnOptions {
  /** Answer a command; default exit 0 with no output. */
  exec?: (cmd: string) => { code: number; stdout?: string; stderr?: string } | undefined;
}

export function fakeConn(opts: FakeConnOptions = {}) {
  const remote: string[] = [];
  const shells: FakeShell[] = [];
  const forwards: Array<{ port: number; host: string; closed: boolean }> = [];
  const answer = (cmd: string) => {
    const r = opts.exec?.(cmd) ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const conn = Object.assign(new EventEmitter(), {
    isOpen: true,
    connect: async () => {},
    exec: async (cmd: string) => {
      remote.push(cmd);
      return answer(cmd);
    },
    run: async (cmd: string) => {
      remote.push(cmd);
      const r = answer(cmd);
      if (r.code !== 0) throw new Error(`remote \`${cmd.slice(0, 80)}\` exited ${r.code}: ${r.stderr}`);
      return r.stdout;
    },
    shell: async (cwd: string) => {
      const sh = new FakeShell(cwd);
      shells.push(sh);
      return sh;
    },
    forward: async (port: number, host = "127.0.0.1") => {
      const f = { port, host, closed: false };
      forwards.push(f);
      return { localPort: 40000 + port, close: () => void (f.closed = true) };
    },
    close() {
      (this as { isOpen: boolean }).isOpen = false;
    },
  });
  return { conn: conn as unknown as SshConnection, remote, shells, forwards };
}

export interface Machine {
  chatId: string;
  instance: string;
  status: "running" | "stopped";
}

export type Ref = { id: number };

export const INSTANCE = "abc123abc123";

/** `conn`: what bringUp connects to (or makes it, per bring-up); a fresh fake each time by default. */
export function fakeProvider(initial: Record<number, Machine> = {}, opts: { conn?: SshConnection | (() => SshConnection) } = {}) {
  const machines = new Map<number, Machine>(Object.entries(initial).map(([k, v]) => [Number(k), { ...v }]));
  const calls: string[] = [];
  const state = { down: false, configured: true };
  const reachable = () => {
    if (state.down) throw new Error("provider unreachable: connect ECONNREFUSED");
  };
  const owned = (id: number, chatId: string) => machines.get(id)?.chatId === chatId;
  const provider: Provider<Ref> = {
    configured: () => state.configured,
    refOf: (rec) => (Number(rec.id) > 0 ? { id: Number(rec.id) } : undefined),
    keyOf: (ref) => String(ref.id),
    name: (ref) => `machine ${ref.id}`,
    async bringUp(chat) {
      reachable();
      let id = chat.ref?.id;
      if (!id || !owned(id, chat.chatId)) {
        id = Math.max(0, ...machines.keys()) + 1;
        machines.set(id, { chatId: chat.chatId, instance: INSTANCE, status: "stopped" });
        calls.push(`create ${id}`);
        await chat.remember({ id });
      }
      if (machines.get(id)!.status !== "running") {
        machines.get(id)!.status = "running";
        calls.push(`start ${id}`);
      }
      return typeof opts.conn === "function" ? opts.conn() : (opts.conn ?? fakeConn().conn);
    },
    async stop(chatId, ref) {
      reachable();
      const m = machines.get(ref.id);
      if (!m || m.status !== "running" || m.chatId !== chatId) return;
      m.status = "stopped";
      calls.push(`stop ${ref.id}`);
    },
    async destroy(chatId, ref) {
      reachable();
      if (!owned(ref.id, chatId)) return; // gone, or not ours: never destroy it
      machines.delete(ref.id);
      calls.push(`destroy ${ref.id}`);
    },
    async release(chatId, ref) {
      reachable();
      const m = machines.get(ref.id);
      if (!m || m.status !== "running" || m.chatId !== chatId) return;
      calls.push(`release ${ref.id}`);
    },
    async discover(instance, known) {
      reachable();
      return [...machines]
        .filter(([id, m]) => m.instance === instance && !known.has(String(id)))
        .map(([id, m]) => ({ chatId: m.chatId, ref: { id } }));
    },
  };
  return { provider, machines, calls, state };
}

/** RemoteChats over `kv` — pass the previous run's kv to simulate a Dispatch restart. */
export function chats(
  f: ReturnType<typeof fakeProvider>,
  kv: Record<string, unknown> = { instance: INSTANCE },
  policy: Partial<{ idleStopMinutes: number; destroyUnusedDays: number; workDir: string }> = {},
) {
  const t = createTestContext({ id: "test-remote", kv });
  const published: Array<{ chatId: string; remotePort: number; url: string; withdrawn: boolean }> = [];
  const c = new RemoteChats<Ref>({
    backendId: "test",
    label: "test-remote",
    provider: f.provider,
    kv: t.ctx.kv,
    log: t.ctx.log,
    publishPort: (p) => {
      const rec = { ...p, withdrawn: false };
      published.push(rec);
      return () => void (rec.withdrawn = true);
    },
    policy: () => ({ idleStopMinutes: 30, destroyUnusedDays: 7, workDir: "/work", ...policy }),
  });
  return { c, t, published, kvNow: () => Object.fromEntries(t.kv) as Record<string, unknown> };
}

export const rec = (id: number, extra: Record<string, unknown> = {}) => ({ id, createdAt: 1, lastUsedAt: Date.now(), ...extra });
