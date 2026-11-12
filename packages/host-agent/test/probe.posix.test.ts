/**
 * The probe's check of the git sync runs, and of Homebrew: which one, and
 * whether it runs, as on a Mac whose Xcode's license isn't accepted. POSIX
 * only (the fakes are `#!/bin/sh` scripts); CI runs it on Linux and macOS.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLT_DEVELOPER_DIR, gitEnv } from "../src/git-env.js";
import { checkBrew, checkGit, probe, which } from "../src/probe.js";

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
      writable: true,
      blocked: `Xcode's license isn't accepted (exit 69), and Homebrew ignores DEVELOPER_DIR, so it uses xcode-select's ${XCODE}`,
    });
    // Asked the way brew asks: with no DEVELOPER_DIR.
    expect(readFileSync(x.ran, "utf8")).toBe("dev=none\n");
  });

  it("runs once xcode-select points at the Command Line Tools", async () => {
    const b = bin(BREW, "brew");
    const ok = bin(`echo ${CLT_DEVELOPER_DIR}/usr/bin/clang`, "xcrun");
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}` };
    expect(await checkBrew(env, { developerDir: CLT_DEVELOPER_DIR }, join(ok, "xcrun"))).toEqual({ path: join(b, "brew"), version: "Homebrew 7.0.12", writable: true });
  });

  it("doesn't run xcrun with no developer directory chosen (brew skips it too, and the stub would open a dialog), nor off a Mac", async () => {
    const b = bin(BREW, "brew");
    const x = xcrun();
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}` };
    expect(await checkBrew(env, { developerDir: null }, x.path)).toEqual({ path: join(b, "brew"), version: "Homebrew 7.0.12", writable: true });
    expect(await checkBrew(env, undefined, x.path)).toEqual({ path: join(b, "brew"), version: "Homebrew 7.0.12", writable: true });
    expect(existsSync(x.ran)).toBe(false);
  });

  it("is absent when no brew is on the PATH", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dh-probe-"));
    dirs.push(empty);
    expect(await checkBrew({ ...process.env, PATH: empty }, { developerDir: XCODE })).toBeUndefined();
  });

  describe("Command Line Tools older than Homebrew needs on this macOS", () => {
    /** cvx-mac's brew doctor, 2026-11-06: Command Line Tools 14.3.1 on macOS 27.2. */
    const TOO_OLD = [
      "Warning: Your Command Line Tools are too outdated.",
      "",
      "Update them from Software Update in System Settings.",
      "",
      "Alternatively, manually download them from:",
      "  https://developer.apple.com/download/all/.",
      "You should download the Command Line Tools for Xcode 27.0.",
    ];
    /** A brew whose `doctor <check>` prints `lines` to stderr and exits `code`; each doctor call is logged. */
    function brew(lines: string[], code: number): { dir: string; doctor: string } {
      const echo = lines.map((l) => `echo '${l}' >&2`).join("; ");
      const b = bin(
        `case "$1" in doctor) echo "$*" >> "$(dirname "$0")/doctor"; ${echo || ":"}; exit ${code};; *) echo "Homebrew 7.0.12";; esac`,
        "brew",
      );
      return { dir: b, doctor: join(b, "doctor") };
    }
    const ok = () => join(bin(`echo ${CLT_DEVELOPER_DIR}/usr/bin/clang`, "xcrun"), "xcrun");
    const clt = { developerDir: CLT_DEVELOPER_DIR };

    it("asks brew's own check, and says which ones it wants: brew runs, so nothing is blocked", async () => {
      const b = brew(TOO_OLD, 1);
      const env = { ...process.env, PATH: `${b.dir}:${process.env.PATH}` };
      expect(await checkBrew(env, clt, ok())).toEqual({
        path: join(b.dir, "brew"),
        version: "Homebrew 7.0.12",
        writable: true,
        cltTooOld: "Command Line Tools for Xcode 27.0",
      });
      expect(readFileSync(b.doctor, "utf8")).toBe("doctor check_clt_minimum_version\n");
    });

    it("still says so when brew doesn't name the ones it wants", async () => {
      const b = brew(["Warning: Your Command Line Tools are too outdated."], 1);
      const env = { ...process.env, PATH: `${b.dir}:${process.env.PATH}` };
      expect(await checkBrew(env, clt, ok())).toMatchObject({ cltTooOld: "newer Command Line Tools" });
    });

    it("says nothing when they're new enough, when this brew has no such check, or when brew failed some other way", async () => {
      for (const [lines, code] of [
        [["Your system is ready to brew."], 0],
        [["Error: No check available by the name: check_clt_minimum_version"], 1],
        [["Error: Something else broke"], 1],
      ] as const) {
        const b = brew([...lines], code);
        const env = { ...process.env, PATH: `${b.dir}:${process.env.PATH}` };
        const r = await checkBrew(env, clt, ok());
        expect(r).toEqual({ path: join(b.dir, "brew"), version: "Homebrew 7.0.12", writable: true });
      }
    });

    it("says only that brew is blocked while Xcode's license stops it", async () => {
      const b = brew(TOO_OLD, 1);
      const x = xcrun();
      const env = { ...process.env, PATH: `${b.dir}:${process.env.PATH}` };
      const r = await checkBrew(env, { developerDir: XCODE }, x.path);
      expect(r?.blocked).toMatch(/license/);
      expect(r?.cltTooOld).toBeUndefined();
    });

    it("doesn't ask with no developer directory chosen, nor off a Mac", async () => {
      const b = brew(TOO_OLD, 1);
      const env = { ...process.env, PATH: `${b.dir}:${process.env.PATH}` };
      expect(await checkBrew(env, { developerDir: null }, ok())).not.toHaveProperty("cltTooOld");
      expect(await checkBrew(env, undefined, ok())).not.toHaveProperty("cltTooOld");
      expect(existsSync(b.doctor)).toBe(false);
    });
  });

  // Root writes anywhere, so as root a read-only prefix stays writable. (Homebrew
  // refuses to run as root anyway, so remote-host says nothing of it to a root login.)
  const root = process.getuid?.() === 0;
  it("says this account can't install with a Homebrew whose prefix another account owns", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "dh-brew-"));
    dirs.push(prefix);
    mkdirSync(join(prefix, "Cellar"));
    mkdirSync(join(prefix, "bin"));
    const b = bin(`case "$1" in --prefix) echo '${prefix}';; *) echo "Homebrew 7.0.12";; esac`, "brew");
    const env = { ...process.env, PATH: `${b}:${process.env.PATH}` };
    expect(await checkBrew(env, undefined)).toEqual({ path: join(b, "brew"), version: "Homebrew 7.0.12", writable: true });
    chmodSync(join(prefix, "Cellar"), 0o555);
    try {
      expect(await checkBrew(env, undefined)).toMatchObject({ writable: root });
    } finally {
      chmodSync(join(prefix, "Cellar"), 0o755);
    }
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

describe.skipIf(!posix)("probe", () => {
  it("says who it runs as, how a shell gets root, what finds ports, and which bash", async () => {
    const p = await probe();
    expect(p.uid).toBe(process.getuid!());
    expect(p.elevation).toBe(p.uid === 0 ? "root" : "approval-helper");
    expect(p.ports).toEqual(process.platform === "darwin" ? "lsof" : expect.stringMatching(/^(ss|proc)$/));
    expect(p.bash).toMatch(/\/bash$/);
    if (process.platform === "linux") expect(p.os.id).toMatch(/^[a-z0-9._-]+$/);
  }, 30_000);
});
