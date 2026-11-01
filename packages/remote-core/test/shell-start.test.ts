/**
 * Where a remote shell starts. The machine's twin of a local directory can
 * be missing: an empty or git-ignored local directory is not in the snapshot,
 * and a checkout can be gone. The shell then used to `cd ~` and run the
 * agent's next command — `rm -rf build`, say — in the home directory. It must
 * not start at all, so the spawn fails and says why.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SshConnection, remoteShellCommand } from "../src/index.js";

function channel() {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    written: [] as string[],
    closed: false,
    write(c: string) {
      this.written.push(c);
      return true;
    },
    end() {},
    close() {
      this.closed = true;
    },
  });
}

/** An SshConnection whose every exec gets a fake channel, answered by `answer`. */
function connWith(answer: (cmd: string, ch: ReturnType<typeof channel>) => void) {
  const conn = new SshConnection({ host: "box", username: "u" });
  const channels: Array<ReturnType<typeof channel>> = [];
  const client = {
    exec(cmd: string, cb: (err: undefined, ch: ReturnType<typeof channel>) => void) {
      const ch = channel();
      channels.push(ch);
      cb(undefined, ch);
      setImmediate(() => answer(cmd, ch));
    },
  };
  Object.assign(conn as unknown as { client: unknown; closed: boolean }, { client, closed: false });
  return { conn, channels };
}

describe("starting a shell", () => {
  it("never falls back to the home directory", () => {
    const cmd = remoteShellCommand("/work/repo/gone", {});
    expect(cmd).not.toMatch(/cd ~|\|\|\s*cd\b/);
  });

  it("fails, and closes the channel, when the directory is missing", async () => {
    const { conn, channels } = connWith((_cmd, ch) => {
      ch.emit("data", Buffer.from("DTERR:cwd\n"));
      ch.emit("exit", 97);
      ch.emit("close");
    });
    await expect(conn.shell("/work/repo/gone", {})).rejects.toThrow(/\/work\/repo\/gone does not exist on box/);
    expect(channels[0]!.closed).toBe(true);
  });

  it("fails when the shell exits before it started", async () => {
    const { conn } = connWith((_cmd, ch) => {
      ch.emit("exit", 127);
      ch.emit("close");
    });
    await expect(conn.shell("/work/repo", {})).rejects.toThrow(/exited before it started/);
  });

  it("resolves once the shell is running in the directory", async () => {
    const { conn } = connWith((_cmd, ch) => ch.emit("data", Buffer.from("DTPID:42\nready\n")));
    const sh = await conn.shell("/work/repo", {});
    expect(sh.cwd).toBe("/work/repo");
    const out: string[] = [];
    sh.stdout.on("data", (s) => void out.push(String(s)));
    await new Promise((r) => setImmediate(r));
    sh.kill();
  });
});

// The real command, under a real POSIX shell — Linux CI; skipped on Windows.
const posix = process.platform !== "win32" && spawnSync("sh", ["-c", "command -v bash"]).status === 0;

describe.skipIf(!posix)("the start command under sh", () => {
  const run = (cwd: string, input: string) =>
    spawnSync("sh", ["-c", remoteShellCommand(cwd, { DT_TEST: "it's" })], { input, encoding: "utf8" });

  it("prints DTPID and runs in the directory, with the env set", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-cwd-"));
    try {
      const r = run(dir, 'pwd; echo "$DT_TEST"; exit 0\n');
      const lines = r.stdout.trim().split("\n");
      expect(lines[0]).toMatch(/^DTPID:\d+$/);
      expect(lines.slice(1)).toEqual([dir, "it's"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing directory without running anything", () => {
    const r = run(join(tmpdir(), "rc-no-such-dir-xyz"), "echo RAN\n");
    expect(r.stdout.trim()).toBe("DTERR:cwd");
    expect(r.status).toBe(97);
  });
});
