/**
 * Pairing a machine, in three calls the Settings pane makes:
 *
 * 1. **scan**: connect far enough to see the host key, and log in to nothing.
 *    The human compares its fingerprint with what the machine prints itself
 *    (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
 * 2. **start**, with that fingerprint confirmed: mint a keypair for this
 *    machine, and hand back its restricted authorized_keys line, plus a
 *    one-liner that installs it.
 * 3. **finish**: either the human ran the one-liner on the machine, or they
 *    give the account's password ONCE. The password is sent only to a host
 *    presenting the pinned key (ssh2 checks it during key exchange, before
 *    authentication starts), is used to append the line, and is never stored.
 *    Then the new key must log in on its own, and only then is anything saved.
 *
 * The private key lives in memory between start and finish (30 min at most),
 * then in Dispatch's secret store, `REMOTE_HOST_KEY_<SLUG>`. It never touches
 * disk on its own.
 */
import { randomUUID } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { PluginLog } from "@dispatch/plugin-sdk";
import {
  SshConnection,
  errText,
  generateKeyPair,
  hostKeyFingerprint,
  pinnedHostKey,
  publicKeyOf,
  scanHostKey,
  type HostKeyScan,
  type SshTarget,
} from "@dispatch-plugins/remote-core";
import { shCommand } from "@dispatch-plugins/host-agent";
import { addKeyOneLiner, addKeyScript, authorizedKeysLine, keyBlobOf, removeKeyScript } from "./authorized-keys.js";
import {
  HOST_KEY_TYPES,
  SLUG_PATTERN,
  backendId,
  dialFamily,
  hostKeyAlgorithms,
  keySecretName,
  validAddress,
  validFrom,
  validUser,
  KEY_LINE,
  type HostConfig,
} from "./hosts.js";
import { describeConnectError, type LinkConnection } from "./link.js";

/** An error the human can fix, reported as HTTP 400 (or `status`). */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export interface PairingDeps {
  hosts: () => HostConfig[];
  /** Store the full list (a human's edit: this is the only path that writes settings). */
  saveHosts: (hosts: HostConfig[]) => Promise<void>;
  secrets: {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<boolean>;
  };
  log: PluginLog;
  scan?: (opts: { host: string; port: number }) => Promise<HostKeyScan>;
  connect?: (target: SshTarget) => LinkConnection;
  /** This computer's addresses, for the default `from=` list. */
  localAddresses?: () => string[];
  /** Names the key: `dispatch-remote-host:<slug>@<this>`. */
  dispatchName?: string;
  now?: () => number;
}

export interface ScanResult extends HostKeyScan {
  address: string;
  port: number;
  /** A good default for the key's `from=` list: this computer's addresses, the one used to reach the machine first. */
  suggestedAllowFrom: string[];
}

export interface StartRequest {
  slug: string;
  label?: string;
  address: string;
  /** More names or addresses to try later, after `address`. */
  addresses?: string[];
  port?: number;
  user: string;
  /** The fingerprint the human confirmed. */
  hostKey: string;
  hostKeyType?: string;
  allowFrom?: string[];
  /** Pair a machine that is already paired again (a new key, or a new host key). */
  replace?: boolean;
}

export interface StartResult {
  pairingId: string;
  slug: string;
  id: string;
  /** The line to add to `~/.ssh/authorized_keys` on the machine. */
  authorizedKeysLine: string;
  /** The same, as a command to paste into a terminal there, logged in as the account. */
  oneLiner: string;
  expiresAt: number;
}

interface Pending {
  id: string;
  req: Required<Omit<StartRequest, "label" | "addresses" | "replace">> & { label: string; addresses: string[]; replace: boolean };
  privateKey: string;
  publicKey: string;
  line: string;
  expiresAt: number;
}

const PENDING_MS = 30 * 60_000;
const CONNECT_MS = 15_000;

export class Pairing {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(private readonly deps: PairingDeps) {
    this.now = deps.now ?? Date.now;
  }

  async scan(body: { address?: unknown; port?: unknown }): Promise<ScanResult> {
    const address = str(body.address, "address");
    if (!validAddress(address)) throw new UserError(`not a host name or address: ${address}`);
    const port = portOf(body.port);
    let scan: HostKeyScan;
    try {
      scan = await (this.deps.scan ?? ((o) => scanHostKey(o)))({ host: address, port });
    } catch (err) {
      throw new UserError(`could not reach SSH at ${address}:${port}: ${describeConnectError(err)}`, 502);
    }
    const local = (this.deps.localAddresses ?? localIPv4)();
    const suggested = [...new Set([...(scan.localAddress ? [scan.localAddress] : []), ...local])].filter(validFrom);
    return { ...scan, address, port, suggestedAllowFrom: suggested };
  }

