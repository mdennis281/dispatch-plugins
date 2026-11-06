/**
 * The probe's check of the git sync runs, and of Homebrew: which one, and
 * whether it runs, as on a Mac whose Xcode's license isn't accepted. POSIX
 * only (the fakes are `#!/bin/sh` scripts); CI runs it on Linux and macOS.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLT_DEVELOPER_DIR, gitEnv } from "../src/git-env.js";
import { checkBrew, checkGit, which } from "../src/probe.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A directory holding `name` (git by default), a script with `body`. */
function bin(body: string, name = "git"): string {
  const d = mkdtempSync(join(tmpdir(), "dh-probe-"));
  dirs.push(d);
  mkdirSync(join(d, "bin"));
  writeFileSync(join(d, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
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

describe.skipIf(!posix)("checkBrew", () => {
  const BREW = 'echo "Homebrew 7.0.12"';
  /**
   * `/usr/bin/xcrun` on cvx-mac (xcode-select on Xcode, license not accepted):
   * fine with the Command Line Tools' DEVELOPER_DIR, which brew never passes
   * it. `ran` records each call's DEVELOPER_DIR.
   */
  function xcrun(): { path: string; ran: string } {
    const b = bin(
      [
        `echo "dev=\${DEVELOPER_DIR:-none}" >> "$(dirname "$0")/ran"`,
        `[ "\${DEVELOPER_DIR:-}" = "${CLT_DEVELOPER_DIR}" ] && { echo ${CLT_DEVELOPER_DIR}/usr/bin/clang; exit 0; }`,
        LICENSE,
      ].join("\n"),
      "xcrun",
    );
    return { path: join(b, "xcrun"), ran: join(b, "ran") };
  }

  it("names the brew on the PATH and says it is blocked by Xcode's license, whatever DEVELOPER_DIR the shell has", async () => {
    const b = bin(BREW, "brew");
    const x = xcrun();
    // The chat shell's environment: the Command Line Tools' DEVELOPER_DIR, which git honours and brew drops.
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}`, DEVELOPER_DIR: CLT_DEVELOPER_DIR };
    expect(await checkBrew(env, { developerDir: XCODE }, x.path)).toEqual({
      path: join(b, "brew"),
      version: "Homebrew 7.0.12",
      blocked: `Xcode's license isn't accepted (exit 69), and Homebrew ignores DEVELOPER_DIR, so it uses xcode-select's ${XCODE}`,
    });
    // Asked the way brew asks: with no DEVELOPER_DIR.
    expect(readFileSync(x.ran, "utf8")).toBe("dev=none\n");
  });

  it("runs once xcode-select points at the Command Line Tools", async () => {
    const b = bin(BREW, "brew");
    const ok = bin(`echo ${CLT_DEVELOPER_DIR}/usr/bin/clang`, "xcrun");
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}` };
    expect(await checkBrew(env, { developerDir: CLT_DEVELOPER_DIR }, join(ok, "xcrun"))).toEqual({ path: join(b, "brew"), version: "Homebrew 7.0.12" });
  });

  it("doesn't run xcrun with no developer directory chosen (brew skips it too, and the stub would open a dialog), nor off a Mac", async () => {
    const b = bin(BREW, "brew");
    const x = xcrun();
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}` };
    expect(await checkBrew(env, { developerDir: null }, x.path)).toEqual({ path: join(b, "brew"), version: "Homebrew 7.0.12" });
    expect(await checkBrew(env, undefined, x.path)).toEqual({ path: join(b, "brew"), version: "Homebrew 7.0.12" });
    expect(existsSync(x.ran)).toBe(false);
  });

  it("is absent when no brew is on the PATH", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dh-probe-"));
    dirs.push(empty);
    expect(await checkBrew({ ...process.env, PATH: empty }, { developerDir: XCODE })).toBeUndefined();
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
