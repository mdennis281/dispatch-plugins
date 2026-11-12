/** Tier B's pure parts: the plist, never-downgrade, launchctl's answers, dialogs, the Simulator choice. */
import { describe, expect, it } from "vitest";
import { explain } from "../src/gui/cli.js";
import { findDialogs, parseScreen } from "../src/gui/dialogs.js";
import { GUI_LABEL, Launchd, PLIST_FORMAT, buildOf, decideLink, guiPaths, plistFormat, plistXml, versionOfBuild, type Run } from "../src/gui/launchd.js";
import { runEnv } from "../src/gui/server.js";
import { Simctl, baseName, chatDeviceName, chooseSim, parseDevices, simEnv } from "../src/gui/sims.js";

const H = "abcdef012345";

describe("the LaunchAgent's plist", () => {
  const p = guiPaths("/Users/dispatch/.dispatch-host", "/Users/dispatch");

  it("runs current.mjs with the pinned Node in the Aqua session, kept alive", () => {
    const x = plistXml("/Users/dispatch/.dispatch-host", p);
    expect(p.plist).toBe(`/Users/dispatch/Library/LaunchAgents/${GUI_LABEL}.plist`);
    expect(x).toContain("<string>/Users/dispatch/.dispatch-host/runtime/node/bin/node</string>");
    expect(x).toContain("<string>/Users/dispatch/.dispatch-host/gui/current.mjs</string>");
    expect(x).toContain("<key>LimitLoadToSessionType</key><string>Aqua</string>");
    expect(x).toContain("<key>KeepAlive</key><true/>");
    expect(plistFormat(x)).toBe(PLIST_FORMAT);
  });

  it("names no build, so every build writes the same bytes", () => {
    expect(plistXml("/r", guiPaths("/r", "/h"))).not.toMatch(/\d+\.\d+\.\d+-[0-9a-f]{12}/);
  });

  it("escapes paths", () => {
    expect(plistXml("/a&b", guiPaths("/a&b", "/h"))).toContain("<string>/a&amp;b</string>");
  });

  it("reads no format from a plist that isn't ours", () => {
    expect(plistFormat("<plist/>")).toBe(0);
  });
});

describe("side-by-side builds never go backwards", () => {
  it("parses build ids from agent paths", () => {
    expect(buildOf(`/r/agent/0.3.0-${H}/dispatch-host.mjs`)).toBe(`0.3.0-${H}`);
    expect(buildOf("/r/elsewhere/dispatch-host.mjs")).toBeUndefined();
    expect(versionOfBuild(`0.10.2-${H}`)).toBe("0.10.2");
  });

  it("installs when nothing is there, upgrades only to a newer version", () => {
    expect(decideLink(undefined, `0.3.0-${H}`)).toBe("install");
    expect(decideLink(`0.3.0-${H}`, `0.3.1-${H}`)).toBe("upgrade");
    expect(decideLink(`0.3.0-${H}`, `0.10.0-${H}`)).toBe("upgrade");
    // stable (older) connecting after dev (newer) installed: keep dev's
    expect(decideLink(`0.4.0-${H}`, `0.3.9-${H}`)).toBe("keep");
    // same version, another hash (a rebuild): keep, so two builds never take turns
    expect(decideLink(`0.3.0-${H}`, "0.3.0-000000000000")).toBe("keep");
  });
});

describe("launchctl, as the dispatch account sees it", () => {
  const fake = (answers: Record<string, { code: number; stdout?: string; stderr?: string }>): Run => async (_f, args) => {
    const a = answers[args.join(" ")] ?? answers[args[0]!] ?? { code: 1 };
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };

  it("has a GUI domain when launchd says the probe service isn't found (113)", async () => {
    const ld = new Launchd(503, fake({ print: { code: 113, stderr: "Could not find service" } }));
    expect(await ld.hasGuiDomain()).toBe(true);
  });

  it("has none with nobody logged in (cvx-mac: 125, Domain does not support specified action)", async () => {
    const ld = new Launchd(503, fake({ print: { code: 125, stderr: "Could not print domain: 125: Domain does not support specified action" } }));
    expect(await ld.hasGuiDomain()).toBe(false);
  });

  it("reads the service's pid and state", async () => {
    const ld = new Launchd(503, fake({ [`print gui/503/${GUI_LABEL}`]: { code: 0, stdout: "\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n" } }));
    expect(await ld.service_()).toEqual({ loaded: true, pid: 4242, state: "running", lastExit: "(never exited)" });
  });

  it("takes 'already loaded' from bootstrap as done, and reports anything else", async () => {
    expect(await new Launchd(503, fake({ bootstrap: { code: 37, stderr: "Operation already in progress" } })).bootstrap("/p")).toBeUndefined();
    expect(await new Launchd(503, fake({ bootstrap: { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } })).bootstrap("/p")).toMatch(
      /exited 5: Bootstrap failed: 5/,
    );
  });
});

