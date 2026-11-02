/**
 * Host-key scanning, pinning and client keys, against a real SSH server in
 * the test process. The point of most of these is what the client does NOT
 * do: offer a password to a host whose key isn't the pinned one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { SshConnection, generateKeyPair, pinnedHostKey, publicKeyOf, scanHostKey } from "../src/index.js";
import { startTestSshServer, type TestSshServer } from "./ssh-server.js";

/** OpenSSH's own tool, where there is one, to check our keys against. Unix only: Windows' wants ACLs, not modes. */
const sshKeygen = process.platform !== "win32" && spawnSync("ssh-keygen", ["-?"]).error === undefined;

const servers: TestSshServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(opts: Parameters<typeof startTestSshServer>[0] = {}) {
  const s = await startTestSshServer(opts);
  servers.push(s);
  return s;
}

describe("scanHostKey", () => {
  it("reports the host's key and the address used to reach it, and never logs in", async () => {
    const s = await server({ password: "hunter2" });
    const scan = await scanHostKey({ host: s.host, port: s.port });
    expect(scan.fingerprint).toBe(s.fingerprint);
    expect(scan.keyType).toBe("ssh-ed25519");
    expect(scan.localAddress).toBe("127.0.0.1");
    expect(s.attempts).toEqual([]);
  });

  it("fails clearly when nothing answers", async () => {
    const s = await server();
    const port = s.port;
    await s.close();
    servers.length = 0;
    await expect(scanHostKey({ host: "127.0.0.1", port, timeoutMs: 3_000 })).rejects.toThrow(/ECONNREFUSED|closed|no SSH answer/);
  });
});

describe("a pinned connection", () => {
  it("sends no password to a host whose key is not the pinned one", async () => {
    const s = await server({ password: "hunter2" });
    const wrong = await server(); // another machine's key
    const conn = new SshConnection({
      host: s.host,
      port: s.port,
      username: "dispatch",
      password: "hunter2",
      hostVerifier: pinnedHostKey(wrong.fingerprint),
      algorithms: { serverHostKey: ["ssh-ed25519"] },
    });
    await expect(conn.connect(5_000)).rejects.toThrow(/host denied/i);
    expect(s.attempts.filter((a) => a.password !== undefined)).toEqual([]);
  });

  it("logs in with the password once the key matches, through keyboard-interactive too", async () => {
    const s = await server({ password: "hunter2", keyboardInteractiveOnly: true });
    const conn = new SshConnection({
      host: s.host,
      port: s.port,
      username: "dispatch",
      password: "hunter2",
      hostVerifier: pinnedHostKey(s.fingerprint),
      algorithms: { serverHostKey: ["ssh-ed25519"] },
    });
    await conn.connect(5_000);
    expect(s.attempts.some((a) => a.method === "keyboard-interactive" && a.password === "hunter2")).toBe(true);
    conn.close();
  });

  it("gives up at once on a wrong password instead of retrying it", async () => {
    const s = await server({ password: "hunter2" });
    const conn = new SshConnection({
      host: s.host,
      port: s.port,
      username: "dispatch",
      password: "nope",
      hostVerifier: pinnedHostKey(s.fingerprint),
    });
    const started = Date.now();
    await expect(conn.connect(20_000)).rejects.toThrow(/authentication/i);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("client keys", () => {
  it("makes an ed25519 pair whose public half logs in, and opens a raw channel", async () => {
    const kp = generateKeyPair("dispatch-remote-host:test@box");
    expect(kp.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ dispatch-remote-host:test@box$/);
    expect(publicKeyOf(kp.privateKey)).toBe(kp.publicKey.split(" ").slice(0, 2).join(" "));
    const s = await server({
      authorizedKeys: () => [kp.publicKey],
      exec: ({ command, channel }) => {
        channel.on("data", (d: Buffer) => channel.write(Buffer.concat([Buffer.from(`${command}:`), d])));
        channel.on("end", () => {
          channel.exit(0);
          channel.end();
        });
      },
    });
    const conn = new SshConnection({ host: s.host, port: s.port, username: "dispatch", privateKey: kp.privateKey, hostVerifier: pinnedHostKey(s.fingerprint) });
    await conn.connect(5_000);
    const ch = await conn.channel("echo");
    const got: Buffer[] = [];
    ch.on("data", (d: Buffer) => got.push(d));
    ch.write("hi");
    ch.end();
    await new Promise((r) => ch.on("close", r));
    expect(Buffer.concat(got).toString()).toBe("echo:hi");
    conn.close();
  });

  it("never makes a malformed key (ssh2's own generator broke about one in 256)", () => {
    // ssh2 1.17 dropped a public key's leading zero byte. 2 000 keys hold
    // about eight such public keys, so this fails reliably if that comes back.
    for (let i = 0; i < 2_000; i++) {
      const kp = generateKeyPair("k");
      const parsed = utils.parseKey(kp.privateKey);
      if (parsed instanceof Error) throw new Error(`key ${i} does not parse: ${parsed.message}\n${kp.privateKey}`);
      const blob = parsed.getPublicSSH();
      expect(blob.length).toBe(51); // string "ssh-ed25519" + string <32 bytes>
      expect(kp.publicKey.split(" ")[1]).toBe(blob.toString("base64"));
      const sig = parsed.sign(Buffer.from("x"));
      const pub = utils.parseKey(kp.publicKey);
      if (pub instanceof Error) throw pub;
      expect(pub.verify(Buffer.from("x"), sig)).toBe(true);
    }
  });

  it.skipIf(!sshKeygen)("writes keys OpenSSH itself reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-key-"));
    try {
      for (let i = 0; i < 20; i++) {
        const kp = generateKeyPair(`k${i}`);
        const f = join(dir, `id_${i}`);
        writeFileSync(f, kp.privateKey, { mode: 0o600 });
        const out = execFileSync("ssh-keygen", ["-y", "-f", f], { encoding: "utf8" }).trim();
        expect(out.split(" ").slice(0, 2).join(" ")).toBe(kp.publicKey.split(" ").slice(0, 2).join(" "));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a comment that would break an authorized_keys line", () => {
    expect(() => generateKeyPair("two words")).toThrow(/comment/);
    expect(() => generateKeyPair('a"b')).toThrow(/comment/);
  });
});
