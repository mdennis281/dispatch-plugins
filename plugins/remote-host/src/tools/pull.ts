/**
 * Copy a file or a whole folder (an .xcresult bundle, a test report) from a
 * machine to here, for `remote_fetch`. A file comes as itself; a folder as a
 * tar stream, unpacked here by tar.ts. Either way it lands under a temporary
 * name first and is moved into place whole, so `to` is never half written.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname } from "node:path";
import { Transform } from "node:stream";
import { sq } from "@dispatch-plugins/host-agent";
import type { RemoteSide } from "../sync/remote.js";
import { DROPPED, remoteFiles } from "../mcp/files.js";
import { extractTar, type Unpacked } from "./tar.js";

/** The most `remote_fetch` copies at once. An xcresult can be big; a DerivedData folder isn't the tool's to move. */
export const MAX_PULL_BYTES = 1024 * 1024 * 1024;
const PULL_MS = 20 * 60_000;

export type Found = { kind: "file"; bytes: number } | { kind: "dir"; bytes: number } | { kind: "other" } | { kind: "missing" };

/** What is at `path` there, and how big. A folder's size is `du`'s, so roughly. */
export async function look(remote: RemoteSide, path: string): Promise<Found> {
  const r = await remote.run(
    [
      `p=${sq(path)}`,
      `if [ -d "$p" ]; then printf 'd %s\\n' "$(du -sk "$p" | cut -f1)"`,
      `elif [ -f "$p" ]; then printf 'f %s\\n' "$(wc -c < "$p" | tr -d ' ')"`,
      `elif [ -e "$p" ] || [ -L "$p" ]; then echo o`,
      `else echo n; fi`,
    ].join("\n"),
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) throw new Error(r.code === null ? "the connection to the machine dropped" : r.stderr.trim() || `exit ${r.code}`);
  const m =/^([dfon])(?: (\d+))?/.exec(r.stdout.trim());
  if (!m) throw new Error(`unexpected answer: ${r.stdout.trim().slice(0, 80)}`);
  if (m[1] === "d") return { kind: "dir", bytes: Number(m[2] ?? 0) * 1024 };
  if (m[1] === "f") return { kind: "file", bytes: Number(m[2] ?? 0) };
  return { kind: m[1] === "o" ? "other" : "missing" };
}

export interface Pulled {
  kind: "file" | "dir";
  bytes: number;
  /** A folder's unpacking: files, folders, what was skipped. */
  unpacked?: Unpacked;
}

/**
 * Copy `from` there to `to` here, replacing whatever is at `to` (the caller
 * has made sure that's allowed). `found` is {@link look}'s answer for `from`.
 */
export async function pull(
  remote: RemoteSide,
  from: string,
  found: Found,
  to: string,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Pulled> {
  const max = opts.maxBytes ?? MAX_PULL_BYTES;
  if (found.kind === "missing") throw new Error(`there is nothing at ${from}`);
  if (found.kind === "other") throw new Error(`${from} is neither a file nor a folder`);
  if (found.bytes > max) throw new Error(`it is ${mb(found.bytes)}, over the ${mb(max)} one copy may be`);
  await mkdir(dirname(to), { recursive: true });
  const part = `${to}.part-${process.pid}-${Date.now().toString(36)}`;
  try {
    if (found.kind === "file") {
      const files = remoteFiles(remote, { maxBytes: max, timeoutMs: PULL_MS });
      if (!(await files.fetch(from, part, opts.signal))) throw new Error(`${from} went away while it was being copied`);
      cancelled(opts.signal);
      await replace(part, to);
      return { kind: "file", bytes: (await stat(to)).size };
    }
    const archive = `${part}.tar`;
    try {
      await streamTar(remote, from, archive, max, opts.signal);
      const unpacked = await extractTar(archive, part, opts.signal);
      cancelled(opts.signal);
      await replace(part, to);
      return { kind: "dir", bytes: unpacked.bytes, unpacked };
    } finally {
      await rm(archive, { force: true });
    }
  } finally {
    await rm(part, { recursive: true, force: true });
  }
}

/** `tar` the folder there into `archive` here, stopping past `max` bytes. */
async function streamTar(remote: RemoteSide, from: string, archive: string, max: number, signal?: AbortSignal): Promise<void> {
  const out = createWriteStream(archive);
  const closed = once(out, "close").catch(() => undefined);
  let seen = 0;
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, PULL_MS);
  const counter = new Transform({
    transform(c: Buffer, _enc, cb) {
      seen += c.length;
      if (seen > max + 1024 * 1024) stop();
      cb(null, c);
    },
  });
  counter.pipe(out);
  // COPYFILE_DISABLE: macOS's tar would add ._ files for extended attributes.
  // From inside the folder, so the entries are its contents (./…), unpacked straight into `to`.
  const script = `cd ${sq(from)} && COPYFILE_DISABLE=1 exec tar -cf - .`;
  let r: { code: number | null; stderr: string };
  try {
    r = await remote.stream(script, { output: counter }, abort.signal);
  } catch (err) {
    counter.destroy();
    out.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    // The channel normally ends the pipe; one closed by a dropped connection may not.
    if (!counter.writableEnded && !counter.destroyed) counter.end();
    await closed;
  }
  if (seen > max + 1024 * 1024) throw new Error(`it grew past the ${mb(max)} one copy may be while it was copied`);
  if (signal?.aborted) throw new Error("cancelled");
  if (r.code === null) throw new Error(DROPPED);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").slice(-3).join("; ") || `tar exited ${r.code}`);
}

/** A cancelled call replaces nothing: what is at `to` stays, and the copy is dropped. */
function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("cancelled; nothing was replaced");
}

/** Move `part` to `to`, removing what `to` was. */
async function replace(part: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await rename(part, to);
}

export function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(bytes >= 100 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The name a pulled path gets here when no `to` is given. */
export function localName(from: string): string {
  return basename(from.replace(/\/+$/, "")) || "fetched";
}
