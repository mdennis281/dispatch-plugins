/**
 * Elevation, the plugin's half: who is asked, with what; that nothing runs
 * without an approval; the separate login as the helper's account; one at a
 * time per machine; cancelling; and every way it says no. The machine's
 * helper is a fake channel here; e2e.posix.test.ts runs the whole chain.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ElevateEndMsg } from "@dispatch-plugins/host-agent";
import type { SshTarget } from "@dispatch-plugins/remote-core";
import type { ClientChannel } from "ssh2";
import {
  ELEVATE_USER,
  Elevation,
  approvalsOf,
  displayCommand,
  runCommand,
  type ApprovalRequest,
  type ApprovalResult,
  type ElevationConnection,
  type ElevationMachine,
  type ElevationShell,
} from "../src/elevation.js";
import type { HostConfig } from "../src/hosts.js";

const HOST: HostConfig = {
  slug: "cvx-mac",
  label: "CVX Mac",
  user: "dispatch",
  addresses: ["10.0.4.5", "cvx-mac.local"],
  port: 22,
  hostKey: `SHA256:${"a".repeat(43)}`,
  hostKeyType: "ssh-ed25519",
  keyFingerprint: `SHA256:${"b".repeat(43)}`,
  allowFrom: ["10.0.4.1"],
  pairedAt: "2026-11-06T00:00:00.000Z",
};

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

class FakeShell implements ElevationShell {
  out: Array<[string, number, string]> = [];
  ends: ElevateEndMsg[] = [];
  holds = new Map<string, string>();
  heldEver: string[] = [];
  elevateOutput(id: string, stream: 1 | 2, data: Buffer) {
    this.out.push([id, stream, data.toString()]);
  }
  elevateEnd(m: ElevateEndMsg) {
    this.ends.push(m);
  }
  hold(id: string, detail: string) {
    this.holds.set(id, detail);
    this.heldEver.push(detail);
  }
  release(id: string) {
    this.holds.delete(id);
  }
  text(id: string, stream: number) {
    return this.out.filter(([i, s]) => i === id && s === stream).map(([, , t]) => t).join("");
  }
}

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
  finish(code: number, out = "", err = "") {
    if (out) this.emit("data", Buffer.from(out));
    if (err) this.stderr.emit("data", Buffer.from(err));
    this.emit("exit", code);
    this.emit("close");
  }
}

/**
 * A machine the elevation key logs in to. `refuse` makes the login fail with
 * that message; `slowChannel` holds each channel's opening until the test
 * calls `opened()`.
 */
function machine(opts: { refuse?: string; slowChannel?: boolean } = {}) {
  const logins: Array<{ target: SshTarget; commands: string[]; closed: boolean }> = [];
  const channels: FakeChannel[] = [];
  let waiters: Array<() => void> = [];
  let opening: Array<() => void> = [];
  const connect = (target: SshTarget): ElevationConnection => {
    const login = { target, commands: [] as string[], closed: false };
    logins.push(login);
    return {
      connect: async () => {
        if (opts.refuse) throw new Error(opts.refuse);
      },
      channel: async (command: string) => {
        login.commands.push(command);
        const ch = new FakeChannel();
        channels.push(ch);
        for (const w of waiters.splice(0)) w();
        if (opts.slowChannel) await new Promise<void>((r) => opening.push(r));
        return ch as unknown as ClientChannel;
      },
      close: () => void (login.closed = true),
    };
  };
  const channel = async (n: number) => {
    while (channels.length < n) await new Promise<void>((r) => waiters.push(r));
    return channels[n - 1]!;
  };
  const opened = () => {
    for (const o of opening.splice(0)) o();
  };
  return { connect, logins, channels, channel, opened };
}

/** Approvals the test answers. Each request waits until `answer` is called for it. */
function approvals() {
  const asked: Array<{ chatId: string; req: ApprovalRequest; answer: (r: Partial<ApprovalResult>) => void }> = [];
  let waiters: Array<() => void> = [];
  const api = {
    request: (chatId: string, req: ApprovalRequest) =>
      new Promise<ApprovalResult>((resolve) => {
        asked.push({ chatId, req, answer: (r) => resolve({ decision: "approved", at: Date.now(), ...r }) });
        req.signal?.addEventListener("abort", () => resolve({ decision: "cancelled", at: Date.now() }), { once: true });
        for (const w of waiters.splice(0)) w();
      }),
  };
  const nth = async (n: number) => {
    while (asked.length < n) await new Promise<void>((r) => waiters.push(r));
    return asked[n - 1]!;
  };
  return { api, asked, nth };
}

