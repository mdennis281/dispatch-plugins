/**
 * What host key a machine presents, learned WITHOUT logging in: the verifier
 * records the key and refuses it, so the connection ends during key exchange,
 * before any credential is offered. A human compares the fingerprint with
 * what the machine itself prints, and only then is anything sent to it.
 */
import { connect as tcpConnect, type Socket } from "node:net";
import { Client, type ConnectConfig } from "ssh2";
import { hostKeyFingerprint } from "./host-verifier.js";

export interface HostKeyScan {
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
  /** The key's type, e.g. `ssh-ed25519`. */
  keyType: string;
  /** The address THIS machine used to reach it, which is the one the host sees (unless something NATs between). */
  localAddress?: string;
}

/**
 * Connect to `host:port` far enough to see its host key. Asks for an ed25519
 * key first (what macOS and current Linux present, and what people compare),
 * and takes whatever the host offers if it has none.
 */
export async function scanHostKey(opts: {
  host: string;
  port?: number;
  timeoutMs?: number;
  keyTypes?: NonNullable<ConnectConfig["algorithms"]>["serverHostKey"];
}): Promise<HostKeyScan> {
  const prefer = opts.keyTypes ?? ["ssh-ed25519"];
  try {
    return await scanOnce(opts.host, opts.port ?? 22, opts.timeoutMs ?? 10_000, prefer);
  } catch (err) {
    // No key of the preferred type: the key exchange fails before the verifier
    // runs. Ask again with ssh2's defaults.
    if (opts.keyTypes || !/no matching|handshake failed/i.test(String((err as Error).message))) throw err;
    return scanOnce(opts.host, opts.port ?? 22, opts.timeoutMs ?? 10_000, undefined);
  }
}

function scanOnce(
  host: string,
  port: number,
  timeoutMs: number,
  keyTypes: NonNullable<ConnectConfig["algorithms"]>["serverHostKey"] | undefined,
): Promise<HostKeyScan> {
  return new Promise((resolve, reject) => {
    let seen: Buffer | undefined;
    let localAddress: string | undefined;
    let done = false;
    const sock: Socket = tcpConnect({ host, port });
    const client = new Client();
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.end();
      sock.destroy();
      if (seen) resolve({ fingerprint: hostKeyFingerprint(seen), keyType: keyTypeOf(seen), ...(localAddress ? { localAddress } : {}) });
      else reject(err ?? new Error(`${host}:${port} closed the connection before showing a host key`));
    };
    const timer = setTimeout(() => finish(new Error(`no SSH answer from ${host}:${port} within ${timeoutMs / 1000}s`)), timeoutMs);
    sock.once("error", (e) => finish(e));
    sock.once("connect", () => {
      localAddress = sock.localAddress;
      client.on("error", (e) => finish(e));
      client.on("close", () => finish());
      client.connect({
        sock,
        username: "dispatch-host-key-scan",
        readyTimeout: timeoutMs,
        ...(keyTypes ? { algorithms: { serverHostKey: keyTypes } } : {}),
        hostVerifier: ((key: Buffer) => {
          seen = Buffer.from(key);
          return false;
        }) as ConnectConfig["hostVerifier"],
      });
    });
  });
}

/** The type name at the start of an SSH public key blob (`string type` per RFC 4253 §6.6). */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return "unknown";
  const len = blob.readUInt32BE(0);
  return len > 0 && len < 64 && blob.length >= 4 + len ? blob.subarray(4, 4 + len).toString("latin1") : "unknown";
}
