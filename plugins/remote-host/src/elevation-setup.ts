/**
 * Turning elevation on for a machine, and off again: the machine's side of
 * elevation.ts.
 *
 * On, from the Settings pane, in two calls:
 * 1. **start**: mint the machine's elevation key, and hand back the setup
 *    command (elevate-setup.sh), which the user runs at the machine once,
 *    with sudo. The private key waits here, in memory, for 2 hours.
 * 2. **verify**: log in with that key as the hidden account and run the
 *    helper's `check`, which answers only as root. `uid=0` proves the whole
 *    chain: the account, its forced command, the sudoers rule and the helper.
 *    Only then is the key stored (`REMOTE_HOST_ELEVATE_KEY_<SLUG>`), and
 *    elevation is on.
 *
 * Off (the pane's button, Remove machine, uninstalling the plugin): the
 * helper's `uninstall` over the same login, then the key is deleted here.
 * When the machine can't be reached, the key goes anyway, since nothing here
 * can use it then, and the user gets the command that undoes it by hand.
 *
 * `check` and `uninstall` need no approval card: they are fixed, run nothing
 * of the agent's, and come from the user's own button. The pane has no chat
 * to show a card in anyway.
 */
import { gzipSync } from "node:zlib";
import { hostname } from "node:os";
import { sq } from "@dispatch-plugins/host-agent";
import { errText, generateKeyPair } from "@dispatch-plugins/remote-core";
import helperTemplate from "./elevate-helper.sh?raw";
import setupTemplate from "./elevate-setup.sh?raw";
import { ELEVATE_USER, ElevationLoginError, HELPER_PATH, type Elevation } from "./elevation.js";
import { validFrom, type HostConfig } from "./hosts.js";
import { UserError, safeName } from "./pairing.js";

/** The helper's own version, which `check` prints. Raise it when the helper changes. */
export const HELPER_VERSION = "1";

/** Where everything goes on the machine. Tests point these at a scratch directory. */
export interface HelperPaths {
  helper: string;
  account: string;
  home: string;
  sudoers: string;
  log: string;
  sudo: string;
  dscl: string;
  /** The uid the helper's root half insists on: 0, except in tests (which can't be root). */
  rootUid: number;
}

export const MAC_PATHS: HelperPaths = {
  helper: HELPER_PATH,
  account: ELEVATE_USER,
  home: "/private/var/dispatch-elevate",
  sudoers: "/etc/sudoers.d/dispatch-elevate",
  log: "/var/log/dispatch-elevate.log",
  sudo: "/usr/bin/sudo",
  dscl: "/usr/bin/dscl",
  rootUid: 0,
};

/** What the user runs by hand to take it all out when Dispatch can't. */
export const MANUAL_UNINSTALL = `sudo ${MAC_PATHS.helper} uninstall`;

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const HELPER_END = "DISPATCH_ELEVATE_HELPER_EOF";

function checkPaths(p: HelperPaths): void {
  for (const k of ["helper", "home", "sudoers", "log", "sudo", "dscl"] as const) {
    if (!SAFE_PATH.test(p[k]) || p[k].includes("..")) throw new Error(`not a usable path for ${k}: ${p[k]}`);
  }
  // Two levels at least: uninstall deletes the home directory.
  if (!/^\/[^/]+\/[^/]+/.test(p.home)) throw new Error(`the elevation account's home must be deeper than ${p.home}`);
  if (!/^_?[a-z][a-z0-9_]{0,30}$/.test(p.account)) throw new Error(`not a usable account name: ${p.account}`);
  if (!Number.isInteger(p.rootUid) || p.rootUid < 0) throw new Error("rootUid must be a uid");
}

/** Fill `@NAME@` placeholders; one that has no value is an error, never left in. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/@([A-Z_]+)@/g, (m, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`no value for ${m}`);
    return v;
  });
}

/** The root helper, as installed on the machine (elevate-helper.sh). */
export function helperScript(p: HelperPaths = MAC_PATHS): string {
  checkPaths(p);
  return fill(helperTemplate, {
    HELPER: sq(p.helper),
    VERSION: sq(HELPER_VERSION),
    ACCOUNT: sq(p.account),
    HOME: sq(p.home),
    SUDOERS: sq(p.sudoers),
    LOG: sq(p.log),
    SUDO: sq(p.sudo),
    DSCL: sq(p.dscl),
    ROOT_UID: String(p.rootUid),
  });
}

/**
 * The elevation account's one authorized_keys line: no pty, no forwarding,
 * no rc file (`restrict`), only from this computer's addresses, and whatever
 * the client asks for, only the helper runs (`command=`), which reads the
 * request from SSH_ORIGINAL_COMMAND.
 */
export function elevationKeyLine(publicKey: string, allowFrom: readonly string[], helper = HELPER_PATH): string {
  const parts = publicKey.trim().split(/\s+/);
  if (parts.length < 2 || !/^ssh-[a-z0-9-]+$/.test(parts[0]!) || !/^[A-Za-z0-9+/=]+$/.test(parts[1]!)) {
    throw new Error("not an OpenSSH public key");
  }
  if (!allowFrom.length) throw new Error("the key needs at least one address it may be used from");
  for (const a of allowFrom) if (!validFrom(a)) throw new Error(`not an address pattern: ${JSON.stringify(a)}`);
  if (!SAFE_PATH.test(helper)) throw new Error(`not a usable helper path: ${helper}`);
  return `restrict,command="${helper}",from="${allowFrom.join(",")}" ${parts.join(" ")}`;
}

