/**
 * The session journal: every byte the shell wrote, addressable by its offset in
 * the stream, plus one line per run with its exit code. It is what lets a
 * dropped connection RESUME. The client says "I have 41 233 bytes of stdout",
 * and gets byte 41 233 onwards. The run that was in flight still reports its
 * real exit code instead of `transport lost, outcome unknown`.
 *
 * Output is kept in segments so a dev server that logs for days can't fill the
 * disk. Only the newest `keep` segments are kept. A client that was gone
 * long enough to miss the dropped ones is told where the replay really starts.
 *
 * A write that fails (a full disk) never takes the session down: the offset
 * still advances, the bytes are simply not journaled, and the next append
 * starts a new segment. A replay steps over that hole, and the client sees
 * the offsets jump.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface StreamLogOptions {
  /** Start a new segment once the current one holds this much. Default 8 MiB. */
  segmentBytes?: number;
  /** Segments kept, newest first. Default 2. */
  keep?: number;
}

interface Segment {
  base: number;
  file: string;
  size: number;
}

/** One output stream's journal: `<name>.<base offset>.log` files in `dir`. */
export class StreamLog {
  private segments: Segment[] = [];
  private fd?: number;
  /** The offset of the next byte. Ahead of the segments after a failed write. */
  private next = 0;
  /** The last write failed: start a fresh segment rather than append after a hole. */
  private broken = false;
  private readonly segmentBytes: number;
  private readonly keep: number;

  private constructor(
    private readonly dir: string,
    private readonly name: string,
    opts: StreamLogOptions,
  ) {
    this.segmentBytes = opts.segmentBytes ?? 8 * 1024 * 1024;
    this.keep = Math.max(1, opts.keep ?? 2);
  }

  /** Open (or create) the journal in `dir`, picking up whatever segments are there. */
  static open(dir: string, name: string, opts: StreamLogOptions = {}): StreamLog {
    const log = new StreamLog(dir, name, opts);
    const re = new RegExp(`^${name}\\.(\\d+)\\.log$`);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const m = re.exec(f);
        if (!m) continue;
        const file = join(dir, f);
        const fd = openSync(file, "r");
        const size = fstatSync(fd).size;
        closeSync(fd);
        log.segments.push({ base: Number(m[1]), file, size });
      }
    }
    log.segments.sort((a, b) => a.base - b.base);
    const last = log.segments.at(-1);
    log.next = last ? last.base + last.size : 0;
    return log;
  }

  /** The offset the next byte will have: how many bytes the stream has ever had. */
  get offset(): number {
    return this.next;
  }

  /** The oldest offset still held. */
  get start(): number {
    return this.segments[0]?.base ?? this.offset;
  }

  /**
   * Append `data`; returns the offset of its first byte. Never throws: a
   * failed write is reported to `onError` and leaves a hole.
   */
  append(data: Buffer, onError?: (err: unknown) => void): number {
    const at = this.next;
    if (!data.length) return at;
    this.next += data.length;
    try {
      let cur = this.segments.at(-1);
      if (!cur || cur.size >= this.segmentBytes || this.broken) {
        this.closeFd();
        mkdirSync(this.dir, { recursive: true });
        cur = { base: at, file: join(this.dir, `${this.name}.${at}.log`), size: 0 };
        this.segments.push(cur);
        this.broken = false;
        while (this.segments.length > this.keep) rmSync(this.segments.shift()!.file, { force: true });
      }
      if (this.fd === undefined) this.fd = openSync(cur.file, "a");
      for (let done = 0; done < data.length; ) {
        const n = writeSync(this.fd, data, done);
        done += n;
        cur.size += n;
      }
    } catch (err) {
      this.broken = true;
      this.closeFd();
      onError?.(err);
    }
    return at;
  }

  private closeFd(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      /* already gone */
    }
    this.fd = undefined;
  }

  /**
   * Everything from `from` on, in pieces of at most `maxChunk` bytes. Starts
   * at {@link start} when `from` is older than what is held.
   */
  *read(from: number, maxChunk = 256 * 1024): Generator<{ offset: number; data: Buffer }> {
    let at = Math.max(from, this.start);
    for (const seg of this.segments) {
      const end = seg.base + seg.size;
      if (end <= at) continue;
      if (seg.base > at) at = seg.base; // a hole a failed write left
      const fd = openSync(seg.file, "r");
      try {
        while (at < end) {
          const n = Math.min(maxChunk, end - at);
          const buf = Buffer.alloc(n);
          const got = readSync(fd, buf, 0, n, at - seg.base);
          if (got <= 0) break;
          yield { offset: at, data: buf.subarray(0, got) };
          at += got;
        }
      } finally {
        closeSync(fd);
      }
    }
  }

  close(): void {
    this.closeFd();
  }
}

/** One line of `runs.jsonl`. */
export type RunEntry =
  | { t: "begin"; runId: string; background: boolean; out: number; err: number; at: string }
  | { t: "end"; runId: string; exitCode: number; cwd: string; out: number; err: number; at: string };

export function appendRun(file: string, entry: RunEntry): void {
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

/** Every readable line of `runs.jsonl`, in order. A torn last line is skipped. */
export function readRuns(file: string): RunEntry[] {
  if (!existsSync(file)) return [];
  const out: RunEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RunEntry);
    } catch {
      /* torn by a crash mid-write */
    }
  }
  return out;
}

/**
 * Core's probe line: `CMTERMSENTINEL_<nonce>|<exit>|<True|False>|<cwd>`. The
 * cwd is last because a path may itself contain `|`.
 */
const SENTINEL = /^CMTERMSENTINEL_[A-Za-z0-9_-]+\|(-?\d+)\|(?:True|False)\|(.*)$/;

/** The longest line kept while waiting for its newline. Sentinel lines are short. */
const MAX_LINE = 64 * 1024;

/**
 * Finds core's sentinel lines in stdout, however the bytes were split. Only
 * reads the stream: the bytes still go to the client untouched, and core's
 * own parser is what resolves the run.
 */
export class SentinelScanner {
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  /** Inside a line longer than {@link MAX_LINE}: skip to its end. */
  private skipping = false;

  push(data: Buffer): Array<{ exitCode: number; cwd: string }> {
    const found: Array<{ exitCode: number; cwd: string }> = [];
    let text = this.decoder.write(data);
    while (text) {
      const nl = text.indexOf("\n");
      if (nl < 0) {
        if (!this.skipping) {
          this.line += text;
          if (this.line.length > MAX_LINE) {
            this.line = "";
            this.skipping = true;
          }
        }
        break;
      }
      if (!this.skipping) {
        const m = SENTINEL.exec((this.line + text.slice(0, nl)).replace(/\r$/, ""));
        if (m) found.push({ exitCode: Number(m[1]), cwd: m[2]! });
      }
      this.line = "";
      this.skipping = false;
      text = text.slice(nl + 1);
    }
    return found;
  }
}
