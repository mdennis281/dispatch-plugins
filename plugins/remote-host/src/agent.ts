/**
 * What gets installed on a machine: dispatch-host itself (inlined in this
 * plugin's bundle at build time) and the pinned Node it runs on (downloaded
 * from nodejs.org on first need, checked against the pinned SHA-256, and kept
 * in a local cache).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AGENT_VERSION, nodeTarball, type NodeTarball } from "@dispatch-plugins/host-agent";
import agentSource from "@dispatch-plugins/host-agent/dist/dispatch-host.mjs?raw";

export interface AgentBundle {
  version: string;
  source: string;
  sha256: string;
}

let bundled: AgentBundle | undefined;

/** The dispatch-host build this plugin carries. */
export function bundledAgent(): AgentBundle {
  bundled ??= { version: AGENT_VERSION, source: agentSource, sha256: sha256(Buffer.from(agentSource, "utf8")) };
  return bundled;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Where the Node tarball for a host comes from. */
export interface RuntimeSource {
  /** A local file holding the verified tarball for `platform`/`arch` (as `uname` prints them). */
  tarball(platform: string, arch: string, signal?: AbortSignal): Promise<{ path: string; tarball: NodeTarball }>;
}

/**
 * Download once, verify, keep. The cache lives in the OS temp dir: losing it
 * costs one download. A file whose checksum doesn't match is never used.
 */
export function nodejsOrgRuntime(opts: { cacheDir?: string; fetch?: typeof fetch } = {}): RuntimeSource {
  const dir = opts.cacheDir ?? join(tmpdir(), "dispatch-remote-host");
  const get = opts.fetch ?? fetch;
  const inFlight = new Map<string, Promise<string>>();

  async function verified(path: string, want: string): Promise<boolean> {
    try {
      await stat(path);
      return sha256(await readFile(path)) === want;
    } catch {
      return false;
    }
  }

  async function download(t: NodeTarball, signal?: AbortSignal): Promise<string> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, t.file);
    if (await verified(path, t.sha256)) return path;
    const part = `${path}.${process.pid}.part`;
    try {
      const res = await get(t.url, signal ? { signal } : {});
      if (!res.ok || !res.body) throw new Error(`GET ${t.url}: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(part));
      const got = sha256(await readFile(part));
      if (got !== t.sha256) throw new Error(`${t.file} from nodejs.org has SHA-256 ${got}, not the pinned ${t.sha256}`);
      await rename(part, path);
      return path;
    } finally {
      await rm(part, { force: true });
    }
  }

  return {
    async tarball(platform, arch, signal) {
      const t = nodeTarball(platform, arch);
      let p = inFlight.get(t.file);
      if (!p) {
        p = download(t, signal).finally(() => inFlight.delete(t.file));
        inFlight.set(t.file, p);
      }
      return { path: await p, tarball: t };
    },
  };
}
