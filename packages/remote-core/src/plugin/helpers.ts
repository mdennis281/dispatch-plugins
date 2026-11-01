/** Small pieces every remote-machine plugin's activate needs. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { SshAuth } from "../ssh/connection.js";

/**
 * A private key pasted into a secret card may arrive with its newlines
 * flattened, or base64-encoded so it survived a single-line input. Accept all
 * three; ssh2 wants the PEM/OpenSSH text.
 */
export function normaliseKey(raw: string): string {
  const t = raw.trim();
  // Header, body, footer — with whatever whitespace (or none) the paste left
  // between them. The body is base64, so any whitespace in it was a newline.
  const pem = t.match(/^(-----BEGIN [A-Z ]+-----)\s*([\s\S]*?)\s*(-----END [A-Z ]+-----)$/);
  if (pem) return `${pem[1]}\n${pem[2]!.replace(/\s+/g, "\n")}\n${pem[3]}\n`;
  const decoded = Buffer.from(t, "base64").toString("utf8");
  return decoded.includes("-----BEGIN") ? decoded.trim() + "\n" : t;
}

/**
 * SSH credentials, read at each use: a private key from the `keySecret`
 * secret, else from the file at `keyPath()` (`~` expands), plus the password
 * secret when set. A key file that can't be read is an error unless there is
 * a password to fall back on.
 */
export function sshAuthFrom(opts: {
  secret: (name: string) => Promise<string | undefined>;
  keySecret: string;
  passwordSecret: string;
  keyPath: () => string;
}): () => Promise<SshAuth> {
  return async () => {
    const password = (await opts.secret(opts.passwordSecret)) || undefined;
    const secretKey = await opts.secret(opts.keySecret);
    if (secretKey) return { privateKey: normaliseKey(secretKey), password };
    const path = opts.keyPath().replace(/^~(?=$|[\\/])/, homedir());
    if (path) {
      try {
        return { privateKey: await readFile(path, "utf8"), password };
      } catch (err) {
        if (!password) throw new Error(`cannot read the SSH key at ${path}: ${(err as Error).message}`);
      }
    }
    return { password };
  };
}

/**
 * Stored settings merged over `defaults`, coercing the obvious mistakes: a
 * number typed as a string, `"true"` for a boolean, stray whitespace. Empty
 * and missing values keep the default; keys `defaults` lacks are dropped.
 */
export function coerceSettings<T extends object>(defaults: T, raw: Record<string, unknown>): T {
  const out = { ...defaults } as Record<string, unknown>;
  const base = defaults as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    const v = raw[key];
    if (v === undefined || v === null || v === "") continue;
    const d = base[key];
    if (typeof d === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof d === "boolean") {
      out[key] = v === true || v === "true";
    } else {
      out[key] = String(v).trim();
    }
  }
  return out as T;
}
