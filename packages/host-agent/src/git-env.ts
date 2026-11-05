/**
 * How the plugin's own git runs on a host: sync, forget, gc, and the probe's
 * check of it. A chat's shell is another matter; it keeps its environment.
 *
 * On a Mac, `/usr/bin/git` is a stub that runs the git of a developer
 * directory: `DEVELOPER_DIR` when it is set, else the one `xcode-select`
 * chose. The hosts are set up with the Command Line Tools chosen
 * (docs/setup/macos-host.md, step 5), because every Xcode update puts
 * Xcode's tools, git among them, behind its new license until someone
 * accepts it: exit 69, and no sync. A `DEVELOPER_DIR` pointing at Xcode (a
 * `.zshenv` that exports it, say) would bring that back, so the plugin's git
 * never sees one. Xcode builds set it per command instead.
 */

/** Where Xcode keeps its developer directory: what its tools are run with, per command. */
export const XCODE_DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";

/** For a `/bin/sh` script that runs git: the same as {@link gitEnv}, in shell. */
export const GIT_SH_ENV = "unset DEVELOPER_DIR; export LC_ALL=C";

/** `base` (the agent's own environment) for git: the C locale, and no `DEVELOPER_DIR`. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: "C" };
  delete env.DEVELOPER_DIR;
  return env;
}
