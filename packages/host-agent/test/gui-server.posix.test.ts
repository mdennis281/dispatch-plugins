/**
 * The GUI agent's server, for real: its unix socket, real child processes and
 * process groups. What only a Mac's login session has (simctl, safaridriver,
 * the window server, launchd) is faked. POSIX only; CI runs it on Linux and macOS.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame } from "../src/protocol.js";
import { GF } from "../src/gui/protocol.js";
import { dispatchGui } from "../src/gui/cli.js";
import { guiCall, guiRun } from "../src/gui/client.js";
import { Launchd, placeAgent, type Run } from "../src/gui/launchd.js";
import type { GuiAgentStatus, SafariLease, SimLease } from "../src/gui/protocol.js";
import { GuiServer, readGuiState } from "../src/gui/server.js";
import { Simctl } from "../src/gui/sims.js";
import { AGENT_VERSION } from "../src/version.js";

const posix = process.platform !== "win32";
const d = posix ? describe : describe.skip;
const H = "abcdef012345";
const INST = "inst-a";

let work = "";
let root = "";
let home = "";
let script = "";
let servers: GuiServer[] = [];
const exits: number[] = [];

/** A simctl that keeps its devices in memory. */
function fakeSimctl() {
  const devices = new Map<string, { name: string; state: string }>();
  let n = 0;
  const calls: string[] = [];
  const run: Run = async (_f, args) => {
    const a = args.slice(1); // drop "simctl"
    calls.push(a.join(" "));
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (a[0] === "list" && a[2] === "runtimes") {
      return ok(
        JSON.stringify({
          runtimes: [
            {
              identifier: "rt.iOS-27-2",
              name: "iOS 27.2",
              version: "27.2",
              platform: "iOS",
              isAvailable: true,
              supportedDeviceTypes: [{ identifier: "dt.iPhone-17", name: "iPhone 17", productFamily: "iPhone" }],
            },
          ],
        }),
      );
    }
    if (a[0] === "list" && a[2] === "devices") {
      return ok(JSON.stringify({ devices: { "rt.iOS-27-2": [...devices].map(([udid, v]) => ({ udid, ...v, isAvailable: true })) } }));
    }
    if (a[0] === "create") {
      const u = mkUdid(++n);
      devices.set(u, { name: a[1]!, state: "Shutdown" });
      return ok(`${u}\n`);
    }
    if (a[0] === "clone") {
      if (!devices.has(a[1]!)) return { code: 1, stdout: "", stderr: "Invalid device" };
      const u = mkUdid(++n);
      devices.set(u, { name: a[2]!, state: "Shutdown" });
      return ok(`${u}\n`);
    }
    if (a[0] === "shutdown") {
      const dev = devices.get(a[1]!);
      if (!dev) return { code: 164, stdout: "", stderr: "Invalid device" };
      if (dev.state === "Shutdown") return { code: 149, stdout: "", stderr: "Unable to shutdown device in current state: Shutdown" };
      dev.state = "Shutdown";
      return ok();
    }
    if (a[0] === "delete") {
      if (!devices.delete(a[1]!)) return { code: 164, stdout: "", stderr: "Invalid device" };
      return ok();
    }
    return { code: 1, stdout: "", stderr: `fake simctl: ${a.join(" ")}` };
  };
  return { simctl: new Simctl(run, () => ({})), devices, calls };
}

function mkUdid(n: number): string {
  const hex = n.toString(16).toUpperCase().padStart(12, "0");
  return `AAAAAAAA-BBBB-CCCC-DDDD-${hex}`;
}

/** A safaridriver stand-in: a process that just stays up. */
const fakeSafaridriver = async () => spawn("sleep", ["600"], { stdio: "ignore" });

async function startServer(over: Partial<ConstructorParameters<typeof GuiServer>[0]> = {}): Promise<GuiServer> {
  const s = new GuiServer({
    root,
    home,
    script,
    simctl: fakeSimctl().simctl,
    safaridriver: fakeSafaridriver,
    caffeinate: () => () => {},
    screen: async () => ({ session: { user: "dispatch", onConsole: true, screenLocked: false }, windows: [] }),
    launchd: new Launchd(503, async () => ({ code: 0, stdout: "", stderr: "" })),
    exit: (c) => exits.push(c),
    timing: { killGraceMs: 300 },
    ...over,
  });
  await s.start();
  servers.push(s);
  return s;
}

