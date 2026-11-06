import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractTar, safeTarget } from "../src/tools/tar.js";
import { SH } from "./local-remote.js";

/** One tar entry, as tar writes it: a 512-byte header, then the data padded to 512. */
function entry(name: string, type: string, data: Buffer | string = "", opts: { prefix?: string; size?: number; linkname?: string } = {}): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, "ascii");
  h.write("0000000\0", 108, "ascii");
  h.write("0000000\0", 116, "ascii");
  h.write(`${(opts.size ?? body.length).toString(8).padStart(11, "0")}\0`, 124, "ascii");
  h.write("00000000000\0", 136, "ascii");
  h.write(type, 156, "ascii");
  if (opts.linkname) h.write(opts.linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  if (opts.prefix) h.write(opts.prefix, 345, 155, "utf8");
  h.write("        ", 148, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}

function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = rest.length + 1;
  while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
  return `${len}${rest}`;
}

const end = Buffer.alloc(1024);

describe("extractTar", () => {
  const work = mkdtempSync(join(tmpdir(), "rh-tar-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  let n = 0;
  const unpack = async (...parts: Buffer[]) => {
    const archive = join(work, `a${++n}.tar`);
    writeFileSync(archive, Buffer.concat([...parts, end]));
    const dest = join(work, `out${n}`);
    return { dest, r: await extractTar(archive, dest) };
  };

  it("writes files and folders, with ustar's prefix, a pax path and a GNU long name", async () => {
    const long = `${"d".repeat(120)}/deep.txt`;
    const { dest, r } = await unpack(
      entry("Run.xcresult/", "5"),
      entry("Run.xcresult/Info.plist", "0", "<plist/>"),
      entry("database.sqlite3", "0", "SQLITE", { prefix: "Run.xcresult/Data" }),
      entry("PaxHeaders/x", "x", paxRecord("path", "Run.xcresult/Data/a name with spaces.json")),
      entry("ignored-short-name", "0", "{}"),
      entry("././@LongLink", "L", `${long}\0`),
      entry(long.slice(0, 99), "0", "deep"),
      entry("Run.xcresult/empty", "0", ""),
    );
    expect(r).toMatchObject({ files: 5, dirs: 1, skipped: [] });
    expect(readFileSync(join(dest, "Run.xcresult", "Info.plist"), "utf8")).toBe("<plist/>");
    expect(readFileSync(join(dest, "Run.xcresult", "Data", "database.sqlite3"), "utf8")).toBe("SQLITE");
    expect(readFileSync(join(dest, "Run.xcresult", "Data", "a name with spaces.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(dest, "d".repeat(120), "deep.txt"), "utf8")).toBe("deep");
    expect(readFileSync(join(dest, "Run.xcresult", "empty"), "utf8")).toBe("");
    expect(r.bytes).toBe(8 + 6 + 2 + 4);
  });

  it("never writes outside the folder, nor a link, and says what it skipped", async () => {
    const { dest, r } = await unpack(
      entry("../escape.txt", "0", "no"),
      entry("/etc/abs.txt", "0", "no"),
      entry("ok/../../up.txt", "0", "no"),
      entry("link", "2", "", { linkname: "/etc/passwd" }),
      entry("hard", "1", "", { linkname: "ok.txt" }),
      entry("ok.txt", "0", "yes"),
    );
    expect(readdirSync(dest)).toEqual(["ok.txt"]);
    expect(existsSync(join(work, "escape.txt"))).toBe(false);
    expect(r.files).toBe(1);
    expect(r.skipped).toEqual([
      "../escape.txt (outside the folder)",
      "/etc/abs.txt (outside the folder)",
      "ok/../../up.txt (outside the folder)",
      "link (a symbolic link)",
      "hard (a hard link)",
    ]);
  });

  it("refuses what isn't a tar archive", async () => {
    const archive = join(work, "junk.tar");
    writeFileSync(archive, Buffer.alloc(1024, 7));
    await expect(extractTar(archive, join(work, "junk"))).rejects.toThrow(/not a tar archive/);
  });

  it("keeps a target inside the root, or gives none", () => {
    const root = join(work, "root");
    expect(safeTarget(root, "a/b.txt")).toBe(join(root, "a", "b.txt"));
    expect(safeTarget(root, "./a/./b")).toBe(join(root, "a", "b"));
    expect(safeTarget(root, "a/../../b")).toBeUndefined();
    expect(safeTarget(root, "C:/x")).toBeUndefined();
    expect(safeTarget(root, "a\\..\\..\\b")).toBeUndefined();
  });

  it.skipIf(!SH)("unpacks what a real tar made", async () => {
    const src = join(work, "src");
    mkdirSync(join(src, "Run.xcresult", "Data", "nested"), { recursive: true });
    writeFileSync(join(src, "Run.xcresult", "Info.plist"), "plist");
    writeFileSync(join(src, "Run.xcresult", "Data", "nested", `${"n".repeat(110)}.bin`), Buffer.alloc(70_000, 1));
    const archive = join(work, "real.tar");
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const r = spawnSync(SH!, ["-c", `cd '${fwd(src)}' && tar -cf - Run.xcresult > '${fwd(archive)}'`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const dest = join(work, "real");
    const got = await extractTar(archive, dest);
    expect(got).toMatchObject({ files: 2, skipped: [] });
    expect(readFileSync(join(dest, "Run.xcresult", "Info.plist"), "utf8")).toBe("plist");
    expect(readFileSync(join(dest, "Run.xcresult", "Data", "nested", `${"n".repeat(110)}.bin`)).length).toBe(70_000);
  });
});
