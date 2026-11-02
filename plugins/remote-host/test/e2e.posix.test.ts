/**
 * The whole chain on one POSIX machine: the plugin's registry and link, a real
 * SSH server (in this process) that runs commands with /bin/sh as sshd would,
 * and the real dispatch-host bundle, installed over SSH into a throwaway HOME.
 * The pinned Node is stood in for by this test's own Node.
 *
 * Skipped on Windows; CI runs it on Linux and macOS.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TerminalBackendHandle, TerminalExitReason } from "@dispatch/plugin-sdk";
import { createTestContext, type TestContext } from "@dispatch/plugin-sdk/testing";
import { NODE_RUNTIME, sq } from "@dispatch-plugins/host-agent";
import { generateKeyPair } from "@dispatch-plugins/remote-core";
import { runLocally, startTestSshServer, type TestSshServer } from "@dispatch-plugins/remote-core/testing";
import { bundledAgent } from "../src/agent.js";
import type { HostConfig } from "../src/hosts.js";
import { HostRegistry } from "../src/registry.js";

const posix = process.platform !== "win32";
const INSTANCE = "e2e-instance";
const ID = "remote-host/e2e";

const until = async (cond: () => boolean, ms = 20_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

function watch(h: TerminalBackendHandle) {
  const w = { out: "", err: "", events: [] as string[], exit: undefined as { code: number | null; reason?: TerminalExitReason } | undefined };
  h.stdout.on("data", (d) => (w.out += d.toString()));
  h.stderr.on("data", (d) => (w.err += d.toString()));
  const on = h.on as (e: string, l: (...a: unknown[]) => void) => unknown;
  on.call(h, "stalled", () => w.events.push("stalled"));
  on.call(h, "resumed", () => w.events.push("resumed"));
  h.on("exit", (code, reason) => {
    w.events.push("exit");
    w.exit = { code, ...(reason ? { reason } : {}) };
  });
  return w;
}

describe.skipIf(!posix)("end to end under a real SSH server and dispatch-host (POSIX)", () => {
  let home: string;
  let server: TestSshServer;
  let t: TestContext;
  let registry: HostRegistry;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rh-e2e-")));
    const bin = join(home, ".dispatch-host", "runtime", "node", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${NODE_RUNTIME.version}; exit 0; fi\nexec ${sq(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const kp = generateKeyPair("e2e@test");
    server = await startTestSshServer({
      authorizedKeys: () => [kp.publicKey],
      exec: runLocally({
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        SHELL: "/bin/bash",
        USER: process.env.USER ?? "test",
        LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "test",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: "C.UTF-8",
      }),
    });
    t = createTestContext({ id: "remote-host", secrets: { REMOTE_HOST_KEY_E2E: kp.privateKey }, instance: { id: INSTANCE } });
    registry = new HostRegistry({
      ctx: t.ctx,
      instanceId: INSTANCE,
      agent: bundledAgent(),
      runtime: {
        tarball: async () => {
          throw new Error("the test stands in its own Node; nothing should be downloaded");
        },
      },
      timing: { tickMs: 100, helloEveryMs: 1_000, backoffMs: [100] },
      shell: { heartbeatMs: 200, stallAfterMs: 5_000, retryMs: [100] },
    });
    const host: HostConfig = {
      slug: "e2e",
      label: "E2E",
      user: "test",
      addresses: [server.host],
      port: server.port,
      hostKey: server.fingerprint,
      hostKeyType: server.keyType,
      keyFingerprint: `SHA256:${"b".repeat(43)}`,
      allowFrom: ["127.0.0.1"],
      pairedAt: new Date().toISOString(),
    };
    registry.sync([host]);
    await until(() => t.terminalStatus.get(ID)?.state === "online", 60_000, `${ID} online (status: ${JSON.stringify(t.terminalStatus.get(ID))})`);
  }, 90_000);

  afterAll(async () => {
    await registry?.get("e2e")?.link.agent(["kill", "--instance", INSTANCE, "--all"]).catch(() => {});
    registry?.dispose();
    await server?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("installed the agent and reports the machine online, with its probe", () => {
    const view = registry.list()[0]!;
    expect(view.status.state).toBe("online");
    expect(view.probe?.agentVersion).toBe(bundledAgent().version);
    expect(view.probe?.home).toBe(home);
  });

  it("runs a shell there, in the chat's own directory", async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-1", name: "main" });
    const w = watch(h);
    expect(h.cwd).toBe(join(home, ".dispatch-host", INSTANCE, "chats", "chat-1"));
    h.stdin.write("echo hello-$((40+2)); pwd\n");
    await until(() => w.out.includes("hello-42"), 20_000, "hello-42");
    await until(() => w.out.includes(h.cwd!), 5_000, "pwd");
    h.stdin.write("exit 7\n");
    await until(() => w.exit !== undefined, 20_000, "exit");
    expect(w.exit).toEqual({ code: 7, reason: { kind: "exited" } });
  });

  it("rides out a dropped connection: the shell keeps running and nothing is lost or repeated", async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-1", name: "drop" });
    const w = watch(h);
    h.stdin.write("echo before-drop; (sleep 2; echo after-drop) &\n");
    await until(() => w.out.includes("before-drop"), 20_000, "before-drop");
    server.dropClients();
    await until(() => w.events.includes("stalled"), 10_000, "stalled");
    await until(() => w.events.includes("resumed"), 30_000, "resumed");
    await until(() => w.out.includes("after-drop"), 20_000, "after-drop");
    h.stdin.write("echo still-here\n");
    await until(() => w.out.includes("still-here"), 20_000, "still-here");
    expect(w.out.match(/before-drop/g)).toHaveLength(1);
    expect(w.out.match(/after-drop/g)).toHaveLength(1);
    expect(w.exit).toBeUndefined();
    h.kill();
    expect(w.exit?.reason).toEqual({ kind: "killed", detail: "stopped by Dispatch" });
  });

  it("kill() ends the session and what it started on the machine", async () => {
    const h = await t.terminals.spawn(ID, { chatId: "chat-2", name: "main" });
    const w = watch(h);
    h.stdin.write("sleep 300 &\necho started\n");
    await until(() => w.out.includes("started"), 20_000, "started");
    h.kill();
    const link = registry.get("e2e")!.link;
    type Row = { chat: string; state: string };
    let rows: Row[] = [];
    await until(
      () => {
        void link.agent<Row[]>(["list", "--instance", INSTANCE]).then((r) => (rows = r));
        return rows.some((r) => r.chat === "chat-2") && rows.filter((r) => r.chat === "chat-2").every((r) => r.state === "exited");
      },
      20_000,
      "chat-2's session to exit",
    );
  });
});
