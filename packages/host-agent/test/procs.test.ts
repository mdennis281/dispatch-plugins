import { describe, expect, it } from "vitest";
import {
  attribute,
  descendantsOf,
  escapees,
  killPlan,
  killTree,
  parseLsof,
  parsePs,
  type KillIo,
  type ProcRow,
} from "../src/procs.js";

// A Mac with one chat session: sshd → relay; the owner (700, detached) → bash
// 800 → vite 810 → esbuild 820. 830 left with setsid and was reparented to
// launchd; 840 is still in bash's session but reparented; 815 moved itself to
// its own process group. 900 is the console user's ControlCenter (AirPlay).
const PS = `
    1     0     1 Sun Nov  1 09:00:00 2026     /sbin/launchd
  500     1   500 Sun Nov  1 10:00:00 2026     /usr/sbin/sshd -i
  600   500   600 Sun Nov  1 10:00:01 2026     node dispatch-host.mjs session --sid s1
  700     1   700 Sun Nov  1 10:00:02 2026     node dispatch-host.mjs serve --sid s1
  800   700   800 Sun Nov  1 10:00:03 2026     /bin/bash --noprofile --norc
  810   800   800 Sun Nov  1 10:00:04 2026     node node_modules/.bin/vite
  815   810   815 Sun Nov  1 10:00:04 2026     node worker.js
  820   810   800 Sun Nov  1 10:00:05 2026     esbuild --service=0.25.0
  830     1   830 Sun Nov  1 10:00:06 2026     sleep 1000
  840     1   800 Sun Nov  1 10:00:06 2026     tail -f log
  900     1   900 Sun Nov  1 09:00:05 2026     /System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter
garbage line
`;

describe("parsePs", () => {
  it("reads pid, ppid, pgid, the five-word start time and the command", () => {
    const rows = parsePs(PS);
    expect(rows).toHaveLength(11);
    expect(rows.find((r) => r.pid === 810)).toEqual({
      pid: 810,
      ppid: 800,
      pgid: 800,
      start: "Sun Nov 1 10:00:04 2026",
      command: "node node_modules/.bin/vite",
    });
  });
});

const rows = parsePs(PS);
const start = (pid: number) => rows.find((r) => r.pid === pid)!.start;

describe("the session's tree", () => {
  it("follows parent pids from the roots", () => {
    expect([...descendantsOf(rows, [800])].sort()).toEqual([800, 810, 815, 820]);
    expect([...descendantsOf(rows, [12345])]).toEqual([]);
  });

  it("plans a kill of the tree, session members and live tracked escapees, never the owner or anyone else", () => {
    const plan = killPlan(rows, { root: 800, sessionMembers: [800, 810, 820, 840], tracked: [{ pid: 830, start: start(830) }], self: 700 });
    expect(plan.pids).toEqual([800, 810, 815, 820, 830, 840]);
    expect(plan.pgids).toEqual([800, 815, 830]);
  });

  it("skips a tracked pid whose start time differs: the pid was reused by someone else", () => {
    const plan = killPlan(rows, { root: 800, tracked: [{ pid: 900, start: "Mon Nov  2 00:00:00 2026" }], self: 700 });
    expect(plan.pids).not.toContain(900);
    expect(plan.pgids).not.toContain(900);
  });

  it("leaves a shell pid alone, and its session id too, once it belongs to another process", () => {
    // 800 restarted at a later time: a reboot, or the pid came round again.
    const reused = rows.map((r) => (r.pid === 800 ? { ...r, start: "Mon Nov  2 08:00:00 2026" } : r));
    const plan = killPlan(reused, { root: 800, rootStart: start(800), sessionMembers: [800, 810, 820, 840], self: 700 });
    expect(plan.pids).toEqual([]);
    const same = killPlan(rows, { root: 800, rootStart: start(800), self: 700 });
    expect(same.pids).toEqual([800, 810, 815, 820, 840]);
  });

  it("never plans the owner's own process group, even if the tree claims it", () => {
    const twisted: ProcRow[] = [...rows, { pid: 850, ppid: 800, pgid: 700, start: "x", command: "odd" }];
    const plan = killPlan(twisted, { root: 800, self: 700 });
    expect(plan.pids).toContain(850);
    expect(plan.pgids).not.toContain(700);
  });

  it("finds a background job by the shell's process group once the shell is gone (macOS pgrep -s can't)", () => {
    const after = rows.filter((r) => r.pid !== 800).map((r) => (r.pid === 810 ? { ...r, ppid: 1 } : r));
    const plan = killPlan(after, { root: 800, rootStart: start(800), sessionMembers: [], self: 700 });
    expect(plan.pids).toEqual([810, 815, 820, 840]);
    expect(plan.pgids).toEqual([800, 815]);
  });

  it("finds the processes a kill of the shell's group would miss", () => {
    expect(escapees(rows, 800, [800, 810, 820, 840]).map((e) => e.pid).sort()).toEqual([815, 840]);
  });
});

describe("killTree", () => {
  it("signals groups then pids, and looks again for anything forked meanwhile", async () => {
    let live = rows;
    const sent: string[] = [];
    const io: KillIo = {
      listProcs: async () => live,
      sessionMembers: async () => [],
      kill: (pid, sig) => {
        sent.push(`${pid}:${sig}`);
        live = live.filter((r) => r.pid !== pid && r.pgid !== -pid);
      },
      sleep: async () => {},
    };
    const n = await killTree(io, { root: 800, self: 700 });
    expect(n).toBe(5);
    expect(sent[0]).toBe("-800:SIGKILL");
    expect(sent).not.toContain("700:SIGKILL");
    // 840 is in the shell's group; 830 left the session and wasn't tracked.
    expect(live.map((r) => r.pid)).toEqual([1, 500, 600, 700, 830, 900]);
  });
});

// `lsof -nP -iTCP -sTCP:LISTEN -F pcn` on that Mac.
const LSOF = `p810
cnode
f23
n*:5173
f24
n[::1]:5173
p820
cesbuild
f9
n127.0.0.1:43211
p900
cControlCe
f5
n*:7000
f6
n[::]:5000
p830
csleep
f3
n[fe80::1%lo0]:9229
`;

describe("ports", () => {
  it("parses listeners, dialling a wildcard on 127.0.0.1 and keeping ::1 and link-local hosts", () => {
    expect(parseLsof(LSOF)).toEqual([
      { pid: 900, command: "ControlCe", host: "127.0.0.1", port: 5000 },
      { pid: 810, command: "node", host: "127.0.0.1", port: 5173 },
      { pid: 900, command: "ControlCe", host: "127.0.0.1", port: 7000 },
      { pid: 830, command: "sleep", host: "fe80::1", port: 9229 },
      { pid: 820, command: "esbuild", host: "127.0.0.1", port: 43211 },
    ]);
  });

  it("attributes each listener to the session whose tree holds it; AirPlay belongs to nobody", () => {
    const att = attribute(parseLsof(LSOF), rows, [
      { sid: "s1", chat: "c1", root: 800, tracked: [{ pid: 830, start: start(830) }] },
      { sid: "s2", chat: "c2", root: 5555 },
    ]);
    expect(att.sessions[0]!.ports.map((p) => p.port)).toEqual([5173, 9229, 43211]);
    expect(att.sessions[1]!.ports).toEqual([]);
    expect(att.unattributed.map((p) => p.port)).toEqual([5000, 7000]);
  });
});
