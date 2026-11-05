import { describe, expect, it } from "vitest";
import { FALLBACK_PATH, filterLoginEnv, loginShell, parseCapturedEnv, shellEnv } from "../src/env.js";

const LOGIN = {
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
  HOMEBREW_PREFIX: "/opt/homebrew",
  HOMEBREW_NO_ANALYTICS: "1",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  JAVA_HOME: "/opt/jdk",
  GITHUB_TOKEN: "ghp_secret",
  NPM_TOKEN: "npm_secret",
  AWS_SECRET_ACCESS_KEY: "aws",
  SSH_AUTH_SOCK: "/tmp/agent",
  HOME: "/Users/someone-else",
};

describe("the login environment allow-list", () => {
  it("keeps PATH, Homebrew, locale and toolchain variables, and nothing else", () => {
    expect(filterLoginEnv(LOGIN)).toEqual({
      PATH: LOGIN.PATH,
      HOMEBREW_PREFIX: "/opt/homebrew",
      HOMEBREW_NO_ANALYTICS: "1",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      DEVELOPER_DIR: LOGIN.DEVELOPER_DIR,
      JAVA_HOME: "/opt/jdk",
    });
  });

  it("builds the shell's env from the agent's base variables, the allowed login ones, then the plugin's", () => {
    const env = shellEnv({
      agentEnv: { HOME: "/Users/dispatch", USER: "dispatch", SHELL: "/bin/zsh", TMPDIR: "/var/folders/x/", SSH_CONNECTION: "a b", PATH: "/usr/bin" },
      login: LOGIN,
      extra: { DISPATCH_CHAT: "c1" },
    });
    expect(env).toEqual({
      HOME: "/Users/dispatch",
      USER: "dispatch",
      SHELL: "/bin/zsh",
      TMPDIR: "/var/folders/x/",
      ...filterLoginEnv(LOGIN),
      DISPATCH_CHAT: "c1",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("SSH_CONNECTION");
  });

  it("defaults DEVELOPER_DIR to the Command Line Tools' on a Mac that has them, so the agent's git isn't Xcode's", () => {
    const agentEnv = { HOME: "/Users/dispatch" };
    const login = { PATH: "/usr/bin:/bin" };
    expect(shellEnv({ agentEnv, login, clt: true }).DEVELOPER_DIR).toBe("/Library/Developer/CommandLineTools");
    expect(shellEnv({ agentEnv, login, clt: false })).not.toHaveProperty("DEVELOPER_DIR");
    expect(shellEnv({ agentEnv, login })).not.toHaveProperty("DEVELOPER_DIR");
    // One the login shell or the plugin chose stands.
    expect(shellEnv({ agentEnv, login: LOGIN, clt: true }).DEVELOPER_DIR).toBe(LOGIN.DEVELOPER_DIR);
    expect(shellEnv({ agentEnv, login, clt: true, extra: { DEVELOPER_DIR: "/x" } }).DEVELOPER_DIR).toBe("/x");
  });

  it("falls back to a PATH with Homebrew when the login shell couldn't be read, and refuses a bad name", () => {
    expect(shellEnv({ agentEnv: { HOME: "/h" } }).PATH).toBe(FALLBACK_PATH);
    expect(() => shellEnv({ agentEnv: {}, extra: { "A=B": "x" } })).toThrow(/not an environment variable name/);
  });
});

describe("capturing it", () => {
  it("reads the JSON after the last marker, whatever the profile printed first", () => {
    const out = `Welcome!\n__DISPATCH_HOST_ENV__\nnot json\n\n__DISPATCH_HOST_ENV__\n{"PATH":"/x","N":1}`;
    expect(parseCapturedEnv(out)).toEqual({ PATH: "/x" });
    expect(() => parseCapturedEnv("no marker")).toThrow(/no environment/);
  });

  it("uses $SHELL when it is absolute, else the platform's default", () => {
    expect(loginShell({ SHELL: "/usr/local/bin/fish" }, "darwin")).toBe("/usr/local/bin/fish");
    expect(loginShell({ SHELL: "zsh" }, "darwin")).toBe("/bin/zsh");
    expect(loginShell({}, "linux")).toBe("/bin/bash");
  });
});