const sock = () => join(root, "run", "gui.sock");

function collect() {
  const out = new PassThrough();
  const err = new PassThrough();
  const o: Buffer[] = [];
  const e: Buffer[] = [];
  out.on("data", (b: Buffer) => o.push(b));
  err.on("data", (b: Buffer) => e.push(b));
  return { stdout: out, stderr: err, text: () => Buffer.concat(o).toString(), errText: () => Buffer.concat(e).toString() };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(f: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  if (!posix) return;
  // Short: a unix socket path is capped at 104 bytes on macOS.
  work = realpathSync(mkdtempSync(join(tmpdir(), "gui-")));
  root = join(work, "r");
  home = join(work, "h");
  script = join(root, "agent", `${AGENT_VERSION}-${H}`, "dispatch-host.mjs");
  mkdirSync(join(root, "agent", `${AGENT_VERSION}-${H}`), { recursive: true });
  writeFileSync(script, "// the agent\n");
  mkdirSync(join(root, INST), { recursive: true });
  writeFileSync(join(root, INST, "contact"), "now\n");
  exits.length = 0;
});

afterEach(async () => {
  if (!posix) return;
  for (const s of servers) await s.stop();
  servers = [];
  rmSync(work, { recursive: true, force: true });
});

d("the GUI agent's socket", () => {
  it("answers status", async () => {
    await startServer();
    const r = await guiCall<GuiAgentStatus>(sock(), { op: "status" });
    expect(r).toMatchObject({
      ok: true,
      agentVersion: AGENT_VERSION,
      build: `${AGENT_VERSION}-${H}`,
      session: { user: "dispatch", onConsole: true, screenLocked: false },
      dialogs: [],
      simulators: { usable: true, runtime: "iOS 27.2", deviceType: "iPhone 17" },
      runs: 0,
    });
  });

  it("refuses to start a second agent on the same socket", async () => {
    await startServer();
    await expect(new GuiServer({ root, home, script }).start()).rejects.toThrow(/already answers/);
  });

  it("tells an older client's unknown op apart from a failure", async () => {
    await startServer();
    const r = await guiCall(sock(), { op: "teleport" } as never);
    expect(r).toMatchObject({ ok: false, code: "unknown-op" });
  });
});