function setup(o: { key?: string | undefined; approvals?: boolean; refuse?: string; slowChannel?: boolean; machine?: ElevationMachine } = {}) {
  const m = machine({ ...(o.refuse ? { refuse: o.refuse } : {}), ...(o.slowChannel ? { slowChannel: true } : {}) });
  const a = approvals();
  const key = "key" in o ? o.key : "ELEVATE-PRIVATE-KEY";
  const el = new Elevation({
    host: () => HOST,
    address: () => "10.0.4.5",
    key: async () => key,
    ...(o.approvals === false ? {} : { approvals: a.api }),
    log,
    connect: m.connect,
    ...(o.machine ? { machine: () => o.machine! } : {}),
  });
  return { el, m, a };
}

const origin = { chatId: "chat-1", terminal: "main" };
const req = (id: string, argv = ["installer", "-pkg", "/tmp/My App.pkg", "-target", "/"], cwd = "/Users/dispatch/w") => ({ id, argv, cwd });

function decodeRun(command: string) {
  const [verb, id, b64] = command.split(" ");
  const parts = Buffer.from(b64!, "base64").toString("utf8").split("\0");
  expect(parts.pop()).toBe(""); // every part NUL-terminated
  return { verb, id, cwd: parts[0], argv: parts.slice(1) };
}