describe("dialogs on the screen", () => {
  const screen = JSON.stringify({
    session: { kCGSSessionUserNameKey: "dispatch", kCGSSessionOnConsoleKey: 1 },
    windows: [
      { owner: "Dock", pid: 1, layer: 20, w: 1000, h: 80 },
      { owner: "Window Server", pid: 2, layer: 0, w: 1512, h: 30 },
      { owner: "SecurityAgent", pid: 3, layer: 1000, w: 400, h: 300 },
      { owner: "SecurityAgent", pid: 3, layer: 1000, w: 400, h: 300 },
      { owner: "Xcode", pid: 4, layer: 8, w: 500, h: 200 },
      { owner: "Xcode", pid: 4, layer: 0, w: 1200, h: 800 },
      { owner: "Simulator", pid: 5, layer: 0, w: 400, h: 800 },
      { owner: "UserNotificationCenter", pid: 6, layer: 0, w: 1, h: 1 },
      { owner: "CoreServicesUIAgent", pid: 7, layer: 8, alpha: 0, w: 400, h: 200 },
    ],
  });

  it("parses the session, unlocked when the lock key is absent", () => {
    const s = parseScreen(`noise\n${screen}\n`);
    expect(s.session).toEqual({ user: "dispatch", onConsole: true, screenLocked: false });
    expect(s.windows).toHaveLength(9);
  });

  it("names known dialog processes and modal panels, once each, and nothing else", () => {
    const d = findDialogs(parseScreen(screen).windows!);
    expect(d).toEqual([
      { owner: "SecurityAgent", pid: 3, kind: "known" },
      { owner: "Xcode", pid: 4, kind: "modal" },
    ]);
  });

  it("says a locked screen", () => {
    const s = parseScreen(JSON.stringify({ session: { kCGSSessionUserNameKey: "d", kCGSSessionOnConsoleKey: 0, CGSSessionScreenIsLocked: 1 }, windows: [] }));
    expect(s.session).toEqual({ user: "d", onConsole: false, screenLocked: true });
  });

  it("survives output that isn't JSON", () => {
    expect(parseScreen("execution error: boom")).toMatchObject({ session: null, windows: null, error: expect.stringContaining("boom") });
  });
});

const RUNTIMES = JSON.stringify({
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
      name: "iOS 26.1",
      version: "26.1",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [{ identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", name: "iPhone 16", productFamily: "iPhone" }],
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-2",
      name: "iOS 27.2",
      version: "27.2",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17", productFamily: "iPhone" },
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", name: "iPhone 18 Pro", productFamily: "iPhone" },
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro", name: "iPad Pro", productFamily: "iPad" },
      ],
    },
    { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-12-0", name: "watchOS 12.0", version: "12.0", platform: "watchOS", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-28-0", name: "iOS 28.0", version: "28.0", platform: "iOS", isAvailable: false },
  ],
});

describe("the Simulator every chat clones", () => {
  it("is the newest AVAILABLE iOS runtime's newest iPhone", () => {
    const c = chooseSim(RUNTIMES);
    expect(c).toEqual({
      usable: true,
      choice: {
        runtime: { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-2", name: "iOS 27.2", version: "27.2" },
        deviceType: { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", name: "iPhone 18 Pro" },
      },
    });
    if (c.usable) expect(baseName(c.choice)).toBe("Dispatch base (iPhone 18 Pro, iOS 27.2)");
  });

  it("says how to get a runtime when there is none (cvx-mac today)", () => {
    expect(chooseSim(JSON.stringify({ runtimes: [] }))).toEqual({ usable: false, reason: expect.stringContaining("downloadPlatform iOS") });
  });

  it("names chat devices so they can be told apart in Xcode", () => {
    expect(chatDeviceName("0123456789abcdef", "chat-1")).toBe("Dispatch 01234567 chat-1");
  });

  it("parses devices across runtimes", () => {
    const d = parseDevices(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-27-2": [{ udid: "U1", name: "A", state: "Shutdown", isAvailable: true }],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [{ udid: "U2", name: "B", state: "Booted", isAvailable: false }, { name: "no udid" }],
        },
      }),
    );
    expect(d).toEqual([
      { udid: "U1", name: "A", state: "Shutdown", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-2", isAvailable: true },
      { udid: "U2", name: "B", state: "Booted", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-1", isAvailable: false },
    ]);
  });

  it("says when Xcode's license blocks simctl (cvx-mac, 2026-11-06)", async () => {
    const s = new Simctl(async () => ({ code: 69, stdout: "", stderr: "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'…" }), () => ({}));
    expect(await s.check()).toEqual({ usable: false, reason: expect.stringContaining("license") });
  });

  it("runs simctl with Xcode's developer directory, not the Command Line Tools'", () => {
    const x = "/"; // exists everywhere
    expect(simEnv({ DEVELOPER_DIR: "/Library/Developer/CommandLineTools" }, x).DEVELOPER_DIR).toBe(x);
    expect(simEnv({ DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer" }, x).DEVELOPER_DIR).toBe(
      "/Applications/Xcode-beta.app/Contents/Developer",
    );
  });
});

describe("a run's environment", () => {
  it("is the client's, minus its SSH session, with the agent's TMPDIR when it has none", () => {
    const env = runEnv({ PATH: "/x", SSH_CONNECTION: "a b", SSH_AUTH_SOCK: "/s", DISPATCH_HOST_CHAT: "c", "bad name": "v", N: 1 }, { TMPDIR: "/var/folders/t/", HOME: "/h" });
    expect(env).toEqual({ PATH: "/x", DISPATCH_HOST_CHAT: "c", TMPDIR: "/var/folders/t/", HOME: "/h" });
  });
});

describe("why there is no GUI agent", () => {
  it("is 'Tier A only, log in at the Mac' when nobody is logged in as the user", () => {
    const s = explain({ state: "no-gui-session", user: "dispatch", consoleUser: "mikedennis", installed: true });
    expect(s).toContain("Tier A only");
    expect(s).toContain("log in as dispatch at the Mac");
    expect(s).toContain("the screen shows mikedennis");
  });
});
