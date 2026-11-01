import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  RemoteShell,
  coerceSettings,
  githubHttps,
  hostKeyFingerprint,
  normaliseKey,
  parseListeners,
  pinnedHostKey,
  remoteShellCommand,
  sshAuthFrom,
  tofuHostKey,
  trustProvisioner,
  withDeadline,
} from "../src/index.js";

describe("parseListeners", () => {
  it("parses ss listeners into the address to dial on the machine", () => {
    const out = [
      "LISTEN 0 4096   0.0.0.0:22      0.0.0.0:*",
      "LISTEN 0 511    [::1]:5173      [::]:*",
      "LISTEN 0 511    *:3000          *:*",
      "LISTEN 0 511    127.0.0.1:8080  0.0.0.0:*",
      "LISTEN 0 511    [::1]:8080      [::]:*",
    ].join("\n");
    expect([...parseListeners(out)]).toEqual([
      [5173, "::1"],
      [3000, "127.0.0.1"],
      [8080, "127.0.0.1"],
    ]);
  });
});

describe("githubHttps", () => {
  it("normalises every spelling of a GitHub origin to https", () => {
    expect(githubHttps("git@github.com:mdennis281/dispatch.git")).toBe("https://github.com/mdennis281/dispatch.git");
    expect(githubHttps("https://github.com/mdennis281/dispatch")).toBe("https://github.com/mdennis281/dispatch.git");
    expect(githubHttps("https://x-token@github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(githubHttps("https://gitlab.com/o/r.git")).toBeUndefined();
  });
});

describe("plugin helpers", () => {
  it("accepts a private key pasted multi-line, flattened to one line, or base64", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\n";
    expect(normaliseKey(pem)).toBe(pem);
    expect(normaliseKey(pem.replace(/\n/g, " "))).toBe(pem);
    expect(normaliseKey(Buffer.from(pem).toString("base64"))).toBe(pem);
  });

  it("reads SSH credentials from the key secret, else the key file, keeping the password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-key-"));
    try {
      const file = join(dir, "id");
      writeFileSync(file, "FILE KEY");
      const secrets: Record<string, string> = { PW: "hunter2" };
      const auth = sshAuthFrom({ secret: async (n) => secrets[n], keySecret: "KEY", passwordSecret: "PW", keyPath: () => file });
      expect(await auth()).toEqual({ privateKey: "FILE KEY", password: "hunter2" });
      secrets.KEY = "-----BEGIN K-----\nAA\n-----END K-----";
      expect(await auth()).toEqual({ privateKey: "-----BEGIN K-----\nAA\n-----END K-----\n", password: "hunter2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable key file is an error only without a password", async () => {
    const missing = join(tmpdir(), "rc-no-such-key");
    const secrets: Record<string, string> = {};
    const auth = sshAuthFrom({ secret: async (n) => secrets[n], keySecret: "KEY", passwordSecret: "PW", keyPath: () => missing });
    await expect(auth()).rejects.toThrow(/cannot read the SSH key/);
    secrets.PW = "pw";
    expect(await auth()).toEqual({ password: "pw" });
  });

  it("coerces stored settings over the defaults", () => {
    const d = { apiUrl: "", cores: 2, tls: false };
    expect(coerceSettings(d, { cores: "4", tls: "true", apiUrl: " https://x ", extra: 1 })).toEqual({ apiUrl: "https://x", cores: 4, tls: true });
    expect(coerceSettings(d, { cores: "lots", apiUrl: "" })).toEqual(d);
  });

  it("withDeadline resolves undefined when the deadline wins", async () => {
    expect(await withDeadline(Promise.resolve(1), 1_000)).toBe(1);
    expect(await withDeadline(new Promise(() => {}), 10)).toBeUndefined();
    expect(await withDeadline(Promise.reject(new Error("x")), 1_000)).toBeUndefined();
  });
});

describe("host verifiers", () => {
  const key = randomBytes(51);
  const fp = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

  it("fingerprints a key the way ssh-keygen -lf prints it", () => {
    expect(hostKeyFingerprint(key)).toBe(fp);
    expect(fp).not.toMatch(/=$/);
  });

  it("trustProvisioner accepts anything; pinnedHostKey only its own", () => {
    expect(trustProvisioner()(key)).toBe(true);
    expect(pinnedHostKey(fp)(key)).toBe(true);
    expect(pinnedHostKey(["SHA256:other", fp])(key)).toBe(true);
    expect(pinnedHostKey("SHA256:other")(key)).toBe(false);
  });

  it("tofuHostKey pins the first key it sees and refuses any other", async () => {
    let stored: string | undefined;
    const v = tofuHostKey({ load: async () => stored, save: async (f) => void (stored = f) });
    expect(await v(key)).toBe(true);
    expect(stored).toBe(fp);
    expect(await v(key)).toBe(true);
    expect(await v(randomBytes(51))).toBe(false);
  });
});

describe("RemoteShell", () => {
  function channel() {
    const ch = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      written: [] as string[],
      closed: false,
      write(c: string) {
        this.written.push(c);
        return true;
      },
      end() {},
      close() {
        this.closed = true;
      },
    });
    return ch;
  }

  it("hides the DTPID line, then passes stdout through", () => {
    const ch = channel();
    const sh = new RemoteShell(ch as never, "/w", () => {});
    const out: string[] = [];
    sh.stdout.on("data", (s: string) => out.push(s));
    ch.emit("data", Buffer.from("DTPID:4"));
    ch.emit("data", Buffer.from("2\nhello\n"));
    ch.emit("data", Buffer.from("more\n"));
    expect(out.join("")).toBe("hello\nmore\n");
  });

  it("kill ends the shell's session by its pid and reports exit once", () => {
    const ch = channel();
    const killed: number[] = [];
    const sh = new RemoteShell(ch as never, "/w", (pid) => killed.push(pid));
    const exits: Array<number | null> = [];
    sh.on("exit", (c: number | null) => exits.push(c));
    ch.emit("data", Buffer.from("DTPID:42\n"));
    sh.kill();
    ch.emit("close");
    expect(killed).toEqual([42]);
    expect(ch.closed).toBe(true);
    expect(exits).toEqual([null]);
  });

  it("starts in the cwd with the env exported, quoted for the shell", () => {
    const cmd = remoteShellCommand("/w/it's here", { A: "x y", B: "it's" });
    expect(cmd).toContain(`export A='x y'; export B='it'\\''s';`);
    expect(cmd).toContain(`cd '/w/it'\\''s here'`);
    expect(cmd.startsWith('echo "DTPID:$$";')).toBe(true);
  });
});
