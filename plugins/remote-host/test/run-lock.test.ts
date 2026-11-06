/**
 * The lock across locations against the SDK's own fake of core's run list
 * (`t.terminals.startRun` / `endRun`), so the shape `runsOf` reads is the
 * host's. The sync around it is in sync.test.ts ("the checkout lock").
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { CheckoutLock, runsOf } from "../src/sync/run-lock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig(afterWaitMs = 5_000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rh-lock-")));
  dirs.push(root);
  mkdirSync(join(root, "src"));
  const t = createTestContext({ id: "remote-host", capabilities: ["terminals"] });
  const runs = runsOf(t.ctx);
  if (!runs) throw new Error("the SDK's fake has no ctx.terminals.runs");
  const lock = new CheckoutLock({ runs, self: "remote-host/studio", where: (b) => (b === "local" ? "this computer" : b), afterWaitMs });
  return { t, root, lock, q: { chatId: "chat-1", root, runId: "mine" } };
}

describe("runsOf", () => {
  it("finds core's run list on a Dispatch that has it, and nothing on one that doesn't", () => {
    expect(runsOf(createTestContext({ capabilities: ["terminals"] }).ctx)).toBeDefined();
    expect(runsOf({ terminals: { registerBackend() {} } })).toBeUndefined();
    expect(runsOf({})).toBeUndefined();
    expect(runsOf(undefined)).toBeUndefined();
  });
});

describe("the lock across locations", () => {
  it("counts a foreground run on this computer inside the files, whatever the chat, and not one outside them", async () => {
    const { t, root, lock, q } = rig();
    t.terminals.startRun({ chatId: "chat-2", backend: "local", cwd: join(root, "src"), terminal: "build", command: "pnpm install" });
    t.terminals.startRun({ chatId: "chat-1", backend: "local", cwd: tmpdir(), terminal: "elsewhere" });
    const found = await lock.others(q, "before");
    expect(found.map((r) => r.terminal)).toEqual(["build"]);
    // The host shows a plugin the commands of its own backends only.
    const text = lock.refusal(found, q.chatId, "Studio");
    expect(text).toMatch(/^Not run: terminal "build" of another chat on this computer \(for \d+ s\) is running a command in this chat's files, and syncing them with Studio now/);
    expect(text).not.toContain("pnpm install");
  });

  it("waits for a run to end, woken by core's event, and gives up at its limit", async () => {
    const { t, root, lock, q } = rig();
    const r = t.terminals.startRun({ chatId: "chat-1", backend: "local", cwd: root, terminal: "lint" });
    setTimeout(() => t.terminals.endRun(r.runId), 1_100);
    const started = Date.now();
    const w = await lock.waitClear(q, new AbortController().signal);
    expect(w.still).toEqual([]);
    expect(w.waitedFor.map((x) => x.terminal)).toEqual(["lint"]);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(lock.waited(w, q.chatId, "Studio")).toMatch(/^\[Studio\] Waited 1 s for terminal "lint" on this computer to finish its command/);

    const short = rig(200);
    short.t.terminals.startRun({ chatId: "chat-1", backend: "local", cwd: short.root, terminal: "test" });
    const w2 = await short.lock.waitClear(short.q, new AbortController().signal);
    expect(w2.still.map((x) => x.terminal)).toEqual(["test"]);
    expect(short.lock.notBack(w2, short.q.chatId, "Studio")).toMatch(/isn't brought back yet: terminal "test" on this computer \(for \d+ s\) is still running/);
  });

  it("stops waiting the moment core gives up on the run here", async () => {
    const { t, root, lock, q } = rig(60_000);
    t.terminals.startRun({ chatId: "chat-1", backend: "local", cwd: root });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    const w = await lock.waitClear(q, ac.signal);
    expect(w.still).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
