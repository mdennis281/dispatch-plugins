/**
 * The platform seam: Linux's /proc and ss parsers on any OS, a fake /proc
 * tree on POSIX, and this machine's own /proc (and ss, when it is there) on
 * Linux. CI runs the last as root on Debian 12, which has neither procps nor
 * lsof.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bashPath,
  hostPlatform,
  linuxProcs,
  parseProcNetTcp,
  parseProcStat,
  parseSs,
  platformFor,
  procListeners,
  procNetAddress,
} from "../src/platform.js";
import { rootReused, sameProcess, type ProcRow } from "../src/procs.js";

const linux = process.platform === "linux";
const posix = process.platform !== "win32";

/** A /proc/<pid>/stat line: fields 3.. after the name, starttime at field 22. */
function stat(pid: number, comm: string, o: { ppid: number; pgrp: number; session: number; start: number; state?: string }): string {
  const rest = [o.state ?? "S", o.ppid, o.pgrp, o.session, 0, -1, 4194560, 100, 0, 0, 0, 1, 2, 0, 0, 20, 0, 1, 0, o.start, 1000, 200, 1];
  return `${pid} (${comm}) ${rest.join(" ")}\n`;
}

describe("parseProcStat", () => {
  it("reads the fields after the LAST parenthesis, so a name with spaces and parentheses can't shift them", () => {
    expect(parseProcStat(stat(4242, "my (odd) name) x", { ppid: 1, pgrp: 4242, session: 4242, start: 987654 }))).toEqual({
      pid: 4242,
      comm: "my (odd) name) x",
      state: "S",
      ppid: 1,
      pgrp: 4242,
      session: 4242,
      starttime: "987654",
    });
  });

  it.each(["", "garbage", "12 (x) S 1 2", "x (y) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20"])("refuses %j", (text) => {
    expect(parseProcStat(text)).toBeUndefined();
  });
});

describe("starts in two forms", () => {
  const rows: ProcRow[] = [{ pid: 800, ppid: 1, pgid: 800, start: "@5000", command: "bash" }];

  it("compares /proc's starts exactly", () => {
    expect(sameProcess(rows, 800, "@5000")).toBe(true);
    expect(sameProcess(rows, 800, "@5001")).toBe(false);
    expect(rootReused(rows, 800, "@5001")).toBe(true);
  });

  it("takes a start an older agent recorded with ps on Linux like no start at all: on trust, never as reused", () => {
    expect(sameProcess(rows, 800, "Sun Nov  1 12:00:00 2026")).toBe(true);
    expect(rootReused(rows, 800, "Sun Nov  1 12:00:00 2026")).toBe(false);
  });
});

describe("parseSs", () => {
  it("reads listeners with or without the state column, every process holding one, and IPv6", () => {
    const out = [
      'LISTEN 0      511          127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=1234,fd=20))',
      'LISTEN 0      4096             [::1]:5173          [::]:*    users:(("node",pid=1234,fd=21))',
      'LISTEN 0      128                  *:8080             *:*    users:(("nginx",pid=50,fd=6),("nginx",pid=51,fd=6))',
      "0      128            0.0.0.0:22         0.0.0.0:*    users:((\"sshd\",pid=7,fd=3))",
      "LISTEN 0      128            0.0.0.0:631        0.0.0.0:*",
      'LISTEN 0      10       [fe80::1%eth0]:9000            [::]:*    users:(("my app",pid=60,fd=4))',
      'LISTEN 0      10    [::ffff:127.0.0.1]:9100            *:*    users:(("srv",pid=61,fd=4))',
    ].join("\n");
    expect(parseSs(out)).toEqual([
      { pid: 7, command: "sshd", host: "127.0.0.1", port: 22 },
      { pid: 1234, command: "node", host: "127.0.0.1", port: 5173 },
      { pid: 50, command: "nginx", host: "127.0.0.1", port: 8080 },
      { pid: 51, command: "nginx", host: "127.0.0.1", port: 8080 },
      { pid: 60, command: "my app", host: "fe80::1", port: 9000 },
      { pid: 61, command: "srv", host: "127.0.0.1", port: 9100 },
    ]);
  });

  it("keeps ::1 for a server bound only there", () => {
    expect(parseSs('LISTEN 0 511 [::1]:5173 [::]:* users:(("node",pid=9,fd=20))')).toEqual([{ pid: 9, command: "node", host: "::1", port: 5173 }]);
  });
});

describe("/proc/net/tcp", () => {
  it("decodes addresses in the host's byte order, IPv4 and IPv6", () => {
    expect(procNetAddress("0100007F", true)).toBe("127.0.0.1");
    expect(procNetAddress("7F000001", false)).toBe("127.0.0.1");
    expect(procNetAddress("00000000", true)).toBe("0.0.0.0");
    expect(procNetAddress("00000000000000000000000001000000", true)).toBe("::1");
    expect(procNetAddress("00000000000000000000000000000000", true)).toBe("::");
    expect(procNetAddress("0000000000000000FFFF00000100007F", true)).toBe("::ffff:127.0.0.1");
    expect(procNetAddress("xyz", true)).toBeUndefined();
    expect(procNetAddress("0100007F01", true)).toBeUndefined();
  });

  it("lists only listening sockets, with their inodes", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:1435 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 31338 1 0000000000000000 20 4 30 10 -1",
      "   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 900 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    expect(parseProcNetTcp(text, true)).toEqual([
      { inode: "31337", address: "127.0.0.1", port: 5173 },
      { inode: "900", address: "0.0.0.0", port: 22 },
    ]);
  });
});

