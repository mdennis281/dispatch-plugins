#!/usr/bin/env node
/**
 * Point `<repo>/.dispatch-sdk` at a Dispatch checkout's `packages/plugin-sdk`.
 *
 * `@dispatch/plugin-sdk` is not on npm, so every package here depends on it as
 * `link:../../.dispatch-sdk`: a path INSIDE this checkout, which is the same
 * from the primary checkout, from any git worktree of it, and from CI. This
 * script makes that path real. It runs as the root `pnpm:devPreinstall`, so a
 * plain `pnpm install` sets it up before pnpm links anything.
 *
 * Which Dispatch checkout, first match wins:
 *   1. `DISPATCH_REPO`, if set. CI sets it; so can anyone whose checkout is
 *      somewhere else.
 *   2. A sibling of the PRIMARY checkout named `claude-manager` or `dispatch`.
 *      The primary checkout comes from `git rev-parse --git-common-dir`, so a
 *      worktree under `../.worktrees/` finds the same sibling the primary does.
 *
 * The link is a junction on Windows (no admin rights or developer mode needed)
 * and a symlink elsewhere. It is gitignored. It is replaced when it points
 * somewhere else, and a real directory in its place is an error, never deleted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const link = join(repoRoot, ".dispatch-sdk");
const SDK = "@dispatch/plugin-sdk";

function fail(message) {
  console.error(`[link-dispatch-sdk] ${message}`);
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

function isSdk(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === SDK;
  } catch {
    return false;
  }
}

function findSdk() {
  const fromEnv = process.env.DISPATCH_REPO;
  if (fromEnv) {
    const sdk = resolve(fromEnv, "packages", "plugin-sdk");
    if (!isSdk(sdk)) fail(`DISPATCH_REPO=${fromEnv} has no ${SDK} at packages/plugin-sdk`);
    return sdk;
  }
  const parent = dirname(primaryCheckout());
  const tried = [];
  for (const name of ["claude-manager", "dispatch"]) {
    const sdk = join(parent, name, "packages", "plugin-sdk");
    tried.push(sdk);
    if (isSdk(sdk)) return sdk;
  }
  fail(
    `no Dispatch checkout found. Clone https://github.com/mdennis281/dispatch beside this repository ` +
      `(looked for ${tried.join(", ")}), or set DISPATCH_REPO to one.`,
  );
}

const target = realpathSync(findSdk());

let stat;
try {
  stat = lstatSync(link);
} catch {
  stat = undefined;
}
if (stat) {
  if (!stat.isSymbolicLink()) fail(`${link} exists and is not a link; move it out of the way`);
  let current;
  try {
    current = realpathSync(link);
  } catch {
    current = readlinkSync(link); // dangling
  }
  if (resolve(current) === target) process.exit(0);
  unlinkSync(link);
}
symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
console.log(`[link-dispatch-sdk] .dispatch-sdk -> ${target}`);
if (!existsSync(join(target, "dist", "index.js"))) {
  console.warn(
    `[link-dispatch-sdk] ${SDK} is not built. In the Dispatch checkout run: ` +
      `pnpm install && pnpm --filter @dispatch/shared --filter ${SDK} build`,
  );
}
