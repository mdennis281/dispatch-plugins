/**
 * The `sudo` shim chat shells get: which of sudo's options it can honour,
 * which it refuses (and why), and that a command reaches dispatch-elevate
 * with its arguments intact. POSIX only (the shims are shell scripts); CI
 * runs it on Linux and macOS.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elevateShim, ensureShims } from "../src/shims.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The shims, with a stand-in `dispatch-host` that prints the arguments it got, one per line. */
function shims(): string {
  const dir = mkdtempSync(join(tmpdir(), "dh-shims-"));
  dirs.push(dir);
  const fake = join(dir, "fake-agent.sh");
  writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n', { mode: 0o755 });
  ensureShims(join(dir, "bin"), "/bin/sh", fake);
  return join(dir, "bin");
}

function sudo(bin: string, ...args: string[]) {
  const r = spawnSync(join(bin, "sudo"), args, { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!posix)("the sudo shim", () => {
  it("hands the command to dispatch-elevate with every argument intact", () => {
    const bin = shims();
    const r = sudo(bin, "installer", "-pkg", "/tmp/a b.pkg", "-target", "/");
    expect(r.code).toBe(0);
    expect(r.out).toBe("[elevate]\n[installer]\n[-pkg]\n[/tmp/a b.pkg]\n[-target]\n[/]\n");
  });

  it("takes -- and -u root, and refuses another user rather than quietly running as root", () => {
    const bin = shims();
    expect(sudo(bin, "--", "id", "-u").out).toBe("[elevate]\n[id]\n[-u]\n");
    expect(sudo(bin, "-u", "root", "id").out).toBe("[elevate]\n[id]\n");
    const other = sudo(bin, "-u", "bob", "id");
    expect(other.code).toBe(1);
    expect(other.out).toBe("");
    expect(other.err).toMatch(/-u bob: only root is possible here/);
  });

  it("refuses what it can't honour, saying why: -n, -E, -s, -i, -S, unknown options", () => {
    const bin = shims();
    for (const [flag, why] of [
      ["-n", /needs the user's approval/],
      ["-E", /root's own environment/],
      ["-s", /no interactive root shell/],
      ["-i", /no interactive root shell/],
      ["-S", /no password to give/],
      ["-x", /not supported here/],
    ] as const) {
      const r = sudo(bin, flag, "id");
      expect(r.code, flag).toBe(1);
      expect(r.out, flag).toBe("");
      expect(r.err, flag).toMatch(why);
    }
  });

  it("treats -v and -k as done (each command is approved on its own), and a bare sudo as a mistake", () => {
    const bin = shims();
    expect(sudo(bin, "-v").code).toBe(0);
    expect(sudo(bin, "-k").code).toBe(0);
    const bare = sudo(bin);
    expect(bare.code).toBe(1);
    expect(bare.err).toMatch(/usage: sudo <command>/);
  });

  it("is written once, executable, and left alone when unchanged", () => {
    const bin = shims();
    const file = join(bin, "dispatch-elevate");
    expect(statSync(file).mode & 0o111).toBeTruthy();
    expect(readFileSync(file, "utf8")).toBe(elevateShim("/bin/sh", join(bin, "..", "fake-agent.sh")));
    const before = statSync(file).mtimeMs;
    ensureShims(bin, "/bin/sh", join(bin, "..", "fake-agent.sh"));
    expect(statSync(file).mtimeMs).toBe(before);
  });
});
