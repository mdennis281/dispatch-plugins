/**
 * The three-way sync against a real local repository and a "machine" that
 * is a directory here, its scripts run by the local `sh` (local-remote.ts).
 * On Windows this is also the real case on the local side: autocrlf on, no
 * exec bits, no symlinks.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalAfterRunInfo, TerminalRunInfo } from "@dispatch/plugin-sdk";
import { within } from "../src/backend.js";
import { ChatSync, type ChatSyncDeps } from "../src/sync/chat-sync.js";
import { batches, parseRawDiff } from "../src/sync/local.js";
import { SH, localRemote } from "./local-remote.js";

const win = process.platform === "win32";
// Every "machine" script forks sh and git; on Windows (MSYS) that is slow.
vi.setConfig({ testTimeout: 120_000 });
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const norm = (s: string) => s.replace(/\r\n/g, "\n");

function setup() {
  const base = mkdtempSync(join(tmpdir(), "rh-sync-"));
  dirs.push(base);
  const local = join(base, "proj");
  mkdirSync(join(local, "src"), { recursive: true });
  g(local, "init", "-q");
  g(local, "config", "user.name", "t");
  g(local, "config", "user.email", "t@t");
  writeFileSync(join(local, "a.txt"), "one\ntwo\n");
  writeFileSync(join(local, "src", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(local, ".gitignore"), "node_modules/\n");
  g(local, "add", "-A");
  g(local, "commit", "-qm", "init");
  const host = join(base, "machine").replace(/\\/g, "/");
  mkdirSync(host);
  const kv = new Map<string, unknown>();
  const remote = localRemote();
  const mk = (over: Partial<ChatSyncDeps> = {}) =>
    new ChatSync({
      chatId: "chat-1",
      root: local,
      label: "Test Mac",
      slug: "test-mac",
      instanceId: "inst-1",
      hostRoot: async () => host,
      remote,
      kv: {
        get: async <T>(k: string) => kv.get(k) as T | undefined,
        set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
        delete: async (k: string) => void kv.delete(k),
        list: async () => [...kv.keys()],
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      ...over,
    });
  return { local, host, work: `${host}/inst-1/chats/chat-1/proj`, kv, remote, mk };
}

let n = 0;
const run = (over: Partial<TerminalRunInfo> = {}): TerminalRunInfo => ({
  runId: `run-${++n}`,
  chatId: "chat-1",
  terminal: "main",
  command: "make",
  cwd: "/x",
  background: false,
  signal: new AbortController().signal,
  ...over,
});
const after = (i: TerminalRunInfo): TerminalAfterRunInfo => ({ ...i, exitCode: 0, durationMs: 1, outcome: "finished" });
const text = (r: { notices?: string[] }) => (r.notices ?? []).join("\n");
const read = (p: string) => norm(readFileSync(p, "utf8"));

describe.skipIf(!SH)("pushing", () => {
  it("sets the checkout up on the first command, then sends only what changed", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    const b1 = await s.beforeRun(r1);
    expect(b1.refuse).toBeUndefined();
    expect(text(b1)).toMatch(/Set up this chat's files there \(.*\/inst-1\/chats\/chat-1\/proj\)/);
    // The machine has no autocrlf: its files are as committed.
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(`${t.work}/src/b.ts`, "utf8")).toBe("export const b = 1;\n");
    await s.afterRun(after(r1));

    const sent = t.remote.scripts.length;
    const r2 = run();
    expect(await s.beforeRun(r2)).toEqual({});
    await s.afterRun(after(r2));
    expect(t.remote.scripts.slice(sent).some((x) => x.includes("index-pack"))).toBe(false);

    writeFileSync(join(t.local, "a.txt"), "one\ntwo\nthree\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("leaves big untracked files behind, and says so once", async () => {
    const t = setup();
    const s = t.mk({ capBytes: 1024 });
    writeFileSync(join(t.local, "dump.bin"), Buffer.alloc(4096, 1));
    const r1 = run();
    expect(text(await s.beforeRun(r1))).toMatch(/Not sent, over 1 KB and untracked: dump\.bin \(4 KB\)/);
    expect(existsSync(`${t.work}/dump.bin`)).toBe(false);
    await s.afterRun(after(r1));
    expect(await s.beforeRun(run())).toEqual({});
  });

  it("resumes a transfer a dropped connection cut short, sending only what hadn't arrived", async () => {
    const t = setup();
    for (let i = 0; i < 40; i++) writeFileSync(join(t.local, `f${i}.txt`), `line ${i}\n`.repeat(400 + i));
    const s = t.mk({ batchBytes: 8_000 });
    t.remote.failStream(3, 200);
    const b1 = await s.beforeRun(run());
    expect(b1.refuse).toMatch(/could not be synced .*connection lost/);
    const b2 = await s.beforeRun(run());
    expect(b2.refuse).toBeUndefined();
    const objects = Number(text(b2).match(/(\d+) objects/)?.[1]);
    expect(objects).toBeGreaterThan(0);
    // 40 + 3 files, 2 trees, 1 commit; two batches had arrived before the drop.
    expect(objects).toBeLessThan(46);
    expect(readFileSync(`${t.work}/f39.txt`, "utf8")).toBe("line 39\n".repeat(439));
  });

  it("never overwrites a change the machine made while files were being sent", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    writeFileSync(join(t.local, "a.txt"), "local edit\n");
    t.remote.before = (script) => {
      if (script.includes("read-tree -m -u")) writeFileSync(`${t.work}/a.txt`, "racing edit there\n");
    };
    const b = await s.beforeRun(run());
    t.remote.before = undefined;
    expect(b.refuse).toMatch(/`a\.txt` changed on the machine while your files were being sent, so nothing was overwritten/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("racing edit there\n");
    // The next command finds both sides changed it.
    expect((await s.beforeRun(run())).refuse).toMatch(/^Not run: a conflict with Test Mac/);
  });
});

describe.skipIf(!SH)("bringing changes back", () => {
  it("brings back edits, new files and deletions a command made there, and ignores ignored files", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ command: "pnpm codegen" });
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/a.txt`, "one\ntwo\nhost\n");
    writeFileSync(`${t.work}/gen.ts`, "export const g = 1;\n");
    rmSync(`${t.work}/src/b.ts`);
    mkdirSync(`${t.work}/node_modules/x`, { recursive: true });
    writeFileSync(`${t.work}/node_modules/x/i.js`, "ignored");
    const a = await s.afterRun(after(r1));
    const said = text(a);
    expect(said).toMatch(/Brought back the changes made there by `pnpm codegen`:/);
    expect(said).toMatch(/M a\.txt/);
    expect(said).toMatch(/A gen\.ts/);
    expect(said).toMatch(/D src\/b\.ts/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\nhost\n");
    if (win && g(t.local, "config", "core.autocrlf") === "true") {
      // Written the way a checkout here would write it.
      expect(readFileSync(join(t.local, "a.txt"), "utf8")).toBe("one\r\ntwo\r\nhost\r\n");
    }
    expect(read(join(t.local, "gen.ts"))).toBe("export const g = 1;\n");
    expect(existsSync(join(t.local, "src", "b.ts"))).toBe(false);
    expect(existsSync(join(t.local, "node_modules"))).toBe(false);
    // Nothing more to do either way now.
    expect(await s.beforeRun(run())).toEqual({});
  });

  it("brings back what changed between commands (a dev server, a watcher)", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    writeFileSync(`${t.work}/routes.gen.ts`, "// generated\n");
    const b = await s.beforeRun(run());
    expect(text(b)).toMatch(/Brought back the changes made there \(by something still running there\): A routes\.gen\.ts/);
    expect(read(join(t.local, "routes.gen.ts"))).toBe("// generated\n");
  });

  it("doesn't bring big new files back, says so once, and leaves them there", async () => {
    const t = setup();
    const s = t.mk({ capBytes: 1024 });
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/trace.json`, Buffer.alloc(8192, 50));
    expect(text(await s.afterRun(after(r1)))).toMatch(/too big to bring back \(over 1 KB\), and stay only there: trace\.json \(8 KB\)/);
    expect(existsSync(join(t.local, "trace.json"))).toBe(false);
    writeFileSync(join(t.local, "a.txt"), "push something\n");
    expect(await s.beforeRun(run())).toEqual({});
    expect(existsSync(`${t.work}/trace.json`)).toBe(true);
  });

  it("keeps a local edit to a file the command deleted there, and sends it back", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ command: "git clean" });
    await s.beforeRun(r1);
    rmSync(`${t.work}/src/b.ts`);
    writeFileSync(join(t.local, "src", "b.ts"), "export const b = 'mine';\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/Deleted there by `git clean` but changed here, so your version was kept and goes back: src\/b\.ts/);
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/src/b.ts`, "utf8")).toBe("export const b = 'mine';\n");
  });

  it.skipIf(win)("keeps an exec bit set there, even for a local checkout that can't hold one", async () => {
    const t = setup();
    g(t.local, "config", "core.filemode", "false");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    chmodSync(`${t.work}/src/b.ts`, 0o755);
    expect(text(await s.afterRun(after(r1)))).toMatch(/mode src\/b\.ts/);
    writeFileSync(join(t.local, "a.txt"), "push something\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(statSync(`${t.work}/src/b.ts`).mode & 0o111).not.toBe(0);
  });
});

describe.skipIf(!SH)("conflicts", () => {
  it("refuse the next command, keep both versions, and let yours win once the copy is gone", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ command: "pnpm format" });
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/a.txt`, "their version\n");
    writeFileSync(join(t.local, "a.txt"), "my version\n");
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/next command won't run until this is settled: a conflict with Test Mac/);
    expect(text(a)).toMatch(/`a\.txt` \(theirs: `a\.txt\.from-test-mac`, changed by `pnpm format`\)/);
    expect(read(join(t.local, "a.txt.from-test-mac"))).toBe("their version\n");
    expect(read(join(t.local, "a.txt"))).toBe("my version\n");

    const b2 = await s.beforeRun(run());
    expect(b2.refuse).toMatch(/^Not run: a conflict with Test Mac/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("their version\n");

    writeFileSync(join(t.local, "a.txt"), "merged\n");
    rmSync(join(t.local, "a.txt.from-test-mac"));
    const b3 = await s.beforeRun(run());
    expect(b3.refuse).toBeUndefined();
    expect(text(b3)).toMatch(/Conflict settled, your version goes there: a\.txt/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("merged\n");
    // The copy was never sent.
    expect(existsSync(`${t.work}/a.txt.from-test-mac`)).toBe(false);
  });
});

describe.skipIf(!SH)("the checkout lock", () => {
  it("refuses a command in another terminal while one runs in the foreground, and not after", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ terminal: "main", command: "pnpm test" });
    await s.beforeRun(r1);
    expect((await s.beforeRun(run({ terminal: "server" }))).refuse).toMatch(/terminal "main" is still running `pnpm test`/);
    await s.afterRun(after(r1));
    // A background command doesn't hold it.
    expect((await s.beforeRun(run({ terminal: "server", background: true }))).refuse).toBeUndefined();
    expect((await s.beforeRun(run({ terminal: "main" }))).refuse).toBeUndefined();
  });
});

describe.skipIf(!SH)("restarts and lost state", () => {
  it("picks up from what it saved, and from the machine's own record when that is gone too", async () => {
    const t = setup();
    const s1 = t.mk();
    const r1 = run();
    await s1.beforeRun(r1);
    await s1.afterRun(after(r1));
    writeFileSync(`${t.work}/a.txt`, "changed while Dispatch was down\n");
    const b2 = await t.mk().beforeRun(run());
    expect(text(b2)).toMatch(/Brought back .*M a\.txt/);
    expect(text(b2)).not.toMatch(/Set up/);
    expect(read(join(t.local, "a.txt"))).toBe("changed while Dispatch was down\n");

    t.kv.clear();
    writeFileSync(`${t.work}/src/b.ts`, "export const b = 2;\n");
    const b3 = await t.mk().beforeRun(run());
    expect(text(b3)).toMatch(/Brought back .*M src\/b\.ts/);
    expect(read(join(t.local, "src", "b.ts"))).toBe("export const b = 2;\n");
  });

  it("sets the checkout up again when it is gone from the machine", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    rmSync(t.work, { recursive: true, force: true });
    const b = await s.beforeRun(run());
    expect(text(b)).toMatch(/checkout there was gone; it is set up again/);
    expect(text(b)).toMatch(/Set up this chat's files there/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("one\ntwo\n");
  });
});

describe("pieces", () => {
  it("reads git's -z raw diff, odd paths included", () => {
    const z =
      ":100644 100755 " + "a".repeat(40) + " " + "a".repeat(40) + " M\0bin/run me\0" + ":000000 100644 " + "0".repeat(40) + " " + "b".repeat(40) + " A\0new\nline\0";
    expect(parseRawDiff(z)).toEqual([
      { path: "bin/run me", from: { mode: "100644", sha: "a".repeat(40) }, to: { mode: "100755", sha: "a".repeat(40) } },
      { path: "new\nline", from: { mode: "000000", sha: "0".repeat(40) }, to: { mode: "100644", sha: "b".repeat(40) } },
    ]);
  });

  it("starts the shell at the matching place in the checkout, or its top when the cwd is outside the worktree", () => {
    const r = join(tmpdir(), "repo");
    expect(within(r, join(r, "src", "lib"))).toBe("src/lib");
    expect(within(r, r)).toBe("");
    expect(within(r, join(tmpdir(), "repo-other"))).toBe("");
    expect(within(r, tmpdir())).toBe("");
  });

  it("batches by size, never leaving a batch empty", () => {
    const sizes = new Map([
      ["a", 5],
      ["b", 5],
      ["c", 20],
      ["d", 1],
    ]);
    expect(batches(["a", "b", "c", "d"], sizes, 10)).toEqual([["a", "b"], ["c"], ["d"]]);
  });
});