d("dispatch-gui run", () => {
  it("runs in the agent and streams stdout, stderr and the exit code back", async () => {
    await startServer();
    const io = collect();
    const code = await guiRun(sock(), { op: "run", argv: ["sh", "-c", 'echo out; echo err >&2; printf "%s" "$X"; exit 7'], cwd: work, env: { X: "env-ok", PATH: process.env.PATH! } }, io);
    expect(code).toBe(7);
    expect(io.text()).toBe("out\nenv-ok");
    expect(io.errText()).toBe("err\n");
  });

  it("runs in the cwd it was given", async () => {
    await startServer();
    const io = collect();
    expect(await guiRun(sock(), { op: "run", argv: ["pwd"], cwd: work, env: { PATH: process.env.PATH! } }, io)).toBe(0);
    expect(io.text().trim()).toBe(work);
  });

  it("says a command that doesn't exist, like a shell (127)", async () => {
    await startServer();
    const r = await guiRun(sock(), { op: "run", argv: ["no-such-command-xyz"], cwd: work, env: { PATH: process.env.PATH! } }, collect());
    expect(r).toMatchObject({ code: 127, error: expect.stringContaining("no-such-command-xyz") });
  });

  it("passes a Ctrl-C on to the run's whole process group", async () => {
    await startServer();
    let forward: ((s: NodeJS.Signals) => void) | undefined;
    const io = { ...collect(), onSignal: (f: (s: NodeJS.Signals) => void) => (forward = f) };
    const pidFile = join(work, "child.pid");
    const p = guiRun(sock(), { op: "run", argv: ["sh", "-c", `sleep 600 & echo $! > ${pidFile}; wait`], cwd: work, env: { PATH: process.env.PATH! } }, io);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    forward!("SIGTERM");
    expect(await p).toBe(128 + 15);
    await until(() => !alive(grandchild));
  });

  it("ends the run when its client goes away (the chat shell was killed)", async () => {
    const s = await startServer();
    const pidFile = join(work, "child.pid");
    // A raw client, dropped the way a SIGKILLed dispatch-gui drops: no signal frame, just gone.
    const c = connect(sock());
    await new Promise((r) => c.once("connect", r));
    c.write(encodeFrame(GF.request, { v: 1, op: "run", argv: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 600`], cwd: work, env: { PATH: process.env.PATH! } }));
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(s.runCount).toBe(1);
    c.destroy();
    await until(() => !alive(pid));
    await until(() => s.runCount === 0);
  });

  it("gives the run the chat's Simulator", async () => {
    await startServer();
    const lease = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    expect(lease?.ok).toBe(true);
    const io = collect();
    await guiRun(sock(), { op: "run", argv: ["sh", "-c", 'printf "%s" "$DISPATCH_SIM_UDID"'], cwd: work, env: { PATH: process.env.PATH! }, instance: INST, chat: "c1" }, io);
    expect(io.text()).toBe(lease!.ok ? lease!.udid : "?");
  });
});

d("Simulator leases", () => {
  it("clones one device per chat from one base, and keeps it", async () => {
    const f = fakeSimctl();
    await startServer({ simctl: f.simctl });
    const a = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    const a2 = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    const b = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c2" });
    if (!a?.ok || !a2?.ok || !b?.ok) throw new Error("no lease");
    expect(a2.udid).toBe(a.udid);
    expect(b.udid).not.toBe(a.udid);
    expect(a.name).toBe(`Dispatch ${INST.slice(0, 8)} c1`);
    expect([...f.devices.values()].map((v) => v.name).sort()).toEqual(["Dispatch base (iPhone 17, iOS 27.2)", `Dispatch ${INST} c1`, `Dispatch ${INST} c2`]);
    expect(f.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    expect(readGuiState(join(root, "gui", "state.json")).sims[`${INST}/c1`]?.udid).toBe(a.udid);
  });

  it("clones again when the chat's device was deleted by hand", async () => {
    const f = fakeSimctl();
    await startServer({ simctl: f.simctl });
    const a = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    if (!a?.ok) throw new Error("no lease");
    f.devices.delete(a.udid);
    const b = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    expect(b?.ok && b.udid).not.toBe(a.udid);
  });

  it("says why when there can be none", async () => {
    const simctl = new Simctl(async () => ({ code: 69, stdout: "", stderr: "You have not agreed to the Xcode license agreements." }), () => ({}));
    await startServer({ simctl });
    expect(await guiCall(sock(), { op: "sim", instance: INST, chat: "c1" })).toMatchObject({ ok: false, code: "sim-unavailable", error: expect.stringContaining("license") });
  });

  it("idle shuts a chat's device down and keeps it; deleted deletes it", async () => {
    const f = fakeSimctl();
    await startServer({ simctl: f.simctl });
    const a = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    if (!a?.ok) throw new Error("no lease");
    f.devices.get(a.udid)!.state = "Booted";
    expect(await guiCall(sock(), { op: "release", instance: INST, chat: "c1" })).toMatchObject({ ok: true, sims: [a.udid] });
    expect(f.devices.get(a.udid)?.state).toBe("Shutdown");
    expect(await guiCall(sock(), { op: "release", instance: INST, chat: "c1", forget: true })).toMatchObject({ ok: true, sims: [a.udid] });
    expect(f.devices.has(a.udid)).toBe(false);
    expect(readGuiState(join(root, "gui", "state.json")).sims).toEqual({});
  });

  it("deletes a chat's device on start when the chat was deleted while the agent was down", async () => {
    const f = fakeSimctl();
    const s = await startServer({ simctl: f.simctl });
    const a = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    if (!a?.ok) throw new Error("no lease");
    await s.stop();
    servers = [];
    mkdirSync(join(root, "gui", "pending"), { recursive: true });
    writeFileSync(join(root, "gui", "pending", `${INST}.c1`), "x\n");
    await startServer({ simctl: f.simctl });
    expect(f.devices.has(a.udid)).toBe(false);
    expect(existsSync(join(root, "gui", "pending", `${INST}.c1`))).toBe(false);
  });

  it("never touches another instance's devices", async () => {
    const f = fakeSimctl();
    await startServer({ simctl: f.simctl });
    const a = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    const b = await guiCall<SimLease>(sock(), { op: "sim", instance: "inst-b", chat: "c1" });
    if (!a?.ok || !b?.ok) throw new Error("no lease");
    await guiCall(sock(), { op: "release", instance: INST, forget: true });
    expect(f.devices.has(a.udid)).toBe(false);
    expect(f.devices.has(b.udid)).toBe(true);
  });
});

d("the Safari lease", () => {
  it("is one chat's at a time, across instances", async () => {
    await startServer();
    const a = await guiCall<SafariLease>(sock(), { op: "safari", instance: INST, chat: "c1" });
    expect(a).toMatchObject({ ok: true, instance: INST, chat: "c1", port: expect.any(Number) });
    expect(await guiCall(sock(), { op: "safari", instance: "inst-b", chat: "c9" })).toMatchObject({
      ok: false,
      code: "leased",
      error: expect.stringContaining("from another Dispatch"),
    });
    // The holder renews it and keeps its port.
    const again = await guiCall<SafariLease & { renewed: boolean }>(sock(), { op: "safari", instance: INST, chat: "c1" });
    expect(again).toMatchObject({ ok: true, renewed: true, port: a?.ok ? a.port : -1 });
  });

  it("goes when released, and with its chat going idle", async () => {
    await startServer();
    await guiCall(sock(), { op: "safari", instance: INST, chat: "c1" });
    expect(await guiCall(sock(), { op: "safari", instance: INST, chat: "c2", release: true })).toMatchObject({ ok: true, released: false });
    expect(await guiCall(sock(), { op: "release", instance: INST, chat: "c1" })).toMatchObject({ ok: true, safari: true });
    expect(await guiCall(sock(), { op: "safari", instance: INST, chat: "c2" })).toMatchObject({ ok: true, chat: "c2" });
  });

  it("lapses when the holder stops renewing it", async () => {
    let now = Date.now();
    const s = await startServer({ now: () => now, timing: { safariLeaseMs: 1_000, tickMs: 3_600_000 } });
    await guiCall(sock(), { op: "safari", instance: INST, chat: "c1" });
    now += 2_000;
    expect(await guiCall(sock(), { op: "safari", instance: INST, chat: "c2" })).toMatchObject({ ok: true, chat: "c2" });
    await s.tick();
  });
});

d("upgrades", () => {
  function install(version: string, hash = H): string {
    const s = join(root, "agent", `${version}-${hash}`, "dispatch-host.mjs");
    mkdirSync(join(root, "agent", `${version}-${hash}`), { recursive: true });
    writeFileSync(s, "// agent\n");
    return s;
  }

  it("point current.mjs forward only, and write the plist once", async () => {
    const newer = install("99.0.0");
    expect(await placeAgent({ root, home, script })).toMatchObject({ link: "install", current: `${AGENT_VERSION}-${H}`, plist: "written" });
    expect(await placeAgent({ root, home, script: newer })).toMatchObject({ link: "upgrade", current: `99.0.0-${H}`, plist: "kept" });
    // The older build connects again (stable after dev): nothing moves.
    expect(await placeAgent({ root, home, script })).toMatchObject({ link: "keep", current: `99.0.0-${H}`, plist: "kept" });
    expect(realpathSync(join(root, "gui", "current.mjs"))).toBe(realpathSync(newer));
    // Relative within the root, so moving it (or /tmp → /private/tmp) never breaks it.
    expect(readlinkSync(join(root, "gui", "current.mjs"))).toBe(`../agent/99.0.0-${H}/dispatch-host.mjs`);
  });

  it("never overwrites a plist of a newer format", async () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    const plist = join(home, "Library", "LaunchAgents", "com.dispatch-host.gui.plist");
    writeFileSync(plist, "<!-- dispatch-host GUI agent, plist format 99. -->\n");
    expect(await placeAgent({ root, home, script })).toMatchObject({ plist: "newer" });
    expect(readFileSync(plist, "utf8")).toContain("format 99");
  });

  it("restarts into a newer build only once nothing of its own runs", async () => {
    const s = await startServer();
    await placeAgent({ root, home, script });
    expect(await s.checkUpgrade()).toBe(false); // current is itself
    const newer = install("99.0.0");
    await placeAgent({ root, home, script: newer });
    const pidFile = join(work, "p");
    const run = guiRun(sock(), { op: "run", argv: ["sh", "-c", `echo $$ > ${pidFile}; sleep 1`], cwd: work, env: { PATH: process.env.PATH! } }, collect());
    await until(() => existsSync(pidFile));
    expect(await s.checkUpgrade()).toBe(false);
    expect(exits).toEqual([]);
    expect((await guiCall<GuiAgentStatus>(sock(), { op: "status" }))?.ok).toBe(true);
    await run;
    await until(() => s.runCount === 0);
    expect(await s.checkUpgrade()).toBe(true);
    expect(exits).toEqual([0]);
    servers = servers.filter((x) => x !== s);
  });

  it("never restarts into an older build", async () => {
    const s = await startServer();
    const older = install("0.0.1");
    rmSync(join(root, "gui"), { recursive: true, force: true });
    mkdirSync(join(root, "gui"), { recursive: true });
    symlinkSync(older, join(root, "gui", "current.mjs"));
    expect(await s.checkUpgrade()).toBe(false);
    expect(exits).toEqual([]);
  });
});

d("the dead-man switch", () => {
  it("ends runs and releases leases after the silence, and boots itself out after days of it", async () => {
    const f = fakeSimctl();
    let now = Date.now();
    const booted: string[] = [];
    const s = await startServer({
      simctl: f.simctl,
      now: () => now,
      timing: { deadManMs: 60_000, bootoutMs: 600_000, tickMs: 3_600_000 },
      launchd: new Launchd(503, async (_f, args) => {
        booted.push(args.join(" "));
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    const sim = await guiCall<SimLease>(sock(), { op: "sim", instance: INST, chat: "c1" });
    if (!sim?.ok) throw new Error("no lease");
    f.devices.get(sim.udid)!.state = "Booted";
    await guiCall(sock(), { op: "safari", instance: INST, chat: "c1" });
    const pidFile = join(work, "p");
    void guiRun(sock(), { op: "run", argv: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 600`], cwd: work, env: { PATH: process.env.PATH! } }, collect());
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8"));

    // Contact a moment ago: nothing happens.
    await s.tick();
    expect(alive(pid)).toBe(true);

    // Silent past the switch.
    const old = (now - 120_000) / 1000;
    utimesSync(join(root, INST, "contact"), old, old);
    await s.tick();
    await until(() => !alive(pid));
    expect(f.devices.get(sim.udid)?.state).toBe("Shutdown");
    const st = await guiCall<GuiAgentStatus>(sock(), { op: "status" });
    expect(st?.ok).toBe(true);
    expect(st).not.toHaveProperty("safari");
    expect(exits).toEqual([]);

    // Days of it: boot out.
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.dispatch-host.gui.plist"), "x");
    now += 1_000_000;
    await s.tick();
    expect(booted).toContain("bootout gui/503/com.dispatch-host.gui");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.dispatch-host.gui.plist"))).toBe(false);
    expect(exits).toEqual([0]);
    servers = servers.filter((x) => x !== s);
  });
});

