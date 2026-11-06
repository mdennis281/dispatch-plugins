/**
 * Root with approval, the machine's side: the helper and setup scripts as
 * generated, the setup command, the keys a setup waits with, and how verify
 * and turning it off read the helper's answers. The scripts themselves run in
 * elevate-helper.posix.test.ts and the e2e.
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ELEVATE_USER,
  ElevationLoginError,
  HELPER_PATH,
  type Elevation,
  type HelperResult,
} from "../src/elevation.js";
import {
  ElevationSetups,
  HELPER_VERSION,
  MAC_PATHS,
  MANUAL_UNINSTALL,
  elevationKeyLine,
  helperScript,
  removeElevation,
  setupOneLiner,
  setupScript,
  verifyElevation,
} from "../src/elevation-setup.js";
import type { HostConfig } from "../src/hosts.js";

const HOST: HostConfig = {
  slug: "cvx-mac",
  label: "CVX Mac",
  user: "dispatch",
  addresses: ["10.0.4.5"],
  port: 22,
  hostKey: `SHA256:${"a".repeat(43)}`,
  hostKeyType: "ssh-ed25519",
  keyFingerprint: `SHA256:${"b".repeat(43)}`,
  allowFrom: ["10.0.4.1", "10.69.69.69"],
  pairedAt: "2026-11-06T00:00:00.000Z",
};
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOkF5YQ1ZK2c3xYdH1x8m8m8m8m8m8m8m8m8m8m8m8m8 dispatch-elevate:cvx-mac@pc";

/** An Elevation whose helper answers as the test says. */
function fakeElevation(answer: (verb: string, key?: string) => Promise<HelperResult>): Elevation & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    helper: (verb: string, key?: string) => {
      calls.push(`${verb}${key ? ` with ${key}` : ""}`);
      return answer(verb, key);
    },
  } as unknown as Elevation & { calls: string[] };
}