describe.skipIf(!posix)("Linux from a /proc tree", () => {
  let proc: string;
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  function fake(): string {
    proc = mkdtempSync(join(tmpdir(), "dh-proc-"));
    const add = (
      pid: number,
      comm: string,
      o: { ppid: number; pgrp: number; session: number; start: number; state?: string },
      fds: Record<string, string> = {},
    ) => {
      mkdirSync(join(proc, String(pid), "fd"), { recursive: true });
      writeFileSync(join(proc, String(pid), "stat"), stat(pid, comm, o));
      writeFileSync(join(proc, String(pid), "comm"), `${comm}\n`);
      for (const [fd, target] of Object.entries(fds)) symlinkSync(target, join(proc, String(pid), "fd", fd));
    };
    add(1, "init", { ppid: 0, pgrp: 1, session: 1, start: 1 });
    add(800, "bash", { ppid: 700, pgrp: 800, session: 800, start: 5000 });
    add(810, "node", { ppid: 800, pgrp: 800, session: 800, start: 5100 }, { "0": "/dev/null", "20": "socket:[31337]", "21": "socket:[31340]" });
    add(820, "sshd", { ppid: 1, pgrp: 820, session: 820, start: 200 }, { "3": "socket:[900]" });
    // A dead owner no init reaped.
    add(830, "node", { ppid: 1, pgrp: 830, session: 830, start: 4000, state: "Z" });
    mkdirSync(join(proc, "self"));
    mkdirSync(join(proc, "net"));
    writeFileSync(
      join(proc, "net", "tcp"),
      [
        "  sl  local_address rem_address   st",
        "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1",
        "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 900 1",
      ].join("\n"),
    );
    writeFileSync(
      join(proc, "net", "tcp6"),
      ["  sl  local_address", "   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 0 0 0 1000 0 31340 1"].join("\n"),
    );
    return proc;
  }

  it("lists processes with their group, session and exact start", async () => {
    const p = platformFor("linux", 1000, fake());
    const rows = await p.procs();
    expect(rows.find((r) => r.pid === 810)).toEqual({ pid: 810, ppid: 800, pgid: 800, sid: 800, start: "@5100", command: "node" });
    expect(await p.sessionMembers(800)).toEqual([800, 810]);
    expect(await p.procStart(800)).toBe("@5000");
    expect(await p.procStart(999)).toBeUndefined();
    // A zombie is no process: its session is swept, not taken for live.
    expect(rows.find((r) => r.pid === 830)).toBeUndefined();
    expect(await p.procStart(830)).toBeUndefined();
    expect(linuxProcs(proc).map((r) => r.pid).sort((a, b) => a - b)).toEqual([1, 800, 810, 820]);
  });

  it("finds listeners through the sockets' inodes, one per process and port, preferring 127.0.0.1", async () => {
    fake();
    expect(procListeners(proc)).toEqual([
      { pid: 820, command: "sshd", host: "127.0.0.1", port: 22 },
      { pid: 810, command: "node", host: "127.0.0.1", port: 5173 },
    ]);
    expect(await platformFor("linux", 1000, proc).listeners()).toEqual(procListeners(proc));
  });

  it("is root at uid 0, and asks through the helper otherwise", () => {
    expect(platformFor("linux", 0, "/nonexistent").elevation).toBe("root");
    expect(platformFor("linux", 1000, "/nonexistent").elevation).toBe("approval-helper");
    expect(platformFor("darwin", 501).elevation).toBe("approval-helper");
    expect(platformFor("darwin", 0).elevation).toBe("root");
  });
});

describe.skipIf(!linux)("this Linux machine", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("reads this process from /proc, its start exact and steady", async () => {
    const p = hostPlatform();
    const me = (await p.procs()).find((r) => r.pid === process.pid);
    expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid });
    expect(me!.start).toMatch(/^@\d+$/);
    // ps's lstart could move by a second between two looks; this never does.
    for (let i = 0; i < 5; i++) expect(await p.procStart(process.pid)).toBe(me!.start);
    expect(bashPath()).toMatch(/\/bash$/);
  });

  it("finds this process's listener, through ss when it is there and through /proc always", async () => {
    server = createServer();
    const port = await new Promise<number>((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as AddressInfo).port)));
    const mine = { pid: process.pid, host: "127.0.0.1", port };
    expect(procListeners()).toContainEqual(expect.objectContaining(mine));
    expect(await hostPlatform().listeners()).toContainEqual(expect.objectContaining(mine));
    const ss = spawnSync("sh", ["-c", "ss -Htlnp"], { encoding: "utf8" });
    if (ss.status === 0) {
      expect(hostPlatform().portsVia()).toBe("ss");
      expect(parseSs(ss.stdout)).toContainEqual(expect.objectContaining(mine));
    } else {
      expect(hostPlatform().portsVia()).toBe("proc");
    }
  });
});
