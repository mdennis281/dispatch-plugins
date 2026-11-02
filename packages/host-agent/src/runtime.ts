/**
 * The Node that runs `dispatch-host` on a host, and how versions move.
 *
 * - **Pinned, checksummed.** The plugin downloads the official tarball from
 *   nodejs.org, checks it against the SHA-256 below (copied from that
 *   release's SHASUMS256.txt), and streams it to the host over SSH exec stdin,
 *   where it is checked again. Bytes that arrive through a pipe carry no
 *   quarantine attribute, so Gatekeeper never prompts.
 * - **One FIXED path**, `~/.dispatch-host/runtime/node/bin/node`, replaced by
 *   rename. A versioned path, or Homebrew's node, changes the identity macOS
 *   attaches permission grants to, so the grants would silently drop.
 *   Replacing the file in place would also kill a running owner: macOS checks
 *   code pages against the signature. A rename leaves running processes on
 *   the old inode.
 * - **Never downgraded.** Stable and dev share the host but may run different
 *   plugin builds. Whichever pinned the newer runtime wins, and the other
 *   keeps using it. Node keeps backward compatibility within a major line,
 *   and the agent targets the oldest pin.
 * - **Agents side by side**, at `agent/<version>/`, each invoked by its own
 *   path. Installing one never touches another, so neither instance can
 *   downgrade the other's agent or kill its sessions.
 */

export interface NodeDist {
  /** e.g. `24.22.2`. */
  version: string;
  /** SHA-256 of `node-v<version>-<platform>-<arch>.tar.gz`, per `<platform>-<arch>`. */
  sha256: Readonly<Record<string, string>>;
}

/** Node 24 LTS ("Krypton"), released 2026-10-27. From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt. */
export const NODE_RUNTIME: NodeDist = {
  version: "24.22.2",
  sha256: {
    "darwin-arm64": "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
    "darwin-x64": "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
    "linux-arm64": "95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2",
    "linux-x64": "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
  },
};

export interface NodeTarball {
  url: string;
  file: string;
  /** The directory the tarball unpacks to. */
  dir: string;
  sha256: string;
  version: string;
}

/**
 * The tarball for a host. `platform` and `arch` are what `uname -s` / `uname -m`
 * print (`Darwin`, `arm64`, `x86_64`, `aarch64`) or Node's own spelling.
 */
export function nodeTarball(platform: string, arch: string, dist: NodeDist = NODE_RUNTIME): NodeTarball {
  const os = platform.toLowerCase();
  const p = os === "darwin" ? "darwin" : os === "linux" ? "linux" : undefined;
  const a = ({ arm64: "arm64", aarch64: "arm64", x86_64: "x64", amd64: "x64", x64: "x64" } as Record<string, string>)[arch.toLowerCase()];
  const key = p && a ? `${p}-${a}` : undefined;
  const sha256 = key ? dist.sha256[key] : undefined;
  if (!key || !sha256) throw new Error(`no pinned Node for ${platform}/${arch}`);
  const dir = `node-v${dist.version}-${key}`;
  return { url: `https://nodejs.org/dist/v${dist.version}/${dir}.tar.gz`, file: `${dir}.tar.gz`, dir, sha256, version: dist.version };
}

/** Compare dotted numeric versions (`v` prefix and pre-release suffix ignored). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => Number(n) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * What to do about the host's runtime. `installed` is `node --version` from
 * the fixed path, or undefined when there is none.
 */
export function runtimeAction(installed: string | undefined, pinned: string = NODE_RUNTIME.version): "install" | "upgrade" | "keep" {
  if (!installed) return "install";
  return compareVersions(installed, pinned) < 0 ? "upgrade" : "keep";
}
