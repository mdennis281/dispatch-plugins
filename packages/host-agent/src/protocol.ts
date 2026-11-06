/**
 * The wire between the remote-host plugin and `dispatch-host session`.
 *
 * The SSH exec channel carries binary frames both ways instead of a bare
 * shell's stdio. A bare stdio can't say "this byte was the 41 233rd one the
 * shell ever wrote", and a dropped connection could only reset the shell. Each
 * frame is
 *
 *   [type: u8][length: u32 BE][payload: length bytes]
 *
 * Output frames start their payload with the stream offset of their first byte
 * (u64 BE). A client that re-attaches after a drop says how far it got, and the
 * owner replays from there out of its journal. Nothing is lost and nothing
 * arrives twice.
 *
 * The relay under sshd never parses the plugin's frames. It writes its own
 * ATTACH frame first, then pipes bytes both ways.
 */

export const PROTOCOL_VERSION = 1;

/** The largest payload either side sends. Output is chunked below it. */
export const MAX_FRAME = 1 << 20;

/** Frame types. Plugin → host below 0x80, host → plugin from 0x80. */
export const F = {
  /** Raw bytes for the shell's stdin. */
  stdin: 0x01,
  /** Close the shell's stdin (core's teardown). */
  stdinEnd: 0x02,
  /** "Dispatch is still here." Any frame counts, this one carries nothing else. */
  heartbeat: 0x03,
  /** JSON {@link SignalMsg}: deliver a signal to the session. */
  signal: 0x04,
  /** JSON {@link RunBeginMsg}: a command is about to be written. Journaled. */
  runBegin: 0x05,
  /** Leaving on purpose. The session keeps running until the heartbeat lapses. */
  detach: 0x06,
  /** End the session now: kill its whole tree. */
  kill: 0x07,
  /** u8 stream (1 out, 2 err) + u8 id length + id + bytes: output of an elevated command, for `dispatch-elevate`. */
  elevateOutput: 0x08,
  /** JSON {@link ElevateEndMsg}: the elevated command is over (or never ran). */
  elevateEnd: 0x09,
  /** JSON {@link AttachMsg}. Written by the relay, first, on every connection. */
  attach: 0x10,
  /** JSON {@link ElevateMsg}. Written first by `dispatch-elevate` on its own connection to the owner's socket. */
  elevate: 0x11,

  /** JSON {@link ReadyMsg}: attached; replay follows. */
  ready: 0x81,
  /** u64 offset + bytes the shell wrote to stdout. */
  stdout: 0x82,
  /** u64 offset + bytes the shell wrote to stderr. */
  stderr: 0x83,
  /** JSON {@link ExitMsg}: the session is over. */
  exit: 0x84,
  /** Answer to a heartbeat. */
  heartbeatAck: 0x85,
  /** JSON {@link ErrorMsg}: the session could not start or attach. The relay exits after it. */
  error: 0x86,
  /** JSON {@link RunEndMsg}: the journal saw a run's sentinel. */
  runEnd: 0x87,
  /** JSON {@link ElevateRequestMsg}: a command in the shell asks to run something as root. */
  elevateRequest: 0x88,
  /** JSON {@link ElevateCancelMsg}: whoever asked has gone (Ctrl-C); stop asking, stop running. */
  elevateCancel: 0x89,
  /** Owner → `dispatch-elevate`: u8 stream (1 out, 2 err) + bytes. */
  elevateData: 0x8a,
  /** Owner → `dispatch-elevate`: JSON {@link ElevateEndMsg} without the id. */
  elevateDone: 0x8b,
} as const;

export type FrameType = (typeof F)[keyof typeof F];

export interface Frame {
  type: number;
  payload: Buffer;
}

export interface AttachMsg {
  v: number;
  /** How many bytes of each stream the client already has. Absent on a fresh start. */
  resume?: { out: number; err: number };
}

export interface ReadyMsg {
  v: number;
  sid: string;
  /** The shell's pid on the host, which is also its session id. */
  pid: number;
  agentVersion: string;
  cwd: string;
  /** Stream offsets now. The replay brings the client from its resume point up to them. */
  out: number;
  err: number;
  /** True when this attach continued an existing session rather than starting it. */
  resumed: boolean;
  /**
   * Where the replay really starts, when the journal no longer holds what the
   * client asked for (it rotated). The client missed the bytes in between.
   */
  gap?: { out?: number; err?: number };
}

export type ExitReason =
  /** The shell itself ended. */
  | "exited"
  /** Dispatch asked (a KILL frame, or `dispatch-host kill`). */
  | "killed"
  /** No heartbeat within the timeout. */
  | "heartbeat"
  /** No Dispatch in contact with this instance for too long. */
  | "dead-man"
  /** The shell never started. */
  | "start-failed";

export interface ExitMsg {
  code: number | null;
  signal: string | null;
  reason: ExitReason;
  detail?: string;
}

export type ErrorCode =
  /** The working directory does not exist on the host. Never `cd ~` instead. */
  | "no-cwd"
  /** A resume was asked for a session the host no longer has. */
  | "gone"
  | "bad-args"
  | "start"
  | "protocol";

export interface ErrorMsg {
  code: ErrorCode;
  message: string;
}

export interface SignalMsg {
  signal: string;
}

