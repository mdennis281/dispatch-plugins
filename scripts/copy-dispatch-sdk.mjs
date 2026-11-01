#!/usr/bin/env node
/**
 * Copy a Dispatch checkout's `@dispatch/plugin-sdk` into `<repo>/.dispatch-sdk`.
 *
 * `@dispatch/plugin-sdk` is not on npm, so every package here depends on it as
 * `link:../../.dispatch-sdk`: a path INSIDE this checkout, which is the same
 * from the primary checkout, from any git worktree of it, and from CI. This
 * script fills that path. It runs as the root `pnpm:devPreinstall`, so a plain
 * `pnpm install` refreshes it before pnpm links anything.
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
 * Re-run `pnpm install` after rebuilding them there; the copy does not follow.
 *
 * Which Dispatch checkout, first match wins:
 *   1. `DISPATCH_REPO`, if set. CI sets it; so can anyone whose checkout is
 *      somewhere else.
 *   2. A sibling of the PRIMARY checkout named `claude-manager` or `dispatch`.
 *      The primary checkout comes from `git rev-parse --git-common-dir`, so a
 *      worktree finds the same sibling the primary does.
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

/** The directory holding the main `.git`, whichever worktree we are in. */
function primaryCheckout() {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirname(common);
  } catch {
    return repoRoot; // not a git checkout (an unpacked tarball): look beside it
  }
}

function manifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function findSdk() {
  const fromEnv = process.env.DISPATCH_REPO;
  if (fromEnv) {
    const sdk = resolve(fromEnv, "packages", "plugin-sdk");
    if (manifest(sdk)?.name !== SDK) fail(`DISPATCH_REPO=${fromEnv} has no ${SDK} at packages/plugin-sdk`);
    return sdk;
  }
  const parent = dirname(primaryCheckout());
  const tried = [];
  for (const name of ["claude-manager", "dispatch"]) {
    const sdk = join(parent, name, "packages", "plugin-sdk");
    tried.push(sdk);
    if (manifest(sdk)?.name === SDK) return sdk;
  }
  fail(
    `no Dispatch checkout found. Clone https://github.com/mdennis281/dispatch beside this repository ` +
      `(looked for ${tried.join(", ")}), or set DISPATCH_REPO to one.`,
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

const sdk = realpathSync(findSdk());
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
console.log(`[copy-dispatch-sdk] .dispatch-sdk <- ${sdk} (+ ${SHARED}, ${[...copied].join(", ")})`);
