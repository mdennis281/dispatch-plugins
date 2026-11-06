import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DROPPED, remoteFiles } from "../src/mcp/files.js";
import type { RemoteSide } from "../src/sync/remote.js";
import { SH, localRemote } from "./local-remote.js";

/** Paths as the machine's `sh` takes them (Git's sh on Windows reads C:/…). */
const fwd = (p: string) => p.replace(/\\/g, "/");

describe.skipIf(!SH)("remoteFiles (the machine played by the local sh)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-files-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files = remoteFiles(localRemote(), { maxBytes: 64 });

  it("copies a file there to here, through a temporary name", async () => {
    writeFileSync(join(dir, "there file.png"), "PNG");
    const to = join(dir, "here", "sub", "copy.png");
    expect(await files.fetch(fwd(join(dir, "there file.png")), to)).toBe(true);
    expect(readFileSync(to, "utf8")).toBe("PNG");
  });

  it("says false for no such file, and refuses one too big", async () => {
    expect(await files.fetch(fwd(join(dir, "missing.png")), join(dir, "x.png"))).toBe(false);
    writeFileSync(join(dir, "big.bin"), "x".repeat(100));
    await expect(files.fetch(fwd(join(dir, "big.bin")), join(dir, "y.bin"))).rejects.toThrow(/100 bytes, over the/);
  });

  it("stops when cancelled, and leaves no copy or temporary behind", async () => {
    writeFileSync(join(dir, "cancel.png"), "PNG");
    const to = join(dir, "cancelled", "copy.png");
    await expect(files.fetch(fwd(join(dir, "cancel.png")), to, AbortSignal.abort())).rejects.toThrow(/cancelled/);
    expect(existsSync(to)).toBe(false);
    expect(readdirSync(join(dir, "cancelled"))).toEqual([]);
  });

  it("copies a local file there, making its directory", async () => {
    writeFileSync(join(dir, "up me.txt"), "hello");
    const to = fwd(join(dir, "there", "uploads", "ab12", "up me.txt"));
    await files.upload(join(dir, "up me.txt"), to);
    expect(readFileSync(to, "utf8")).toBe("hello");
  });
});

describe("remoteFiles when a copy ends without an exit status", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-files-null-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  // Waits until it is stopped: what a copy that outlasts its time limit looks like.
  const hang: RemoteSide = { run, stream: (_s, _io, signal) => new Promise((res) => signal?.addEventListener("abort", () => res({ code: null, stderr: "" }))) };
  // Closes with no status though nobody stopped it: a dropped connection.
  const cut: RemoteSide = { run, stream: async () => ({ code: null, stderr: "" }) };

  it("says it took too long when its own time limit stopped it", async () => {
    writeFileSync(join(dir, "up.txt"), "x");
    const files = remoteFiles(hang, { timeoutMs: 1_500 });
    await expect(files.fetch("/x", join(dir, "slow.bin"))).rejects.toThrow("it took longer than 2 seconds, so it was stopped");
    await expect(files.upload(join(dir, "up.txt"), "/there/up.txt")).rejects.toThrow("it took longer than 2 seconds, so it was stopped");
    expect(readdirSync(dir).filter((n) => n.includes(".part-"))).toEqual([]);
  });

  it("says the connection dropped when nothing stopped it", async () => {
    const files = remoteFiles(cut);
    await expect(files.fetch("/x", join(dir, "cut.bin"))).rejects.toThrow(DROPPED);
    await expect(files.upload(join(dir, "up.txt"), "/there/up.txt")).rejects.toThrow(DROPPED);
    expect(readdirSync(dir).filter((n) => n.includes(".part-"))).toEqual([]);
  });
});