export interface RunBeginMsg {
  runId: string;
  background: boolean;
}

export interface RunEndMsg {
  runId: string;
  exitCode: number;
  cwd: string;
}

/**
 * Elevation: `dispatch-elevate` (or the `sudo` shim) in a chat shell asks to
 * run a command as root. It connects to its session's owner and sends
 * {@link ElevateMsg}; the owner gives it an id and passes it up the session's
 * channel as {@link ElevateRequestMsg}. The plugin asks the human, and only on
 * approval runs it over a separate connection the agent's account has no key
 * for. Nothing here can elevate anything: it only carries the question and
 * the answer.
 */
export interface ElevateMsg {
  argv: string[];
  cwd: string;
}

export interface ElevateRequestMsg extends ElevateMsg {
  id: string;
}

export interface ElevateCancelMsg {
  id: string;
}

export interface ElevateEndMsg {
  id: string;
  /** The command's exit code; null when it never ran or was killed. */
  code: number | null;
  signal?: string | null;
  /** Why it didn't run, or didn't finish: denied, timed out, not set up. Printed by `dispatch-elevate`. */
  error?: string;
}

/** Most argv (bytes, all arguments together) an elevation may carry. */
export const MAX_ELEVATE_ARGV = 32 * 1024;

/** Ids the owner hands out: also safe in a forced command's argument list. */
export const ELEVATE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** An {@link ElevateMsg} as the owner accepts it, or a throw naming what is wrong. */
export function checkElevate(m: unknown): ElevateMsg {
  const o = m as Partial<ElevateMsg> | null;
  if (!o || typeof o !== "object") throw new Error("not an elevation request");
  if (!Array.isArray(o.argv) || !o.argv.length || !o.argv.every((a) => typeof a === "string")) throw new Error("argv must be a non-empty list of strings");
  if (o.argv.some((a) => a.includes("\0"))) throw new Error("an argument holds a NUL byte");
  if (!o.argv[0]) throw new Error("the command is empty");
  if (Buffer.byteLength(o.argv.join("\0"), "utf8") > MAX_ELEVATE_ARGV) throw new Error(`the command is longer than ${MAX_ELEVATE_ARGV} bytes`);
  if (typeof o.cwd !== "string" || !o.cwd.startsWith("/") || o.cwd.includes("\0")) throw new Error("cwd must be an absolute path");
  return { argv: [...o.argv], cwd: o.cwd };
}

/** An elevateOutput frame: which request, which stream, what bytes. */
export function encodeElevateOutput(id: string, stream: 1 | 2, data: Buffer): Buffer[] {
  const idBytes = Buffer.from(id, "utf8");
  if (idBytes.length > 255) throw new Error("elevation id too long");
  const head = Buffer.concat([Buffer.from([stream, idBytes.length]), idBytes]);
  const room = MAX_FRAME - head.length;
  const frames: Buffer[] = [];
  let at = 0;
  do {
    frames.push(encodeFrame(F.elevateOutput, Buffer.concat([head, data.subarray(at, at + room)])));
    at += room;
  } while (at < data.length);
  return frames;
}

export function decodeElevateOutput(payload: Buffer): { id: string; stream: 1 | 2; data: Buffer } {
  if (payload.length < 2) throw new Error("elevation output frame too short");
  const stream = payload.readUInt8(0);
  const len = payload.readUInt8(1);
  if (stream !== 1 && stream !== 2) throw new Error(`elevation output for stream ${stream}`);
  if (payload.length < 2 + len) throw new Error("elevation output frame shorter than its id");
  return { id: payload.subarray(2, 2 + len).toString("utf8"), stream, data: payload.subarray(2 + len) };
}

/** One frame. `payload` may be bytes, text, or an object sent as JSON. */
export function encodeFrame(type: number, payload: Buffer | string | object = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  if (body.length > MAX_FRAME) throw new Error(`frame of ${body.length} bytes is over the ${MAX_FRAME}-byte limit`);
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/**
 * Output frames for `data`, which starts at stream offset `offset`. More than
 * one when `data` is bigger than a frame may carry.
 */
export function encodeOutput(type: number, offset: number, data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const room = MAX_FRAME - 8;
  let at = 0;
  do {
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(BigInt(offset + at), 0);
    frames.push(encodeFrame(type, Buffer.concat([head, data.subarray(at, at + room)])));
    at += room;
  } while (at < data.length);
  return frames;
}

/** The offset and bytes of an output frame's payload. */
export function decodeOutput(payload: Buffer): { offset: number; data: Buffer } {
  if (payload.length < 8) throw new Error("output frame shorter than its offset");
  return { offset: Number(payload.readBigUInt64BE(0)), data: payload.subarray(8) };
}

/** A JSON payload, typed by the caller. */
export function decodeJson<T>(payload: Buffer): T {
  return JSON.parse(payload.toString("utf8")) as T;
}

/**
 * Turns a byte stream back into frames, whatever pieces the transport cut it
 * into. A frame claiming more than {@link MAX_FRAME} means the stream is not
 * this protocol (or is corrupt); `push` throws and the caller drops it.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes is over the ${MAX_FRAME}-byte limit`);
      if (this.buf.length < 5 + len) break;
      frames.push({ type: this.buf.readUInt8(0), payload: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return frames;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.buf.length;
  }
}
