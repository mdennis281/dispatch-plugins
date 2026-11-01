#!/usr/bin/env node
/**
 * Copy a Dispatch checkout's `@dispatch/plugin-sdk` into `<repo>/.dispatch-sdk`.
 *
 * `@dispatch/plugin-sdk` is not on npm, so every package here depends on it as
 * `link:../../.dispatch-sdk`: a path INSIDE this checkout, which is the same
 * from the primary checkout, from any git worktree of it, and from CI. This
 * script fills that path. It runs as the root `pnpm:devPreinstall`, so the
 * first `pnpm install` of a checkout makes it before pnpm links anything. A
 * REPEAT install that pnpm finds "Already up to date" skips the hook, so to
 * refresh it, run `pnpm copy-sdk`. The `link:` follows: no reinstall needed.
 *
 * A COPY, never a link. `.dispatch-sdk` was once a junction to the Dispatch
 * checkout, and removing a worktree that held it (`git worktree remove` on
 * Windows walks INTO junctions) deleted the Dispatch checkout's
 * packages/shared and packages/plugin-sdk. Nothing here may point outside the
 * checkout: deleting a worktree must only ever delete the worktree.
 *
 * What is copied, all dereferenced into real files:
 *   .dispatch-sdk/                        the SDK's package.json and dist/
 *   .dispatch-sdk/node_modules/@dispatch/shared/   its package.json and dist/
 *   .dispatch-sdk/node_modules/<pkg>/     what those need to load and to type:
 *                                         shared's dependencies (zod, yaml),
 *                                         @types/react, and their dependencies
 * The SDK and shared must be BUILT in the Dispatch checkout (their dist/).
 * Run `pnpm copy-sdk` after rebuilding them there; the copy does not follow.
 *
 * Which Dispatch checkout, first match wins. Any checkout or git worktree of
 * Dispatch will do, as long as its shared and plugin-sdk are built:
 *   1. `DISPATCH_REPO`, if set. CI sets it.
 *   2. `git config dispatch.repo`. It lives in this repository's shared
 *      `.git/config`, so every worktree sees it and every later copy keeps
 *      using it. An environment variable is gone in the next shell, and the
 *      next copy then silently fell back to (3).
 *   3. A sibling of the PRIMARY checkout named `claude-manager` or `dispatch`.
 *      The primary checkout comes from `git rev-parse --git-common-dir`, so a
 *      worktree finds the same sibling the primary does. That checkout may be
 *      well behind Dispatch's main; the commit copied from is printed.
 * A checkout named by (1) or (2) that has no SDK is an error, not a fallback.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(repoRoot, ".dispatch-sdk");
const SDK = "@dispatch/plugin-sdk";
const SHARED = "@dispatch/shared";
/** Not a runtime dependency of shared, but its declarations import "react". */
const TYPE_ONLY = ["@types/react"];

function fail(message) {
  console.error(`[copy-dispatch-sdk] ${message}`);
  process.exit(1);
}

/** `git <args>` in `cwd`: its trimmed stdout, or undefined when git fails or prints nothing. */
function gitOut(args, cwd = repoRoot) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The directory holding the main `.git`, whichever worktree we are in. */
function primaryCheckout() {
  const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common ? dirname(common) : repoRoot; // not a git checkout (an unpacked tarball): look beside it
}

function manifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** The SDK to copy, and which rule (see the header) found it. */
function findSdk() {
  const [via, named] = process.env.DISPATCH_REPO
    ? ["DISPATCH_REPO", process.env.DISPATCH_REPO]
    : ["git config dispatch.repo", gitOut(["config", "--path", "--get", "dispatch.repo"])];
  if (named) {
    const sdk = resolve(named, "packages", "plugin-sdk");
    if (manifest(sdk)?.name !== SDK) fail(`${via} is ${named}, which has no ${SDK} at packages/plugin-sdk`);
    return { sdk, via };
  }
  const parent = dirname(primaryCheckout());
  const tried = [];
  for (const name of ["claude-manager", "dispatch"]) {
    const sdk = join(parent, name, "packages", "plugin-sdk");
    tried.push(sdk);
    if (manifest(sdk)?.name === SDK) return { sdk, via: `the ${name} checkout beside this repository` };
  }
  fail(
    `no Dispatch checkout found. Clone https://github.com/mdennis281/dispatch beside this repository ` +
      `(looked for ${tried.join(", ")}), or point \`git config dispatch.repo\` or DISPATCH_REPO at one.`,
  );
}

/** Where `name` resolves from package directory `from`, Node's way, as a real path. */
function locate(name, from) {
  const paths = createRequire(join(from, "package.json")).resolve.paths(name) ?? [];
  for (const p of paths) {
    const dir = join(p, name);
    if (existsSync(join(dir, "package.json"))) return realpathSync(dir);
  }
  return undefined;
}

/** Remove `p` without ever following a link out of it. */
function remove(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) unlinkSync(p); // a junction from the old link: drop the link only
  else rmSync(p, { recursive: true, force: true });
}

const found = findSdk();
const sdk = realpathSync(found.sdk);
const shared = locate(SHARED, sdk);
if (!shared) fail(`${SDK} at ${sdk} cannot resolve ${SHARED}; run pnpm install in the Dispatch checkout`);
for (const [name, dir] of [[SDK, sdk], [SHARED, shared]]) {
  if (!existsSync(join(dir, "dist", "index.js"))) {
    fail(`${name} is not built (${dir}). In the Dispatch checkout run: pnpm install && pnpm --filter ${SHARED} --filter ${SDK} build`);
  }
}

const tmp = `${dest}.tmp-${process.pid}`;
remove(tmp);
const copy = (from, to, entries) => {
  mkdirSync(to, { recursive: true });
  for (const e of entries) cpSync(join(from, e), join(to, e), { recursive: true, dereference: true });
};
copy(sdk, tmp, ["package.json", "dist"]);
copy(shared, join(tmp, "node_modules", SHARED), ["package.json", "dist"]);

// Shared's runtime dependencies and the declaration-only ones, then theirs,
// flattened into .dispatch-sdk/node_modules. Each is a whole package.
const queue = [...Object.keys(manifest(shared)?.dependencies ?? {}), ...TYPE_ONLY].map((name) => ({ name, from: shared }));
const copied = new Set();
while (queue.length) {
  const { name, from } = queue.shift();
  if (copied.has(name)) continue;
  const dir = locate(name, from);
  if (!dir) {
    if (TYPE_ONLY.includes(name)) continue; // types only: the typecheck degrades, nothing breaks
    fail(`cannot resolve ${name} (needed by ${from}); run pnpm install in the Dispatch checkout`);
  }
  copied.add(name);
  cpSync(dir, join(tmp, "node_modules", name), {
    recursive: true,
    dereference: true,
    filter: (src) => !/[\\/]node_modules$/.test(src.slice(dir.length)),
  });
  for (const dep of Object.keys(manifest(dir)?.dependencies ?? {})) queue.push({ name: dep, from: dir });
}

remove(dest);
renameSync(tmp, dest);
// Which Dispatch this SDK is: a checkout far behind main has none of the
// newer plugin APIs, and nothing else here would say so.
const at = gitOut(["log", "-1", "--format=%h %cs %s"], resolve(sdk, "..", "..")) ?? "an unknown commit";
console.log(`[copy-dispatch-sdk] .dispatch-sdk <- ${sdk}, found by ${found.via}`);
console.log(`[copy-dispatch-sdk]   Dispatch at ${at}; also copied ${SHARED}, ${[...copied].join(", ")}`);