  start(body: Partial<Record<keyof StartRequest, unknown>>): StartResult {
    this.expire();
    const slug = str(body.slug, "slug").toLowerCase();
    if (!SLUG_PATTERN.test(slug)) throw new UserError("the name must be lowercase letters, digits and dashes, starting with a letter or digit (48 at most)");
    const replace = body.replace === true;
    if (!replace && this.deps.hosts().some((h) => h.slug === slug)) {
      throw new UserError(`${slug} is already paired. Pair it again only to replace its key or host key.`, 409);
    }
    const address = str(body.address, "address");
    const extra = Array.isArray(body.addresses) ? body.addresses.map((a) => String(a).trim()).filter(Boolean) : [];
    const addresses = [...new Set([address, ...extra])];
    for (const a of addresses) if (!validAddress(a)) throw new UserError(`not a host name or address: ${a}`);
    const user = str(body.user, "user");
    if (!validUser(user)) throw new UserError(`not an account name: ${user}`);
    const hostKey = str(body.hostKey, "hostKey");
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey)) throw new UserError("hostKey must be the SHA256: fingerprint shown by the scan");
    const hostKeyType = typeof body.hostKeyType === "string" && body.hostKeyType ? body.hostKeyType : "ssh-ed25519";
    if (!(HOST_KEY_TYPES as readonly string[]).includes(hostKeyType)) {
      throw new UserError(`not a host key type Dispatch can pin: ${hostKeyType} (one of ${HOST_KEY_TYPES.join(", ")})`);
    }
    const allowFrom = Array.isArray(body.allowFrom)
      ? body.allowFrom.map((a) => String(a).trim()).filter(Boolean)
      : (this.deps.localAddresses ?? localIPv4)();
    if (!allowFrom.length) throw new UserError("the key needs at least one address of this computer to be usable from (allowFrom)");
    for (const a of allowFrom) {
      if (!validFrom(a)) throw new UserError(`not an IP address or a network no wider than /8: ${a}`);
    }
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : slug;

    const comment = `dispatch-remote-host:${slug}@${safeName(this.deps.dispatchName ?? hostname())}`;
    const kp = generateKeyPair(comment);
    const line = authorizedKeysLine(kp.publicKey, allowFrom);
    const id = randomUUID();
    const p: Pending = {
      id,
      req: { slug, label, address, addresses, port: portOf(body.port), user, hostKey, hostKeyType, allowFrom, replace },
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      line,
      expiresAt: this.now() + PENDING_MS,
    };
    this.pending.set(id, p);
    return { pairingId: id, slug, id: backendId(slug), authorizedKeysLine: line, oneLiner: addKeyOneLiner(line), expiresAt: p.expiresAt };
  }

  cancel(body: { pairingId?: unknown }): { cancelled: boolean } {
    return { cancelled: this.pending.delete(String(body.pairingId ?? "")) };
  }

  /**
   * Install the key (with the password, when given), prove it works, then
   * save. `password` is used for this one call and dropped.
   */
  async finish(body: { pairingId?: unknown; password?: unknown }): Promise<{ host: HostConfig; seenFrom?: string; oldKey?: "removed" | "absent" | "left" }> {
    this.expire();
    const p = this.pending.get(String(body.pairingId ?? ""));
    if (!p) throw new UserError("that pairing is unknown or has expired; start again", 404);
    const r = p.req;
    const base: SshTarget = {
      host: r.address,
      port: r.port,
      username: r.user,
      hostVerifier: pinnedHostKey(r.hostKey),
      algorithms: { serverHostKey: hostKeyAlgorithms(r.hostKeyType) as never },
      // Proving the key works must dial as every later connection will.
      ...(dialFamily(r.address, r.allowFrom) ? { family: 4 as const } : {}),
    };
    const password = typeof body.password === "string" && body.password ? body.password : undefined;

    if (password) {
      const c = this.connect({ ...base, password });
      try {
        await c.connect(CONNECT_MS);
      } catch (err) {
        c.close();
        throw new UserError(
          /host denied/i.test(errText(err))
            ? `${r.address} presented a different host key from the one you confirmed. Nothing was sent to it.`
            : `logging in to ${r.address} as ${r.user} failed: ${describeConnectError(err)}`,
          /host denied|authentication/i.test(errText(err)) ? 400 : 502,
        );
      }
      try {
        const res = await c.exec(shCommand(addKeyScript(p.line)), { timeoutMs: 30_000 });
        if (res.code !== 0) throw new UserError(`adding the key on ${r.address} failed: ${res.stderr.trim() || `exit ${res.code}`}`, 502);
      } finally {
        c.close();
      }
    }

    // The key on its own, as every later connection will use it.
    const k = this.connect({ ...base, privateKey: p.privateKey });
    let seenFrom: string | undefined;
    try {
      await k.connect(CONNECT_MS);
      const res = await k.exec(`printf '%s' "$SSH_CLIENT"`, { timeoutMs: 15_000 });
      seenFrom = res.stdout.trim().split(/\s+/)[0] || undefined;
    } catch (err) {
      const why = errText(err);
      if (/host denied/i.test(why)) throw new UserError(`${r.address} presented a different host key from the one you confirmed`);
      if (/authentication/i.test(why)) {
        throw new UserError(
          password
            ? `the key was added, but ${r.address} refused it. Its from= list (${r.allowFrom.join(", ")}) may not include the address this computer connects from.`
            : `${r.address} doesn't accept the key yet. Run the one-liner on the machine as ${r.user}, then try again.`,
        );
      }
      throw new UserError(`could not log in to ${r.address} with the new key: ${describeConnectError(err)}`, 502);
    } finally {
      k.close();
    }

    // Saved only now, and undone if the settings write fails.
    const name = keySecretName(r.slug);
    const previous = await this.deps.secrets.get(name);
    await this.deps.secrets.set(name, p.privateKey);
    const host: HostConfig = {
      slug: r.slug,
      label: r.label,
      user: r.user,
      addresses: r.addresses,
      port: r.port,
      hostKey: r.hostKey,
      hostKeyType: r.hostKeyType,
      keyFingerprint: hostKeyFingerprint(Buffer.from(keyBlobOf(p.publicKey), "base64")),
      allowFrom: r.allowFrom,
      pairedAt: new Date(this.now()).toISOString(),
      keyLine: KEY_LINE,
    };
    const hosts = this.deps.hosts();
    const before = hosts.find((h) => h.slug === r.slug);
    const at = hosts.findIndex((h) => h.slug === r.slug);
    const next = at >= 0 ? hosts.map((h, i) => (i === at ? host : h)) : [...hosts, host];
    try {
      await this.deps.saveHosts(next);
    } catch (err) {
      if (previous) await this.deps.secrets.set(name, previous).catch(() => {});
      else await this.deps.secrets.delete(name).catch(() => {});
      throw err;
    }
    this.pending.delete(p.id);
    this.deps.log.info(`remote-host: paired ${r.slug} (${r.user}@${r.address}, host key ${r.hostKey})`);

    // Pairing again: the old machine (or account) still lets the old key in.
    // Take it out there, logging in with the old key itself.
    let oldKey: "removed" | "absent" | "left" | undefined;
    if (previous && before && previous.trim() !== p.privateKey.trim()) {
      oldKey = await this.removeOldKey(before, previous);
    }
    return { host, ...(seenFrom ? { seenFrom } : {}), ...(oldKey ? { oldKey } : {}) };
  }

  private async removeOldKey(old: HostConfig, previous: string): Promise<"removed" | "absent" | "left"> {
    let blob: string;
    try {
      blob = keyBlobOf(publicKeyOf(previous));
    } catch {
      return "left";
    }
    const c = this.connect({
      host: old.addresses[0]!,
      port: old.port,
      username: old.user,
      privateKey: previous,
      hostVerifier: pinnedHostKey(old.hostKey),
      algorithms: { serverHostKey: hostKeyAlgorithms(old.hostKeyType) as never },
      ...(dialFamily(old.addresses[0]!, old.allowFrom) ? { family: 4 as const } : {}),
    });
    try {
      await c.connect(CONNECT_MS);
      const res = await c.exec(shCommand(removeKeyScript(blob)), { timeoutMs: 30_000 });
      return res.code === 0 && res.stdout.includes("removed") ? "removed" : res.code === 0 ? "absent" : "left";
    } catch (err) {
      this.deps.log.warn(`remote-host: could not remove the old key from ${old.user}@${old.addresses[0]}: ${errText(err)}`);
      return "left";
    } finally {
      c.close();
    }
  }

  private connect(target: SshTarget): LinkConnection {
    return this.deps.connect ? this.deps.connect(target) : (new SshConnection(target) as LinkConnection);
  }

  private expire(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  clear(): void {
    this.pending.clear();
  }
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new UserError(`${name} is required`);
  return v.trim();
}

function portOf(v: unknown): number {
  if (v === undefined || v === null || v === "") return 22;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UserError(`not a port: ${String(v)}`);
  return n;
}

/** This computer's IPv4 addresses that another machine could see it by. */
export function localIPv4(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)];
}

function safeName(name: string): string {
  // The whole comment must stay within generateKeyPair's 128 characters.
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50) || "dispatch";
}
