/**
 * Unpack a tar archive (what `tar -cf -` made on the machine: bsdtar's
 * ustar/pax on a Mac, GNU tar on Linux) into a directory here. Only regular
 * files and directories are written. Links, devices and anything named
 * outside `dest` are skipped and listed, so an archive can never write
 * anywhere but under `dest`, nor through a link it planted.
 *
 * It reads a file, not a stream: the archive was copied whole first, so a cut
 * connection never leaves half an unpacked tree.
 */
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const BLOCK = 512;

export interface Unpacked {
  files: number;
  dirs: number;
  bytes: number;
  /** Entries not written, with why. */
  skipped: string[];
}

export async function extractTar(archive: string, dest: string, signal?: AbortSignal): Promise<Unpacked> {
  const out: Unpacked = { files: 0, dirs: 0, bytes: 0, skipped: [] };
  const root = resolve(dest);
  await mkdir(root, { recursive: true });
  const fh = await open(archive, "r");
  try {
    let pos = 0;
    // Set by a pax header (`x`) or a GNU long name (`L`), for the entry after it.
    let nextPath: string | undefined;
    let nextSize: number | undefined;
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      const h = await readExact(fh, pos, BLOCK);
      if (!h) break; // a truncated archive ends where it ends; what was whole is kept
      if (h.every((b) => b === 0)) break;
      pos += BLOCK;
      if (!checksumOk(h)) throw new Error(`not a tar archive (a bad header at byte ${pos - BLOCK})`);
      const type = String.fromCharCode(h[156] || 48);
      const size = nextSize ?? octal(h, 124, 12);
      const dataAt = pos;
      pos += Math.ceil(size / BLOCK) * BLOCK;

      if (type === "g") continue; // global pax: nothing in it changes where a file goes
      if (type === "x") {
        const rec = pax((await readExact(fh, dataAt, size)) ?? Buffer.alloc(0));
        if (rec.path !== undefined) nextPath = rec.path;
        if (rec.size !== undefined && /^\d+$/.test(rec.size)) {
          nextSize = Number(rec.size);
        }
        continue;
      }
      if (type === "L") {
        nextPath = cstr((await readExact(fh, dataAt, size)) ?? Buffer.alloc(0), 0, size);
        continue;
      }
      if (type === "K") continue; // a GNU long link name: links are skipped anyway

      const prefix = cstr(h, 345, 155);
      const name = nextPath ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
      nextPath = undefined;
      nextSize = undefined;
      const shown = name.replace(/^(\.\/)+/, "");

      const target = safeTarget(root, name);
      if (!target) {
        out.skipped.push(`${shown} (outside the folder)`);
        continue;
      }
      if (type === "5") {
        if (target !== root) {
          await mkdir(target, { recursive: true });
          out.dirs++;
        }
        continue;
      }
      if (type !== "0" && type !== "7") {
        out.skipped.push(`${shown} (${KINDS[type] ?? `type ${type}`})`);
        continue;
      }
      if (target === root) {
        out.skipped.push(`${shown || name} (no name)`);
        continue;
      }
      await mkdir(resolve(target, ".."), { recursive: true });
      await copyRange(fh, dataAt, size, target);
      out.files++;
      out.bytes += size;
    }
  } finally {
    await fh.close();
  }
  return out;
}

const KINDS: Record<string, string> = { "1": "a hard link", "2": "a symbolic link", "3": "a device", "4": "a device", "6": "a pipe" };

/** Where `name` lands under `root`, or undefined if it would land anywhere else. */
export function safeTarget(root: string, name: string): string | undefined {
  const clean = name.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) return undefined;
  const parts = clean.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return undefined;
  const target = resolve(join(root, ...parts));
  return target === root || target.startsWith(root + sep) ? target : undefined;
}

async function readExact(fh: FileHandle, at: number, n: number): Promise<Buffer | undefined> {
  const buf = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const { bytesRead } = await fh.read(buf, got, n - got, at + got);
    if (bytesRead === 0) return undefined;
    got += bytesRead;
  }
  return buf;
}

async function copyRange(fh: FileHandle, at: number, size: number, to: string): Promise<void> {
  const w = await open(to, "w");
  try {
    const chunk = Buffer.alloc(Math.min(size, 1 << 20) || 1);
    let done = 0;
    while (done < size) {
      const n = Math.min(chunk.length, size - done);
      const { bytesRead } = await fh.read(chunk, 0, n, at + done);
      if (bytesRead === 0) throw new Error(`the archive ends inside ${to}`);
      await w.write(chunk, 0, bytesRead);
      done += bytesRead;
    }
  } finally {
    await w.close();
  }
}

function cstr(b: Buffer, at: number, len: number): string {
  const s = b.subarray(at, at + len);
  const z = s.indexOf(0);
  return s.subarray(0, z === -1 ? s.length : z).toString("utf8");
}

/** A numeric header field: octal text, or GNU's base-256 for big values (high bit set). */
function octal(b: Buffer, at: number, len: number): number {
  if (b[at]! & 0x80) {
    let n = 0;
    for (let i = at + 1; i < at + len; i++) n = n * 256 + b[i]!;
    return n;
  }
  const s = cstr(b, at, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h: Buffer): boolean {
  const want = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === want;
}

/** pax records: `<len> <key>=<value>\n`. */
function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number(data.subarray(i, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}