describe("elevation", () => {
  it("asks the user with the exact command, holds the shell meanwhile, then runs it as the helper's account and relays it", async () => {
    const { el, m, a } = setup();
    const sh = new FakeShell();
    const done = el.handle(req("e-1"), origin, sh);
    const q = await a.nth(1);
    expect(q.chatId).toBe("chat-1");
    expect(q.req).toMatchObject({
      title: "Run as root on CVX Mac",
      command: "installer -pkg '/tmp/My App.pkg' -target /",
      cwd: "/Users/dispatch/w",
      machine: "CVX Mac",
      timeoutSeconds: 300,
    });
    expect(q.req.detail).toMatch(/terminal "main"/);
    expect(sh.holds.get("e-1")).toMatch(/^waiting for the user to approve: sudo installer/);
    expect(m.logins).toHaveLength(0); // nothing before the answer
    q.answer({ by: "Michael" });
    const ch = await m.channel(1);
    expect(sh.holds.size).toBe(0); // the command's own run time counts again
    const login = m.logins[0]!;
    expect(login.target).toMatchObject({ host: "10.0.4.5", port: 22, username: ELEVATE_USER, privateKey: "ELEVATE-PRIVATE-KEY" });
    expect(login.target.hostVerifier).toBeTypeOf("function");
    expect(decodeRun(login.commands[0]!)).toEqual({ verb: "run", id: "e-1", cwd: "/Users/dispatch/w", argv: ["installer", "-pkg", "/tmp/My App.pkg", "-target", "/"] });
    ch.finish(0, "installer: The install was successful.\n", "");
    await done;
    expect(sh.text("e-1", 1)).toBe("installer: The install was successful.\n");
    expect(sh.text("e-1", 2)).toMatch(/asking the user to approve[\s\S]*approved by Michael; running as root on CVX Mac/);
    expect(sh.ends).toEqual([{ id: "e-1", code: 0 }]);
    expect(login.closed).toBe(true);
  });

  it("runs nothing when the user denies it, or doesn't answer in time, and says which", async () => {
    const { el, m, a } = setup();
    const sh = new FakeShell();
    const one = el.handle(req("e-1"), origin, sh);
    (await a.nth(1)).answer({ decision: "denied", by: "Michael" });
    await one;
    const two = el.handle(req("e-2"), origin, sh);
    (await a.nth(2)).answer({ decision: "timeout" });
    await two;
    expect(m.logins).toHaveLength(0);
    expect(sh.ends).toEqual([
      { id: "e-1", code: null, error: "the user denied running this as root by Michael; nothing ran" },
      { id: "e-2", code: null, error: "no answer from the user within 300 s; nothing ran" },
    ]);
    expect(sh.holds.size).toBe(0);
  });

  it("refuses at once, without asking, when this Dispatch can't ask or elevation isn't set up there", async () => {
    const none = setup({ approvals: false });
    const sh = new FakeShell();
    await none.el.handle(req("e-1"), origin, sh);
    expect(sh.ends[0]).toMatchObject({ code: null, error: expect.stringMatching(/no way to ask the user for approval/) });
    expect(await none.el.refresh()).toBe("unsupported");

    const off = setup({ key: undefined });
    await off.el.handle(req("e-2"), origin, sh);
    expect(sh.ends[1]).toMatchObject({ code: null, error: expect.stringMatching(/elevation isn't set up on CVX Mac.*Settings → Remote hosts/) });
    expect(off.a.asked).toHaveLength(0);
    expect(await off.el.refresh()).toBe("off");
    expect(await setup().el.refresh()).toBe("on");
  });

  it("tells a shell on a root login to run it without sudo, and a machine that isn't a Mac that it can't be set up there", async () => {
    const sh = new FakeShell();
    const root = setup({ key: undefined, machine: { root: true, setup: false } });
    await root.el.handle(req("e-1"), origin, sh);
    expect(sh.ends[0]).toMatchObject({ code: null, error: "this shell is root on CVX Mac already (the login is root): run the command without sudo." });
    await root.el.refresh();
    expect(root.el.state).toBe("root");

    const linux = setup({ key: undefined, machine: { root: false, setup: false } });
    await linux.el.handle(req("e-2"), origin, sh);
    expect(sh.ends[1]).toMatchObject({ code: null, error: expect.stringMatching(/root with approval can only be set up on a Mac so far/) });
    await linux.el.refresh();
    expect(linux.el.state).toBe("unavailable");
    expect(root.a.asked).toHaveLength(0);
    expect(linux.a.asked).toHaveLength(0);

    // A key stored before is still honoured, and a Mac is as it was.
    const kept = setup({ machine: { root: false, setup: false } });
    await kept.el.refresh();
    expect(kept.el.state).toBe("on");
    const mac = setup({ key: undefined, machine: { root: false, setup: true } });
    await mac.el.refresh();
    expect(mac.el.state).toBe("off");
  });

  it("takes one at a time per machine: the second is asked only once the first is over, and says it waits", async () => {
    const { el, m, a } = setup();
    const sh1 = new FakeShell();
    const sh2 = new FakeShell();
    const one = el.handle(req("e-1", ["id"]), origin, sh1);
    await a.nth(1);
    const two = el.handle(req("e-2", ["whoami"]), { chatId: "chat-2", terminal: "t" }, sh2);
    await new Promise((r) => setTimeout(r, 10));
    expect(a.asked).toHaveLength(1);
    expect(sh2.text("e-2", 2)).toMatch(/waits its turn/);
    expect(sh2.holds.get("e-2")).toMatch(/waiting for another root command on CVX Mac/);
    a.asked[0]!.answer({});
    (await m.channel(1)).finish(0, "0\n");
    await one;
    const q2 = await a.nth(2);
    expect(q2.chatId).toBe("chat-2");
    q2.answer({ decision: "denied" });
    await two;
    expect(sh2.ends).toEqual([{ id: "e-2", code: null, error: "the user denied running this as root; nothing ran" }]);
  });

  it("a cancel withdraws the card while it waits, or stops the command while it runs", async () => {
    const { el, m, a } = setup();
    const sh = new FakeShell();
    const one = el.handle(req("e-1"), origin, sh);
    const q = await a.nth(1);
    el.cancel("e-1");
    await one;
    expect(q.req.signal?.aborted).toBe(true);
    expect(sh.ends[0]).toEqual({ id: "e-1", code: null, error: "cancelled; nothing ran" });
    expect(m.logins).toHaveLength(0);

    const two = el.handle(req("e-2"), origin, sh);
    (await a.nth(2)).answer({});
    const ch = await m.channel(1);
    el.cancel("e-2");
    await two;
    expect(ch.closed).toBe(true);
    expect(sh.ends[1]).toEqual({ id: "e-2", code: null, error: "cancelled while it ran; CVX Mac was told to stop it" });
  });

  it("a cancel while the helper's channel is still opening closes it as soon as it opens", async () => {
    const { el, m, a } = setup({ slowChannel: true });
    const sh = new FakeShell();
    const done = el.handle(req("e-1"), origin, sh);
    (await a.nth(1)).answer({});
    const ch = await m.channel(1); // asked for, not open yet
    el.cancel("e-1");
    m.opened();
    await done;
    expect(ch.closed).toBe(true);
    expect(sh.ends).toEqual([{ id: "e-1", code: null, error: "cancelled as it started; CVX Mac was told to stop it" }]);
    expect(m.logins[0]!.closed).toBe(true);
  });

  it("the shell ending withdraws everything it asked for", async () => {
    const { el, a } = setup();
    const sh = new FakeShell();
    const one = el.handle(req("e-1"), origin, sh);
    const q = await a.nth(1);
    el.cancelShell(sh);
    await one;
    expect(q.req.signal?.aborted).toBe(true);
  });

  it("ignores a request sent again after a reconnect, whether it is still open or already answered", async () => {
    const { el, a } = setup();
    const sh = new FakeShell();
    const one = el.handle(req("e-1"), origin, sh);
    await a.nth(1);
    await el.handle(req("e-1"), origin, sh); // the owner said it again
    expect(a.asked).toHaveLength(1);
    a.asked[0]!.answer({ decision: "denied" });
    await one;
    await el.handle(req("e-1"), origin, sh);
    expect(a.asked).toHaveLength(1);
    expect(sh.ends).toHaveLength(1);
  });

  it("says what to do when the machine refuses the elevation key", async () => {
    const { el, a } = setup({ refuse: "All configured authentication methods failed" });
    const sh = new FakeShell();
    const one = el.handle(req("e-1"), origin, sh);
    (await a.nth(1)).answer({});
    await one;
    expect(sh.ends[0]).toMatchObject({ code: null, error: expect.stringMatching(/refused the elevation key, so nothing ran.*set it up again/) });
  });

  it("reports a connection lost mid-run as unknown, not as a success", async () => {
    const { el, m, a } = setup();
    const sh = new FakeShell();
    const one = el.handle(req("e-1"), origin, sh);
    (await a.nth(1)).answer({});
    const ch = await m.channel(1);
    ch.emit("close");
    await one;
    expect(sh.ends[0]).toMatchObject({ code: null, error: expect.stringMatching(/ended while it ran/) });
  });

  it("refuses a malformed request, and never asks about it", async () => {
    const { el, a } = setup();
    const sh = new FakeShell();
    await el.handle({ id: "e-1", argv: [], cwd: "/w" }, origin, sh);
    await el.handle({ id: "e-2", argv: ["id"], cwd: "relative" }, origin, sh);
    await el.handle({ id: "../bad", argv: ["id"], cwd: "/w" }, origin, sh);
    expect(a.asked).toHaveLength(0);
    expect(sh.ends.map((e) => e.id)).toEqual(["e-1", "e-2"]); // an unusable id can't even be answered
  });

  it("refuses, without asking, a command too long for the approval card to show in full", async () => {
    const { el, a } = setup();
    const sh = new FakeShell();
    await el.handle(req("e-1", ["sh", "-c", "x".repeat(8_001)]), origin, sh);
    await el.handle(req("e-2", ["id"], `/${"d".repeat(1_000)}`), origin, sh);
    expect(a.asked).toHaveLength(0);
    expect(sh.ends[0]!.error).toMatch(/too long to show the user for approval \(\d+ characters, at most 8000\); nothing ran/);
    expect(sh.ends[1]!.error).toMatch(/directory's path is too long/);
  });
});

describe("elevation's wire format and helpers", () => {
  it("encodes the directory and every argument NUL-terminated in base64, so nothing is shell-parsed", () => {
    const c = runCommand("e-9", "/tmp/a b", ["sh", "-c", "echo $HOME; rm -rf '/'"]);
    expect(c).toMatch(/^run e-9 [A-Za-z0-9+/=]+$/);
    expect(decodeRun(c)).toEqual({ verb: "run", id: "e-9", cwd: "/tmp/a b", argv: ["sh", "-c", "echo $HOME; rm -rf '/'"] });
    expect(() => runCommand("bad id", "/", ["id"])).toThrow();
  });

  it("shows a command the way a person would type it", () => {
    expect(displayCommand(["installer", "-pkg", "/tmp/My App.pkg"])).toBe("installer -pkg '/tmp/My App.pkg'");
    expect(displayCommand(["sh", "-c", "it's"])).toBe(`sh -c 'it'\\''s'`);
  });

  it("finds ctx.approvals only when it is really there", () => {
    expect(approvalsOf({})).toBeUndefined();
    expect(approvalsOf({ approvals: {} })).toBeUndefined();
    const api = { request: async () => ({ decision: "denied" as const, at: 0 }) };
    expect(approvalsOf({ approvals: api })).toBe(api);
  });
});
