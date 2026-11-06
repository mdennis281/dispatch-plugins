/**
 * Copying files between this computer and a machine for the MCP bridge, on a
 * channel of their own (the sync's `RemoteSide.stream`), so a big trace never
 * holds the control connection. Both ways go to a temporary name first and
 * are renamed into place, so nobody reads half a file.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { dirname, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { sq } from "@dispatch-plugins/host-agent";
import type { RemoteSide } from "../sync/remote.js";
import type { BridgeFiles } from "./bridge.js";

/** The biggest file copied either way. A browser's trace can be large; a build output isn't the bridge's to move. */
export const MAX_COPY_BYTES = 200 * 1024 * 1024;
/** How long one copy may take. */
const COPY_MS = 5 * 60_000;

const NO_FILE = 3;
const TOO_BIG = 4;

export function remoteFiles(remote: RemoteSide, opts: { maxBytes?: number; timeoutMs?: number } = {}): BridgeFiles {
  const max = opts.maxBytes ?? MAX_COPY_BYTES;
  const ms = opts.timeoutMs ?? COPY_MS;
  return {
    async fetch(from, to) {
      await mkdir(dirname(to), { recursive: true });
      const part = `${to}.part-${process.pid}`;
      const out = createWriteStream(part);
      const closed = once(out, "close").catch(() => undefined);
      const script = [
        `f=${sq(from)}`,
        `[ -f "$f" ] || exit ${NO_FILE}`,
        `s=$(wc -c < "$f" | tr -d ' ')`,
        `if [ "$s" -gt ${max} ]; then echo "$s bytes" >&2; exit ${TOO_BIG}; fi`,
        `exec cat -- "$f"`,
      ].join("\n");
      let r: { code: number | null; stderr: string };
      try {
        r = await remote.stream(script, { output: out }, AbortSignal.timeout(ms));
      } catch (err) {
        // No channel (the machine is offline): nothing was piped, so close and drop the temporary here.
        out.destroy();
        await closed;
        await rm(part, { force: true });
        throw err;
      }
      await closed;
      if (r.code !== 0) {
        await rm(part, { force: true });
        if (r.code === NO_FILE) return false;
        if (r.code === TOO_BIG) throw new Error(`it is ${r.stderr.trim()}, over the ${Math.round(max / 1048576)} MB a copy may be`);
        throw new Error(r.stderr.trim() || `exit ${r.code}`);
      }
      await rename(part, to);
      return true;
    },

    async upload(from, to) {
      const st = await stat(from);
      if (st.size > max) throw new Error(`it is ${st.size} bytes, over the ${Math.round(max / 1048576)} MB a copy may be`);
      // `'<to>'.part-$$`: the shell's pid, so two copies of one file never share a temporary.
      // A copy cut short leaves no `.part` behind there.
      const script = [
        `d=${sq(posix.dirname(to))}`,
        `t=${sq(to)}.part-$$`,
        `mkdir -p "$d" || exit 1`,
        `if cat > "$t" && mv -f "$t" ${sq(to)}; then exit 0; fi`,
        `rm -f "$t"; exit 1`,
      ].join("\n");
      const r = await remote.stream(script, { input: (ch) => pipeline(createReadStream(from), ch) }, AbortSignal.timeout(ms));
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    },
  };
}
