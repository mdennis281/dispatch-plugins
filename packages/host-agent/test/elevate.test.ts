/**
 * `dispatch-elevate` (dispatch-host's `elevate`) against a fake session
 * owner: what it sends, how it prints the answer, and how it ends. A named
 * pipe on Windows and a unix socket elsewhere, so it runs on every platform.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runElevate } from "../src/elevate.js";
import { ELEVATE_SOCKET_ENV } from "../src/env.js";
import { F, FrameDecoder, decodeJson, encodeFrame, type ElevateMsg } from "../src/protocol.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

/** A fake owner: records what each asker sent, and answers with `answer`. */
async function owner(answer: (sock: Socket, msg: ElevateMsg) => void): Promise<{ path: string; asked: ElevateMsg[]; closed: Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "dh-elev-"));
  const path = process.platform === "win32" ? `\\\\.\\pipe\\dh-elev-${process.pid}-${Math.random().toString(36).slice(2)}` : join(dir, "s.sock");
  const asked: ElevateMsg[] = [];
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => (closedResolve = r));
  const server: Server = createServer((sock) => {
    const dec = new FrameDecoder();
    sock.on("data", (d: Buffer) => {
      for (const f of dec.push(d)) {
        if (f.type !== F.elevate) continue;
        const msg = decodeJson<ElevateMsg>(f.payload);
        asked.push(msg);
        answer(sock, msg);
      }
    });
    sock.on("close", () => closedResolve());
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  cleanup.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, asked, closed };
}

function io(socket: string | undefined, extra: { onSignal?: (fn: (s: NodeJS.Signals) => void) => () => void } = {}) {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  return {
    io: {
      env: socket ? { [ELEVATE_SOCKET_ENV]: socket } : {},
      cwd: "/Users/dispatch/work",
      stdout: { write: (d: Buffer | string) => out.push(Buffer.from(d)) },
      stderr: { write: (d: Buffer | string) => err.push(Buffer.from(d)) },
      ...extra,
    },
    out: () => Buffer.concat(out).toString(),
    err: () => Buffer.concat(err).toString(),
  };
}

const data = (stream: 1 | 2, text: string) => encodeFrame(F.elevateData, Buffer.concat([Buffer.from([stream]), Buffer.from(text)]));

describe("dispatch-elevate", () => {
  it("sends the command and its directory, prints what comes back on the right stream, and exits with the command's code", async () => {
    const o = await owner((sock) => {
      sock.write(Buffer.concat([data(2, "dispatch-elevate: approved\n"), data(1, "installed\n"), encodeFrame(F.elevateDone, { code: 3 })]));
    });
    const t = io(o.path);
    const code = await runElevate(["--", "installer", "-pkg", "/tmp/a b.pkg"], t.io);
    expect(o.asked).toEqual([{ argv: ["installer", "-pkg", "/tmp/a b.pkg"], cwd: "/Users/dispatch/work" }]);
    expect(code).toBe(3);
    expect(t.out()).toBe("installed\n");
    expect(t.err()).toBe("dispatch-elevate: approved\n");
  });

  it("says why nothing ran, and exits 1: a denial, a timeout, elevation not set up", async () => {
    const o = await owner((sock) => sock.write(encodeFrame(F.elevateDone, { code: null, error: "the user denied running this as root; nothing ran" })));
    const t = io(o.path);
    expect(await runElevate(["whoami"], t.io)).toBe(1);
    expect(t.err()).toBe("dispatch-elevate: the user denied running this as root; nothing ran\n");
  });

  it("exits 128+n for a command killed by a signal", async () => {
    const o = await owner((sock) => sock.write(encodeFrame(F.elevateDone, { code: null, signal: "TERM" })));
    expect(await runElevate(["sleep", "100"], io(o.path).io)).toBe(143);
  });

  it("hangs up when interrupted, so the owner withdraws the request", async () => {
    let fire!: (s: NodeJS.Signals) => void;
    const o = await owner(() => {
      queueMicrotask(() => fire("SIGINT"));
    });
    const t = io(o.path, { onSignal: (fn) => ((fire = fn), () => {}) });
    expect(await runElevate(["sleep", "100"], t.io)).toBe(130);
    await o.closed;
    expect(t.err()).toMatch(/interrupted \(SIGINT\); the request is withdrawn/);
  });

  it("fails clearly when the session goes away before an answer", async () => {
    const o = await owner((sock) => sock.destroy());
    const t = io(o.path);
    expect(await runElevate(["id"], t.io)).toBe(1);
    expect(t.err()).toMatch(/the session went away before an answer came/);
  });

  it("outside a Dispatch chat shell there is nobody to ask; with no command it prints usage", async () => {
    const none = io(undefined);
    expect(await runElevate(["id"], none.io)).toBe(1);
    expect(none.err()).toMatch(/not in a Dispatch chat shell/);
    const empty = io("/nowhere");
    expect(await runElevate([], empty.io)).toBe(2);
    expect(empty.err()).toMatch(/^usage: dispatch-elevate <command>/);
    const help = io("/nowhere");
    expect(await runElevate(["--help"], help.io)).toBe(0);
    expect(help.out()).toMatch(/once the user approves it in Dispatch/);
  });

  it("refuses a relative directory or a NUL in an argument before connecting", async () => {
    const t = io("/nowhere");
    expect(await runElevate(["printf", "a\0b"], t.io)).toBe(2);
    expect(t.err()).toMatch(/NUL/);
    const rel = io("/nowhere");
    rel.io.cwd = "relative";
    expect(await runElevate(["id"], rel.io)).toBe(2);
  });
});
