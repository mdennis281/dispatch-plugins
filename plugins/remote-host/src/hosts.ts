/**
 * A paired machine, as settings keep it, and the names derived from it.
 *
 * Settings hold only what the human decided: which machine, its host key,
 * where to look for it. They are shared by the stable and dev instances
 * (`config/`), and written only when a human pairs, renames or removes a
 * machine. What changes at run time (online, last seen, the probe) is kept
 * per instance in kv.
 */
import { isIP } from "node:net";

export const PLUGIN_ID = "remote-host";

/** A machine's immutable name: the `<slug>` in `remote-host/<slug>`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export interface HostConfig {
  slug: string;
  /** What pickers and notes call it. Renaming changes only this. */
  label: string;
  /** The account Dispatch logs in as: a dedicated, non-admin user. */
  user: string;
  /** Names and addresses to try, in order. A different host key at one means "not this machine". */
  addresses: string[];
  port: number;
  /** The pinned host key, `SHA256:…`. The machine's identity; changed only by pairing again. */
  hostKey: string;
  /** Its type (`ssh-ed25519`). Negotiated explicitly, so the host shows the key that was pinned. */
  hostKeyType: string;
  /** Fingerprint of the client key Dispatch holds for it (`REMOTE_HOST_KEY_<SLUG>`). */
  keyFingerprint: string;
  /** The `from=` list on the machine's authorized_keys line. */
  allowFrom: string[];
  pairedAt: string;
  /**
   * Which form of the authorized_keys line it was paired with ({@link KEY_LINE}).
   * Absent: before 0.4.0, whose line lets forwards reach 127.0.0.1 only, not ::1.
   */
  keyLine?: number;
}

export { KEY_LINE } from "./key-line.js";

/** `remote-host/<slug>`. */
export function backendId(slug: string): string {
  return `${PLUGIN_ID}/${slug}`;
}

/** The secret holding a machine's private key. Slugs have no `_`, so no two map to one name. */
export function keySecretName(slug: string): string {
  return `REMOTE_HOST_KEY_${slug.toUpperCase().replace(/-/g, "_")}`;
}

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ADDRESS = /^[A-Za-z0-9._:%-]{1,253}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/**
 * The hosts in stored settings. An entry that doesn't parse is skipped and
 * reported, never "repaired": settings may have been written by a newer
 * version, and this one must not guess at what it meant.
 */
export function readHosts(raw: unknown, warn: (msg: string) => void = () => {}): HostConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn("settings.hosts is not a list; no machines are configured");
    return [];
  }
  const out: HostConfig[] = [];
  const seen = new Set<string>();
  for (const [i, h] of raw.entries()) {
    const why = invalid(h);
    if (why) {
      warn(`settings.hosts[${i}] skipped: ${why}`);
      continue;
    }
    const host = h as HostConfig;
    if (seen.has(host.slug)) {
      warn(`settings.hosts[${i}] skipped: ${host.slug} is listed twice`);
      continue;
    }
    seen.add(host.slug);
    out.push({
      slug: host.slug,
      label: host.label,
      user: host.user,
      addresses: [...host.addresses],
      port: typeof host.port === "number" ? host.port : 22,
      hostKey: host.hostKey,
      hostKeyType: host.hostKeyType,
      keyFingerprint: host.keyFingerprint,
      allowFrom: [...host.allowFrom],
      pairedAt: host.pairedAt,
      ...(Number.isInteger(host.keyLine) && (host.keyLine as number) > 0 ? { keyLine: host.keyLine } : {}),
    });
  }
  return out;
}

function invalid(h: unknown): string | undefined {
  if (!h || typeof h !== "object") return "not an object";
  const o = h as Record<string, unknown>;
  if (typeof o.slug !== "string" || !SLUG_PATTERN.test(o.slug)) return "no valid slug";
  if (typeof o.label !== "string" || !o.label.trim()) return `${o.slug}: no label`;
  if (typeof o.user !== "string" || !USER.test(o.user)) return `${o.slug}: no valid user`;
  if (!Array.isArray(o.addresses) || !o.addresses.length || !o.addresses.every((a) => typeof a === "string" && ADDRESS.test(a))) {
    return `${o.slug}: no valid addresses`;
  }
  if (o.port !== undefined && !(Number.isInteger(o.port) && (o.port as number) > 0 && (o.port as number) < 65536)) return `${o.slug}: bad port`;
  if (typeof o.hostKey !== "string" || !FINGERPRINT.test(o.hostKey)) return `${o.slug}: no pinned host key`;
  if (typeof o.hostKeyType !== "string" || !(HOST_KEY_TYPES as readonly string[]).includes(o.hostKeyType)) {
    return `${o.slug}: no usable host key type`;
  }
  if (typeof o.keyFingerprint !== "string" || !FINGERPRINT.test(o.keyFingerprint)) return `${o.slug}: no client key fingerprint`;
  if (!Array.isArray(o.allowFrom) || !o.allowFrom.length || !o.allowFrom.every((a) => typeof a === "string" && validFrom(a))) {
    return `${o.slug}: no valid allowFrom`;
  }
  if (typeof o.pairedAt !== "string") return `${o.slug}: no pairedAt`;
  return undefined;
}

export function validAddress(a: string): boolean {
  return ADDRESS.test(a);
}

/**
 * One entry of the key's `from=` list: an IP address, or a network in CIDR
 * form. Not a host name or a wildcard: those widen who may use the key in
 * ways that are easy to get wrong (`*` lets in everyone). A network can't be
 * wider than a /8 (IPv4) or a /32 (IPv6).
 */
export function validFrom(a: string): boolean {
  const m = a.match(/^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/);
  if (!m) return false;
  const ip = m[1]!;
  const v = isIP(ip);
  if (!v) return false;
  if (m[2] === undefined) return true;
  const bits = Number(m[2]);
  return v === 4 ? bits >= 8 && bits <= 32 : bits >= 32 && bits <= 128;
}

/** Host key types a machine may be pinned by. */
export const HOST_KEY_TYPES = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"] as const;

/**
 * What to let the host negotiate so that it shows the pinned key. An RSA key
 * is the same key under either SHA-2 signature; plain `ssh-rsa` (SHA-1) is
 * refused by OpenSSH 8.8 and later.
 */
export function hostKeyAlgorithms(type: string): string[] {
  return type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256"] : [type];
}

export function validUser(u: string): boolean {
  return USER.test(u);
}

/** What changed between two configs of one machine that needs a new connection (not just a new label). */
export function connectionChanged(a: HostConfig, b: HostConfig): boolean {
  return (
    a.user !== b.user ||
    a.port !== b.port ||
    a.hostKey !== b.hostKey ||
    a.hostKeyType !== b.hostKeyType ||
    a.keyFingerprint !== b.keyFingerprint ||
    a.addresses.join("\n") !== b.addresses.join("\n")
  );
}
