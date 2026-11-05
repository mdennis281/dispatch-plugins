/**
 * Pairing against a real SSH server in the test process. The server installs
 * a key when the plugin runs the add script, the way a machine's
 * authorized_keys would, so "the new key logs in on its own" is checked for
 * real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startTestSshServer, type TestSshServer } from "@dispatch-plugins/remote-core/testing";
import { SshConnection, hostKeyFingerprint, publicKeyOf, type SshTarget } from "@dispatch-plugins/remote-core";
import type { LinkConnection } from "../src/link.js";
import type { HostConfig } from "../src/hosts.js";
import { Pairing, UserError } from "../src/pairing.js";

const servers: TestSshServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A machine whose authorized_keys is `keys`, edited by the plugin's own scripts. */
async function machine(opts: { password?: string } = {}) {
  const keys: string[] = [];
  const s = await startTestSshServer({
    ...(opts.password ? { password: opts.password } : {}),
    authorizedKeys: () => keys,
    exec: ({ command, channel }) => {
      let out = "";
      if (command.includes("authorized_keys") && command.includes("echo added")) {
        const blob = command.match(/ssh-ed25519 ([A-Za-z0-9+/=]+)/)?.[1];
        if (blob && !keys.includes(blob)) keys.push(blob);
        out = "added\n";
      } else if (command.includes("echo removed")) {
        // Quoted twice over (sq inside shCommand), so match the blob, not its quotes.
        const blob = command.match(/grep -vF \W*([A-Za-z0-9+/]{40,}=*)/)?.[1];
        const at = blob ? keys.indexOf(blob) : -1;
        if (at >= 0) keys.splice(at, 1);
        out = at >= 0 ? "removed\n" : "absent\n";
      } else if (command.includes("SSH_CLIENT")) {
        out = "127.0.0.1 50123 22";
      }
      channel.write(out);
      channel.exit(0);
      channel.end();
    },
  });
  servers.push(s);
  return { s, keys };
}

