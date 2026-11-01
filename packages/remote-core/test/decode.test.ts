/**
 * Text that crosses a chunk boundary. SSH channels hand over bytes in
 * whatever pieces the transport made, and a multi-byte UTF-8 character
 * (é, €, an emoji, a box-drawing line from a test reporter) is routinely cut
 * in two. Decoding each piece on its own turns both halves into U+FFFD.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RemoteShell, SshConnection } from "../src/index.js";

/** "é" is C3 A9; "€" is E2 82 AC. Each split mid-character. */
const pieces = [Buffer.from([0x68, 0xc3]), Buffer.from([0xa9, 0x20, 0xe2]), Buffer.from([0x82, 0xac, 0x0a])];
const text = "hé €\n";

function channel() {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    write: () => true,
    end() {},
    close() {},
  });
}

describe("UTF-8 split across chunks", () => {
  it("a shell's stdout and stderr come through whole", () => {
    const ch = channel();
    const sh = new RemoteShell(ch as never, "/w", () => {});
    const out: string[] = [];
    const err: string[] = [];
    sh.stdout.on("data", (s: string) => out.push(s));
    sh.stderr.on("data", (s: string) => err.push(s));
    ch.emit("data", Buffer.from("DTPID:7\n"));
    for (const p of pieces) ch.emit("data", p);
    for (const p of pieces) ch.stderr.emit("data", p);
    expect(out.join("")).toBe(text);
    expect(err.join("")).toBe(text);
  });

  it("a shell flushes a character still pending when it exits", () => {
    const ch = channel();
    const sh = new RemoteShell(ch as never, "/w", () => {});
    const out: string[] = [];
    sh.stdout.on("data", (s: string) => out.push(s));
    ch.emit("data", Buffer.from("DTPID:7\n"));
    ch.emit("data", Buffer.from([0xe2, 0x82]));
    ch.emit("exit", 0);
    // A truncated character is still reported, once, as the replacement.
    expect(out.join("")).toBe("�");
  });

  it("exec's stdout and stderr come through whole", async () => {
    const conn = new SshConnection({ host: "h", username: "u" });
    const client = {
      exec(_cmd: string, cb: (err: undefined, ch: ReturnType<typeof channel>) => void) {
        const ch = channel();
        cb(undefined, ch);
        setImmediate(() => {
          for (const p of pieces) ch.emit("data", p);
          for (const p of pieces) ch.stderr.emit("data", p);
          ch.emit("exit", 0);
          ch.emit("close");
        });
      },
    };
    Object.assign(conn as unknown as { client: unknown }, { client });
    const r = await conn.exec("printf 'hé €'");
    expect(r).toEqual({ code: 0, stdout: text, stderr: text });
  });
});
