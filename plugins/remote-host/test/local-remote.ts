/**
 * The machine, played by this one: the sync's scripts run under the local
 * `sh` (Git's on Windows), against a directory standing in for the machine's
 * home. Every script runs for real; only SSH is left out.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { RemoteSide } from "../src/sync/remote.js";

/**
 * The `sh` to run the scripts with: the one on PATH, else (Windows outside
 * Git Bash) Git's own launcher, which brings its coreutils with it.
 * Undefined when there is none: the tests that need it skip.
 */
export const SH: string | undefined = (() => {
  if (spawnSync("sh", ["-c", "true"]).status === 0) return "sh";
  if (process.platform !== "win32") return undefined;
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout?.trim();
  const sh = exec ? join(exec, "..", "..", "..", "bin", "sh.exe") : undefined;
  return sh && existsSync(sh) ? sh : undefined;
})();

export interface LocalRemote extends RemoteSide {
  /** Every script run, in order. */
  scripts: string[];
  /** Cut the `nth` transfer from now (1 = the next) off after `afterBytes` of its input, as a dropped connection would. */
  failStream(nth: number, afterBytes: number): void;
  /** Called with each script just before it runs (to change the "machine" at that moment). */
  before?: (script: string) => void;
  /** The scripts' environment, when not this process's (to trace the machine's git apart from this side's). */
  env?: NodeJS.ProcessEnv;
}

export function localRemote(): LocalRemote {
  const scripts: string[] = [];
  let cutAt: { nth: number; bytes: number } | undefined;
  const r: LocalRemote = {
    scripts,
    failStream(nth, afterBytes) {
      cutAt = { nth, bytes: afterBytes };
    },
    run(script, opts = {}) {
      scripts.push(script);
      r.before?.(script);
      return new Promise((res, rej) => {
        const c = spawn(SH ?? "sh", ["-c", script], { windowsHide: true, env: r.env ?? process.env });
        let stdout = "";
        let stderr = "";
        c.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
        c.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
        c.on("error", rej);
        c.on("close", (code) => res({ code, stdout, stderr }));
        c.stdin.on("error", () => {});
        c.stdin.end(opts.input ?? "");
      });
    },
    stream(script, io, signal) {
      scripts.push(script);
      r.before?.(script);
      let cut: number | undefined;
      if (cutAt && --cutAt.nth === 0) {
        cut = cutAt.bytes;
        cutAt = undefined;
      }
      return new Promise((res, rej) => {
        const c = spawn(SH ?? "sh", ["-c", script], { windowsHide: true, env: r.env ?? process.env });
        let stderr = "";
        c.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
        if (io.output) c.stdout.pipe(io.output, { end: true });
        else c.stdout.resume();
        c.on("error", rej);
        c.on("close", (code) => res(cut !== undefined ? { code: null, stderr: "connection lost" } : { code, stderr }));
        c.stdin.on("error", () => {});
        signal?.addEventListener("abort", () => c.kill(), { once: true });
        if (!io.input) {
          c.stdin.end();
          return;
        }
        if (cut === undefined) {
          void io.input(c.stdin).catch(() => c.kill());
          return;
        }
        // Cut off part-way: the machine gets the first bytes, then the input ends.
        const limit = cut;
        let sent = 0;
        const tap = new PassThrough();
        tap.on("data", (d: Buffer) => {
          if (sent >= limit) return;
          const part = d.subarray(0, limit - sent);
          sent += part.length;
          c.stdin.write(part);
          if (sent >= limit) c.stdin.end();
        });
        tap.on("end", () => c.stdin.end());
        void io.input(tap).catch(() => {});
      });
    },
  };
  return r;
}
