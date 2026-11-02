/**
 * The machine's side of one session channel, played by the test: frames the
 * plugin wrote are decoded into `sent`, and `ready`/`out`/`exit`… send what
 * dispatch-host would.
 */
import { EventEmitter } from "node:events";
import { F, FrameDecoder, decodeJson, encodeFrame, encodeOutput, type ExitMsg, type ReadyMsg } from "@dispatch-plugins/host-agent";
import type { SessionChannel, SessionOpener } from "../src/session.js";

export interface SentFrame {
  type: number;
  payload: Buffer;
  json?: unknown;
}

export class FakeChannel extends EventEmitter implements SessionChannel {
  readonly stderr = new EventEmitter();
  readonly sent: SentFrame[] = [];
  ended = false;
  closed = false;
  private readonly decoder = new FrameDecoder();

  write(data: Buffer): boolean {
    for (const f of this.decoder.push(data)) {
      let json: unknown;
      if (f.payload.length && f.type !== F.stdin) {
        try {
          json = decodeJson(f.payload);
        } catch {
          /* binary */
        }
      }
      this.sent.push({ type: f.type, payload: f.payload, ...(json !== undefined ? { json } : {}) });
    }
    return true;
  }

  end(): void {
    this.ended = true;
  }

  close(): void {
    this.drop();
  }

  /** The connection went away. */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  ready(m: Partial<ReadyMsg> = {}): void {
    const msg: ReadyMsg = { v: 1, sid: "s", pid: 4242, agentVersion: "0.1.0", cwd: "/Users/dispatch/x", out: 0, err: 0, resumed: false, ...m };
    this.emit("data", encodeFrame(F.ready, msg));
  }

  out(offset: number, text: string | Buffer, type: number = F.stdout): void {
    for (const f of encodeOutput(type, offset, Buffer.isBuffer(text) ? text : Buffer.from(text))) this.emit("data", f);
  }

  exit(m: Partial<ExitMsg> = {}): void {
    this.emit("data", encodeFrame(F.exit, { code: 0, signal: null, reason: "exited", ...m }));
  }

  error(code: string, message: string): void {
    this.emit("data", encodeFrame(F.error, { code, message }));
  }

  /** Text of every STDIN frame, in order. */
  stdinText(): string {
    return Buffer.concat(this.sent.filter((f) => f.type === F.stdin).map((f) => f.payload)).toString("utf8");
  }

  types(): number[] {
    return this.sent.map((f) => f.type);
  }
}

/** An opener handing out fresh fake channels, and recording how each was asked for. */
export function fakeOpener(opts: { fail?: () => Error | undefined } = {}) {
  const channels: FakeChannel[] = [];
  const resumes: Array<{ out: number; err: number } | undefined> = [];
  let killedDetached = 0;
  const opener: SessionOpener = {
    open: async (resume) => {
      resumes.push(resume);
      const err = opts.fail?.();
      if (err) throw err;
      const ch = new FakeChannel();
      channels.push(ch);
      return ch;
    },
    killDetached: () => {
      killedDetached++;
    },
  };
  return {
    opener,
    channels,
    resumes,
    get killedDetached() {
      return killedDetached;
    },
    /** Wait for the n-th channel (1-based) to be opened. */
    async nth(n: number, timeoutMs = 2_000): Promise<FakeChannel> {
      const until = Date.now() + timeoutMs;
      while (channels.length < n) {
        if (Date.now() > until) throw new Error(`channel ${n} was never opened (have ${channels.length})`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return channels[n - 1]!;
    },
  };
}