function pairing(state: { hosts: HostConfig[]; secrets: Map<string, string> }, connect?: (t: SshTarget) => LinkConnection) {
  return new Pairing({
    ...(connect ? { connect } : {}),
    hosts: () => state.hosts,
    saveHosts: async (h) => {
      state.hosts = h;
    },
    secrets: {
      get: async (n) => state.secrets.get(n),
      set: async (n, v) => void state.secrets.set(n, v),
      delete: async (n) => state.secrets.delete(n),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    localAddresses: () => ["10.0.4.1", "10.69.69.69"],
    dispatchName: "DipDuo",
  });
}

const fresh = () => ({ hosts: [] as HostConfig[], secrets: new Map<string, string>() });

describe("scan", () => {
  it("shows the host key and suggests this computer's addresses for from=, the one it used first", async () => {
    const { s } = await machine();
    const scan = await pairing(fresh()).scan({ address: s.host, port: s.port });
    expect(scan).toMatchObject({ fingerprint: s.fingerprint, keyType: "ssh-ed25519", address: "127.0.0.1", port: s.port });
    expect(scan.suggestedAllowFrom).toEqual(["127.0.0.1", "10.0.4.1", "10.69.69.69"]);
    expect(s.attempts).toEqual([]);
  });

  it("refuses an address that is not one", async () => {
    await expect(pairing(fresh()).scan({ address: "a b" })).rejects.toThrow(UserError);
  });
});

describe("start", () => {
  it("mints a key whose line may only forward to loopback, only from this computer", async () => {
    const p = pairing(fresh());
    const r = p.start({ slug: "cvx-mac", address: "10.0.10.16", user: "dispatch", hostKey: `SHA256:${"a".repeat(43)}` });
    expect(r.id).toBe("remote-host/cvx-mac");
    expect(r.authorizedKeysLine).toMatch(
      /^restrict,port-forwarding,permitopen="127\.0\.0\.1:\*",permitopen="\[::1\]:\*",from="10\.0\.4\.1,10\.69\.69\.69" ssh-ed25519 \S+ dispatch-remote-host:cvx-mac@DipDuo$/,
    );
    expect(r.oneLiner.startsWith("( umask 077; ")).toBe(true);
    expect(r.oneLiner).not.toMatch(/\bexit\b/); // pasted into a terminal, it must not close it
  });

  it("refuses a bad name, a taken one, and a fingerprint that isn't one", () => {
    const state = fresh();
    state.hosts.push({ slug: "cvx-mac" } as HostConfig);
    const p = pairing(state);
    const ok = { address: "h", user: "dispatch", hostKey: `SHA256:${"a".repeat(43)}` };
    expect(() => p.start({ ...ok, slug: "-bad" })).toThrow(/lowercase/);
    expect(() => p.start({ ...ok, slug: "cvx-mac" })).toThrow(/already paired/);
    expect(() => p.start({ ...ok, slug: "x", hostKey: "MD5:aa" })).toThrow(/fingerprint/);
    expect(() => p.start({ ...ok, slug: "x", allowFrom: ['1.2.3.4" evil'] })).toThrow(/not an IP address/);
    expect(() => p.start({ ...ok, slug: "x", hostKeyType: "ssh-dss" })).toThrow(/host key type/);
  });

  it("never lets the key in from everywhere: no wildcards, names, or catch-all networks", () => {
    const p = pairing(fresh());
    const ok = { slug: "x", address: "h", user: "dispatch", hostKey: `SHA256:${"a".repeat(43)}` };
    for (const bad of ["*", "0.0.0.0/0", "10.0.0.0/7", "::/0", "*.lan", "cvx-mac.lan", "10.0.4.*"]) {
      expect(() => p.start({ ...ok, allowFrom: [bad] }), bad).toThrow(/not an IP address/);
    }
    expect(p.start({ ...ok, allowFrom: ["10.0.4.1", "10.0.0.0/20", "fd00::1", "2001:db8::/48"] }).authorizedKeysLine).toContain(
      'from="10.0.4.1,10.0.0.0/20,fd00::1,2001:db8::/48"',
    );
  });

  it("keeps the key's comment within bounds for the longest name and a long computer name", () => {
    const p = new Pairing({
      hosts: () => [],
      saveHosts: async () => {},
      secrets: { get: async () => undefined, set: async () => {}, delete: async () => false },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      localAddresses: () => ["10.0.4.1"],
      dispatchName: "a-very-long-computer-name.with.a.domain.that.goes.on.and.on.example.internal",
    });
    const r = p.start({ slug: "a".repeat(48), address: "h", user: "dispatch", hostKey: `SHA256:${"a".repeat(43)}` });
    expect(r.authorizedKeysLine.split(" ").at(-1)!.length).toBeLessThanOrEqual(128);
  });
});

describe("finish", () => {
  it("sends no password to a machine whose key isn't the one confirmed, and saves nothing", async () => {
    const { s } = await machine({ password: "hunter2" });
    const other = await machine();
    const state = fresh();
    const p = pairing(state);
    const r = p.start({ slug: "cvx-mac", address: s.host, port: s.port, user: "dispatch", hostKey: other.s.fingerprint });
    await expect(p.finish({ pairingId: r.pairingId, password: "hunter2" })).rejects.toThrow(/different host key.*Nothing was sent/);
    expect(s.attempts.filter((a) => a.password !== undefined)).toEqual([]);
    expect(state.hosts).toEqual([]);
    expect(state.secrets.size).toBe(0);
  });

  it("with the password: adds the key, proves it logs in alone, then saves the machine and its key", async () => {
    const { s, keys } = await machine({ password: "hunter2" });
    const state = fresh();
    const p = pairing(state);
    const r = p.start({ slug: "cvx-mac", label: "CVX Mac", address: s.host, port: s.port, user: "dispatch", hostKey: s.fingerprint });
    const done = await p.finish({ pairingId: r.pairingId, password: "hunter2" });
    expect(keys).toHaveLength(1);
    expect(done.seenFrom).toBe("127.0.0.1");
    expect(state.hosts).toEqual([done.host]);
    const key = state.secrets.get("REMOTE_HOST_KEY_CVX_MAC")!;
    expect(publicKeyOf(key).split(" ")[1]).toBe(keys[0]);
    expect(done.host).toMatchObject({
      slug: "cvx-mac",
      label: "CVX Mac",
      user: "dispatch",
      addresses: ["127.0.0.1"],
      port: s.port,
      hostKey: s.fingerprint,
      hostKeyType: "ssh-ed25519",
      keyFingerprint: hostKeyFingerprint(Buffer.from(keys[0]!, "base64")),
      allowFrom: ["10.0.4.1", "10.69.69.69"],
      // Its line lets forwards reach ::1 as well; the pane flags machines without it.
      keyLine: 2,
    });
    // The pairing is spent.
    await expect(p.finish({ pairingId: r.pairingId })).rejects.toThrow(/unknown or has expired/);
  });

  it("without a password: waits for the human to install the line, then works", async () => {
    const { s, keys } = await machine();
    const state = fresh();
    const p = pairing(state);
    const r = p.start({ slug: "cvx-mac", address: s.host, port: s.port, user: "dispatch", hostKey: s.fingerprint });
    await expect(p.finish({ pairingId: r.pairingId })).rejects.toThrow(/doesn't accept the key yet.*one-liner/);
    expect(state.hosts).toEqual([]);
    keys.push(r.authorizedKeysLine.match(/ssh-ed25519 (\S+)/)![1]!); // the human ran it
    const done = await p.finish({ pairingId: r.pairingId });
    expect(done.host.slug).toBe("cvx-mac");
  });

  it("dials a machine given by name on IPv4, as the link will, since the key's from= list is IPv4", async () => {
    const { s } = await machine({ password: "hunter2" });
    const targets: SshTarget[] = [];
    const p = pairing(fresh(), (t) => {
      targets.push(t);
      return new SshConnection(t) as unknown as LinkConnection;
    });
    const r = p.start({ slug: "cvx-mac", address: "localhost", port: s.port, user: "dispatch", hostKey: s.fingerprint });
    const done = await p.finish({ pairingId: r.pairingId, password: "hunter2" });
    expect(done.host.addresses).toEqual(["localhost"]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.map((t) => t.family)).toEqual(targets.map(() => 4));
  });

  it("pairing again replaces the key and takes the old one off the machine", async () => {
    const { s, keys } = await machine({ password: "hunter2" });
    const state = fresh();
    const p = pairing(state);
    const first = p.start({ slug: "cvx-mac", address: s.host, port: s.port, user: "dispatch", hostKey: s.fingerprint });
    await p.finish({ pairingId: first.pairingId, password: "hunter2" });
    const oldKey = state.secrets.get("REMOTE_HOST_KEY_CVX_MAC");
    // As the Settings pane sends it: the machine's saved addresses ride along (one added
    // by Edit since), so pairing again doesn't shrink the list to the scanned one.
    const again = p.start({
      slug: "cvx-mac",
      address: s.host,
      addresses: ["mac.lan", s.host],
      port: s.port,
      user: "dispatch",
      hostKey: s.fingerprint,
      replace: true,
    });
    const done = await p.finish({ pairingId: again.pairingId, password: "hunter2" });
    expect(done.oldKey).toBe("removed");
    expect(keys).toHaveLength(1);
    expect(state.secrets.get("REMOTE_HOST_KEY_CVX_MAC")).not.toBe(oldKey);
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]!.addresses).toEqual([s.host, "mac.lan"]);
  });

  it("puts the old key back if the settings can't be saved", async () => {
    const { s } = await machine({ password: "hunter2" });
    const state = fresh();
    const p = new Pairing({
      hosts: () => state.hosts,
      saveHosts: async () => {
        throw new Error("disk full");
      },
      secrets: {
        get: async (n) => state.secrets.get(n),
        set: async (n, v) => void state.secrets.set(n, v),
        delete: async (n) => state.secrets.delete(n),
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      localAddresses: () => ["127.0.0.1"],
    });
    const r = p.start({ slug: "cvx-mac", address: s.host, port: s.port, user: "dispatch", hostKey: s.fingerprint });
    await expect(p.finish({ pairingId: r.pairingId, password: "hunter2" })).rejects.toThrow(/disk full/);
    expect(state.secrets.size).toBe(0);
  });
});
