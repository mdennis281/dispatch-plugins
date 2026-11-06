/**
 * The root helper as generated, run the way sshd runs the elevation
 * account's forced command: `bash <helper>` with the request in
 * SSH_ORIGINAL_COMMAND and stdin the channel, which stays open until Dispatch
 * closes it. CI can't be root, so `sudo` here is a stand-in that runs the
 * helper's root half as this user, and the root half accepts this user's uid.
 * The SSH round trip, verify and uninstall are in e2e.posix.test.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ELEVATE_USER, runCommand } from "../src/elevation.js";
import { HELPER_VERSION, elevationKeyLine, helperScript, setupScript, type HelperPaths } from "../src/elevation-setup.js";

const posix = process.platform !== "win32";

interface Ran {
  code: number | null;
  out: string;
  err: string;
  ms: number;
}

describe.skipIf(!posix)("the root helper (POSIX)", () => {
  let dir: string;
  let p: HelperPaths;

  /** Run the helper as the forced command. Its stdin stays open until `closeAfterMs` (never, by default, until it exits). */
  const forced = (command: string | undefined, opts: { closeAfterMs?: number; paths?: HelperPaths } = {}): Promise<Ran> =>
    new Promise((resolve) => {
      const started = Date.now();
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: (opts.paths ?? p).home };
      if (command !== undefined) env.SSH_ORIGINAL_COMMAND = command;
      const child = spawn("/bin/bash", [(opts.paths ?? p).helper], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      if (opts.closeAfterMs !== undefined) setTimeout(() => child.stdin.end(), opts.closeAfterMs);
      child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - started }));
    });

  const run = (cwd: string, ...argv: string[]) => forced(runCommand("req-1", cwd, argv));

  beforeAll(() => {
    dir = realpathSync(mkdtempSync("/tmp/rh-helper-"));
    p = {
      helper: join(dir, "dispatch-elevate"),
      account: ELEVATE_USER,
      home: join(dir, "home"),
      sudoers: join(dir, "sudoers"),
      log: join(dir, "log"),
      sudo: join(dir, "sudo"),
      dscl: join(dir, "dscl"),
      rootUid: process.getuid!(),
    };
    mkdirSync(join(p.home, ".ssh"), { recursive: true });
    mkdirSync(join(dir, "work"));
    writeFileSync(p.sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 1\nshift\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(p.dscl, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(p.helper, helperScript(p), { mode: 0o755 });
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("parses as bash, and so does the setup script", () => {
    expect(spawnSync("/bin/bash", ["-n", p.helper]).status).toBe(0);
    const setup = join(dir, "setup.sh");
    writeFileSync(setup, setupScript("lab", elevationKeyLine("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample k@x", ["127.0.0.1"])));
    const r = spawnSync("/bin/bash", ["-n", setup], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("runs the command in its directory, with root's plain environment, and passes its output and exit code through", async () => {
    const r = await run(join(dir, "work"), "sh", "-c", 'echo "out $(pwd)"; echo "env $HOME $USER $PATH"; echo err >&2; exit 3');
    expect(r.code).toBe(3);
    expect(r.out).toBe(`out ${join(dir, "work")}\nenv /var/root root /usr/bin:/bin:/usr/sbin:/sbin\n`);
    expect(r.err).toBe("err\n");
  });

  it("never lets a shell see the request: quotes, $(…) and backquotes stay literal", async () => {
    const r = await run(join(dir, "work"), "printf", "%s|", `$(touch ${dir}/pwned)`, "`id`", "a'b", "two words", "");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`$(touch ${dir}/pwned)|\`id\`|a'b|two words||`);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("gives the command no input: nobody could type into it", async () => {
    const r = await run("/", "sh", "-c", "cat; echo after-cat");
    expect(r.out).toBe("after-cat\n");
  });

  it("stops the command, its whole group, when the channel closes (Dispatch's cancel)", async () => {
    const r = await forced(runCommand("req-2", "/", ["sh", "-c", "sleep 28.613 & sleep 28.614; echo never"]), { closeAfterMs: 500 });
    expect(r.code).toBe(143);
    expect(r.out).toBe("");
    expect(r.err).toBe(""); // no job-control noise
    expect(r.ms).toBeLessThan(5_000);
    await new Promise((res) => setTimeout(res, 300));
    expect(spawnSync("pgrep", ["-f", "sleep 28.61"]).status).not.toBe(0);
  });

  it("refuses anything else with 125, before sudo", async () => {
    const cases: Array<[string, RegExp]> = [
      ["rm -rf /", /not a request this helper takes/],
      ["run x;y abc", /not a request id/],
      ["run abc ab*c", /not a request/],
      ["run abc abc extra", /not a request this helper takes/],
      [`run abc ${"A".repeat(70_000)}`, /too long/],
      ["", /not a request this helper takes/],
    ];
    for (const [cmd, why] of cases) {
      const r = await forced(cmd);
      expect(r.code, cmd.slice(0, 40)).toBe(125);
      expect(r.err).toMatch(why);
    }
    const nowhere = await run("/no/such/dir", "true");
    expect(nowhere.code).toBe(125);
    expect(nowhere.err).toMatch(/there is no directory \/no\/such\/dir here, so nothing ran/);
  });

  it("answers check with its version and uid; logs every request; refuses --root to anyone but root", async () => {
    const r = await forced("check");
    expect(r).toMatchObject({ code: 0, out: `dispatch-elevate ${HELPER_VERSION} uid=${p.rootUid}\n` });
    const log = readFileSync(p.log, "utf8");
    expect(log).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ run req-1 in /m);
    expect(log).toMatch(/run req-1: exit 3\n/);
    expect(log).toMatch(/run req-2: exit 143\n/);
    expect(log).toMatch(/run req-1: no such directory\n/);
    expect(log).toMatch(/Z check\n/);

    const other = { ...p, helper: join(dir, "other-helper"), rootUid: p.rootUid + 1 };
    writeFileSync(other.helper, helperScript(other), { mode: 0o755 });
    const asMe = spawnSync("/bin/bash", [other.helper, "--root", "check"], { encoding: "utf8" });
    expect(asMe.status).toBe(125);
    expect(asMe.stderr).toMatch(/--root is for sudo/);
    // A login with no command (a shell) gets the usage, and nothing else.
    const shell = await forced(undefined);
    expect(shell.code).toBe(2);
    expect(shell.err).toMatch(/usage: sudo .* uninstall/);
  });
});
