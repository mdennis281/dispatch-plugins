/**
 * The line a paired machine keeps in `~/.ssh/authorized_keys`, and the
 * scripts that add and remove it.
 *
 * The key may do exactly what Dispatch needs and nothing else:
 * - `restrict`: no pty, agent or X11 forwarding, no `~/.ssh/rc`;
 * - `port-forwarding` + `permitopen="127.0.0.1:*"` + `permitopen="[::1]:*"`:
 *   local forwards, to the machine's own loopback only (a dev server it runs).
 *   Both loopbacks, because Vite's `localhost` on macOS binds only `[::1]`;
 *   sshd matches the address literally, so a dev server there needs the v6 one;
 * - `from=`: only from the Dispatch computer's addresses.
 *
 * Dispatch never asks for a reverse forward; letting one in is a later,
 * opt-in feature (design §2.8).
 */
import { sq } from "@dispatch-plugins/host-agent";
import { validFrom } from "./hosts.js";

export function authorizedKeysLine(publicKey: string, allowFrom: readonly string[]): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !/^ssh-[a-z0-9-]+$/.test(parts[0]!) || !/^[A-Za-z0-9+/=]+$/.test(parts[1]!)) {
    throw new Error("not an OpenSSH public key");
  }
  if (!allowFrom.length) throw new Error("the key needs at least one address it may be used from");
  for (const a of allowFrom) if (!validFrom(a)) throw new Error(`not an address pattern: ${JSON.stringify(a)}`);
  return `restrict,port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",from="${allowFrom.join(",")}" ${parts.join(" ")}`;
}

/** The base64 key blob in an authorized_keys line or a public key line. */
export function keyBlobOf(line: string): string {
  const m = line.match(/(?:^|\s)ssh-[a-z0-9-]+\s+([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error("no public key in the line");
  return m[1]!;
}

/**
 * Append `line` to the account's authorized_keys, creating `~/.ssh` with the
 * modes sshd insists on. Safe to run twice (it won't add the line again),
 * under zsh or sh, and it never `exit`s, so it can be pasted into a terminal.
 * Prints `added` or `present`.
 */
export function addKeyScript(line: string): string {
  if (line.includes("'") || /[\r\n]/.test(line)) throw new Error("refusing to quote an authorized_keys line with ' or a newline in it");
  return [
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    'F="$HOME/.ssh/authorized_keys"',
    `if [ -f "$F" ] && grep -qF ${sq(keyBlobOf(line))} "$F"; then echo present; else`,
    // A last line with no newline would swallow ours.
    '  if [ -s "$F" ] && [ -n "$(tail -c 1 "$F")" ]; then echo >> "$F"; fi',
    `  printf '%s\\n' ${sq(line)} >> "$F"`,
    '  chmod 600 "$F"',
    "  echo added",
    "fi",
  ].join("\n");
}

/**
 * What a human pastes on the machine, as the paired account, instead of
 * typing its password into Dispatch: {@link addKeyScript} on one line, in a
 * subshell so its umask doesn't stay behind in their terminal.
 */
export function addKeyOneLiner(line: string): string {
  const body = addKeyScript(line)
    .split("\n")
    .map((l) => l.trim())
    .join("; ")
    .replace(/; else; /g, "; else ");
  return `( ${body} )`;
}

/**
 * Remove every line holding `publicKeyBlob` (the base64 part) from the
 * account's authorized_keys. A grep that fails leaves the file untouched.
 * Prints `removed` or `absent`.
 */
export function removeKeyScript(publicKeyBlob: string): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(publicKeyBlob)) throw new Error("not a public key blob");
  return [
    'F="$HOME/.ssh/authorized_keys"',
    `if [ ! -f "$F" ] || ! grep -qF ${sq(publicKeyBlob)} "$F"; then echo absent; exit 0; fi`,
    'T="$F.dispatch.$$"',
    `grep -vF ${sq(publicKeyBlob)} "$F" > "$T"`,
    // 0 = lines kept, 1 = none kept (the key was the only line); 2+ = an error.
    'rc=$?; if [ "$rc" -gt 1 ]; then rm -f "$T"; echo "could not filter $F" >&2; exit 1; fi',
    'chmod 600 "$T" && mv "$T" "$F"',
    "echo removed",
  ].join("\n");
}