describe("the helper and setup scripts", () => {
  it("fills every placeholder in the helper, each value shell-quoted", () => {
    const s = helperScript();
    expect(s).not.toMatch(/@[A-Z_]+@/);
    expect(s.startsWith("#!/bin/bash\n")).toBe(true);
    expect(s).toContain(`HELPER='${HELPER_PATH}'`);
    expect(s).toContain(`VERSION='${HELPER_VERSION}'`);
    expect(s).toContain(`ACCOUNT='${ELEVATE_USER}'`);
    expect(s).toContain("SUDO='/usr/bin/sudo'");
    expect(s).toContain("ROOT_UID=0\n");
    expect(s).not.toContain("\r");
    // Version 2: the watcher job is disowned, so bash never reports it into a command's stderr.
    expect(HELPER_VERSION).toBe("2");
    expect(s).toMatch(/watcher=\$!\n(?:\s*#.*\n)*\s*disown "\$watcher"/);
  });

  it("refuses paths it couldn't quote or would be unsafe to delete", () => {
    expect(() => helperScript({ ...MAC_PATHS, helper: "/usr/local/libexec/dispatch elevate" })).toThrow(/not a usable path/);
    expect(() => helperScript({ ...MAC_PATHS, log: "relative/log" })).toThrow(/not a usable path/);
    expect(() => helperScript({ ...MAC_PATHS, home: "/private/../etc" })).toThrow(/not a usable path/);
    expect(() => helperScript({ ...MAC_PATHS, home: "/var" })).toThrow(/deeper/);
    expect(() => helperScript({ ...MAC_PATHS, account: "root; rm" })).toThrow(/account name/);
  });

  it("makes the account's key line: restricted, only the helper, only from this computer", () => {
    expect(elevationKeyLine(PUB, HOST.allowFrom)).toBe(
      `restrict,command="${HELPER_PATH}",from="10.0.4.1,10.69.69.69" ${PUB}`,
    );
    expect(() => elevationKeyLine("not a key", HOST.allowFrom)).toThrow(/public key/);
    expect(() => elevationKeyLine(PUB, [])).toThrow(/at least one address/);
    expect(() => elevationKeyLine(PUB, ['10.0.0.1" ,command="sh'])).toThrow(/address pattern/);
  });

  it("puts the helper into the setup script verbatim, and the one-liner decodes back to the script", () => {
    const line = elevationKeyLine(PUB, HOST.allowFrom);
    const script = setupScript("cvx-mac", line);
    expect(script).not.toMatch(/@[A-Z_]+@/);
    expect(script).toContain(`KEY_LINE='${line}'`);
    expect(script).toContain("MACHINE='cvx-mac'");
    // The helper sits whole between its here-document markers.
    const start = script.indexOf("<<'DISPATCH_ELEVATE_HELPER_EOF'\n") + "<<'DISPATCH_ELEVATE_HELPER_EOF'\n".length;
    const end = script.indexOf("\nDISPATCH_ELEVATE_HELPER_EOF\n");
    expect(script.slice(start, end)).toBe(helperScript().replace(/\n+$/, ""));
    // Root-only steps, in the order that keeps a half-done setup harmless.
    const order = ["safe_dir", "dscl . -create", "authorized_keys", "visudo -cf", "visudo -c >", "Done."].map((w) => script.indexOf(w));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(script.trimEnd().endsWith("\nmain")).toBe(true);

    const one = setupOneLiner(script);
    const m = one.match(/^echo ([A-Za-z0-9+/=]+) \| base64 --decode \| gunzip \| sudo \/bin\/bash -s$/);
    expect(m).not.toBeNull();
    expect(gunzipSync(Buffer.from(m![1]!, "base64")).toString("utf8")).toBe(script);
    // Short enough to paste.
    expect(one.length).toBeLessThan(12_000);
  });

  it("names the manual way out", () => {
    expect(MANUAL_UNINSTALL).toBe("sudo /usr/local/libexec/dispatch-elevate uninstall");
  });
});

describe("ElevationSetups", () => {
  it("mints a key per machine, keeps it 2 hours, and replaces it when made again", () => {
    let now = 1_000;
    const s = new ElevationSetups({ now: () => now, dispatchName: "My PC" });
    const a = s.start(HOST);
    expect(a.allowFrom).toEqual(HOST.allowFrom);
    expect(a.keyLine).toMatch(/^restrict,command="\/usr\/local\/libexec\/dispatch-elevate",from="10\.0\.4\.1,10\.69\.69\.69" ssh-ed25519 \S+ dispatch-elevate:cvx-mac@My-PC$/);
    expect(a.script).toContain(a.keyLine);
    expect(a.expiresAt).toBe(1_000 + 2 * 60 * 60_000);
    const key = s.key("cvx-mac");
    expect(key).toMatch(/BEGIN OPENSSH PRIVATE KEY/);
    const b = s.start(HOST);
    expect(b.keyLine).not.toBe(a.keyLine);
    expect(s.key("cvx-mac")).not.toBe(key);
    now += 2 * 60 * 60_000;
    expect(s.key("cvx-mac")).toBeUndefined();
    s.start(HOST);
    s.drop("cvx-mac");
    expect(s.key("cvx-mac")).toBeUndefined();
  });

  it("makes the command again with the key elevation is on with, so updating the helper keeps the same key line", () => {
    const s = new ElevationSetups({ dispatchName: "My PC" });
    const first = s.start(HOST);
    const stored = s.key("cvx-mac")!;
    s.drop("cvx-mac");
    const again = s.start(HOST, stored);
    // The same public key (its comment isn't part of the key, and goes).
    expect(again.keyLine.split(" ")[2]).toBe(first.keyLine.split(" ")[2]);
    expect(again.keyLine).toMatch(/^restrict,command="\/usr\/local\/libexec\/dispatch-elevate",from="10\.0\.4\.1,10\.69\.69\.69" ssh-ed25519 \S+$/);
    expect(s.key("cvx-mac")).toBe(stored);
    // It installs this plugin's helper.
    expect(again.script).toContain(`VERSION='${HELPER_VERSION}'`);
    expect(() => s.start(HOST, "not a key")).toThrow(/not a private key/);
  });
});

describe("verifyElevation", () => {
  const ok = (stdout: string, code = 0, stderr = ""): Promise<HelperResult> => Promise.resolve({ code, stdout, stderr });

  it("is satisfied by the helper answering as root, with the key it was given", async () => {
    const el = fakeElevation(() => ok(`dispatch-elevate ${HELPER_VERSION} uid=0\n`));
    await expect(verifyElevation(el, "KEY", "CVX Mac")).resolves.toEqual({ version: HELPER_VERSION });
    expect(el.calls).toEqual(["check with KEY"]);
  });

  it("says what to do next when it isn't", async () => {
    const refused = fakeElevation(() => Promise.reject(new ElevationLoginError("CVX Mac refused the elevation key", "refused")));
    await expect(verifyElevation(refused, "KEY", "CVX Mac")).rejects.toThrow(/doesn't accept the elevation key yet\. Run the setup command there/);
    const hostKey = fakeElevation(() => Promise.reject(new ElevationLoginError("a different host key answered at 10.0.4.5", "host-key")));
    await expect(verifyElevation(hostKey, "KEY", "CVX Mac")).rejects.toThrow(/different host key.*nothing was checked/);
    const away = fakeElevation(() => Promise.reject(new ElevationLoginError("could not reach CVX Mac (timeout)", "unreachable")));
    await expect(verifyElevation(away, "KEY", "CVX Mac")).rejects.toMatchObject({ status: 502 });
    const noSudo = fakeElevation(() => ok("", 1, "sudo: a password is required\n"));
    await expect(verifyElevation(noSudo, "KEY", "CVX Mac")).rejects.toThrow(/sudo on CVX Mac won't let it run the helper.*setup command again/);
    const notRoot = fakeElevation(() => ok("dispatch-elevate 1 uid=503\n"));
    await expect(verifyElevation(notRoot, "KEY", "CVX Mac")).rejects.toThrow(/ran as uid 503, not as root/);
    const odd = fakeElevation(() => ok("", 125, "dispatch-elevate: not a request this helper takes\n"));
    await expect(verifyElevation(odd, "KEY", "CVX Mac")).rejects.toThrow(/didn't answer as expected \(exit 125\): dispatch-elevate: not a request/);
  });
});

describe("removeElevation", () => {
  it("reports what became of it on the machine, and never throws", async () => {
    const done = fakeElevation(() => Promise.resolve({ code: 0, stdout: "removed: the account _dispatchelevate, …\n", stderr: "" }));
    expect(await removeElevation(done)).toEqual({ there: "removed" });
    expect(done.calls).toEqual(["uninstall"]);
    const partly = fakeElevation(() => Promise.resolve({ code: 1, stdout: "", stderr: "partly removed: see the errors above\n" }));
    expect(await removeElevation(partly)).toEqual({ there: "failed", detail: "partly removed: see the errors above" });
    const refused = fakeElevation(() => Promise.reject(new ElevationLoginError("CVX Mac refused the elevation key", "refused")));
    expect(await removeElevation(refused)).toEqual({ there: "refused", detail: "CVX Mac refused the elevation key" });
    const away = fakeElevation(() => Promise.reject(new ElevationLoginError("could not reach CVX Mac (EHOSTUNREACH)", "unreachable")));
    expect(await removeElevation(away)).toMatchObject({ there: "unreachable" });
    const none = fakeElevation(() => Promise.reject(new Error("elevation isn't set up on CVX Mac")));
    expect(await removeElevation(none)).toEqual({ there: "not-set-up" });
  });
});
