/**
 * The pinned runtime, the version policy, and the install scripts. The
 * scripts themselves run under /bin/sh on POSIX (CI); on Windows only their
 * text is checked.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_EXIT, agentBuildId, agentPath, installAgentScript, installRuntimeScript, shCommand, sq } from "../src/install.js";
import { NODE_RUNTIME, compareVersions, nodeTarball, runtimeAction, type NodeTarball } from "../src/runtime.js";
import { AGENT_VERSION } from "../src/version.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "dh-rt-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the pinned runtime", () => {
  it("picks the official tarball and its checksum from uname's spelling", () => {
    expect(nodeTarball("Darwin", "arm64")).toEqual({
      url: `https://nodejs.org/dist/v${NODE_RUNTIME.version}/node-v${NODE_RUNTIME.version}-darwin-arm64.tar.gz`,
      file: `node-v${NODE_RUNTIME.version}-darwin-arm64.tar.gz`,
      dir: `node-v${NODE_RUNTIME.version}-darwin-arm64`,
      sha256: NODE_RUNTIME.sha256["darwin-arm64"],
      version: NODE_RUNTIME.version,
    });
    expect(nodeTarball("Linux", "x86_64").dir).toBe(`node-v${NODE_RUNTIME.version}-linux-x64`);
    expect(nodeTarball("linux", "aarch64").dir).toBe(`node-v${NODE_RUNTIME.version}-linux-arm64`);
    expect(() => nodeTarball("FreeBSD", "x86_64")).toThrow(/no pinned Node/);
    for (const sha of Object.values(NODE_RUNTIME.sha256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is never downgraded: a newer runtime someone else installed is kept", () => {
    expect(compareVersions("v24.22.2", "24.22.2")).toBe(0);
    expect(compareVersions("24.9.0", "24.22.2")).toBe(-1);
    expect(compareVersions("v25.0.0-pre", "24.22.2")).toBe(1);
    expect(runtimeAction(undefined)).toBe("install");
    expect(runtimeAction("v24.1.0")).toBe("upgrade");
    expect(runtimeAction(`v${NODE_RUNTIME.version}`)).toBe("keep");
    expect(runtimeAction("v26.0.0")).toBe("keep");
  });

  it("names agent builds by version and content, so two builds never share a directory", () => {
    const sha = "a".repeat(64);
    expect(agentBuildId("0.1.0", sha)).toBe("0.1.0-aaaaaaaaaaaa");
    expect(agentPath("/Users/dispatch/.dispatch-host", "0.1.0", sha)).toBe("/Users/dispatch/.dispatch-host/agent/0.1.0-aaaaaaaaaaaa/dispatch-host.mjs");
    expect(() => agentBuildId("0.1", sha)).toThrow();
    expect(() => agentBuildId("0.1.0", "xyz")).toThrow();
  });

  it("keeps the agent's version equal to package.json's", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(AGENT_VERSION).toBe(pkg.version);
  });

  it("quotes for sh, including single quotes", () => {
    expect(sq("it's")).toBe(`'it'\\''s'`);
    expect(shCommand("echo 'x'")).toBe(`/bin/sh -c 'echo '\\''x'\\'''`);
  });
});

/* ------------------------------------------------- the scripts, for real */

/** A tarball that unpacks to `<dir>/bin/node`, a script answering --version and the version check. */
function fakeNodeTarball(root: string, version: string, newerExit: number): { tar: string; t: NodeTarball } {
  const dir = `node-v${version}-test`;
  const stage = join(root, "stage");
  mkdirSync(join(stage, dir, "bin"), { recursive: true });
  writeFileSync(
    join(stage, dir, "bin", "node"),
    `#!/bin/sh\ncase "$1" in --version) echo v${version};; -e) exit ${newerExit};; esac\n`,
  );
  chmodSync(join(stage, dir, "bin", "node"), 0o755);
  const tar = join(root, "node.tar.gz");
  execFileSync("tar", ["-czf", tar, "-C", stage, dir]);
  const sha256 = createHash("sha256").update(readFileSync(tar)).digest("hex");
  return { tar, t: { url: "", file: "node.tar.gz", dir, sha256, version } };
}

