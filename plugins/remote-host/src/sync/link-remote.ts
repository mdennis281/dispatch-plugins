/**
 * The sync's view of a machine, over its link: short scripts on the
 * control connection (they take turns there, see `HostLink.exec`), transfers
 * on a channel of their own so a big pack never holds the control
 * connection.
 */
import { shCommand } from "@dispatch-plugins/host-agent";
import { channelExit } from "@dispatch-plugins/remote-core";
import type { MachineLink } from "../link.js";
import type { RemoteSide } from "./remote.js";

export function linkRemote(link: MachineLink): RemoteSide {
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
        let code: number | null | undefined;
        const onAbort = () => ch.close();
        signal?.addEventListener("abort", onAbort, { once: true });
        ch.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-4_000)));
        ch.on("exit", (c: number | null) => (code = typeof c === "number" ? c : null));
        ch.on("error", () => {});
        ch.on("close", () => {
          signal?.removeEventListener("abort", onAbort);
          // A quick command's exit can come before this listener did (remote-core's channelExit):
          // a small file's copy, all in one read on a fast link.
          resolve({ code: code !== undefined ? code : (channelExit(ch)?.code ?? null), stderr });
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
