import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionPaths, type SessionRecord } from "../src/layout.js";
import type { KillIo, ProcRow } from "../src/procs.js";
import { readRecord, touchContact, writeRecord } from "../src/records.js";
import { sweepInstance } from "../src/sweep.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-02T12:00:00Z");
const row = (pid: number, ppid: number, pgid: number, start = "Sun Nov 1 10:00:00 2026"): ProcRow => ({ pid, ppid, pgid, start, command: "x" });

function record(root: string, sid: string, over: Partial<SessionRecord>): void {
  writeRecord(sessionPaths(root, "inst", sid).record, {
    v: 1,
    instance: "inst",
    chat: "c1",
    sid,
    agentVersion: "0.1.0",
    cwd: "/w",
    ownerPid: 0,
    state: "running",
    startedAt: new Date(NOW - HOUR).toISOString(),
    ...over,
  });
}

function fakeIo(rows: ProcRow[]) {
  let live = [...rows];
  const killed: number[] = [];
  const io: KillIo = {
    listProcs: async () => live,
    sessionMembers: async (sid) => live.filter((r) => r.pgid === sid).map((r) => r.pid),
    kill: (pid) => {
      killed.push(pid);
      live = live.filter((r) => r.pid !== pid && r.pgid !== -pid);
    },
    sleep: async () => {},
  };
  return { io, killed, alive: () => live.map((r) => r.pid) };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dh-sweep-"));
  dirs.push(root);
  return root;
}

function contactAt(root: string, at: number) {
  touchContact(root, "inst");
  const d = new Date(at);
  utimesSync(join(root, "inst", "contact"), d, d);
}

describe("sweepInstance", () => {
  it("kills the tree of a session whose owner died, and closes its record", async () => {
    const root = setup();
    contactAt(root, NOW - 60_000);
    // s1's owner (100) is gone; its bash (200) and a child (201) live on.
    record(root, "s1", { ownerPid: 100, shellPid: 200 });
    // s2's owner (300) is alive and Dispatch was here a minute ago.
    record(root, "s2", { ownerPid: 300, shellPid: 400 });
    const f = fakeIo([row(1, 0, 1), row(200, 1, 200), row(201, 200, 200), row(300, 1, 300), row(400, 300, 400)]);
    const r = await sweepInstance({ root, instance: "inst", now: NOW, deadManMs: 12 * HOUR, self: 999, io: f.io });
    expect(r).toEqual({ reaped: ["s1"], deadMan: [], removed: [] });
    expect(f.alive()).toEqual([1, 300, 400]);
    expect(readRecord(sessionPaths(root, "inst", "s1").record)).toMatchObject({ state: "exited", exit: { reason: "killed" } });
    expect(readRecord(sessionPaths(root, "inst", "s2").record)?.state).toBe("running");
  });

  it("treats an owner pid with a different start time as gone: the pid was reused", async () => {
    const root = setup();
    record(root, "s1", { ownerPid: 100, ownerStart: "Sat Oct 31 08:00:00 2026", shellPid: 200 });
    const f = fakeIo([row(100, 1, 100), row(200, 1, 200)]);
    const r = await sweepInstance({ root, instance: "inst", now: NOW, deadManMs: 12 * HOUR, self: 999, io: f.io });
    expect(r.reaped).toEqual(["s1"]);
    expect(f.alive()).toEqual([100]);
  });

  it("doesn't touch a shell pid that now belongs to someone else", async () => {
    const root = setup();
    record(root, "s1", { ownerPid: 100, shellPid: 200, shellStart: "Sat Oct 31 08:00:00 2026" });
    // 200 is alive, but started later: a reused pid, the leader of someone's own session.
    const f = fakeIo([row(200, 1, 200), row(201, 200, 200)]);
    const r = await sweepInstance({ root, instance: "inst", now: NOW, deadManMs: 12 * HOUR, self: 999, io: f.io });
    expect(r.reaped).toEqual(["s1"]);
    expect(f.killed).toEqual([]);
    expect(f.alive()).toEqual([200, 201]);
  });

  it("dead-man switch: no contact for too long kills every live session, owner and all, but never the caller", async () => {
    const root = setup();
    contactAt(root, NOW - 13 * HOUR);
    record(root, "s1", { ownerPid: 300, shellPid: 400 });
    record(root, "me", { ownerPid: 999, shellPid: 1000 });
    const f = fakeIo([row(300, 1, 300), row(400, 300, 400), row(401, 400, 400), row(999, 1, 999), row(1000, 999, 1000)]);
    const r = await sweepInstance({ root, instance: "inst", now: NOW, deadManMs: 12 * HOUR, self: 999, selfSid: "me", io: f.io });
    expect(r.deadMan).toEqual(["s1"]);
    expect(f.alive()).toEqual([999, 1000]);
    expect(readRecord(sessionPaths(root, "inst", "s1").record)?.exit).toMatchObject({ reason: "dead-man", detail: "no Dispatch contact for 13h" });
  });

  it("removes an exited session's directory only once it is old", async () => {
    const root = setup();
    record(root, "old", { state: "exited", exit: { code: 0, signal: null, reason: "exited", at: new Date(NOW - 25 * HOUR).toISOString() } });
    record(root, "new", { state: "exited", exit: { code: 0, signal: null, reason: "exited", at: new Date(NOW - HOUR).toISOString() } });
    const f = fakeIo([]);
    const r = await sweepInstance({ root, instance: "inst", now: NOW, deadManMs: 12 * HOUR, self: 999, io: f.io });
    expect(r.removed).toEqual(["old"]);
    expect(existsSync(sessionPaths(root, "inst", "old").dir)).toBe(false);
    expect(existsSync(sessionPaths(root, "inst", "new").dir)).toBe(true);
  });

  it("does nothing for an instance with no sessions", async () => {
    const root = setup();
    const f = fakeIo([row(1, 0, 1)]);
    expect(await sweepInstance({ root, instance: "inst", now: NOW, deadManMs: HOUR, self: 999, io: f.io })).toEqual({
      reaped: [],
      deadMan: [],
      removed: [],
    });
    expect(f.killed).toEqual([]);
  });
});