function runScript(script: string, stdinFile: string) {
  return spawnSync("/bin/sh", ["-c", script], { input: readFileSync(stdinFile), encoding: "utf8" });
}

describe.skipIf(!posix)("install scripts (POSIX)", () => {
  it("installs the runtime at the fixed path, then keeps it when it is the same or newer", () => {
    const work = tmp();
    const root = join(work, ".dispatch-host");
    const { tar, t } = fakeNodeTarball(work, "24.22.2", 0);
    const first = runScript(installRuntimeScript(root, t), tar);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe("installed v24.22.2");
    expect(execFileSync(join(root, "runtime", "node", "bin", "node"), ["--version"]).toString().trim()).toBe("v24.22.2");
    // The installed fake answers the version check with 0 ("same or newer").
    const again = runScript(installRuntimeScript(root, t), tar);
    expect(again.stdout.trim()).toBe("kept v24.22.2");
    expect(existsSync(join(root, "install.lock"))).toBe(false);
  });

  it("replaces an older runtime by rename", () => {
    const work = tmp();
    const root = join(work, ".dispatch-host");
    const old = fakeNodeTarball(join(work, "old"), "24.1.0", 1);
    expect(runScript(installRuntimeScript(root, old.t), old.tar).status).toBe(0);
    const next = fakeNodeTarball(join(work, "new"), "24.22.2", 0);
    const r = runScript(installRuntimeScript(root, next.t), next.tar);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("installed v24.22.2");
    expect(execFileSync(join(root, "runtime", "node", "bin", "node"), ["--version"]).toString().trim()).toBe("v24.22.2");
  });

  it("refuses a tarball whose checksum is wrong, and installs nothing", () => {
    const work = tmp();
    const root = join(work, ".dispatch-host");
    const { tar, t } = fakeNodeTarball(work, "24.22.2", 0);
    const r = runScript(installRuntimeScript(root, { ...t, sha256: "0".repeat(64) }), tar);
    expect(r.status).toBe(INSTALL_EXIT.checksum);
    expect(existsSync(join(root, "runtime", "node"))).toBe(false);
  });

  it("breaks an install lock left by a dead installer", () => {
    const work = tmp();
    const root = join(work, ".dispatch-host");
    mkdirSync(join(root, "install.lock"), { recursive: true });
    const old = new Date(Date.now() - 45 * 60_000);
    utimesSync(join(root, "install.lock"), old, old);
    const { tar, t } = fakeNodeTarball(work, "24.22.2", 0);
    const r = runScript(installRuntimeScript(root, t), tar);
    expect(r.status, r.stderr).toBe(0);
  });

  it("installs an agent build beside the others, keeps an intact copy, and refuses a corrupt one", () => {
    const work = tmp();
    const root = join(work, ".dispatch-host");
    const bundle = join(work, "dispatch-host.mjs");
    writeFileSync(bundle, "console.log('agent')\n");
    const sha = createHash("sha256").update(readFileSync(bundle)).digest("hex");
    const other = agentPath(root, "0.0.9", "b".repeat(64));
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, "older build\n");
    const first = runScript(installAgentScript(root, "0.1.0", sha), bundle);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe("installed");
    expect(readFileSync(agentPath(root, "0.1.0", sha), "utf8")).toBe("console.log('agent')\n");
    expect(runScript(installAgentScript(root, "0.1.0", sha), bundle).stdout.trim()).toBe("kept");
    expect(readFileSync(other, "utf8")).toBe("older build\n");
    const bad = runScript(installAgentScript(root, "0.1.0", "c".repeat(64)), bundle);
    expect(bad.status).toBe(INSTALL_EXIT.checksum);
  });
});
