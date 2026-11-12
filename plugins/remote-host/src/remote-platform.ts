/**
 * The machine's operating system, as remote-host sees it from here, in one
 * place:
 * - what dispatch-host can run on;
 * - who the login is (root or not), and whether root with approval can be set up;
 * - how to tell the user to install a tool there;
 * - why SSH might refuse.
 *
 * host-agent's platform.ts is the other side of this seam, on the machine.
 * Linux exercises both now; Windows (Phase 7) becomes one more case of each.
 */
import { compareVersions, nodeTarball, sq, type NodeTarball, type ProbeResult } from "@dispatch-plugins/host-agent";

/** A machine dispatch-host can't run on, and why. Reported as it is, never retried into a different failure. */
export class UnsupportedMachine extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMachine";
  }
}

/**
 * The pinned Node for a machine, from `uname -s`, `uname -m` and its C
 * library (`musl` or `gnu`, Linux only); else why there is none. The pinned
 * builds are 64-bit, and the Linux ones need glibc.
 */
export function runtimeFor(platform: string, arch: string, libc?: string): NodeTarball {
  const os = platform.toLowerCase();
  if (os !== "darwin" && os !== "linux") {
    throw new UnsupportedMachine(`${platform} isn't supported: dispatch-host runs on macOS and Linux`);
  }
  if (os === "linux" && libc === "musl") {
    throw new UnsupportedMachine(
      "this Linux uses the musl C library (Alpine, say), which isn't supported: dispatch-host's Node is built for glibc " +
        "(Debian, Ubuntu, Fedora and the like)",
    );
  }
  if (/^(armv[0-7]|arm$|i[3-6]86$|x86$)/i.test(arch)) {
    throw new UnsupportedMachine(`${arch} is a 32-bit machine, which isn't supported: dispatch-host needs x86_64 or arm64`);
  }
  try {
    return nodeTarball(platform, arch);
  } catch {
    throw new UnsupportedMachine(`${platform} on ${arch} isn't supported: dispatch-host needs x86_64 or arm64`);
  }
}

/**
 * A POSIX sh snippet printing the machine's C library: `gnu`, `musl`, or `-`
 * when it can't tell (never refused for that). glibc is looked for first, by
 * `getconf GNU_LIBC_VERSION` or its loader: a Debian or Ubuntu with the
 * `musl` package (musl-tools, for static Rust builds) has `/lib/ld-musl-*`
 * too, and is no musl system. `root` is for the tests: a directory standing
 * in for `/`.
 */
export function libcScript(root = ""): string {
  const glibc = [`${root}/lib64/ld-linux-x86-64.so.2`, `${root}/lib/ld-linux-aarch64.so.1`].map((p) => `[ -e ${sq(p)} ]`).join(" || ");
  return [
    `if getconf GNU_LIBC_VERSION >/dev/null 2>&1 || ${glibc}; then echo gnu`,
    `else m=-; for f in ${sq(root)}/lib/ld-musl-*; do [ -e "$f" ] && m=musl; done; echo "$m"; fi`,
  ].join("\n");
}

/**
 * Whether the login there is root. An agent before 0.5.0 doesn't report its
 * uid; then only the account's name can say.
 */
export function rootLogin(probe: ProbeResult | undefined, user?: string): boolean {
  return probe?.uid !== undefined ? probe.uid === 0 : user === "root";
}

/**
 * Whether root with approval can be set up there: only on a Mac (its setup
 * makes a hidden macOS account), and only for a login that isn't root
 * already. Before the first probe, it is offered as before.
 */
export function elevationSetupPossible(probe: ProbeResult | undefined, user?: string): boolean {
  if (rootLogin(probe, user)) return false;
  return !probe || probe.platform === "darwin";
}

/** Debian, Ubuntu and their kind, which install with apt. */
export function aptBased(probe: ProbeResult | undefined): boolean {
  if (probe?.platform !== "linux") return false;
  const words = `${probe.os.id ?? ""} ${probe.os.like ?? ""} ${probe.os.name ?? ""}`.toLowerCase();
  return /\b(debian|ubuntu)\b/.test(words);
}

/** How to install a missing tool there, for a status line: ` (apt install git)`, or nothing when it can't say. */
export function installHint(probe: ProbeResult | undefined, pkg: { apt?: string; brew?: string }): string {
  if (pkg.apt && aptBased(probe)) return ` (as root: apt install ${pkg.apt})`;
  if (pkg.brew && probe?.platform === "darwin") return ` (brew install ${pkg.brew})`;
  return "";
}

/** What to check when SSH refuses the connection, by the OS last seen there. */
export function refusedHint(platform: string | undefined): string {
  if (platform === "darwin") return "is Remote Login on?";
  if (platform === "linux") return "is sshd running?";
  return "is Remote Login (macOS) or sshd (Linux) on?";
}

/**
 * The oldest git the sync works with there: it checks paths out with
 * `git checkout --pathspec-from-file` (sync/remote.ts), new in 2.26.
 */
export const MIN_GIT = "2.26.0";

/** `git version 2.25.1` → why it's too old; undefined when it isn't, or can't be read. */
export function gitTooOld(version: string | null | undefined): string | undefined {
  const v = version?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
  if (!v || compareVersions(v, MIN_GIT) >= 0) return undefined;
  return `git ${v} is older than ${MIN_GIT.replace(/\.0$/, "")}, which the file sync needs`;
}
