/**
 * A chat's checkouts on its remote machine, one per local repository root.
 *
 * The machine holds its OWN git checkout of the chat's code. Before every
 * command the chat's local worktree is snapshotted (see snapshot.ts) and
 * pushed over SSH as a git pack, then checked out there. So the agent edits
 * locally and never pushes to GitHub to test, no GitHub token goes near the
 * machine, and ignored directories (node_modules, build output) stay put on
 * the machine between commands.
 */
import { basename } from "node:path";
import type { TerminalBackendHandle } from "@dispatch/plugin-sdk";
import type { SshConnection } from "../ssh/connection.js";
import { sq } from "../shell/quote.js";
import { localHas, pack, snapshot } from "./snapshot.js";

interface RepoEntry {
  /** Where the checkout lives on the machine. */
  remote: string;
  /** The snapshot last checked out there. */
  lastSynced?: string;
  seeded?: Promise<void>;
  /** The connection `seeded` checked the checkout on. */
  on?: SshConnection;
}

export interface RemoteCheckoutsOptions {
  /** The chat's live connection, if it has one. */
  conn: () => SshConnection | undefined;
  /** The directory the checkouts go under, e.g. `/root/work`. Read at each seed. */
  workDir: () => string;
  /** Names the plugin in what is written on a terminal's stderr, e.g. `proxmox-terminal`. */
  label: string;
}

export class RemoteCheckouts {
  private readonly repos = new Map<string, RepoEntry>();
  /** Serialises syncs: several shells in one chat share one checkout. */
  private syncChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: RemoteCheckoutsOptions) {}

  /**
   * The machine's copy of a local repo: seeded once, from GitHub when the
   * repo's origin is a public GitHub repo (shallow, so the first pack is just
   * the local delta), otherwise an empty repo the first pack fills.
   *
   * Checked again on every new connection. A connection after a drop may
   * reach a different disk (a machine re-provisioned for the chat, or wiped),
   * and what this process remembers — that the checkout exists, which
   * snapshot it holds — is only true of the old one. Trusting it skipped the
   * seed and the sync, and the next shell started in a directory that wasn't
   * there.
   */
  ensure(root: string, local: { branch?: string; originUrl?: string }): Promise<{ remote: string }> {
    const conn = this.opts.conn()!;
    const existing = this.repos.get(root);
    if (existing?.seeded && existing.on === conn) return existing.seeded.then(() => existing);
    const remote = existing?.remote ?? `${this.opts.workDir()}/${safeName(basename(root))}`;
    const entry: RepoEntry = existing ?? { remote };
    entry.on = conn;
    this.repos.set(root, entry);
    entry.seeded = (async () => {
      const [mark, head] = (await conn.exec(`test -d ${sq(remote)}/.git && echo yes && git -C ${sq(remote)} rev-parse -q --verify HEAD`)).stdout
        .trim()
        .split(/\s+/);
      // Not the snapshot this process last checked out there: send it again.
      if (entry.lastSynced && head !== entry.lastSynced) entry.lastSynced = undefined;
      if (mark === "yes") return;
      const https = githubHttps(local.originUrl);
      if (https) {
        const branchArg = local.branch ? `--branch ${sq(local.branch)} ` : "";
        const r = await conn.exec(
          `mkdir -p ${sq(this.opts.workDir())} && GIT_TERMINAL_PROMPT=0 git clone -q --depth 50 --single-branch ${branchArg}${sq(https)} ${sq(remote)}`,
          { timeoutMs: 300_000 },
        );
        // A branch that exists only locally (or a private repo) can't come from
        // GitHub: fall back to the default branch, then to an empty repo.
        if (r.code !== 0 && local.branch) {
          await conn.exec(`rm -rf ${sq(remote)}`);
          await conn.exec(`GIT_TERMINAL_PROMPT=0 git clone -q --depth 50 ${sq(https)} ${sq(remote)}`, { timeoutMs: 300_000 });
        }
      }
      await conn.run(`mkdir -p ${sq(remote)} && cd ${sq(remote)} && (test -d .git || git init -q)`);
    })().catch((err: unknown) => {
      this.repos.delete(root);
      throw err;
    });
    return entry.seeded.then(() => entry);
  }

  /**
   * Bring the machine's checkout to the local worktree's current state.
   * Cheap when nothing changed: the snapshot sha is stable, and an unchanged
   * one is a no-op.
   */
  sync(root: string): Promise<void> {
    const run = this.syncChain.then(async () => {
      const entry = this.repos.get(root);
      const conn = this.opts.conn();
      if (!entry || !conn?.isOpen) return;
      const snap = await snapshot(root);
      if (snap === entry.lastSynced) return;
      const remote = sq(entry.remote);
      // Everything the machine already has, as candidate exclusions — any of
      // it the local repo also has keeps the pack down to the delta.
      const refs = await conn.exec(`cd ${remote} && git for-each-ref --format='%(objectname)' && git rev-parse -q --verify HEAD`);
      const exclude = await localHas(root, [...new Set(refs.stdout.split(/\s+/).filter(Boolean))]);
      const r = await conn.exec(`cd ${remote} && git index-pack --stdin >/dev/null`, {
        stdin: async (ch) => {
          await pack(root, snap, exclude, ch);
        },
        timeoutMs: 600_000,
      });
      if (r.code !== 0) throw new Error(`index-pack on the remote failed: ${r.stderr.trim()}`);
      await conn.run(`cd ${remote} && git update-ref refs/dispatch/snapshot ${snap} && git checkout -q --force --detach ${snap}`);
      entry.lastSynced = snap;
    });
    this.syncChain = run.catch(() => {});
    return run;
  }

  /**
   * Re-sync before every command. Dispatch writes each command and then its
   * sentinel probe as two writes; the probe (`__cm_ec=…`) needs no sync. Writes
   * stay in order on one promise chain. A failed sync is said ON the terminal's
   * stderr and the command still runs, against the last good snapshot — a
   * silent stale checkout would be worse than a visible one.
   */
  syncBeforeEachCommand(root: string, h: TerminalBackendHandle): TerminalBackendHandle {
    let chain: Promise<unknown> = Promise.resolve();
    const stderr = h.stderr as unknown as { emit(e: "data", s: string): void };
    const write = (chunk: string): void => {
      const isProbe = chunk.startsWith("__cm_ec=");
      chain = chain.then(async () => {
        if (!isProbe) {
          await this.sync(root).catch((err: unknown) => {
            stderr.emit(
              "data",
              `[${this.opts.label}] could not sync your local changes (${err instanceof Error ? err.message : String(err)}); ` +
                `this command runs against the last synced snapshot.\n`,
            );
          });
        }
        h.stdin.write(chunk);
      });
    };
    return {
      stdin: { write, end: () => void chain.then(() => h.stdin.end?.()), on: (e, l) => h.stdin.on?.(e, l) },
      stdout: h.stdout,
      stderr: h.stderr,
      kill: (sig) => h.kill(sig),
      on: ((e: "exit" | "error", l: (arg: never) => void) => h.on(e as "exit", l as (c: number | null) => void)) as TerminalBackendHandle["on"],
      cwd: h.cwd,
    };
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
}

/** `https://github.com/o/r.git` for a GitHub origin in any of its spellings; undefined otherwise. */
export function githubHttps(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m =
    url.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    url.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : undefined;
}
