import { describe, expect, it } from "vitest";
import type { ProbeResult } from "@dispatch-plugins/host-agent";
import {
  UnsupportedMachine,
  aptBased,
  elevationSetupPossible,
  gitTooOld,
  installHint,
  refusedHint,
  rootLogin,
  runtimeFor,
} from "../src/remote-platform.js";
import { PROBE } from "./fake-machine.js";

const linux = (o: Partial<ProbeResult> = {}): ProbeResult => ({
  ...PROBE,
  platform: "linux",
  os: { name: "Debian GNU/Linux", version: "12", id: "debian" },
  ...o,
});

describe("runtimeFor", () => {
  it("pins Node for 64-bit macOS and glibc Linux", () => {
    expect(runtimeFor("Darwin", "arm64").dir).toMatch(/-darwin-arm64$/);
    expect(runtimeFor("Linux", "x86_64", "gnu").dir).toMatch(/-linux-x64$/);
    expect(runtimeFor("Linux", "aarch64").dir).toMatch(/-linux-arm64$/);
  });

  it.each([
    ["Linux", "x86_64", "musl", /musl/],
    ["Linux", "armv7l", "gnu", /armv7l is a 32-bit machine/],
    ["Linux", "armv6l", "gnu", /32-bit/],
    ["Linux", "i686", "gnu", /i686 is a 32-bit machine/],
    ["Linux", "riscv64", "gnu", /Linux on riscv64 isn't supported: dispatch-host needs x86_64 or arm64/],
    ["FreeBSD", "amd64", undefined, /FreeBSD isn't supported/],
  ])("refuses %s %s %s, saying why", (platform, arch, libc, why) => {
    expect(() => runtimeFor(platform, arch, libc)).toThrow(UnsupportedMachine);
    expect(() => runtimeFor(platform, arch, libc)).toThrow(why);
  });
});

describe("root and elevation", () => {
  it("knows a root login by its uid, or by its name from an agent that doesn't report one", () => {
    expect(rootLogin(linux({ uid: 0 }), "admin")).toBe(true);
    expect(rootLogin(linux({ uid: 1000 }), "root")).toBe(false);
    expect(rootLogin(linux(), "root")).toBe(true);
    expect(rootLogin(undefined, "dispatch")).toBe(false);
  });

  it("offers root with approval only on a Mac logged in as someone else, and before the first probe", () => {
    expect(elevationSetupPossible({ ...PROBE, uid: 502 }, "dispatch")).toBe(true);
    expect(elevationSetupPossible(undefined, "dispatch")).toBe(true);
    expect(elevationSetupPossible(linux({ uid: 1000 }), "dev")).toBe(false);
    expect(elevationSetupPossible({ ...PROBE, uid: 0 }, "dispatch")).toBe(false);
    expect(elevationSetupPossible(undefined, "root")).toBe(false);
  });
});

describe("hints", () => {
  it("suggests apt on Debian and Ubuntu only", () => {
    expect(aptBased(linux())).toBe(true);
    expect(aptBased(linux({ os: { name: "Ubuntu", id: "ubuntu", like: "debian" } }))).toBe(true);
    expect(aptBased(linux({ os: { name: "Linux Mint", id: "linuxmint", like: "ubuntu debian" } }))).toBe(true);
    expect(aptBased(linux({ os: { name: "Fedora Linux", id: "fedora" } }))).toBe(false);
    expect(aptBased(PROBE)).toBe(false);
    expect(installHint(linux(), { apt: "iproute2" })).toBe(" (as root: apt install iproute2)");
    expect(installHint(PROBE, { apt: "git", brew: "git" })).toBe(" (brew install git)");
    expect(installHint(PROBE, { apt: "git" })).toBe("");
  });

  it("says what to check when SSH refuses, by the OS", () => {
    expect(refusedHint("darwin")).toBe("is Remote Login on?");
    expect(refusedHint("linux")).toBe("is sshd running?");
    expect(refusedHint(undefined)).toMatch(/Remote Login \(macOS\) or sshd \(Linux\)/);
  });

  it("knows a git too old for the sync's --pathspec-from-file", () => {
    expect(gitTooOld("git version 2.25.1")).toBe("git 2.25.1 is older than 2.26, which the file sync needs");
    expect(gitTooOld("git version 2.26.0")).toBeUndefined();
    expect(gitTooOld("git version 2.39.2 (Apple Git-143)")).toBeUndefined();
    expect(gitTooOld("2.20")).toMatch(/git 2\.20 is older/);
    expect(gitTooOld(null)).toBeUndefined();
    expect(gitTooOld("no version here")).toBeUndefined();
  });
});
