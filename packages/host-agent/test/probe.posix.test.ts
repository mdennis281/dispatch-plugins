/**
 * The probe's check of the git sync runs: which one, and whether it runs, as
 * on a Mac whose git Xcode's license blocks. POSIX only (fake gits are
 * `#!/bin/sh` scripts); CI runs it on Linux and macOS.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLT_DEVELOPER_DIR, gitEnv } from "../src/git-env.js";
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
/**
 * cvx-mac's `/usr/bin/git`, xcode-select on Xcode (license not accepted) and
 * the Command Line Tools installed: git runs only with their DEVELOPER_DIR
 * (then the runner's own git, found past this directory, with the runner's
 * own developer directory).
 */
const STUB = `if [ "\${DEVELOPER_DIR:-}" != "${CLT_DEVELOPER_DIR}" ]; then ${LICENSE.replace("\n", "; ")}; fi\nunset DEVELOPER_DIR\nPATH=\${PATH#*:} exec git "$@"`;
const XCODE = "/Applications/Xcode.app/Contents/Developer";

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

  it("runs git from the Command Line Tools when they're installed, whatever xcode-select or the environment says, and names it", async () => {
    const b = bin(STUB);
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}`, DEVELOPER_DIR: XCODE };
    const mac = { developerDir: XCODE };
    // With them: their DEVELOPER_DIR, no sudo, no license.
    const r = await checkGit(gitEnv(env, true), mac);
    expect(r).toMatchObject({ path: join(b, "git"), developerDir: CLT_DEVELOPER_DIR, exitCode: 0, version: expect.stringMatching(/^git version \d/) });
    expect(r.error).toBeUndefined();
    // Without them: xcode-select's (Xcode's here), blocked, and said so.
    expect(await checkGit(gitEnv(env, false), mac)).toMatchObject({ developerDir: XCODE, exitCode: 69, version: null });
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
  it("sets the Command Line Tools' DEVELOPER_DIR when they're installed, drops any other, and sets the C locale", () => {
    const base = { PATH: "/usr/bin", DEVELOPER_DIR: XCODE, HOME: "/Users/dispatch" };
    expect(gitEnv(base, true)).toEqual({ PATH: "/usr/bin", HOME: "/Users/dispatch", DEVELOPER_DIR: CLT_DEVELOPER_DIR, LC_ALL: "C" });
    expect(gitEnv(base, false)).toEqual({ PATH: "/usr/bin", HOME: "/Users/dispatch", LC_ALL: "C" });
    expect(base.DEVELOPER_DIR).toBe(XCODE);
  });
});
