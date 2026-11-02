/**
 * Installing onto a host: POSIX `sh` scripts the plugin runs over SSH exec,
 * with the payload (Node's tarball, or the agent bundle) on the script's
 * stdin. They run before any agent exists, so they need nothing but `sh`,
 * `tar`, and `shasum` (macOS) or `sha256sum` (Linux).
 *
 * Every install holds `~/.dispatch-host/install.lock`, an atomic `mkdir`.
 * Stable and dev may install at the same moment. A lock older than thirty
 * minutes was left by a dead installer and is broken.
 *
 * Every payload's SHA-256 is checked on the host as well as before sending.
 * Nothing is overwritten in place: new files are written beside the old and
 * renamed over them, so a process running the old one keeps its inode.
 */
import { posix } from "node:path";
import { NODE_RUNTIME, type NodeTarball } from "./runtime.js";

/** Quote one argument for a POSIX shell. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run `script` with /bin/sh, whatever the account's login shell is (zsh on macOS). */
export function shCommand(script: string): string {
  return `/bin/sh -c ${sq(script)}`;
}

/** Exit codes the scripts use beyond 0 and 1. */
export const INSTALL_EXIT = { checksum: 65, locked: 75 } as const;

const SHA_FN = [
  "sha() {",
  "  if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\"; else shasum -a 256 \"$1\"; fi | cut -d' ' -f1",
  "}",
].join("\n");

/** Take the install lock; released on any exit. */
function lock(root: string): string {
  const l = posix.join(root, "install.lock");
  return [
    `L=${sq(l)}`,
    "i=0",
    'while ! mkdir "$L" 2>/dev/null; do',
    // Older than 30 minutes: its installer died holding it. (The runtime upload
    // happens under the lock; 50 MB takes seconds on a LAN, not half an hour.)
    '  if [ -n "$(find "$L" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rm -rf "$L"; continue; fi',
    "  i=$((i+1))",
    `  if [ "$i" -gt 120 ]; then echo "another install holds $L" >&2; exit ${INSTALL_EXIT.locked}; fi`,
    "  sleep 1",
    "done",
    'echo $$ > "$L/pid"',
    "trap 'rm -rf \"$L\"' EXIT",
    "trap 'exit 130' INT TERM HUP",
  ].join("\n");
}

/**
 * Install the pinned Node at `<root>/runtime/node`, unless what is there is
 * the same version or NEWER. Stdin: the tarball. Prints `installed vX` or
 * `kept vY`. The tarball is always read to the end, so the sender's write
 * never fails mid-stream.
 */
export function installRuntimeScript(root: string, t: NodeTarball): string {
  const rt = posix.join(root, "runtime");
  const want = t.version.split(".").map(Number);
  const newer = `const a=process.versions.node.split(".").map(Number),b=${JSON.stringify(want)};` +
    `for(let i=0;i<3;i++){if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1)}`;
  return [
    "set -eu",
    "umask 077",
    SHA_FN,
    `RT=${sq(rt)}`,
    'mkdir -p "$RT"',
    lock(root),
    'N="$RT/node/bin/node"',
    `if [ -x "$N" ] && "$N" -e ${sq(newer)} 2>/dev/null; then`,
    "  cat >/dev/null",
    '  echo "kept $("$N" --version)"',
    "  exit 0",
    "fi",
    'T="$RT/.new.$$"',
    'rm -rf "$T"; mkdir -p "$T"',
    'cat > "$T/node.tar.gz"',
    `if [ "$(sha "$T/node.tar.gz")" != ${sq(t.sha256)} ]; then rm -rf "$T"; echo "node tarball checksum mismatch" >&2; exit ${INSTALL_EXIT.checksum}; fi`,
    'tar -xzf "$T/node.tar.gz" -C "$T"',
    `if [ "$("$T"/${sq(t.dir)}/bin/node --version)" != ${sq(`v${t.version}`)} ]; then rm -rf "$T"; echo "unpacked node is not v${t.version}" >&2; exit ${INSTALL_EXIT.checksum}; fi`,
    // Two renames: a directory can't be renamed over a non-empty one. For the
    // instant between them the path is missing, and a session started in that
    // instant fails to start and is retried by the plugin.
    'if [ -e "$RT/node" ]; then mv "$RT/node" "$RT/.old.$"; fi',
    `mv "$T"/${sq(t.dir)} "$RT/node"`,
    'rm -rf "$T" "$RT/.old.$$"',
    `echo ${sq(`installed v${t.version}`)}`,
  ].join("\n");
}

/** The directory name of an agent build: its version plus a content hash, so two builds never collide. */
export function agentBuildId(version: string, sha256: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not an agent version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("not a SHA-256");
  return `${version}-${sha256.slice(0, 12)}`;
}

/** Where an agent build lives on the host. */
export function agentPath(root: string, version: string, sha256: string): string {
  return posix.join(root, "agent", agentBuildId(version, sha256), "dispatch-host.mjs");
}

/**
 * Install one agent build beside the others. Stdin: the bundle. An intact copy
 * already there is kept; nothing else under `agent/` is touched.
 */
export function installAgentScript(root: string, version: string, sha256: string): string {
  const file = agentPath(root, version, sha256);
  return [
    "set -eu",
    "umask 077",
    SHA_FN,
    `F=${sq(file)}`,
    'mkdir -p "$(dirname "$F")"',
    lock(root),
    `if [ -f "$F" ] && [ "$(sha "$F")" = ${sq(sha256)} ]; then cat >/dev/null; echo "kept"; exit 0; fi`,
    'cat > "$F.tmp.$$"',
    `if [ "$(sha "$F.tmp.$$")" != ${sq(sha256)} ]; then rm -f "$F.tmp.$$"; echo "agent checksum mismatch" >&2; exit ${INSTALL_EXIT.checksum}; fi`,
    'mv "$F.tmp.$$" "$F"',
    'echo "installed"',
  ].join("\n");
}

/** The pinned runtime's path, for invoking an agent: `<node> <agent> <command> …`. */
export function nodePath(root: string): string {
  return posix.join(root, "runtime", "node", "bin", "node");
}

export { NODE_RUNTIME };
