import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SentinelScanner, StreamLog, appendRun, readRuns } from "../src/journal.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dh-journal-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const text = (log: StreamLog, from: number) => Buffer.concat([...log.read(from)].map((c) => c.data)).toString();

describe("StreamLog", () => {
  it("addresses every byte by its offset in the stream", () => {
    const log = StreamLog.open(tmp(), "out");
    expect(log.append(Buffer.from("hello "))).toBe(0);
    expect(log.append(Buffer.from("world"))).toBe(6);
    expect(log.offset).toBe(11);
    expect(text(log, 0)).toBe("hello world");
    expect(text(log, 6)).toBe("world");
    expect(text(log, 11)).toBe("");
    expect(text(log, 99)).toBe("");
    log.close();
  });

  it("keeps only the newest segments, and says where what it holds starts", () => {
    const log = StreamLog.open(tmp(), "out", { segmentBytes: 4, keep: 2 });
    for (const s of ["aaaa", "bbbb", "cccc", "dd"]) log.append(Buffer.from(s));
    expect(log.offset).toBe(14);
    expect(log.start).toBe(8);
    expect(text(log, 0)).toBe("ccccdd"); // from 0 is from what is left
    expect([...log.read(9)][0]!.offset).toBe(9);
    log.close();
  });

  it("picks up where it was after a reopen, as the relay does once the owner is gone", () => {
    const dir = tmp();
    const a = StreamLog.open(dir, "err", { segmentBytes: 5 });
    a.append(Buffer.from("12345"));
    a.append(Buffer.from("678"));
    a.close();
    const b = StreamLog.open(dir, "err", { segmentBytes: 5 });
    expect(b.offset).toBe(8);
    expect(text(b, 3)).toBe("45678");
    expect(b.append(Buffer.from("9"))).toBe(8);
    b.close();
  });

  it("steps over a hole a failed write left, and keeps counting offsets through it", () => {
    const dir = tmp();
    writeFileSync(join(dir, "out.0.log"), "abcd");
    writeFileSync(join(dir, "out.10.log"), "klm");
    const log = StreamLog.open(dir, "out");
    expect(log.offset).toBe(13);
    expect([...log.read(0)].map((p) => [p.offset, p.data.toString()])).toEqual([
      [0, "abcd"],
      [10, "klm"],
    ]);
    expect([...log.read(6)].map((p) => p.offset)).toEqual([10]);
    log.close();
  });

  it("never throws on a write that fails: the offset moves on and the next append starts a segment", () => {
    const dir = tmp();
    const log = StreamLog.open(join(dir, "missing", "deeper"), "out");
    const errors: unknown[] = [];
    // A file where the journal directory should be: every write fails.
    writeFileSync(join(dir, "missing"), "not a dir");
    expect(log.append(Buffer.from("lost"), (e) => errors.push(e))).toBe(0);
    expect(log.offset).toBe(4);
    expect(errors).toHaveLength(1);
    log.close();
  });

  it("reads in bounded pieces", () => {
    const log = StreamLog.open(tmp(), "out");
    log.append(Buffer.alloc(10, 0x41));
    const pieces = [...log.read(0, 4)];
    expect(pieces.map((p) => [p.offset, p.data.length])).toEqual([
      [0, 4],
      [4, 4],
      [8, 2],
    ]);
    log.close();
  });
});

describe("runs.jsonl", () => {
  it("reads back each run, skipping a line torn by a crash", () => {
    const f = join(tmp(), "runs.jsonl");
    appendRun(f, { t: "begin", runId: "r1", background: false, out: 0, err: 0, at: "x" });
    appendRun(f, { t: "end", runId: "r1", exitCode: 2, cwd: "/w", out: 10, err: 0, at: "y" });
    writeFileSync(f, '{"t":"begin","runId":"r2"', { flag: "a" });
    expect(readRuns(f).map((r) => `${r.t}:${r.runId}`)).toEqual(["begin:r1", "end:r1"]);
    expect(readRuns(join(tmp(), "none.jsonl"))).toEqual([]);
  });
});

describe("SentinelScanner", () => {
  const line = "CMTERMSENTINEL_abc123|7|False|/Users/dispatch/work|odd\n";

  it("finds core's probe line however the bytes were split", () => {
    const s = new SentinelScanner();
    const bytes = Buffer.from(`output\n${line}more`);
    const found = [];
    for (let i = 0; i < bytes.length; i += 5) found.push(...s.push(bytes.subarray(i, i + 5)));
    expect(found).toEqual([{ exitCode: 7, cwd: "/Users/dispatch/work|odd" }]);
  });

  it("decodes a multi-byte character split across chunks, and takes CRLF", () => {
    const s = new SentinelScanner();
    const bytes = Buffer.from("CMTERMSENTINEL_x|0|True|/tmp/é\r\n");
    const cut = bytes.indexOf(0xc3) + 1;
    expect([...s.push(bytes.subarray(0, cut)), ...s.push(bytes.subarray(cut))]).toEqual([{ exitCode: 0, cwd: "/tmp/é" }]);
  });

  it("ignores lookalikes and a line too long to be a probe", () => {
    const s = new SentinelScanner();
    expect(s.push(Buffer.from(`say CMTERMSENTINEL_x|0|True|/\nCMTERMSENTINEL_x|zero|True|/\n`))).toEqual([]);
    expect(s.push(Buffer.alloc(70_000, 0x41))).toEqual([]);
    expect(s.push(Buffer.from(`|0|True|/\n${line}`))).toEqual([{ exitCode: 7, cwd: "/Users/dispatch/work|odd" }]);
  });
});
