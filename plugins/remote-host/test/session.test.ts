/**
 * The session client against a scripted dispatch-host: start, output, input,
 * signals, and above all what happens when the channel drops (stall, resume
 * from the right offsets, no byte twice, no byte lost silently).
 */
import { describe, expect, it } from "vitest";
import { F } from "@dispatch-plugins/host-agent";
import type { TerminalExitReason } from "@dispatch/plugin-sdk";
import { HostShell } from "../src/session.js";
import { fakeOpener } from "./fake-channel.js";

const fast = { label: "cvx-mac", heartbeatMs: 20, stallAfterMs: 60, retryMs: [5], giveUpMs: 5_000 };

async function started(o = fakeOpener(), opts: Partial<typeof fast> = {}) {
  const p = HostShell.start(o.opener, { ...fast, ...opts });
  const ch = await o.nth(1);
  ch.ready({ cwd: "/Users/dispatch/.dispatch-host/i/chats/c" });
  const sh = await p;
  const out: string[] = [];
  const err: string[] = [];
  const events: string[] = [];
  let exit: { code: number | null; reason?: TerminalExitReason } | undefined;
  sh.stdout.on("data", (d: string) => out.push(d));
  sh.stderr.on("data", (d: string) => err.push(d));
  sh.on("stalled", () => events.push("stalled"));
  sh.on("resumed", () => events.push("resumed"));
  sh.on("exit", (code: number | null, reason?: TerminalExitReason) => {
    events.push("exit");
    exit = { code, ...(reason ? { reason } : {}) };
  });
  return { o, ch, sh, out, err, events, exit: () => exit };
}

const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("starting", () => {
  it("resolves on READY with the shell's directory on the machine", async () => {
    const { sh } = await started();
    expect(sh.cwd).toBe("/Users/dispatch/.dispatch-host/i/chats/c");
  });

  it("fails with the reason when the directory is missing (never a shell somewhere else)", async () => {
    const o = fakeOpener();
    const p = HostShell.start(o.opener, fast);
    (await o.nth(1)).error("no-cwd", "/x does not exist");
    await expect(p).rejects.toThrow(/directory does not exist on cvx-mac/);
  });

  it("fails with what the relay printed when it dies before READY", async () => {
    const o = fakeOpener();
    const p = HostShell.start(o.opener, fast);
    const ch = await o.nth(1);
    ch.stderr.emit("data", Buffer.from("node: No such file or directory\n"));
    ch.drop();
    await expect(p).rejects.toThrow(/ended before the shell started: node: No such file/);
  });

  it("gives up when the spawn is cancelled", async () => {
    const o = fakeOpener();
    const ac = new AbortController();
    const p = HostShell.start(o.opener, fast, ac.signal);
    await o.nth(1);
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(o.channels[0]!.closed).toBe(true);
    expect(o.killedDetached).toBe(1);
  });
});

describe("a running shell", () => {
  it("passes output on as text, a character cut across frames included", async () => {
    const { ch, out } = await started();
    const bytes = Buffer.from("héllo\n");
    ch.out(0, bytes.subarray(0, 2));
    ch.out(2, bytes.subarray(2));
    expect(out.join("")).toBe("héllo\n");
  });

  it("frames input, marks runs, and sends signals by name", async () => {
    const { ch, sh } = await started();
    sh.runBegin("run-1", false);
    sh.stdin.write("echo hi\n");
    sh.kill("SIGINT");
    expect(ch.stdinText()).toBe("echo hi\n");
    expect(ch.sent.find((f) => f.type === F.runBegin)?.json).toEqual({ runId: "run-1", background: false });
    expect(ch.sent.find((f) => f.type === F.signal)?.json).toEqual({ signal: "INT" });
  });

  it("kill() ends the session on the machine and reports the exit at once", async () => {
    const { ch, sh, exit } = await started();
    sh.kill();
    expect(ch.types()).toContain(F.kill);
    expect(ch.ended).toBe(true);
    expect(exit()).toEqual({ code: null, reason: { kind: "killed", detail: "stopped by Dispatch" } });
  });

  it("reports the shell's own exit with its code", async () => {
    const { ch, exit } = await started();
    ch.exit({ code: 3, reason: "exited" });
    expect(exit()).toEqual({ code: 3, reason: { kind: "exited" } });
  });

  it("says when the machine ended it for lack of a heartbeat", async () => {
    const { ch, exit } = await started();
    ch.exit({ code: null, signal: "SIGKILL", reason: "heartbeat" });
    expect(exit()?.reason).toEqual({ kind: "killed", detail: expect.stringMatching(/heartbeat/) });
  });

  it("sends heartbeats, and reports a stall when the machine stops answering, then the recovery", async () => {
    const { ch, events } = await started();
    await until(() => ch.types().filter((t) => t === F.heartbeat).length >= 2);
    await until(() => events.includes("stalled"));
    ch.emit("data", Buffer.from([F.heartbeatAck, 0, 0, 0, 0]));
    expect(events).toEqual(["stalled", "resumed"]);
  });
});

describe("a dropped connection", () => {
  it("stalls, re-attaches from the last byte it got, and passes on only what is new", async () => {
    const t = await started();
    t.ch.out(0, "one\n");
    t.ch.out(0, "e\n", F.stderr);
    t.ch.drop();
    expect(t.events).toEqual(["stalled"]);
    // Typed while away: held, then sent once re-attached.
    t.sh.stdin.write("echo two\n");
    const again = await t.o.nth(2);
    expect(t.o.resumes[1]).toEqual({ out: 4, err: 2 });
    again.ready({ resumed: true, out: 8, err: 2 });
    again.out(0, "one\ntwo\n"); // the replay overlaps what it already had
    expect(t.out.join("")).toBe("one\ntwo\n");
    expect(again.stdinText()).toBe("echo two\n");
    expect(t.events).toEqual(["stalled", "resumed"]);
    expect(t.exit()).toBeUndefined();
  });

  it("says so when bytes were lost (the journal had rotated)", async () => {
    const t = await started();
    t.ch.out(0, "a\n");
    t.ch.drop();
    const again = await t.o.nth(2);
    again.ready({ resumed: true, out: 100, err: 0, gap: { out: 90 } });
    again.out(90, "tail\n");
    expect(t.out.join("")).toBe("a\ntail\n");
    expect(t.err.join("")).toMatch(/88 bytes of output were lost/);
  });

  it("ends as transport-lost when the machine no longer has the session", async () => {
    const t = await started();
    t.ch.drop();
    (await t.o.nth(2)).error("gone", "no such session");
    await until(() => t.exit() !== undefined);
    expect(t.exit()?.reason).toEqual({ kind: "transport-lost", detail: expect.stringMatching(/gone from cvx-mac/) });
  });

  it("keeps trying while the machine is unreachable, then gives up as transport-lost", async () => {
    let down = false;
    const o = fakeOpener({ fail: () => (down ? new Error("offline") : undefined) });
    const t = await started(o, { giveUpMs: 80 });
    down = true;
    t.ch.drop();
    await until(() => t.exit() !== undefined);
    expect(o.resumes.length).toBeGreaterThan(2);
    expect(t.exit()?.reason?.kind).toBe("transport-lost");
    expect(t.events).toEqual(["stalled", "exit"]);
  });

  it("kill() while detached ends the session from outside", async () => {
    const t = await started(fakeOpener(), { retryMs: [60_000] });
    t.ch.drop();
    t.sh.kill();
    expect(t.o.killedDetached).toBe(1);
    expect(t.exit()?.reason?.kind).toBe("killed");
    expect(t.o.channels).toHaveLength(1); // and stops trying to re-attach
  });
});
