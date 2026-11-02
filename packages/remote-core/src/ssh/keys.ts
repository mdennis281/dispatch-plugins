/**
 * Client keypairs, made here rather than with `ssh-keygen`: the Dispatch host
 * may be Windows with no OpenSSH, and the private half goes straight into
 * Dispatch's secret store without touching disk.
 *
 * Node makes the key; the OpenSSH encoding is written here. ssh2 1.17's own
 * `utils.generateKeyPairSync("ed25519")` drops a leading zero byte from the
 * public key, so about one key in 256 came out malformed: its private key
 * didn't parse, and its public line named a different key.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { utils } from "ssh2";

export interface SshKeyPair {
  /** OpenSSH private key text, unencrypted. Store it as a secret, never on disk. */
  privateKey: string;
  /** One `authorized_keys`-style line: `ssh-ed25519 AAAA… <comment>`. */
  publicKey: string;
}

/** A fresh ed25519 keypair. `comment` ends the public line; keep it to `[A-Za-z0-9@._:-]`. */
export function generateKeyPair(comment: string): SshKeyPair {
  if (!/^[A-Za-z0-9@._:-]{1,128}$/.test(comment)) throw new Error(`not a usable key comment: ${JSON.stringify(comment)}`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // The raw 32-byte seed and public key are the last 32 bytes of their DER forms.
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey: openSshEd25519(seed, pub, comment), publicKey: `ssh-ed25519 ${ed25519Blob(pub).toString("base64")} ${comment}` };
}

/** The public half of `privateKey` as `<type> <base64>` (no comment). Throws on a key ssh2 can't read. */
export function publicKeyOf(privateKey: string): string {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw new Error(`not a private key: ${parsed.message}`);
  return `${parsed.type} ${parsed.getPublicSSH().toString("base64")}`;
}

/** SSH wire `string`: a u32 length, then the bytes. */
function sshString(data: Buffer | string): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function ed25519Blob(pub: Buffer): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
}

/** OpenSSH's own private key format (PROTOCOL.key), unencrypted, as `ssh-keygen` writes it. */
function openSshEd25519(seed: Buffer, pub: Buffer, comment: string): string {
  const check = randomBytes(4).readUInt32BE(0);
  let priv = Buffer.concat([
    u32(check),
    u32(check),
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(Buffer.alloc(0)),
    u32(1),
    sshString(ed25519Blob(pub)),
    sshString(priv),
  ]);
  const b64 = body.toString("base64").replace(/.{1,70}/g, "$&\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`;
}
