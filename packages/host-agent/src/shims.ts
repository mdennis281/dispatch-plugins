/**
 * The commands a chat shell gets in front of its PATH: `dispatch-elevate`,
 * and `sudo`, which hands its command to it.
 *
 * The agent's account has no sudo password and must never get one (design:
 * the approval gate is enforced off the machine). The machine's own `sudo`
 * would only stop at "a terminal is required to read the password", or hang
 * at a prompt nobody sees. So `sudo <cmd>` in a chat shell, and in any script
 * it runs, asks the user instead: `dispatch-elevate` sends the request up the
 * session's channel, Dispatch shows it for approval, and only then runs it as
 * root over a separate login the agent has no key for.
 *
 * A PATH shim, not a shell function: a script the agent runs (`./install.sh`
 * calling `sudo`) gets it too. Only `/usr/bin/sudo` by full path skips it, and
 * that one has no password to use.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { sq } from "./install.js";

/** `dispatch-elevate`: run `dispatch-host elevate` with the pinned Node. */
export function elevateShim(node: string, script: string): string {
  return [
    "#!/bin/sh",
    "# Run a command as root on this machine once the user approves it in Dispatch.",
    "# Usage: dispatch-elevate <command> [args...]",
    `exec ${sq(node)} ${sq(script)} elevate "$@"`,
    "",
  ].join("\n");
}

/**
 * `sudo`, as far as it can be honoured: every command is approved on its own,
 * runs as root, with root's environment, in the current directory. Options
 * that ask for something else are refused with the reason, never ignored:
 * a script that asked for another user must not quietly get root.
 */
export function sudoShim(elevate: string): string {
  return [
    "#!/bin/bash",
    "# sudo in a Dispatch chat shell: the command goes to dispatch-elevate, which asks",
    "# the user to approve it. No password is ever asked for or kept here.",
    "me=sudo",
    'refuse() { printf "%s: %s\\n" "$me" "$1" >&2; exit 1; }',
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    "    --) shift; break ;;",
    "    -v|--validate) echo \"$me: nothing to validate here: each command is approved by the user on its own\" >&2; exit 0 ;;",
    "    -k|-K|--reset-timestamp|--remove-timestamp) exit 0 ;;",
    "    -n|--non-interactive) refuse \"-n: every command here needs the user's approval, which -n rules out\" ;;",
    '    -u|--user) [ "${2:-}" = root ] || [ "${2:-}" = 0 ] || [ "${2:-}" = "#0" ] || refuse "-u ${2:-}: only root is possible here"; shift 2 ;;',
    '    -uroot|--user=root) shift ;;',
    "    -E|--preserve-env|--preserve-env=*) refuse \"$1: the command runs with root's own environment; set what it needs on its command line (env NAME=value cmd)\" ;;",
    "    -s|--shell|-i|--login) refuse \"$1: no interactive root shell here; pass the command itself\" ;;",
    "    -S|--stdin|-A|--askpass) refuse \"$1: there is no password to give; the user approves each command in Dispatch\" ;;",
    "    -b|--background) refuse \"$1: run it in the background yourself (with &)\" ;;",
    '    -*) refuse "$1: not supported here; run sudo <command>, or dispatch-elevate <command>" ;;',
    "    *) break ;;",
    "  esac",
    "done",
    '[ $# -gt 0 ] || refuse "usage: sudo <command> [args...] (the user approves it in Dispatch)"',
    `exec ${sq(elevate)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Write the shims into `binDir` (next to the agent build that uses them),
 * each atomically and only when its content changed: every session's owner
 * calls this at start, several at once.
 */
export function ensureShims(binDir: string, node: string, script: string): void {
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const elevate = posix.join(binDir, "dispatch-elevate");
  write(elevate, elevateShim(node, script));
  write(posix.join(binDir, "sudo"), sudoShim(elevate));
}

function write(file: string, content: string): void {
  try {
    if (readFileSync(file, "utf8") === content) return;
  } catch {
    /* not there yet */
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o755 });
  renameSync(tmp, file);
}
