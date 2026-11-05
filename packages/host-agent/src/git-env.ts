/**
 * Which developer directory git runs from on a Mac, for the plugin's own git
 * (sync, forget, gc, the probe's check of it) and, as a default, for a chat's
 * shell.
 *
 * On a Mac, `/usr/bin/git` is a stub that runs the git of a developer
 * directory: `DEVELOPER_DIR` when it is set, else the one `xcode-select`
 * chose. With Xcode chosen, every Xcode update (the App Store installs them on
 * its own) puts Xcode's git behind its new license until someone runs
 * `sudo xcodebuild -license accept`: exit 69, and no sync. The Command Line
 * Tools' git has no such gate. So whenever they are installed, git runs with
 * `DEVELOPER_DIR` set to them. That needs no sudo, and doesn't care what
 * `xcode-select` chose (docs/setup/macos-host.md, step 5). Xcode's own tools
 * are run with Xcode's developer directory, per command.
 */
import { existsSync } from "node:fs";

/** The Command Line Tools' developer directory. */
export const CLT_DEVELOPER_DIR = "/Library/Developer/CommandLineTools";

/** Where Xcode keeps its developer directory: what its tools are run with, per command. */
export const XCODE_DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";

/** Whether this machine has the Command Line Tools' git (only a Mac does). */
export function hasCommandLineTools(): boolean {
  return existsSync(`${CLT_DEVELOPER_DIR}/usr/bin/git`);
}

/**
 * For a `/bin/sh` script that runs git: the same as {@link gitEnv}, in shell.
 * Without the Command Line Tools, `DEVELOPER_DIR` is unset, so git is the one
 * `xcode-select` chose, never one a `.zshenv` happened to export.
 */
export const GIT_SH_ENV =
  `if [ -x '${CLT_DEVELOPER_DIR}/usr/bin/git' ]; then export DEVELOPER_DIR='${CLT_DEVELOPER_DIR}'; ` +
  `else unset DEVELOPER_DIR; fi; export LC_ALL=C`;

/**
 * `base` (the agent's own environment) for git: the C locale, and
 * `DEVELOPER_DIR` the Command Line Tools' when `clt` (they're installed), else
 * none.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env, clt = hasCommandLineTools()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: "C" };
  if (clt) env.DEVELOPER_DIR = CLT_DEVELOPER_DIR;
  else delete env.DEVELOPER_DIR;
  return env;
}
