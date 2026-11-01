/**
 * Spawning a shell on the chat's machine: bring-up, seeding the checkout,
 * syncing the local worktree before the shell and before every command, and
 * forwarding what the machine listens on. The git side is real (a throwaway
 * repository); the machine and its SSH connection are fakes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PortWatch } from "../src/index.js";
import { chats, fakeConn, fakeProvider } from "./fakes.js";

const dirs: string[] = [];
afterEach(() => {
  // Retries: on Windows a git child can still hold the directory for a moment.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rc-repo-"));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

const info = (cwd: string) => ({ chatId: "c1", name: "main", cwd, signal: new AbortController().signal });
const until = async (ok: () => boolean) => {
  // A snapshot is real git work; on a loaded Windows box it takes a while.
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
};

describe("spawn", () => {
  it("brings the machine up, seeds and syncs the checkout, and starts the shell in the mapped cwd", async () => {
    const repo = gitRepo();
    const ssh = fakeConn();
    const f = fakeProvider({}, { conn: ssh.conn });
    const { c, kvNow } = chats(f);
    const handle = await c.spawn(info(repo));
    expect(f.calls).toEqual(["create 1", "start 1"]);
    expect(kvNow()["chat:c1"]).toMatchObject({ id: 1 });
    // Seeded (no GitHub origin → git init), then synced by pack.
    expect(ssh.remote.some((cmd) => cmd.includes("git init"))).toBe(true);
    expect(ssh.remote.some((cmd) => cmd.includes("git index-pack --stdin"))).toBe(true);
    expect(ssh.remote.some((cmd) => /git checkout -q --force --detach [0-9a-f]{40}/.test(cmd))).toBe(true);
    expect(handle.cwd).toBe(`/work/${basename(repo)}`);
  });

  it("re-syncs before a command but not before the sentinel probe", async () => {
    const repo = gitRepo();
    const ssh = fakeConn();
    const { c } = chats(fakeProvider({}, { conn: ssh.conn }));
    const handle = await c.spawn(info(repo));
    const packsBefore = ssh.remote.filter((cmd) => cmd.includes("index-pack")).length;
    writeFileSync(join(repo, "a.txt"), "edited locally\n");
    handle.stdin.write("cat a.txt\n");
    handle.stdin.write("__cm_ec=$?; printf ...\n");
    await until(() => ssh.shells[0]!.written.length >= 2);
    expect(ssh.remote.filter((cmd) => cmd.includes("index-pack")).length).toBe(packsBefore + 1);
    expect(ssh.shells[0]!.written).toEqual(["cat a.txt\n", "__cm_ec=$?; printf ...\n"]);
  });

  it("says so on stderr when a sync fails, and still runs the command", async () => {
    const repo = gitRepo();
    let failPack = false;
    const ssh = fakeConn({ exec: (cmd) => (failPack && cmd.includes("index-pack") ? { code: 1, stderr: "disk full" } : undefined) });
    const { c } = chats(fakeProvider({}, { conn: ssh.conn }));
    const handle = await c.spawn(info(repo));
    const stderr: string[] = [];
    handle.stderr.on("data", (s) => void stderr.push(String(s)));
    failPack = true;
    writeFileSync(join(repo, "a.txt"), "edited locally\n");
    handle.stdin.write("make\n");
    await until(() => ssh.shells[0]!.written.length >= 1);
    expect(ssh.shells[0]!.written).toEqual(["make\n"]);
    expect(stderr.join("")).toMatch(/^\[test-remote\] could not sync your local changes \(.*disk full\)/);
  });
});

describe("PortWatch", () => {
  it("forwards new listeners, publishes them, and withdraws them when they go", async () => {
    let listening = "LISTEN 0 511 *:3000 *:*\nLISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n";
    const ssh = fakeConn({ exec: (cmd) => (cmd.startsWith("ss ") ? { code: 0, stdout: listening } : undefined) });
    const published: Array<{ remotePort: number; url: string; withdrawn: boolean }> = [];
    const w = new PortWatch({
      conn: () => ssh.conn,
      publish: (p) => {
        const r = { ...p, withdrawn: false };
        published.push(r);
        return () => void (r.withdrawn = true);
      },
      log: { info() {}, warn() {} },
      chatId: "c1",
      host: () => "m1",
      intervalMs: 20,
    });
    w.start();
    await until(() => published.length > 0);
    expect(published).toEqual([{ remotePort: 3000, url: "http://127.0.0.1:43000", withdrawn: false }]);
    listening = "";
    await until(() => published[0]!.withdrawn);
    expect(ssh.forwards[0]).toMatchObject({ port: 3000, host: "127.0.0.1", closed: true });
    w.stop();
  });
});
