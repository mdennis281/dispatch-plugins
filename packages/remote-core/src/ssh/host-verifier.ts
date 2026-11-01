/**
 * Who a host is. ssh2 hands the verifier the raw host key blob the server
 * presented; the verifier says whether that is the machine we meant.
 */
import { createHash } from "node:crypto";

export type HostVerifier = (key: Buffer) => boolean | Promise<boolean>;

/** OpenSSH's `SHA256:` fingerprint of a raw host key blob, as `ssh-keygen -lf` prints it. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Accept any key. For machines the caller provisioned a moment ago through an
 * authenticated API and asked for their address: there the API is the trust
 * anchor. Proxmox's linked clones all present their template's host key, on a
 * DHCP address yesterday's clone may have had, so there is no stable identity
 * to pin.
 */
export function trustProvisioner(): HostVerifier {
  return () => true;
}

/**
 * Accept only these fingerprints. A mismatch means "not this host", never a
 * prompt to re-pin: any device on the LAN can answer to a name.
 */
export function pinnedHostKey(fingerprints: string | readonly string[]): HostVerifier {
  const want = new Set(typeof fingerprints === "string" ? [fingerprints] : fingerprints);
  return (key) => want.has(hostKeyFingerprint(key));
}

/**
 * Trust on first use: pin the first key seen through `store`, then accept only
 * that one.
 */
export function tofuHostKey(store: {
  load(): Promise<string | undefined>;
  save(fingerprint: string): Promise<void>;
}): HostVerifier {
  return async (key) => {
    const seen = hostKeyFingerprint(key);
    const pinned = await store.load();
    if (pinned) return pinned === seen;
    await store.save(seen);
    return true;
  };
}
