/**
 * kill(signal). With no signal (core's teardown) or KILL, the shell's whole
 * session dies and the handle reports its exit at once. Any other signal is
 * DELIVERED, as ChildProcess.kill does: the shell may trap it or outlive it,
 * so the exit is reported when the shell actually exits, not before.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RemoteShell, SshConnection } from "../src/index.js";

function channel() {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    closed: false,
    signals: [] as string[],
    write: () => true,
    end() {},
    close() {
      this.closed = true;
    },
    signal(name: string) {
      this.signals.push(name);
      return true;
    },
  });
}

function started(pidLine = "DTPID:42\n") {
  const ch = channel();
  const sent: Array<[number, string]> = [];
  const sh = new RemoteShell(ch as never, "/w", (pid: number, signal: string) => void sent.push([pid, signal]));
  const exits: Array<number | null> = [];
  sh.on("exit", (c: number | null) => exits.push(c));
  ch.emit("data", Buffer.from(pidLine));
  return { ch, sh, sent, exits };
}

describe("RemoteShell.kill", () => {
  it("with no signal, kills the whole session and reports the exit at once", () => {
    const { ch, sh, sent, exits } = started();
    sh.kill();
    expect(sent).toEqual([[42, "KILL"]]);
    expect(ch.closed).toBe(true);
    expect(exits).toEqual([null]);
  });

  it("SIGKILL is the same teardown", () => {
    const { ch, sh, sent, exits } = started();
    sh.kill("SIGKILL");
    expect(sent).toEqual([[42, "KILL"]]);
    expect(ch.closed).toBe(true);
    expect(exits).toEqual([null]);
  });

  it("delivers any other signal, and waits for the shell to exit", () => {
    const { ch, sh, sent, exits } = started();
    sh.kill("SIGTERM");
    sh.kill("int");
    expect(sent).toEqual([
      [42, "TERM"],
      [42, "INT"],
    ]);
    expect(ch.closed).toBe(false);
    expect(exits).toEqual([]);
    ch.emit("exit", 143);
    expect(exits).toEqual([143]);
  });

  it("treats a signal it does not know as KILL, never passing it to the remote shell", () => {
    const { sh, sent, exits } = started();
    sh.kill("TERM; rm -rf /");
    expect(sent).toEqual([[42, "KILL"]]);
    expect(exits).toEqual([null]);
  });

  it("without a session id, signals the channel instead", () => {
    const { ch, sh, sent } = started("no pid line\n");
    sh.kill("SIGINT");
    expect(sent).toEqual([]);
    expect(ch.signals).toEqual(["INT"]);
  });
});

describe("SshConnection's session kill", () => {
  it("sends the named signal to every process in the session", async () => {
    const conn = new SshConnection({ host: "box", username: "u" });
    const cmds: string[] = [];
    const client = {
      exec(cmd: string, cb: (err: undefined, ch: ReturnType<typeof channel>) => void) {
        cmds.push(cmd);
        const ch = channel();
        cb(undefined, ch);
        setImmediate(() => {
          if (cmd.includes("DTPID")) ch.emit("data", Buffer.from("DTPID:42\n"));
          else {
            ch.emit("exit", 0);
            ch.emit("close");
          }
        });
      },
    };
    Object.assign(conn as unknown as { client: unknown; closed: boolean }, { client, closed: false });
    const sh = await conn.shell("/w", {});
    sh.kill("SIGINT");
    expect(cmds.at(-1)).toBe("pkill -INT -s 42 2>/dev/null; kill -INT 42 2>/dev/null; true");
    sh.kill();
    expect(cmds.at(-1)).toBe("pkill -KILL -s 42 2>/dev/null; kill -KILL 42 2>/dev/null; true");
  });
});
