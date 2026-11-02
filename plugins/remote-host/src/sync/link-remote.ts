/**
 * The sync's view of a machine, over its HostLink: short scripts on the
 * control connection (they take turns there, see `HostLink.exec`), transfers
 * on a channel of their own so a big pack never holds the control
 * connection.
 */
import { shCommand } from "@dispatch-plugins/host-agent";
import type { HostLink } from "../link.js";
import type { RemoteSide } from "./remote.js";

export function linkRemote(link: HostLink): RemoteSide {
  return {
    run(script, opts = {}) {
      const input = opts.input;
      return link.exec(shCommand(script), {
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(input !== undefined
          ? {
              stdin: async (ch) => {
                await new Promise<void>((res, rej) => ch.end(input, (err?: Error | null) => (err ? rej(err) : res())));
              },
            }
          : {}),
      });
    },

    async stream(script, io, signal) {
      const ch = await link.openSession(shCommand(script), signal);
      return new Promise((resolve) => {
        let stderr = "";
        let code: number | null = null;
        const onAbort = () => ch.close();
        signal?.addEventListener("abort", onAbort, { once: true });
        ch.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-4_000)));
        ch.on("exit", (c: number | null) => (code = typeof c === "number" ? c : null));
        ch.on("error", () => {});
        ch.on("close", () => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ code, stderr });
        });
        if (io.output) ch.pipe(io.output, { end: true });
        else ch.resume();
        if (io.input) {
          io.input(ch).catch((err: unknown) => {
            stderr += `\n${err instanceof Error ? err.message : String(err)}`;
            ch.close();
          });
        } else ch.end();
      });
    },
  };
}
