/**
 * The probe's check of the git sync runs: which one, and whether it runs, as
 * on a Mac whose git Xcode's license blocks. POSIX only (fake gits are
 * `#!/bin/sh` scripts); CI runs it on Linux and macOS.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitEnv } from "../src/git-env.js";
import { checkGit, which } from "../src/probe.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A directory holding `git`, a script with `body`. */
function bin(body: string): string {
  const d = mkdtempSync(join(tmpdir(), "dh-probe-"));
  dirs.push(d);
  mkdirSync(join(d, "bin"));
  writeFileSync(join(d, "bin", "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return join(d, "bin");
}

/** `/usr/bin/git` on a Mac whose developer directory is Xcode, its license not accepted. */
const LICENSE = 'echo "You have not agreed to the Xcode license agreements. Please run \'sudo xcodebuild -license\'." >&2\nexit 69';
/** The same stub with the Command Line Tools chosen, unless DEVELOPER_DIR says Xcode: the real git, found past this directory. */
const STUB = `if [ -n "\${DEVELOPER_DIR:-}" ]; then ${LICENSE.replace("\n", "; ")}; fi\nPATH=\${PATH#*:} exec git "$@"`;

describe.skipIf(!posix)("checkGit", () => {
  it("names the git it found and that the license blocks it (exit 69), not 'not found'", async () => {
    const b = bin(LICENSE);
    const r = await checkGit({ ...process.env, PATH: `${b}:${process.env.PATH}` }, { developerDir: "/Applications/Xcode.app/Contents/Developer" });
    expect(r).toEqual({
      path: join(b, "git"),
      developerDir: "/Applications/Xcode.app/Contents/Developer",
      exitCode: 69,
      version: null,
      error: "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'.",
    });
  });

  it("runs git without DEVELOPER_DIR, so an Xcode one in the environment can't block it", async () => {
    const b = bin(STUB);
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}`, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" };
    expect((await checkGit(env)).exitCode).toBe(69);
    const r = await checkGit(gitEnv(env));
    expect(r).toMatchObject({ path: join(b, "git"), exitCode: 0, version: expect.stringMatching(/^git version \d/) });
    expect(r.error).toBeUndefined();
  });

  it("says there is none when no git is on the PATH", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dh-probe-"));
    dirs.push(empty);
    expect(await checkGit({ ...process.env, PATH: empty })).toEqual({ path: null, exitCode: null, version: null });
    expect(which("git", empty)).toBeNull();
  });

  it.skipIf(!existsSync("/usr/bin/git"))("never runs a /usr/bin stub on a Mac with no developer tools (it would open a dialog there)", async () => {
    const r = await checkGit({ ...process.env, PATH: "/usr/bin:/bin" }, { developerDir: null });
    expect(r).toEqual({
      path: "/usr/bin/git",
      developerDir: null,
      exitCode: null,
      version: null,
      error: "no developer tools; install the Command Line Tools (xcode-select --install)",
    });
  });
});

describe("gitEnv", () => {
  it("drops DEVELOPER_DIR and sets the C locale, leaving the rest and the original alone", () => {
    const base = { PATH: "/usr/bin", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer", HOME: "/Users/dispatch" };
    expect(gitEnv(base)).toEqual({ PATH: "/usr/bin", HOME: "/Users/dispatch", LC_ALL: "C" });
    expect(base.DEVELOPER_DIR).toBe("/Applications/Xcode.app/Contents/Developer");
  });
});
