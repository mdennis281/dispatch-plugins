/**
 * The session owner's logic, with a fake shell, fake clients and a hand-wound
 * clock: attach and resume, replacing a stale client, the heartbeat watchdog,
 * run journaling, and how the session ends. The real process wiring is
 * covered by host.posix.test.ts.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StreamLog, type RunEntry } from "../src/journal.js";
import { F, FrameDecoder, decodeJson, decodeOutput, encodeFrame, type ExitMsg, type ReadyMsg } from "../src/protocol.js";
import { Session, type Client } from "../src/session.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}

class FakeShell extends EventEmitter {
  pid = 4242;
  written: string[] = [];
  ended = false;
  stdin = {
    write: (b: Buffer) => void this.written.push(b.toString()),
    end: () => void (this.ended = true),
    get writableEnded() {
      return shellEnded(this);
    },
  };
  stdout = new FakeStream();
  stderr = new FakeStream();
  say(text: string, stream: "stdout" | "stderr" = "stdout") {
    this[stream].emit("data", Buffer.from(text));
  }
}

const ends = new WeakMap<object, FakeShell>();
function shellEnded(stdin: object): boolean {
  return ends.get(stdin)?.ended ?? false;
}

class FakeClient implements Client {
  private dec = new FrameDecoder();
  frames: Array<{ type: number; payload: Buffer }> = [];
  writableLength = 0;
  ended = false;
  destroyed = false;
  write(data: Buffer) {
    this.frames.push(...this.dec.push(data));
    return true;
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
  }
  of(type: number) {
    return this.frames.filter((f) => f.type === type);
  }
  ready() {
    return decodeJson<ReadyMsg>(this.of(F.ready)[0]!.payload);
  }
  text(type: number = F.stdout) {
    return this.of(type)
      .map((f) => decodeOutput(f.payload).data.toString())
      .join("");
  }
}

function setup(opts: { heartbeatMs?: number; segmentBytes?: number; keep?: number; maxBacklog?: number; closeGraceMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dh-session-"));
  dirs.push(dir);
  const shell = new FakeShell();
  ends.set(shell.stdin, shell);
  const clock = { t: 1_000 };
  const runs: RunEntry[] = [];
  const exits: ExitMsg[] = [];
  const signals: string[] = [];
  const contacts: number[] = [];
  let kills = 0;
  const session = new Session({
    sid: "s1",
    agentVersion: "0.1.0",
    cwd: "/w",
    shell,
    out: StreamLog.open(dir, "out", { segmentBytes: opts.segmentBytes, keep: opts.keep }),
    err: StreamLog.open(dir, "err"),
    journalRun: (e) => runs.push(e),
    now: () => clock.t,
    heartbeatMs: opts.heartbeatMs ?? 60_000,
    maxBacklog: opts.maxBacklog,
    closeGraceMs: opts.closeGraceMs ?? 20,
    killTree: async () => {
      kills++;
    },
    signal: async (name) => void signals.push(name),
    onExit: (e) => exits.push(e),
    onContact: () => contacts.push(clock.t),
  });
  return { session, shell, clock, runs, exits, signals, contacts, kills: () => kills };
}

const frame = (type: number, payload?: object | Buffer | string) => decodeFrame(encodeFrame(type, payload));
function decodeFrame(b: Buffer) {
  return new FrameDecoder().push(b)[0]!;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Session", () => {
  it("answers an attach with READY, passes stdin through, and streams output with its offsets", () => {
    const { session, shell } = setup();
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    expect(c.ready()).toMatchObject({ sid: "s1", pid: 4242, cwd: "/w", out: 0, err: 0, resumed: false });
    session.handle(c, frame(F.stdin, Buffer.from("echo hi\n")));
    expect(shell.written).toEqual(["echo hi\n"]);
    shell.say("hi\n");
    shell.say("oops\n", "stderr");
    expect(c.text()).toBe("hi\n");
    expect(c.text(F.stderr)).toBe("oops\n");
    expect(decodeOutput(c.of(F.stdout)[0]!.payload).offset).toBe(0);
  });

  it("replays exactly what a re-attaching client missed, no byte twice", () => {
    const { session, shell } = setup();
    const first = new FakeClient();
    session.attach(first, { v: 1 });
    shell.say("one\n");
    session.detachClient(first); // the connection dropped
    shell.say("two\n"); // written while nobody was attached
    const second = new FakeClient();
    session.attach(second, { v: 1, resume: { out: 4, err: 0 } });
    expect(second.ready()).toMatchObject({ resumed: true, out: 8 });
    shell.say("three\n");
    expect(first.text() + second.text()).toBe("one\ntwo\nthree\n");
    expect(decodeOutput(second.of(F.stdout)[0]!.payload).offset).toBe(4);
  });

  it("tells a client the journal no longer holds where it asked to resume from", () => {
    const { session, shell } = setup({ segmentBytes: 4, keep: 1 });
    for (const s of ["aaaa", "bbbb", "cc"]) shell.say(s);
    const c = new FakeClient();
    session.attach(c, { v: 1, resume: { out: 0, err: 0 } });
    expect(c.ready().gap).toEqual({ out: 8 });
    expect(c.text()).toBe("cc");
  });

  it("lets a newer client replace a stale one, and ignores the stale one's frames", () => {
    const { session, shell } = setup();
    const stale = new FakeClient();
    session.attach(stale, { v: 1 });
    const fresh = new FakeClient();
    session.attach(fresh, { v: 1, resume: { out: 0, err: 0 } });
    expect(stale.destroyed).toBe(true);
    session.handle(stale, frame(F.stdin, Buffer.from("rm -rf build\n")));
    expect(shell.written).toEqual([]);
    session.handle(fresh, frame(F.stdin, Buffer.from("ls\n")));
    expect(shell.written).toEqual(["ls\n"]);
  });

  it("kills the session once Dispatch has been silent past the heartbeat, not before", async () => {
    const { session, shell, clock, exits, kills, contacts } = setup({ heartbeatMs: 60_000 });
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    clock.t += 50_000;
    session.handle(c, frame(F.heartbeat));
    expect(c.of(F.heartbeatAck)).toHaveLength(1);
    expect(contacts).toHaveLength(1);
    session.detachClient(c);
    clock.t += 59_000;
    session.tick();
    expect(kills()).toBe(0);
    clock.t += 2_000;
    session.tick();
    await tick();
    expect(kills()).toBe(1);
    shell.emit("close", null, "SIGKILL");
    await tick();
    expect(exits).toEqual([{ code: null, signal: "SIGKILL", reason: "heartbeat", detail: "no heartbeat for 61s" }]);
  });

  it("journals a run from its announcement to core's sentinel, and tells the client", () => {
    const { session, shell, runs } = setup();
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    session.handle(c, frame(F.runBegin, { runId: "r1", background: false }));
    shell.say("building\nCMTERMSENTINEL_n1|2|False|/w/pkg\n");
    expect(runs.map((r) => r.t)).toEqual(["begin", "end"]);
    expect(runs[1]).toMatchObject({ runId: "r1", exitCode: 2, cwd: "/w/pkg" });
    expect(decodeJson(c.of(F.runEnd)[0]!.payload)).toEqual({ runId: "r1", exitCode: 2, cwd: "/w/pkg" });
    // The sentinel still reaches the client: core's own parser resolves the run.
    expect(c.text()).toContain("CMTERMSENTINEL_n1|2|");
    // A sentinel with no run announced is not journaled.
    shell.say("CMTERMSENTINEL_n2|0|True|/w\n");
    expect(runs).toHaveLength(2);
  });

  it("gives a client that was away when a run ended its RUN_END on resume, after the bytes", () => {
    const { session, shell } = setup();
    const a = new FakeClient();
    session.attach(a, { v: 1 });
    session.handle(a, frame(F.runBegin, { runId: "r1", background: false }));
    shell.say("working\n");
    session.detachClient(a);
    shell.say("CMTERMSENTINEL_n1|0|True|/w\n");
    const b = new FakeClient();
    session.attach(b, { v: 1, resume: { out: 8, err: 0 } });
    expect(b.frames.map((f) => f.type)).toEqual([F.ready, F.stdout, F.runEnd]);
    expect(decodeJson(b.of(F.runEnd)[0]!.payload)).toEqual({ runId: "r1", exitCode: 0, cwd: "/w" });
    // A client that already had the sentinel doesn't get it twice.
    const c = new FakeClient();
    session.attach(c, { v: 1, resume: { out: 8 + 28, err: 0 } });
    expect(c.of(F.runEnd)).toEqual([]);
  });

  it("drops a client too far behind; the journal keeps every byte for its return", () => {
    const { session, shell } = setup({ maxBacklog: 10 });
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    c.writableLength = 11;
    shell.say("x");
    expect(c.destroyed).toBe(true);
    expect(session.hasClient).toBe(false);
  });

  it("when the shell exits on its own: kills what it left, reports the code, and says so to a late attach", async () => {
    const { session, shell, exits, kills } = setup();
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    shell.say("bye\n");
    shell.emit("close", 3, null);
    await tick();
    expect(kills()).toBe(1);
    expect(exits).toEqual([{ code: 3, signal: null, reason: "exited" }]);
    expect(decodeJson(c.of(F.exit)[0]!.payload)).toEqual({ code: 3, signal: null, reason: "exited" });
    expect(c.ended).toBe(true);
    const late = new FakeClient();
    session.attach(late, { v: 1, resume: { out: 0, err: 0 } });
    expect(late.text()).toBe("bye\n");
    expect(decodeJson<ExitMsg>(late.of(F.exit)[0]!.payload).code).toBe(3);
  });

  it("ends on a KILL frame with reason killed, and passes other signals on by name", async () => {
    const { session, shell, exits, signals, kills } = setup();
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    session.handle(c, frame(F.signal, { signal: "SIGINT" }));
    session.handle(c, frame(F.signal, { signal: "rm -rf /" }));
    await tick();
    expect(signals).toEqual(["INT"]);
    session.handle(c, frame(F.kill));
    await tick();
    expect(kills()).toBe(1);
    shell.emit("close", null, "SIGKILL");
    await tick();
    expect(exits[0]).toMatchObject({ reason: "killed" });
  });

  it("ends the shell's stdin on STDIN_END, and lets a client detach on purpose", () => {
    const { session, shell } = setup();
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    session.handle(c, frame(F.detach));
    expect(c.ended).toBe(true);
    expect(session.hasClient).toBe(false);
    const d = new FakeClient();
    session.attach(d, { v: 1, resume: { out: 0, err: 0 } });
    session.handle(d, frame(F.stdinEnd));
    expect(shell.ended).toBe(true);
  });

  it("finishes on the shell's exit even when an escaped process holds its output pipes open", async () => {
    const { session, shell, exits } = setup({ closeGraceMs: 20 });
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    shell.say("last words\n");
    shell.emit("exit", 0, null); // no "close": `ssh -f` still holds stdout
    await new Promise((r) => setTimeout(r, 60));
    expect(exits).toEqual([{ code: 0, signal: null, reason: "exited" }]);
    expect(shell.stdout.destroyed).toBe(true);
    expect(c.text()).toBe("last words\n");
    expect(decodeJson<ExitMsg>(c.of(F.exit)[0]!.payload).code).toBe(0);
  });

  it("keeps killing a shell it is ending that hasn't gone", async () => {
    const { session, clock, kills } = setup();
    await session.terminate("killed");
    expect(kills()).toBe(1);
    clock.t += 1_000;
    session.tick();
    expect(kills()).toBe(1);
    clock.t += 5_000;
    session.tick();
    await tick();
    expect(kills()).toBe(2);
    await session.terminate("heartbeat"); // asking again kills again; the first reason sticks
    expect(kills()).toBe(3);
  });

  it("refuses a frame it can't read without throwing, so the owner drops just that client", () => {
    const { session, shell } = setup();
    const c = new FakeClient();
    session.attach(c, { v: 1 });
    expect(session.handle(c, frame(F.signal, "INT"))).toBe(false);
    expect(session.handle(c, frame(F.runBegin, { background: true }))).toBe(false);
    expect(session.handle(c, frame(F.signal, "null"))).toBe(true);
    session.handle(c, frame(F.stdinEnd));
    session.handle(c, frame(F.stdin, Buffer.from("too late\n")));
    expect(shell.written).toEqual([]);
  });

  it("doesn't count a big replay against the backlog limit", () => {
    const { session, shell } = setup({ maxBacklog: 100 });
    shell.say("x".repeat(1_000));
    const c = new FakeClient();
    // Nothing drains: the whole replay is still queued.
    Object.defineProperty(c, "writableLength", { get: () => c.frames.reduce((n, f) => n + f.payload.length + 5, 0) });
    session.attach(c, { v: 1, resume: { out: 0, err: 0 } });
    shell.say("y");
    expect(c.destroyed).toBe(false);
    shell.say("z".repeat(200));
    expect(c.destroyed).toBe(true);
  });
});
