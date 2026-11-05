/**
 * The machine's half of the sync, as `/bin/sh` scripts run over SSH.
 *
 * Layout (host-agent's): one bare repository per local repository and
 * Dispatch instance, `repos/<repoKey>.git`, that every chat's checkout
 * borrows objects from through a RELATIVE `alternates` entry; and the chat's
 * checkout, `chats/<chatId>/<repo>`, a plain repository whose HEAD is the
 * snapshot last checked out. The bare repository holds a ref per chat, so
 * its gc never drops what a checkout stands on.
 *
 * Nothing here forces a file over a change the machine made: checkouts are
 * two-way merges (`read-tree -m -u`) that refuse to overwrite a file the
 * machine changed since, and recording a new base moves only HEAD and the
 * index.
 */
import { posix } from "node:path";
import type { Writable } from "node:stream";
import { chatWorktreePath, repoPath, sq } from "@dispatch-plugins/host-agent";
import type { ExecResult } from "@dispatch-plugins/remote-core";
import { parseRawDiff, type Change } from "./local.js";

/** How the sync reaches the machine. HostLink provides it over SSH; tests run `sh` locally. */
export interface RemoteSide {
  /** Run a `/bin/sh` script; text output. `input` goes to its stdin. */
  run(script: string, opts?: { input?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** Run a `/bin/sh` script with binary stdin and/or stdout. Resolves with its exit code. */
  stream(
    script: string,
    io: { input?: (sink: Writable) => Promise<void>; output?: Writable },
    signal?: AbortSignal,
  ): Promise<{ code: number | null; stderr: string }>;
}

export interface RemotePaths {
  /** The chat's checkout. */
  work: string;
  /** The shared bare repository. */
  repo: string;
  /** `work`'s alternates entry: `repo`'s objects, relative to `work/.git/objects`. */
  alternates: string;
}

export function remotePaths(root: string, instance: string, chatId: string, repoName: string, repoKey: string): RemotePaths {
  const work = chatWorktreePath(root, instance, chatId, repoName);
  const repo = repoPath(root, instance, repoKey);
  return { work, repo, alternates: posix.relative(posix.join(work, ".git", "objects"), posix.join(repo, "objects")) };
}

const PRELUDE = [
  // C: git's messages are matched below, and file names are bytes.
  "export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1",
  "export GIT_AUTHOR_NAME=Dispatch GIT_AUTHOR_EMAIL=dispatch@localhost GIT_COMMITTER_NAME=Dispatch GIT_COMMITTER_EMAIL=dispatch@localhost",
].join("\n");

export type CheckoutStatus =
  | { state: "missing" }
  /** The checkout's directory is there but its `.git` isn't (a command removed it, or it was never made). */
  | { state: "nogit" }
  | {
      state: "ok";
      tree: string;
      head?: string;
      /** The base the machine last recorded (`refs/dispatch/base`), for picking up after Dispatch lost its own record. */
      base?: { commit: string; tree: string };
      /** Against the base asked about; absent when the machine no longer has that base's objects. */
      changes?: Change[];
      sizes: Map<string, number>;
    };

/**
 * What the checkout holds now, as a tree (a temp index and `add -A`, so the
 * real index is untouched), and how that differs from `baseTree`, with the
 * size of every new blob.
 */
export async function checkoutStatus(remote: RemoteSide, p: RemotePaths, baseTree?: string): Promise<CheckoutStatus> {
  const script = [
    PRELUDE,
    `W=${sq(p.work)}; B=${sq(baseTree ?? "")}`,
    `cd "$W" 2>/dev/null || { echo missing; exit 0; }`,
    `[ -d .git ] || { echo nogit; exit 0; }`,
    `I=.git/dispatch-status.$$`,
    // -p: the copy keeps the index's mtime, which git's racy check needs (see remote-core's copyIndex).
    `cp -p .git/index "$I" 2>/dev/null || rm -f "$I"`,
    // A file there that can't be read (exit 1) is left as the base has it, so
    // it reads as unchanged; it never stops the rest from syncing.
    `GIT_INDEX_FILE=$I git add -A --ignore-errors >/dev/null 2>&1; rc=$?`,
    `if [ "$rc" -gt 1 ]; then rm -f "$I"; echo "git add -A failed (exit $rc)" >&2; exit 3; fi`,
    `T=$(GIT_INDEX_FILE=$I git write-tree) || { rm -f "$I"; exit 3; }`,
    `echo "tree $T"`,
    // HEAD, the base and its tree in one git process: this runs before and
    // after every command. A name that isn't there, or names an object the
    // checkout can't read, comes back "<name> missing", which matches no
    // sha below: a HEAD like that counts as none, and the checkout is
    // rebuilt on the base (a checkout over it would fail).
    `printf '%s\\n' HEAD refs/dispatch/base 'refs/dispatch/base^{tree}' | git cat-file --batch-check='%(objectname)' > "$I" 2>/dev/null`,
    `{ read -r h; read -r b; read -r bt; } < "$I"`,
    `rm -f "$I"`,
    `echo "head $h"`,
    `echo "base $b $bt"`,
    `if [ -n "$B" ] && [ "$T" != "$B" ]; then`,
    `  git cat-file -e "$B^{tree}" 2>/dev/null || { echo nobase; exit 0; }`,
    `  echo sizes`,
    `  git diff-tree -r --no-renames "$B" "$T" | awk '$2 != "160000" && $4 != "0000000000000000000000000000000000000000" {print $4}' | sort -u | git cat-file --batch-check='%(objectname) %(objectsize)'`,
    `  echo diff`,
    `  git diff-tree -r -z --no-renames "$B" "$T"`,
    `fi`,
  ].join("\n");
  const r = await remote.run(script, { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`reading the checkout failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  const out = r.stdout;
  if (/^missing\s*$/.test(out)) return { state: "missing" };
  if (/^nogit\s*$/.test(out)) return { state: "nogit" };
  const tree = out.match(/^tree ([0-9a-f]{40})$/m)?.[1];
  if (!tree) throw new Error(`reading the checkout failed: unexpected answer ${JSON.stringify(out.slice(0, 120))}`);
  const head = out.match(/^head ([0-9a-f]{40})$/m)?.[1];
  const b = out.match(/^base ([0-9a-f]{40}) ([0-9a-f]{40})$/m);
  const known = { state: "ok" as const, tree, ...(head ? { head } : {}), ...(b ? { base: { commit: b[1]!, tree: b[2]! } } : {}) };
  const sizes = new Map<string, number>();
  if (/^nobase$/m.test(out)) return { ...known, sizes };
  const at = out.indexOf("\ndiff\n");
  if (at < 0) return { ...known, changes: [], sizes };
  for (const m of out.slice(0, at).matchAll(/^([0-9a-f]{40}) (\d+)$/gm)) sizes.set(m[1]!, Number(m[2]));
  return { ...known, changes: parseRawDiff(out.slice(at + "\ndiff\n".length)), sizes };
}

/** Make the shared repository and the chat's checkout, if they aren't there. Idempotent. */
export async function initCheckout(remote: RemoteSide, p: RemotePaths): Promise<void> {
  const script = [
    PRELUDE,
    "set -e",
    `R=${sq(p.repo)}; W=${sq(p.work)}; A=${sq(p.alternates)}`,
    `if [ ! -d "$R/objects" ]; then mkdir -p "$R"; git init -q --bare "$R"; git --git-dir="$R" config gc.auto 0; fi`,
    `mkdir -p "$W"; cd "$W"`,
    `if [ ! -d .git ]; then git init -q .; git config core.autocrlf false; git config gc.auto 0; fi`,
    `mkdir -p .git/objects/info`,
    `printf '%s\\n' "$A" > .git/objects/info/alternates`,
  ].join("\n");
  const r = await remote.run(script, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`setting up the checkout failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** Which of `shas` the checkout can't see. */
export async function missingObjects(remote: RemoteSide, p: RemotePaths, shas: readonly string[]): Promise<string[]> {
  if (!shas.length) return [];
  const script = [`cd ${sq(p.work)} || exit 1`, `git cat-file --batch-check | awk '$2 == "missing" {print $1}'`].join("\n");
  const r = await remote.run(script, { input: shas.join("\n") + "\n", timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`asking the machine what it has failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l));
}

/** A pack, from `fill`, into the shared repository. */
export async function receiveObjects(
  remote: RemoteSide,
  p: RemotePaths,
  fill: (sink: Writable) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const r = await remote.stream(`git --git-dir=${sq(p.repo)} index-pack --stdin >/dev/null`, { input: fill }, signal);
  if (r.code !== 0) throw new Error(`the machine could not take the files: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** A pack of everything `commit` holds (its tree, whole), from the checkout, into `sink`. */
export async function sendCommit(remote: RemoteSide, p: RemotePaths, commit: string, sink: Writable, signal?: AbortSignal): Promise<void> {
  const r = await remote.stream(`cd ${sq(p.work)} && echo ${sq(commit)} | git pack-objects --revs --stdout -q`, { output: sink }, signal);
  if (r.code !== 0) throw new Error(`fetching the last synced snapshot failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** A pack of exactly `shas`, from the checkout, into `sink`. */
export async function sendObjects(remote: RemoteSide, p: RemotePaths, shas: readonly string[], sink: Writable, signal?: AbortSignal): Promise<void> {
  const list = shas.join("\n") + "\n";
  const r = await remote.stream(
    `cd ${sq(p.work)} && git pack-objects --stdout -q`,
    {
      input: async (s) => {
        await new Promise<void>((res, rej) => s.end(list, (err?: Error | null) => (err ? rej(err) : res())));
      },
      output: sink,
    },
    signal,
  );
  if (r.code !== 0) throw new Error(`fetching the machine's changes failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/**
 * Check `commit` out in the chat's checkout. A first checkout writes
 * everything, once no file it would write is there already (`ClashError`
 * names those). After that it is a two-way merge from HEAD, which refuses (and
 * says which file) rather than overwrite a change the machine made since the
 * last look: the command then doesn't run, and the next sync brings that
 * change back first.
 */
export async function checkoutCommit(remote: RemoteSide, p: RemotePaths, chatId: string, commit: string, expectHead = false): Promise<void> {
  const script = [
    PRELUDE,
    `R=${sq(p.repo)}; C=${sq(commit)}; cd ${sq(p.work)} || exit 1`,
    `if git rev-parse -q --verify HEAD >/dev/null; then H=1; git update-index -q --refresh >/dev/null 2>&1; else H=; fi`,
    // A checkout that has synced before and lost its HEAD isn't checked out
    // over: the next sync rebuilds it on the base first.
    ...(expectHead ? [`[ -n "$H" ] || exit 7`] : []),
    `git --git-dir="$R" update-ref ${sq(`refs/dispatch/chats/${chatId}`)} "$C" || exit 1`,
    // A path the snapshot adds that is already there, untracked (ignored
    // there, too big to bring back, made since, or there before a first
    // checkout): git would overwrite an ignored one without a word. Name them
    // instead.
    `L=.git/dispatch-added.$$; K=.git/dispatch-clash.$$`,
    `if [ -n "$H" ]; then git diff-tree -r -z --no-renames --diff-filter=A --name-only HEAD "$C"; else git ls-tree -r -z --name-only "$C"; fi > "$L" || { rm -f "$L"; exit 1; }`,
    `xargs -0 sh -c ${sq(CLASHES)} sh < "$L" > "$K" || { rm -f "$L" "$K"; exit 1; }`,
    `rm -f "$L"`,
    `if [ -s "$K" ]; then cat "$K"; rm -f "$K"; exit 5; fi`,
    `rm -f "$K"`,
    `if [ -n "$H" ]; then`,
    `  E=.git/dispatch-rt.$$`,
    `  if ! git read-tree -m -u HEAD "$C" 2>"$E"; then`,
    `    cat "$E" >&2`,
    `    if grep -q 'not uptodate' "$E"; then rm -f "$E"; exit 4; fi`,
    `    rm -f "$E"; exit 6`,
    `  fi`,
    `  rm -f "$E"`,
    `  git update-ref --no-deref HEAD "$C" || exit 1`,
    `else`,
    `  git checkout -q --force --detach "$C" || exit 1`,
    `fi`,
    `git update-ref refs/dispatch/base "$C"`,
  ].join("\n");
  const r = await remote.run(script, { timeoutMs: 10 * 60_000 });
  if (r.code === 5) throw new ClashError(r.stdout.split("\0").filter((s) => s.startsWith("clash ")).map((s) => s.slice("clash ".length)));
  if (r.code === 4) throw new StaleError(r.stderr.match(/Entry '([^']+)'/)?.[1]);
  if (r.code === 7) throw new Error("the machine's checkout has lost its last sync (no HEAD); it is rebuilt before the next command");
  if (r.code !== 0) throw new Error(`checking your files out on the machine failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/**
 * For `xargs -0 sh -c`: which of the paths given are already there. A
 * directory the snapshot turns into a file is no clash (git replaces it)
 * unless it holds something untracked.
 */
const CLASHES = [
  `for f; do`,
  `  if [ -e "$f" ] || [ -L "$f" ]; then`,
  `    if [ -d "$f" ] && [ ! -L "$f" ] && git cat-file -e "HEAD:$f" 2>/dev/null && [ -z "$(git ls-files -o -- ":(literal)$f" | head -n 1)" ]; then continue; fi`,
  `    printf 'clash %s\\0' "$f"`,
  `  fi`,
  `done`,
].join("\n");

/** A file the push would change had changed on the machine since the last look. */
export class StaleError extends Error {
  constructor(readonly file: string | undefined) {
    super(
      `${file ? `\`${file}\`` : "a file"} changed on the machine while your files were being sent, so nothing was overwritten. ` +
        `Run the command again: the change comes back first.`,
    );
  }
}

/** Files the snapshot adds are already on the machine, outside the sync. */
export class ClashError extends Error {
  constructor(readonly paths: string[]) {
    super(`already on the machine, outside the sync: ${paths.join(", ")}`);
  }
}

/** What the machine holds at each of `paths`, outside the sync: a blob (kept in the checkout), or why not. */
export async function hashThere(
  remote: RemoteSide,
  p: RemotePaths,
  paths: readonly string[],
): Promise<Map<string, ({ size: number } & { mode: string; sha: string }) | "dir" | "other">> {
  const each = [
    `for f; do`,
    `  if [ -L "$f" ]; then printf 'other %s\\0' "$f"`,
    `  elif [ -d "$f" ]; then printf 'dir %s\\0' "$f"`,
    `  elif [ -f "$f" ]; then`,
    `    s=$(git hash-object -w -- "$f") || exit 1`,
    `    if [ -x "$f" ]; then m=100755; else m=100644; fi`,
    `    printf 'file %s %s %s %s\\0' "$m" "$s" "$(wc -c < "$f" | tr -d ' ')" "$f"`,
    `  else printf 'other %s\\0' "$f"; fi`,
    `done`,
  ].join("\n");
  const script = [PRELUDE, `cd ${sq(p.work)} || exit 1`, `xargs -0 sh -c ${sq(each)} sh`].join("\n");
  const r = await remote.run(script, { input: paths.join("\0") + "\0", timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`reading files on the machine failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  const out = new Map<string, ({ size: number } & { mode: string; sha: string }) | "dir" | "other">();
  for (const item of r.stdout.split("\0")) {
    const f = item.match(/^file (\d{6}) ([0-9a-f]{40}) (\d+) ([\s\S]*)$/);
    if (f) out.set(f[4]!, { mode: f[1]!, sha: f[2]!, size: Number(f[3]) });
    const o = item.match(/^(dir|other) ([\s\S]*)$/);
    if (o) out.set(o[2]!, o[1] as "dir" | "other");
  }
  return out;
}

/**
 * Record `commit` as the base: HEAD and the index move, the files don't (the
 * machine already has them; they are what was just brought back).
 */
export async function setBase(remote: RemoteSide, p: RemotePaths, chatId: string, commit: string): Promise<void> {
  const script = [
    PRELUDE,
    `R=${sq(p.repo)}; C=${sq(commit)}; cd ${sq(p.work)} || exit 1`,
    `git --git-dir="$R" update-ref ${sq(`refs/dispatch/chats/${chatId}`)} "$C" || exit 1`,
    `if git rev-parse -q --verify HEAD >/dev/null; then git read-tree -m HEAD "$C" || git read-tree "$C" || exit 1; else git read-tree "$C" || exit 1; fi`,
    `git update-ref --no-deref HEAD "$C" || exit 1`,
    `git update-ref refs/dispatch/base "$C"`,
    `git update-index -q --refresh >/dev/null 2>&1 || true`,
  ].join("\n");
  const r = await remote.run(script, { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`recording the sync on the machine failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}