d("dispatch-gui, in a chat shell", () => {
  const env = { DISPATCH_HOST_INSTANCE: INST, DISPATCH_HOST_CHAT: "c1", PATH: process.env.PATH! };

  it("prints the chat's Simulator", async () => {
    await startServer();
    const io = collect();
    expect(await dispatchGui(["sim"], { root, home }, { env, cwd: work, ...io })).toBe(0);
    expect(io.text()).toMatch(/^[0-9A-F-]{36}\n$/);
  });

  it("prints safaridriver's URL", async () => {
    await startServer();
    const io = collect();
    expect(await dispatchGui(["safari"], { root, home }, { env, cwd: work, ...io })).toBe(0);
    expect(io.text()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\n$/);
  });

  it("runs `run -- cmd`", async () => {
    await startServer();
    const io = collect();
    expect(await dispatchGui(["run", "--", "sh", "-c", "echo hi; exit 3"], { root, home }, { env, cwd: work, ...io })).toBe(3);
    expect(io.text()).toBe("hi\n");
  });

  it("says why, and exits 75, when there is no agent", async () => {
    const io = collect();
    const code = await dispatchGui(["run", "true"], { root, home }, { env, cwd: work, ...io });
    expect(code).toBe(75);
    expect(io.errText()).toMatch(/^dispatch-gui: the GUI agent isn't answering: /);
  });
});
