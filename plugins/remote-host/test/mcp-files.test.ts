import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { remoteFiles } from "../src/mcp/files.js";
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

  it("copies a local file there, making its directory", async () => {
    writeFileSync(join(dir, "up me.txt"), "hello");
    const to = fwd(join(dir, "there", "uploads", "ab12", "up me.txt"));
    await files.upload(join(dir, "up me.txt"), to);
    expect(readFileSync(to, "utf8")).toBe("hello");
  });
});
