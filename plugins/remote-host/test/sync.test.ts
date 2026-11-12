/**
 * The three-way sync against a real local repository and a "machine" that
 * is a directory here, its scripts run by the local `sh` (local-remote.ts).
 * On Windows this is also the real case on the local side: autocrlf on, no
 * exec bits, no symlinks.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalAfterRunInfo, TerminalRunInfo } from "@dispatch/plugin-sdk";
import { repoTop, within } from "../src/backend.js";
import { ChatSync, restoreLine, type ChatSyncDeps } from "../src/sync/chat-sync.js";
import { batches, parseRawDiff, pathProblem } from "../src/sync/local.js";
import { CheckoutLock, type RunInFlight } from "../src/sync/run-lock.js";
import { SH, localRemote } from "./local-remote.js";

const win = process.platform === "win32";
const XCODE = "/Applications/Xcode.app/Contents/Developer";
const CLT = "/Library/Developer/CommandLineTools";
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

  it("runs four git processes here and three there per look when nothing changed", async () => {
    // Each git process costs 50-250 ms on Windows, and these run around every command.
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    const traces = { here: join(t.local, "..", "here.trace"), there: join(t.local, "..", "there.trace") };
    const r2 = run();
    process.env.GIT_TRACE2_EVENT = traces.here;
    t.remote.env = { ...process.env, GIT_TRACE2_EVENT: traces.there };
    try {
      expect(await s.beforeRun(r2)).toEqual({});
      expect(await s.afterRun(after(r2))).toEqual({});
    } finally {
      delete process.env.GIT_TRACE2_EVENT;
      t.remote.env = undefined;
    }
    // Each git process's subcommand, in order (one that git started itself has a "/" in its sid).
    const gits = (file: string) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; sid: string; argv?: string[] })
        .filter((e) => e.event === "start" && !e.sid.includes("/"))
        .map((e) => e.argv![1]);
    // Before: the snapshot (the index's path is known; its commit is the base's). After: nothing here.
    expect(gits(traces.here)).toEqual(["ls-files", "config", "add", "write-tree"]);
    // The look there, before and after.
    expect(gits(traces.there)).toEqual(["add", "write-tree", "cat-file", "add", "write-tree", "cat-file"]);
    // And a change still goes.
    writeFileSync(join(t.local, "a.txt"), "changed\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("changed\n");
  });

  /**
   * The "machine" with a `/usr/bin/git` stand-in first on its PATH that fails
   * (exit 69, Xcode's license) when `blocked` says so of its DEVELOPER_DIR,
   * and DEVELOPER_DIR `env` in its environment.
   */
  function withStub(blocked: string, env: string | undefined) {
    const t = setup();
    const bin = join(t.local, "..", "stubbin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif ${blocked}; then echo "You have not agreed to the Xcode license agreements." >&2; exit 69; fi\n` +
        `unset DEVELOPER_DIR\nPATH=\${PATH#*:} exec git "$@"\n`,
      { mode: 0o755 },
    );
    const machineEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    if (env === undefined) delete machineEnv.DEVELOPER_DIR;
    else machineEnv.DEVELOPER_DIR = env;
    t.remote.env = machineEnv;
    return t;
  }

  /** Every script: set up, check, send, check out; then a change there comes back, and one here goes. */
  async function syncsBothWays(t: ReturnType<typeof setup>) {
    const s = t.mk();
    const r1 = run();
    expect((await s.beforeRun(r1)).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("one\ntwo\n");
    writeFileSync(`${t.work}/made-there.txt`, "hi\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/Brought back .*made-there\.txt/);
    expect(read(join(t.local, "made-there.txt"))).toBe("hi\n");
    writeFileSync(join(t.local, "a.txt"), "edited here\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("edited here\n");
  }

  it.skipIf(win)("never runs git there with a DEVELOPER_DIR pointing at Xcode, which an Xcode update blocks", async () => {
    await syncsBothWays(withStub(`[ "\${DEVELOPER_DIR:-}" = "${XCODE}" ]`, XCODE));
  });

  it.skipIf(win || !existsSync(`${CLT}/usr/bin/git`))(
    "runs git there from the Command Line Tools when xcode-select chose a blocked Xcode (cvx-mac), with no sudo",
    async () => {
      await syncsBothWays(withStub(`[ "\${DEVELOPER_DIR:-}" != "${CLT}" ]`, undefined));
    },
  );

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
    expect(text(await s.afterRun(after(r1)))).toMatch(/not brought back, and left as they are on both sides: trace\.json \(too big to bring back, 8 KB\)/);
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

  it("brings back an edit there to a file committed with CRLF, hashing it as the snapshot does", async () => {
    const t = setup();
    writeFileSync(join(t.local, "win.txt"), "a\r\nb\r\n");
    g(t.local, "-c", "core.autocrlf=false", "add", "win.txt");
    g(t.local, "commit", "-qm", "crlf");
    g(t.local, "config", "core.autocrlf", "true");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    expect(readFileSync(`${t.work}/win.txt`, "utf8")).toBe("a\r\nb\r\n");
    writeFileSync(`${t.work}/win.txt`, "a\r\nb\r\nc\r\n");
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/M win\.txt/);
    expect(text(a)).not.toMatch(/settled/);
    expect(readFileSync(join(t.local, "win.txt"), "utf8")).toBe("a\r\nb\r\nc\r\n");
    expect(await s.beforeRun(run())).toEqual({});
  });

  it("brings back a regenerated and then a deleted file that it pinned here", async () => {
    const t = setup();
    g(t.local, "config", "core.autocrlf", "true");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    // Made there with CRLF: it hashes differently here, so it is pinned.
    writeFileSync(`${t.work}/run.bat`, "echo hi\r\n");
    await s.afterRun(after(r1));
    expect(readFileSync(join(t.local, "run.bat"), "utf8")).toBe("echo hi\r\n");

    const r2 = run({ command: "gen" });
    expect(await s.beforeRun(r2)).toEqual({});
    writeFileSync(`${t.work}/run.bat`, "echo hi\r\necho again\r\n");
    const a2 = await s.afterRun(after(r2));
    expect(text(a2)).toMatch(/M run\.bat/);
    expect(text(a2)).not.toMatch(/settled/);
    expect(readFileSync(join(t.local, "run.bat"), "utf8")).toBe("echo hi\r\necho again\r\n");

    const r3 = run({ command: "clean" });
    expect(await s.beforeRun(r3)).toEqual({});
    rmSync(`${t.work}/run.bat`);
    const a3 = await s.afterRun(after(r3));
    expect(text(a3)).toMatch(/D run\.bat/);
    expect(existsSync(join(t.local, "run.bat"))).toBe(false);
  });

  it("brings back a directory there that became a file", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    rmSync(`${t.work}/src`, { recursive: true });
    writeFileSync(`${t.work}/src`, "now a file\n");
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/D src\/b\.ts/);
    expect(text(a)).toMatch(/A src(,|$)/m);
    expect(read(join(t.local, "src"))).toBe("now a file\n");
    expect(await s.beforeRun(run())).toEqual({});
  });

  it("doesn't fetch again what it set aside", async () => {
    const t = setup();
    writeFileSync(join(t.local, ".git", "info", "exclude"), "cfg.local\n");
    writeFileSync(join(t.local, "cfg.local"), "mine\n");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/cfg.local`, "theirs\n");
    await s.afterRun(after(r1));
    const fetches = () => t.remote.scripts.filter((x) => x.includes("pack-objects --stdout") && !x.includes("--revs")).length;
    const was = fetches();
    const r2 = run();
    await s.beforeRun(r2);
    await s.afterRun(after(r2));
    expect(fetches()).toBe(was);
    // Once the file here is gone, theirs comes back.
    rmSync(join(t.local, "cfg.local"));
    expect(text(await s.beforeRun(run()))).toMatch(/A cfg\.local/);
    expect(read(join(t.local, "cfg.local"))).toBe("theirs\n");
  });

  it.skipIf(win || process.getuid?.() === 0)("isn't stopped by a file there it can't read", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/locked.txt`, "secret\n");
    chmodSync(`${t.work}/locked.txt`, 0);
    writeFileSync(`${t.work}/gen.ts`, "x\n");
    const a = await s.afterRun(after(r1));
    chmodSync(`${t.work}/locked.txt`, 0o644);
    expect(text(a)).toMatch(/A gen\.ts/);
    expect(existsSync(join(t.local, "locked.txt"))).toBe(false);
  });

  it("still sends your files when it can't check for changes there", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    writeFileSync(join(t.local, "a.txt"), "mine\n");
    t.remote.before = (script) => {
      if (script.includes("dispatch-status")) throw new Error("status broke");
    };
    const b = await s.beforeRun(run());
    t.remote.before = undefined;
    expect(b.refuse).toBeUndefined();
    expect(text(b)).toMatch(/Could not check for changes made there \(.*status broke.*\)/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("mine\n");
  });

  it("doesn't trust a report from the machine that doesn't start from the last sync", async () => {
    const t = setup();
    const lying = {
      ...t.remote,
      run: async (script: string, o?: { input?: string; timeoutMs?: number }) => {
        const r = await t.remote.run(script, o);
        return script.includes("dispatch-status") ? { ...r, stdout: r.stdout.replace(/^(:100644 100644 )[0-9a-f]{40}/m, `$1${"1".repeat(40)}`) } : r;
      },
    };
    const s = t.mk({ remote: lying });
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/a.txt`, "changed there\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/don't start from the last sync \(a\.txt\)/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");
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

  it("send the machine's version back unchanged when its copy is moved over yours", async () => {
    const t = setup();
    g(t.local, "config", "core.autocrlf", "true");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/a.txt`, "theirs\r\n");
    writeFileSync(join(t.local, "a.txt"), "mine\n");
    await s.afterRun(after(r1));
    renameSync(join(t.local, "a.txt.from-test-mac"), join(t.local, "a.txt"));
    const b = await s.beforeRun(run());
    expect(b.refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("theirs\r\n");
    expect(await s.beforeRun(run())).toEqual({});
  });

  it.skipIf(win)("replace a symlink where the copy goes, never writing through it", async () => {
    const t = setup();
    const outside = join(t.local, "..", "outside.txt");
    writeFileSync(outside, "precious\n");
    symlinkSync(outside, join(t.local, "a.txt.from-test-mac"));
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/a.txt`, "theirs\n");
    writeFileSync(join(t.local, "a.txt"), "mine\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/won't run until this is settled/);
    expect(readFileSync(outside, "utf8")).toBe("precious\n");
    expect(lstatSync(join(t.local, "a.txt.from-test-mac")).isSymbolicLink()).toBe(false);
    expect(read(join(t.local, "a.txt.from-test-mac"))).toBe("theirs\n");
  });
});

describe.skipIf(!SH)("never losing a file", () => {
  it("leaves alone a file the machine makes where this computer has an ignored one", async () => {
    const t = setup();
    writeFileSync(join(t.local, ".git", "info", "exclude"), "secret.env\n");
    writeFileSync(join(t.local, "secret.env"), "TOKEN=local-real\n");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/secret.env`, "TOKEN=placeholder\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/not brought back.*secret\.env \(here it is a file that isn't synced/);
    expect(read(join(t.local, "secret.env"))).toBe("TOKEN=local-real\n");
    writeFileSync(join(t.local, "a.txt"), "push something\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/secret.env`, "utf8")).toBe("TOKEN=placeholder\n");
  });

  it("leaves alone a file the machine makes where this computer has one too big to send", async () => {
    const t = setup();
    writeFileSync(join(t.local, "data.db"), Buffer.alloc(8192, 7));
    const s = t.mk({ capBytes: 1024 });
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/data.db`, "small\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/not brought back.*data\.db/);
    expect(readFileSync(join(t.local, "data.db"))).toEqual(Buffer.alloc(8192, 7));
  });

  it("never overwrites an edit made here while the machine's changes were on their way", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ command: "fmt" });
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/a.txt`, "formatted there\n");
    t.remote.before = (script) => {
      if (script.includes("pack-objects --stdout") && !script.includes("--revs")) writeFileSync(join(t.local, "a.txt"), "edited here meanwhile\n");
    };
    const a = await s.afterRun(after(r1));
    t.remote.before = undefined;
    expect(read(join(t.local, "a.txt"))).toBe("edited here meanwhile\n");
    expect(read(join(t.local, "a.txt.from-test-mac"))).toBe("formatted there\n");
    expect(text(a)).toMatch(/next command won't run until this is settled/);
  });

  it("never replaces a file here with a directory from there, or the reverse", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    // There, the file becomes a directory; here, the file is edited.
    rmSync(`${t.work}/a.txt`);
    mkdirSync(`${t.work}/a.txt`);
    writeFileSync(`${t.work}/a.txt/inner.txt`, "inside\n");
    writeFileSync(join(t.local, "a.txt"), "my edit\n");
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/a\.txt\/inner\.txt \(a\.txt is a file here\)/);
    expect(read(join(t.local, "a.txt"))).toBe("my edit\n");
    // The push doesn't flatten their directory either: it says what to rename.
    const b = await s.beforeRun(run());
    expect(b.refuse).toMatch(/already on the machine, outside the sync: a\.txt \(a directory there\)/);
    expect(readFileSync(`${t.work}/a.txt/inner.txt`, "utf8")).toBe("inside\n");
  });

  it("turns a file the machine has outside the sync (ignored there) into a conflict instead of overwriting it", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    writeFileSync(`${t.work}/.git/info/exclude`, "local.env\n");
    writeFileSync(`${t.work}/local.env`, "THEIRS=1\n");
    writeFileSync(join(t.local, "local.env"), "MINE=1\n");
    const b = await s.beforeRun(run());
    expect(b.refuse).toMatch(/^Not run: a conflict with Test Mac.*`local\.env` \(theirs: `local\.env\.from-test-mac`\)/s);
    expect(readFileSync(`${t.work}/local.env`, "utf8")).toBe("THEIRS=1\n");
    expect(read(join(t.local, "local.env.from-test-mac"))).toBe("THEIRS=1\n");
    rmSync(join(t.local, "local.env.from-test-mac"));
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/local.env`, "utf8")).toBe("MINE=1\n");
  });

  it("leaves alone an ignored file here even when the machine makes the same one", async () => {
    const t = setup();
    writeFileSync(join(t.local, ".git", "info", "exclude"), "same.env\n");
    writeFileSync(join(t.local, "same.env"), "X=1\n");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/same.env`, "X=1\n");
    await s.afterRun(after(r1));
    writeFileSync(join(t.local, "a.txt"), "push something\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    // Nor is the machine's deleted by the push.
    expect(readFileSync(`${t.work}/same.env`, "utf8")).toBe("X=1\n");
    expect(read(join(t.local, "same.env"))).toBe("X=1\n");
  });

  it("lets a file the machine has outside the sync join it when yours is the same", async () => {
    const t = setup();
    const name = win ? "same.cfg" : "same\nname.cfg";
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    writeFileSync(`${t.work}/.git/info/exclude`, "*.cfg\n");
    writeFileSync(`${t.work}/${name}`, "k=v\n");
    writeFileSync(join(t.local, name), "k=v\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(existsSync(join(t.local, `${name}.from-test-mac`))).toBe(false);
    expect(await s.beforeRun(run())).toEqual({});
  });

  it("never overwrites files already where the checkout goes, on the first sync", async () => {
    const t = setup();
    mkdirSync(`${t.work}/src`, { recursive: true });
    writeFileSync(`${t.work}/a.txt`, "left there\n");
    writeFileSync(`${t.work}/src/b.ts`, "export const b = 1;\n");
    const s = t.mk();
    const b = await s.beforeRun(run());
    expect(b.refuse).toMatch(/^Not run: a conflict with Test Mac.*`a\.txt` \(theirs: `a\.txt\.from-test-mac`\)/s);
    // The same file there just joins.
    expect(b.refuse).not.toMatch(/src\/b\.ts/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("left there\n");
    expect(read(join(t.local, "a.txt.from-test-mac"))).toBe("left there\n");
    rmSync(join(t.local, "a.txt.from-test-mac"));
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("one\ntwo\n");
  });

  it("never overwrites a local edit to a file marked assume-unchanged or skip-worktree", async () => {
    const t = setup();
    writeFileSync(join(t.local, "cfg.json"), "{}\n");
    writeFileSync(join(t.local, "sw.json"), "{}\n");
    g(t.local, "add", "cfg.json", "sw.json");
    g(t.local, "commit", "-qm", "config");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    g(t.local, "update-index", "--assume-unchanged", "cfg.json");
    g(t.local, "update-index", "--skip-worktree", "sw.json");
    writeFileSync(join(t.local, "cfg.json"), '{"mine":1}\n');
    writeFileSync(join(t.local, "sw.json"), '{"mine":2}\n');
    writeFileSync(`${t.work}/cfg.json`, "machine\n");
    writeFileSync(`${t.work}/sw.json`, "machine\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/won't run until this is settled/);
    expect(read(join(t.local, "cfg.json"))).toBe('{"mine":1}\n');
    expect(read(join(t.local, "sw.json"))).toBe('{"mine":2}\n');
    expect(read(join(t.local, "cfg.json.from-test-mac"))).toBe("machine\n");
    expect(read(join(t.local, "sw.json.from-test-mac"))).toBe("machine\n");
    // The real index keeps its bits.
    expect(g(t.local, "ls-files", "-v", "cfg.json", "sw.json")).toBe("h cfg.json\nS sw.json");
  });

  it("never overwrites a local edit to a file outside a sparse checkout's cone", async () => {
    const t = setup();
    mkdirSync(join(t.local, "docs"));
    writeFileSync(join(t.local, "docs", "x.md"), "doc\n");
    g(t.local, "add", "docs/x.md");
    g(t.local, "commit", "-qm", "docs");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    g(t.local, "sparse-checkout", "set", "--cone", "src");
    expect(existsSync(join(t.local, "docs", "x.md"))).toBe(false);
    // Brought back by hand, and edited.
    mkdirSync(join(t.local, "docs"), { recursive: true });
    writeFileSync(join(t.local, "docs", "x.md"), "my edit\n");
    writeFileSync(`${t.work}/docs/x.md`, "machine\n");
    expect(text(await s.afterRun(after(r1)))).toMatch(/won't run until this is settled/);
    expect(read(join(t.local, "docs", "x.md"))).toBe("my edit\n");
  });

  it("rebuilds a checkout that lost its HEAD before checking anything out over it", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    writeFileSync(`${t.work}/.git/HEAD`, "ref: refs/heads/nowhere\n");
    writeFileSync(join(t.local, "a.txt"), "mine\n");
    // Not even when the look there fails: it would take every file there for one outside the sync.
    t.remote.before = (script) => {
      if (script.includes("dispatch-status")) throw new Error("status broke");
    };
    const b1 = await s.beforeRun(run());
    t.remote.before = undefined;
    expect(b1.refuse).toMatch(/lost its last sync \(no HEAD\)/);
    expect(existsSync(join(t.local, "a.txt.from-test-mac"))).toBe(false);
    const b2 = await s.beforeRun(run());
    expect(b2.refuse).toBeUndefined();
    expect(text(b2)).toMatch(/HEAD there was gone or broken; it was rebuilt/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("mine\n");
  });

  it("rebuilds a checkout whose HEAD names a commit it can't read, rather than fail every push after", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    const bogus = "1".repeat(40);
    writeFileSync(`${t.work}/.git/HEAD`, `${bogus}\n`);
    writeFileSync(join(t.local, "a.txt"), "mine\n");
    const b = await s.beforeRun(run());
    expect(b.refuse).toBeUndefined();
    expect(text(b)).toMatch(/HEAD there was gone or broken; it was rebuilt/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("mine\n");
    expect(g(t.work, "rev-parse", "HEAD")).not.toBe(bogus);
    expect(await s.beforeRun(run())).toEqual({});
  });

  it.skipIf(win)("keeps the machine's exec bit on a file that joins the sync, on a checkout that can't hold one", async () => {
    const t = setup();
    g(t.local, "config", "core.filemode", "false");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    writeFileSync(`${t.work}/.git/info/exclude`, "*.sh\n");
    writeFileSync(`${t.work}/run.sh`, "echo hi\n");
    chmodSync(`${t.work}/run.sh`, 0o755);
    writeFileSync(join(t.local, "run.sh"), "echo hi\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(statSync(`${t.work}/run.sh`).mode & 0o111).not.toBe(0);
    expect(await s.beforeRun(run())).toEqual({});
  });

  it("sends a file made there back unchanged, CRLF and all", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/run.bat`, "echo hi\r\necho there\r\n");
    await s.afterRun(after(r1));
    writeFileSync(join(t.local, "a.txt"), "push something\n");
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(readFileSync(`${t.work}/run.bat`, "utf8")).toBe("echo hi\r\necho there\r\n");
    expect(await s.beforeRun(run())).toEqual({});
  });

  it("sets up again a checkout whose .git a command removed: nothing deleted here, a file changed there kept beside yours", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/a.txt`, "edited there\n");
    rmSync(`${t.work}/src/b.ts`);
    rmSync(`${t.work}/.git`, { recursive: true, force: true });
    const a = await s.afterRun(after(r1));
    // Without its .git it can't say which checkout it is: never read against the base.
    expect(text(a)).toMatch(/isn't the one last synced; it is set up again from your files\. Nothing was deleted here/);
    expect(text(a)).not.toMatch(/Brought back|Deleted here/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");
    expect(read(join(t.local, "src", "b.ts"))).toBe("export const b = 1;\n");
    // The next command sets it up as a first sync: theirs is kept beside yours until you settle it.
    const b = await s.beforeRun(run());
    expect(b.refuse).toMatch(/a conflict with Test Mac/);
    expect(read(join(t.local, "a.txt.from-test-mac"))).toBe("edited there\n");
    rmSync(join(t.local, "a.txt.from-test-mac"));
    const c = await s.beforeRun(run());
    expect(c.refuse).toBeUndefined();
    expect(read(`${t.work}/a.txt`)).toBe("one\ntwo\n");
    expect(read(`${t.work}/src/b.ts`)).toBe("export const b = 1;\n");
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

  it("is kept while a command that timed out may still be running, until its shell ends", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ terminal: "main", command: "pnpm build" });
    await s.beforeRun(r1);
    await s.afterRun({ ...after(r1), outcome: "timed-out" });
    expect((await s.beforeRun(run({ terminal: "server" }))).refuse).toMatch(/"main", `pnpm build` timed out and may still be running/);
    s.releaseTerminal("main");
    expect((await s.beforeRun(run({ terminal: "server" }))).refuse).toBeUndefined();
  });

  it("is kept from a timed-out command's own terminal too, until the shell there says it ended", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ terminal: "main", command: "pnpm build" });
    await s.beforeRun(r1);
    await s.afterRun({ ...after(r1), outcome: "timed-out" });
    expect((await s.beforeRun(run({ terminal: "main" }))).refuse).toMatch(/`pnpm build` timed out and may still be running/);
    s.runEnded(r1.runId);
    expect((await s.beforeRun(run({ terminal: "main" }))).refuse).toBeUndefined();
  });

  /** Core's runs anywhere, as `ctx.terminals.runs()` would list them, with the lock this machine builds on them. */
  function elsewhere(afterWaitMs = 5_000) {
    const inFlight: RunInFlight[] = [];
    const ended = new Set<(e: { kind: "started" | "ended"; run: RunInFlight }) => void>();
    const lock = new CheckoutLock({
      runs: {
        runs: () => [...inFlight],
        onRun: (fn) => (ended.add(fn), () => ended.delete(fn)),
      },
      self: "remote-host/test-mac",
      where: (b) => (b === "local" ? "this computer" : b),
      afterWaitMs,
    });
    let seq = 0;
    return {
      lock,
      start: (r: Partial<RunInFlight>): RunInFlight => {
        const full: RunInFlight = { runId: `else-${++seq}`, chatId: "chat-1", terminal: "build", backend: "local", cwd: "/x", background: false, startedAt: Date.now(), ...r };
        inFlight.push(full);
        return full;
      },
      end: (run: RunInFlight) => {
        inFlight.splice(inFlight.indexOf(run), 1);
        for (const fn of ended) fn({ kind: "ended", run });
      },
    };
  }

  it("refuses a command while a terminal on this computer runs one in the same files, and touches nothing", async () => {
    const t = setup();
    const e = elsewhere();
    const s = t.mk({ lock: e.lock });
    const local = e.start({ cwd: join(t.local, "src"), chatId: "chat-other" });
    writeFileSync(join(t.local, "a.txt"), "being written here\n");
    const b = await s.beforeRun(run());
    expect(b.refuse).toMatch(/^Not run: terminal "build" of another chat on this computer \(for \d+ s\) is running a command in this chat's files/);
    // Nothing was read or set up there.
    expect(existsSync(t.work)).toBe(false);
    e.end(local);
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
    expect(read(`${t.work}/a.txt`)).toBe("being written here\n");
  });

  it("doesn't count a terminal elsewhere in other files, a background one, or another chat's on another location", async () => {
    const t = setup();
    const e = elsewhere();
    const s = t.mk({ lock: e.lock });
    e.start({ cwd: t.host }); // on this computer, outside the chat's files
    e.start({ cwd: t.local, background: true }); // a dev server here
    e.start({ backend: "proxmox-terminal/pve", chatId: "chat-other" });
    e.start({ backend: "remote-host/test-mac", terminal: "server" }); // this machine's own: its lock is the per-machine one
    expect((await s.beforeRun(run())).refuse).toBeUndefined();
  });

  it("refuses while this chat runs a command at another location, and between two machines lets the older go first", async () => {
    const t = setup();
    const e = elsewhere();
    const s = t.mk({ lock: e.lock });
    const pve = e.start({ backend: "proxmox-terminal/pve", cwd: "/root/work" });
    expect((await s.beforeRun(run())).refuse).toMatch(/terminal "build" on proxmox-terminal\/pve \(for \d+ s\) is running a command/);
    e.end(pve);
    // Another machine of this plugin's started first: it goes, this doesn't.
    const other = e.start({ backend: "remote-host/studio", startedAt: Date.now() - 1_000 });
    const mine = e.start({ backend: "remote-host/test-mac", runId: "mine", terminal: "main" });
    expect((await s.beforeRun(run({ runId: mine.runId }))).refuse).toMatch(/on remote-host\/studio/);
    e.end(other);
    e.end(mine);
    // Started after this one: it is the one that gives way.
    const me = e.start({ backend: "remote-host/test-mac", runId: "me-2", terminal: "main", startedAt: Date.now() - 1_000 });
    e.start({ backend: "remote-host/studio" });
    expect((await s.beforeRun(run({ runId: me.runId }))).refuse).toBeUndefined();
  });

  it("brings a command's changes back only once a command started here meanwhile is over, and says it waited", async () => {
    const t = setup();
    const e = elsewhere();
    const s = t.mk({ lock: e.lock });
    const r1 = run({ command: "pnpm codegen" });
    expect((await s.beforeRun(r1)).refuse).toBeUndefined();
    writeFileSync(`${t.work}/gen.ts`, "export const g = 1;\n");
    const local = e.start({ cwd: t.local, terminal: "lint" });
    setTimeout(() => {
      // Not back yet while it runs.
      expect(existsSync(join(t.local, "gen.ts"))).toBe(false);
      e.end(local);
    }, 1_200);
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/\[Test Mac\] Waited \d+ s for terminal "lint" on this computer to finish its command in this chat's files/);
    expect(text(a)).toMatch(/Brought back the changes made there by `pnpm codegen`/);
    expect(read(join(t.local, "gen.ts"))).toBe("export const g = 1;\n");
  });

  it("past the wait, brings nothing back and says so; the next command brings it back", async () => {
    const t = setup();
    const e = elsewhere(300);
    const s = t.mk({ lock: e.lock });
    const r1 = run({ command: "pnpm codegen" });
    await s.beforeRun(r1);
    writeFileSync(`${t.work}/gen.ts`, "export const g = 1;\n");
    const local = e.start({ cwd: t.local, terminal: "test" });
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/\[Test Mac\] What the command changed there isn't brought back yet: terminal "test" on this computer \(for \d+ s\) is still running/);
    expect(existsSync(join(t.local, "gen.ts"))).toBe(false);
    // Still running: the next command is refused, and brings nothing back either.
    expect((await s.beforeRun(run())).refuse).toMatch(/terminal "test" on this computer/);
    expect(existsSync(join(t.local, "gen.ts"))).toBe(false);
    e.end(local);
    const b = await s.beforeRun(run());
    expect(b.refuse).toBeUndefined();
    expect(text(b)).toMatch(/A gen\.ts/);
    expect(read(join(t.local, "gen.ts"))).toBe("export const g = 1;\n");
  });

  it("isn't taken by a run core gave up on while it synced", async () => {
    const t = setup();
    const s = t.mk();
    const ac = new AbortController();
    ac.abort();
    expect((await s.beforeRun(run({ terminal: "main", signal: ac.signal }))).refuse).toMatch(/cancelled/);
    expect((await s.beforeRun(run({ terminal: "server" }))).refuse).toBeUndefined();
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
    expect(text(b)).toMatch(/checkout there was gone, or isn.t the one last synced; it is set up again/);
    expect(text(b)).toMatch(/Set up this chat's files there/);
    expect(readFileSync(`${t.work}/a.txt`, "utf8")).toBe("one\ntwo\n");
  });

  it("sets it up again, deleting nothing here, when it was wiped and a new terminal made its directory again", async () => {
    // Live on cvx-mac: ~/.dispatch-host deleted, the machine paired again,
    // and the first command in a new terminal deleted every file here.
    const t = setup();
    writeFileSync(join(t.local, "untracked.txt"), "only here\n");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    rmSync(t.work, { recursive: true, force: true });
    // What a new terminal does before the first sync: make the directory it starts in.
    mkdirSync(join(t.work, "src"), { recursive: true });
    const b = await s.beforeRun(run());
    expect(text(b)).toMatch(/checkout there was gone, or isn.t the one last synced; it is set up again/);
    expect(text(b)).not.toMatch(/Brought back|rebuilt/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");
    expect(read(join(t.local, "src", "b.ts"))).toBe("export const b = 1;\n");
    expect(read(join(t.local, "untracked.txt"))).toBe("only here\n");
    expect(read(`${t.work}/untracked.txt`)).toBe("only here\n");
  });

  it("keeps a record per machine: back from another one, the old checkout's files aren't taken for changes made there", async () => {
    const t = setup();
    const r1 = run();
    const a = t.mk();
    await a.beforeRun(r1);
    await a.afterRun(after(r1));
    // The chat moves to another machine, and a.txt changes while it is there.
    const other = join(t.host, "..", "other-machine").replace(/\\/g, "/");
    mkdirSync(other);
    const b = t.mk({ slug: "other-mac", label: "Other Mac", hostRoot: async () => other });
    writeFileSync(join(t.local, "a.txt"), "edited while on the other machine\n");
    const r2 = run();
    await b.beforeRun(r2);
    await b.afterRun(after(r2));
    // Back on the first: its checkout still has the old a.txt, which nobody changed there.
    const back = await t.mk().beforeRun(run());
    expect(text(back)).not.toMatch(/Brought back/);
    expect(read(join(t.local, "a.txt"))).toBe("edited while on the other machine\n");
    expect(read(`${t.work}/a.txt`)).toBe("edited while on the other machine\n");
    expect([...t.kv.keys()].sort()).toEqual(["sync:other-mac:chat-1", "sync:test-mac:chat-1"]);
  });

  it("takes over the per-chat record older versions kept", async () => {
    const t = setup();
    const s1 = t.mk();
    const r1 = run();
    await s1.beforeRun(r1);
    await s1.afterRun(after(r1));
    t.kv.set("sync:chat-1", t.kv.get("sync:test-mac:chat-1"));
    t.kv.delete("sync:test-mac:chat-1");
    writeFileSync(`${t.work}/a.txt`, "changed there\n");
    const b = await t.mk().beforeRun(run());
    expect(text(b)).toMatch(/Brought back .*M a\.txt/);
    expect(text(b)).not.toMatch(/Set up/);
    expect([...t.kv.keys()]).toEqual(["sync:test-mac:chat-1"]);
  });

  it("keeps its record under its own prefix, and adopts no per-chat one when told not to (a provisioned machine)", async () => {
    const t = setup();
    const theirs = { checkout: "/elsewhere/chat-1", note: "a paired machine's, from before records were per machine" };
    t.kv.set("sync:chat-1", theirs);
    const own = { kvPrefix: "x/caller/backend/m1", adoptLegacy: false };
    const r1 = run();
    const s = t.mk(own);
    const b = await s.beforeRun(r1);
    expect(text(b)).toMatch(/Set up/);
    await s.afterRun(after(r1));
    expect([...t.kv.keys()].sort()).toEqual(["sync:chat-1", "sync:x/caller/backend/m1:chat-1"]);
    expect(t.kv.get("sync:chat-1")).toEqual(theirs);
  });
});

describe.skipIf(!SH)("which checkout it is", () => {
  const ID_FILE = (t: ReturnType<typeof setup>) => `${t.work}/.git/dispatch-checkout`;
  const recorded = (t: ReturnType<typeof setup>) => (t.kv.get("sync:test-mac:chat-1") as { checkout?: string }).checkout;

  it("gives the checkout an id at setup and keeps it in the record", async () => {
    const t = setup();
    const s = t.mk();
    await s.beforeRun(run());
    const id = readFileSync(ID_FILE(t), "utf8").trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded(t)).toBe(id);
  });

  it("never reads a checkout with another id against the base: a partial wipe deletes nothing here", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    // Half wiped, and git made again there: the same layout, not the same checkout.
    rmSync(`${t.work}/a.txt`);
    writeFileSync(ID_FILE(t), "some-other-checkout\n");
    const b = await s.beforeRun(run());
    expect(text(b)).toMatch(/isn't the one last synced; it is set up again from your files\. Nothing was deleted here/);
    expect(text(b)).not.toMatch(/Brought back|Deleted here/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");
    expect(b.refuse).toBeUndefined();
    expect(read(`${t.work}/a.txt`)).toBe("one\ntwo\n");
    // Set up again with an id of its own.
    expect(readFileSync(ID_FILE(t), "utf8").trim()).toBe(recorded(t));
    expect(recorded(t)).not.toBe("some-other-checkout");
  });

  it("gives a checkout set up before ids one, and carries on as before", async () => {
    const t = setup();
    const s1 = t.mk();
    const r1 = run();
    await s1.beforeRun(r1);
    await s1.afterRun(after(r1));
    rmSync(ID_FILE(t));
    const rec = t.kv.get("sync:test-mac:chat-1") as { checkout?: string };
    delete rec.checkout;
    writeFileSync(`${t.work}/a.txt`, "changed there\n");
    const b = await t.mk().beforeRun(run());
    expect(text(b)).toMatch(/Brought back .*M a\.txt/);
    expect(text(b)).not.toMatch(/set up again/);
    expect(readFileSync(ID_FILE(t), "utf8").trim()).toBe(recorded(t));
  });

  it("a new terminal sets a missing checkout up instead of making a bare directory, and the next command starts from your files", async () => {
    const t = setup();
    writeFileSync(join(t.local, "untracked.txt"), "only here\n");
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    rmSync(t.work, { recursive: true, force: true });
    await s.ensureCheckout("src");
    // Made by setup: a .git with a new id the record keeps, and the shell's directory in it.
    expect(existsSync(`${t.work}/src`)).toBe(true);
    expect(readFileSync(ID_FILE(t), "utf8").trim()).toBe(recorded(t));
    const b = await s.beforeRun(run());
    expect(text(b)).toMatch(/checkout there was gone; it is set up again from your files\. Nothing was deleted here/);
    expect(text(b)).not.toMatch(/Brought back|Deleted here/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");
    expect(read(join(t.local, "untracked.txt"))).toBe("only here\n");
    expect(read(`${t.work}/untracked.txt`)).toBe("only here\n");
  });

  it("says a new terminal set it up again even when that command is cancelled", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    rmSync(t.work, { recursive: true, force: true });
    await s.ensureCheckout("");
    const b = await s.beforeRun(run({ signal: AbortSignal.abort() }));
    expect(b.refuse).toBeDefined();
    expect(text(b)).toMatch(/checkout there was gone; it is set up again from your files/);
  });

  it("a new terminal in a checkout that is there only makes its directory", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    const id = recorded(t);
    await s.ensureCheckout("deep/new/dir");
    expect(existsSync(`${t.work}/deep/new/dir`)).toBe(true);
    expect(recorded(t)).toBe(id);
    expect(text(await s.beforeRun(run()))).not.toMatch(/set up again/);
  });
});

describe.skipIf(!SH)("bulk deletes there", () => {
  /** A worktree of `n` more tracked files, f0.txt … */
  function withFiles(n: number) {
    const t = setup();
    for (let i = 0; i < n; i++) writeFileSync(join(t.local, `f${i}.txt`), `${i}\n`);
    g(t.local, "add", "-A");
    g(t.local, "commit", "-qm", "more");
    return t;
  }

  it("deletes nothing here when a command deletes more than half the files there, and puts them back there on the next command", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run({ command: "rm a.txt src/b.ts" });
    await s.beforeRun(r1);
    rmSync(`${t.work}/a.txt`);
    rmSync(`${t.work}/src/b.ts`);
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/`rm a\.txt src\/b\.ts` deleted 2 of the 3 files in this chat's checkout on Test Mac: a\.txt, src\/b\.ts\. That is more than half of them, so none of it was deleted here/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");
    expect(read(join(t.local, "src", "b.ts"))).toBe("export const b = 1;\n");
    // Not meant: the next command puts them back there, and runs.
    const b = await s.beforeRun(run());
    expect(b.refuse).toBeUndefined();
    expect(text(b)).toMatch(/Put back there, from the last sync, the 2 files deleted there that you didn't delete here/);
    expect(read(`${t.work}/a.txt`)).toBe("one\ntwo\n");
    expect(read(`${t.work}/src/b.ts`)).toBe("export const b = 1;\n");
  });

  it("refuses the command when it finds a bulk delete before it, and syncs it once you delete them here too", async () => {
    const t = setup();
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    await s.afterRun(after(r1));
    rmSync(`${t.work}/a.txt`);
    rmSync(`${t.work}/src/b.ts`);
    const b = await s.beforeRun(run());
    expect(b.refuse).toMatch(/^Not run: Something deleted 2 of the 3 files .* none of it was deleted here, and the command didn't run/);
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");
    // Meant: delete them here too, and the next command syncs as usual.
    rmSync(join(t.local, "a.txt"));
    rmSync(join(t.local, "src", "b.ts"));
    const c = await s.beforeRun(run());
    expect(c.refuse).toBeUndefined();
    expect(text(c)).not.toMatch(/Put back/);
    expect(existsSync(`${t.work}/a.txt`)).toBe(false);
  });

  it("holds back more than 50 deletes even when that is less than half", async () => {
    const t = withFiles(120);
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    for (let i = 0; i < 51; i++) rmSync(`${t.work}/f${i}.txt`);
    const a = await s.afterRun(after(r1));
    expect(text(a)).toMatch(/deleted 51 of the 123 files .* That is more than 50, so none of it was deleted here/);
    expect(existsSync(join(t.local, "f0.txt"))).toBe(true);
    // 50 is fine.
    const t2 = withFiles(120);
    const s2 = t2.mk();
    const r2 = run();
    await s2.beforeRun(r2);
    for (let i = 0; i < 50; i++) rmSync(`${t2.work}/f${i}.txt`);
    const a2 = await s2.afterRun(after(r2));
    expect(text(a2)).toMatch(/Deleted here, as they were deleted there/);
    expect(existsSync(join(t2.local, "f0.txt"))).toBe(false);
  });

  it("names the snapshot of every delete it brings back, with the one line that undoes it", async () => {
    const t = withFiles(20);
    const s = t.mk();
    const r1 = run();
    await s.beforeRun(r1);
    rmSync(`${t.work}/a.txt`);
    const a = await s.afterRun(after(r1));
    const m = text(a).match(/Deleted here, as they were deleted there.*: a\.txt\. Your files from just before are in commit ([0-9a-f]{40})\. To get these back: `([^`]+)`/);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(`git restore --source=${m![1]} --worktree -- 'a.txt'`);
    expect(existsSync(join(t.local, "a.txt"))).toBe(false);
    g(t.local, "restore", `--source=${m![1]}`, "--worktree", "--", "a.txt");
    expect(read(join(t.local, "a.txt"))).toBe("one\ntwo\n");

    // Many, or odd names: a pathspec file in the git directory, each taken literally.
    const t2 = withFiles(20);
    writeFileSync(join(t2.local, "odd name [1].txt"), "odd\n");
    g(t2.local, "add", "-A");
    g(t2.local, "commit", "-qm", "odd");
    const s2 = t2.mk();
    const r2 = run();
    await s2.beforeRun(r2);
    for (const f of ["odd name [1].txt", "f1.txt", "f2.txt"]) rmSync(`${t2.work}/${f}`);
    const a2 = await s2.afterRun(after(r2));
    const m2 = text(a2).match(/To get these back: `git restore --source=([0-9a-f]{40}) --worktree --pathspec-file-nul --pathspec-from-file=([^`]+)`/);
    expect(m2).not.toBeNull();
    g(t2.local, "restore", `--source=${m2![1]}`, "--worktree", "--pathspec-file-nul", `--pathspec-from-file=${m2![2]}`);
    expect(read(join(t2.local, "odd name [1].txt"))).toBe("odd\n");
    expect(read(join(t2.local, "f2.txt"))).toBe("2\n");
  });

  it("still names the snapshot when the pathspec file can't be written", async () => {
    // Not a repository: git can't say where its directory is, so no file.
    const nowhere = mkdtempSync(join(tmpdir(), "rh-norepo-"));
    dirs.push(nowhere);
    const sha = "a".repeat(40);
    const line = await restoreLine(nowhere, sha, ["odd name.txt", "b"]);
    expect(line).toBe(`\`git restore --source=${sha} --worktree -- <path>\`, for each of the files above`);
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

  it("refuses paths that can't be written here safely", async () => {
    const r = mkdtempSync(join(tmpdir(), "rh-paths-"));
    dirs.push(r);
    writeFileSync(join(r, "file"), "x");
    for (const p of [".git/config", "src/.GIT/x", "GIT~1/HEAD", "../out", "a//b", "/abs"]) expect(await pathProblem(r, p, false), p).toBeDefined();
    for (const p of ["a:b.txt", "con.txt", "dir/NUL", "foo.", "bar ", "q?x"]) expect(await pathProblem(r, p, true), p).toMatch(/Windows/);
    expect(await pathProblem(r, "file/inner", false)).toBe("file is a file here");
    expect(await pathProblem(r, "src/new.ts", false)).toBeUndefined();
    expect(await pathProblem(r, "a:b.txt", false)).toBeUndefined();
  });

  it("syncs a repository from its top, and nothing outside one", async () => {
    const t = setup();
    expect(await repoTop(join(t.local, "src"))).toBe(realpathSync.native(t.local));
    const plain = mkdtempSync(join(tmpdir(), "rh-plain-"));
    dirs.push(plain);
    expect(await repoTop(plain)).toBeUndefined();
    expect(await repoTop(join(plain, "gone"))).toBeUndefined();
    expect(await repoTop(undefined)).toBeUndefined();
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