/** The script the user runs at the machine, with sudo (elevate-setup.sh). */
export function setupScript(slug: string, keyLine: string, p: HelperPaths = MAC_PATHS): string {
  checkPaths(p);
  if (/[\r\n]/.test(keyLine)) throw new Error("an authorized_keys line is one line");
  const helper = helperScript(p).replace(/\n+$/, "");
  // The helper goes in as a quoted here-document: a line equal to its end marker would cut it short.
  if (helper.split("\n").includes(HELPER_END)) throw new Error("the helper contains its own here-document marker");
  return fill(setupTemplate, {
    SLUG: sq(slug),
    ACCOUNT: sq(p.account),
    HOME: sq(p.home),
    HELPER: sq(p.helper),
    SUDOERS: sq(p.sudoers),
    LOG: sq(p.log),
    KEY_LINE: sq(keyLine),
    HELPER_SCRIPT: helper,
  });
}

/**
 * The setup script as one line to paste into Terminal at the machine. It is
 * gzipped and base64'd, since the script itself is long and multi-line. It
 * asks for an administrator's password (sudo) and runs the script as root.
 * `base64 --decode` and `gunzip` are on every macOS.
 */
export function setupOneLiner(script: string): string {
  const b64 = gzipSync(Buffer.from(script, "utf8"), { level: 9 }).toString("base64");
  return `echo ${b64} | base64 --decode | gunzip | sudo /bin/bash -s`;
}

export interface SetupStart {
  /** Paste this at the machine, as an administrator. */
  oneLiner: string;
  /** What the one-liner runs, to read before running it. */
  script: string;
  /** The line it installs for the hidden account. */
  keyLine: string;
  /** Logins with the key are accepted only from these (the machine's pairing `from=` list). */
  allowFrom: string[];
  expiresAt: number;
}

interface Pending {
  privateKey: string;
  expiresAt: number;
}

// Long enough to walk to the machine; the key is in memory only, and the command holds only its public half.
const PENDING_MS = 2 * 60 * 60_000;

/** Elevation keys minted for a setup that hasn't been verified yet, by machine. Memory only. */
export class ElevationSetups {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(private readonly d: { now?: () => number; dispatchName?: string; paths?: HelperPaths } = {}) {
    this.now = d.now ?? Date.now;
  }

  /** Mint a key for `host` (replacing one minted before) and make its setup command. */
  start(host: HostConfig): SetupStart {
    this.expire();
    const kp = generateKeyPair(`dispatch-elevate:${host.slug}@${safeName(this.d.dispatchName ?? hostname())}`);
    const paths = this.d.paths ?? MAC_PATHS;
    const keyLine = elevationKeyLine(kp.publicKey, host.allowFrom, paths.helper);
    const script = setupScript(host.slug, keyLine, paths);
    const expiresAt = this.now() + PENDING_MS;
    this.pending.set(host.slug, { privateKey: kp.privateKey, expiresAt });
    return { oneLiner: setupOneLiner(script), script, keyLine, allowFrom: [...host.allowFrom], expiresAt };
  }

  /** The key a setup for `slug` is waiting with, if any. */
  key(slug: string): string | undefined {
    this.expire();
    return this.pending.get(slug)?.privateKey;
  }

  drop(slug: string): void {
    this.pending.delete(slug);
  }

  clear(): void {
    this.pending.clear();
  }

  private expire(): void {
    const now = this.now();
    for (const [slug, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(slug);
  }
}

/**
 * Log in with `key` and have the helper prove it runs as root. Resolves with
 * the helper's version; rejects with what the user should do next.
 */
export async function verifyElevation(el: Elevation, key: string, label: string, rootUid = 0): Promise<{ version: string }> {
  let r;
  try {
    r = await el.helper("check", key);
  } catch (err) {
    if (err instanceof ElevationLoginError && err.kind === "refused") {
      throw new UserError(
        `${label} doesn't accept the elevation key yet. Run the setup command there (it asks for an administrator's ` +
          `password), wait for "Done", then verify again.`,
      );
    }
    if (err instanceof ElevationLoginError && err.kind === "host-key") throw new UserError(`${errText(err)}; nothing was checked`);
    throw new UserError(`could not check ${label}: ${errText(err)}`, 502);
  }
  const m = r.stdout.match(/^dispatch-elevate (\S+) uid=(\d+)\s*$/m);
  if (r.code !== 0 || !m) {
    const said = (r.stderr || r.stdout).trim().slice(0, 300);
    if (/password is required|not allowed to execute|may not run sudo/i.test(said)) {
      throw new UserError(
        `the elevation account logged in, but sudo on ${label} won't let it run the helper (${said}). Run the setup ` +
          `command again; it reinstalls the sudoers rule.`,
      );
    }
    throw new UserError(`the helper on ${label} didn't answer as expected (exit ${r.code ?? "unknown"})${said ? `: ${said}` : ""}`);
  }
  if (Number(m[2]) !== rootUid) {
    throw new UserError(`the helper on ${label} ran as uid ${m[2]}, not as root, so elevation can't work. Run the setup command again.`);
  }
  return { version: m[1]! };
}

/** What became of elevation on the machine itself when it was turned off. */
export type RemovedThere = "removed" | "not-set-up" | "refused" | "unreachable" | "failed";

/** Turn elevation off on the machine with its own key: the helper's `uninstall`. Never throws. */
export async function removeElevation(el: Elevation): Promise<{ there: RemovedThere; detail?: string }> {
  try {
    const r = await el.helper("uninstall");
    if (r.code === 0 && /^removed/m.test(r.stdout)) return { there: "removed" };
    return { there: "failed", detail: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code ?? "unknown"}` };
  } catch (err) {
    if (/isn't set up/.test(errText(err)) && !(err instanceof ElevationLoginError)) return { there: "not-set-up" };
    if (err instanceof ElevationLoginError) return { there: err.kind === "refused" ? "refused" : "unreachable", detail: errText(err) };
    return { there: "failed", detail: errText(err) };
  }
}
