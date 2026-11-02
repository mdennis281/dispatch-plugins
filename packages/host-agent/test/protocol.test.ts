import { describe, expect, it } from "vitest";
import { F, FrameDecoder, MAX_FRAME, decodeJson, decodeOutput, encodeFrame, encodeOutput } from "../src/protocol.js";

describe("frames", () => {
  it("round-trip whatever pieces the transport cuts them into", () => {
    const bytes = Buffer.concat([
      encodeFrame(F.stdin, Buffer.from("echo hi\n")),
      encodeFrame(F.heartbeat),
      encodeFrame(F.runBegin, { runId: "r1", background: false }),
    ]);
    const dec = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < bytes.length; i += 3) frames.push(...dec.push(bytes.subarray(i, i + 3)));
    expect(frames.map((f) => f.type)).toEqual([F.stdin, F.heartbeat, F.runBegin]);
    expect(frames[0]!.payload.toString()).toBe("echo hi\n");
    expect(frames[1]!.payload.length).toBe(0);
    expect(decodeJson(frames[2]!.payload)).toEqual({ runId: "r1", background: false });
    expect(dec.pending).toBe(0);
  });

  it("carry the stream offset of each output chunk, splitting what is too big for one frame", () => {
    const data = Buffer.alloc(MAX_FRAME + 10, 0x61);
    const frames = encodeOutput(F.stdout, 1_000_000_000_000, data);
    expect(frames).toHaveLength(2);
    const dec = new FrameDecoder();
    const parts = frames.flatMap((f) => dec.push(f)).map((f) => decodeOutput(f.payload));
    expect(parts[0]!.offset).toBe(1_000_000_000_000);
    expect(parts[1]!.offset).toBe(1_000_000_000_000 + parts[0]!.data.length);
    expect(parts[0]!.data.length + parts[1]!.data.length).toBe(data.length);
  });

  it("encode an empty output chunk as one frame", () => {
    expect(encodeOutput(F.stderr, 7, Buffer.alloc(0))).toHaveLength(1);
  });

  it("refuse a frame that claims more than the limit: the stream is not this protocol", () => {
    const head = Buffer.alloc(5);
    head.writeUInt8(F.stdin, 0);
    head.writeUInt32BE(MAX_FRAME + 1, 1);
    expect(() => new FrameDecoder().push(head)).toThrow(/over the/);
    expect(() => encodeFrame(F.stdin, Buffer.alloc(MAX_FRAME + 1))).toThrow(/over the/);
  });
});
