import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browsersDir } from "../src/layout.js";
import { prefixFor, provision, withLock, type ProvisionDeps, type RunResult } from "../src/provision.js";
import { checkProvisionSpec } from "../src/provision-spec.js";

const SPEC = {
  packages: [{ name: "@playwright/mcp", version: "0.0.79" }],
  entry: { name: "@playwright/mcp", bin: "cli.js" },
  browser: "chromium" as const,
};

describe("checkProvisionSpec", () => {
  it("accepts plain names, exact versions and paths within the package", () => {
    expect(checkProvisionSpec(SPEC)).toEqual(SPEC);
    expect(checkProvisionSpec({ ...SPEC, entry: { name: "@playwright/mcp", bin: "build/src/bin/x.js" } }).entry.bin).toBe("build/src/bin/x.js");
  });

  it.each([
    [{ ...SPEC, packages: [{ name: "evil; rm -rf ~", version: "1.0.0" }] }, /not an npm package name/],
    [{ ...SPEC, packages: [{ name: "@playwright/mcp", version: "^0.0.79" }] }, /not an exact version/],
    [{ ...SPEC, packages: [{ name: "@playwright/mcp", version: "latest" }] }, /not an exact version/],
    [{ ...SPEC, entry: { name: "@playwright/mcp", bin: "../../x.js" } }, /not a path within the package/],
    [{ ...SPEC, entry: { name: "@playwright/mcp", bin: "/etc/x" } }, /not a path within the package/],
    [{ ...SPEC, entry: { name: "other", bin: "cli.js" } }, /entry must name one of the packages/],
    [{ ...SPEC, browser: "msedge" }, /not a browser this installs/],
    [{ ...SPEC, browser: undefined, executable: true }, /executable needs a browser/],
    [{ ...SPEC, packages: [] }, /1 to 8 packages/],
  ])("refuses %j", (spec, why) => {
    expect(() => checkProvisionSpec(spec)).toThrow(why);
  });
});

describe("provision", () => {
  let root: string;
  let node: string;
  let calls: Array<{ cmd: string; args: readonly string[]; env: Record<string, string> }>;
  let npmFails: string | undefined;
  let browserOut: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dh-prov-"));
    // The runtime's layout: bin/node and lib/node_modules/npm.
    node = join(root, "runtime", "node", "bin", "node");
    const npmCli = join(root, "runtime", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "");
    calls = [];
    npmFails = undefined;
    browserOut = "Downloading Chromium 150 … done";
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const deps = (): ProvisionDeps => ({
    root,
    node,
    env: { HOME: "/home/x", PATH: "/should/not/leak", NPM_TOKEN: "secret" },
    say: () => {},
    run: async (cmd, args, opts): Promise<RunResult> => {
      calls.push({ cmd, args, env: opts.env });
      if (args[1] === "install" && args[2] === "--prefix") {
        if (npmFails) return { code: 1, stdout: "", stderr: `npm ERR! ${npmFails}` };
        const prefix = args[3]!;
        for (const spec of args.slice(4).filter((a) => !a.startsWith("--"))) {
          const name = spec.slice(0, spec.lastIndexOf("@"));
          mkdirSync(join(prefix, "node_modules", name), { recursive: true });
          writeFileSync(join(prefix, "node_modules", name, "cli.js"), "");
        }
        // @playwright/mcp brings playwright-core.
        mkdirSync(join(prefix, "node_modules", "playwright-core"), { recursive: true });
        writeFileSync(join(prefix, "node_modules", "playwright-core", "cli.js"), "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "install") return { code: 0, stdout: browserOut, stderr: "" };
      if (args[0] === "-e") {
        const exe = join(root, "browsers", "chromium-1", "chrome");
        mkdirSync(dirname(exe), { recursive: true });
        writeFileSync(exe, "");
        return { code: 0, stdout: exe, stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unexpected" };
    },
  });

  it("installs the packages into their own prefix with the runtime's npm, scripts off, then the browser", async () => {
    const r = await provision(SPEC, deps());
    const prefix = prefixFor(root, SPEC);
    expect(r.entry).toBe(join(prefix, "node_modules", "@playwright/mcp", "cli.js"));
    expect(r.browsersPath).toBe(browsersDir(root));
    expect(r.installed).toEqual(["@playwright/mcp@0.0.79", "chromium"]);
    expect(existsSync(join(prefix, ".ready"))).toBe(true);
    const [npm, browser] = calls;
    expect(npm!.cmd).toBe(node);
    expect(npm!.args).toEqual(expect.arrayContaining(["install", "--ignore-scripts", "--omit=dev", "@playwright/mcp@0.0.79"]));
    // The login environment's secrets never reach npm; the runtime's node comes first on PATH.
    expect(npm!.env.NPM_TOKEN).toBeUndefined();
    expect(npm!.env.PATH?.startsWith(dirname(node))).toBe(true);
    expect(browser!.args).toEqual([join(prefix, "node_modules", "playwright-core", "cli.js"), "install", "chromium"]);
    expect(browser!.env.PLAYWRIGHT_BROWSERS_PATH).toBe(r.browsersPath);
  });

  it("uses an installed prefix as it is, and still lets Playwright check its browser", async () => {
    await provision(SPEC, deps());
    calls = [];
    browserOut = "";
    const r = await provision(SPEC, deps());
    expect(calls.map((c) => c.args[1])).toEqual(["install"]);
    expect(calls[0]!.args[0]).toMatch(/playwright-core/);
    expect(r.installed).toEqual([]);
  });

  it("reports the browser's executable when asked", async () => {
    const spec = {
      packages: [
        { name: "chrome-devtools-mcp", version: "1.7.0" },
        { name: "playwright-core", version: "1.65.0" },
      ],
      entry: { name: "chrome-devtools-mcp", bin: "cli.js" },
      browser: "chromium" as const,
      executable: true,
    };
    const r = await provision(spec, deps());
    expect(r.executablePath).toBe(join(root, "browsers", "chromium-1", "chrome"));
  });

  describe("on Linux, the browser's system libraries", () => {
    /** What ldd says, call by call; the last answer repeats. */
    let ldd: RunResult[];
    let depsRun: Array<{ args: readonly string[]; env: Record<string, string> }>;
    const MISSING = "\tlinux-vdso.so.1 (0x0000)\n\tlibnss3.so => not found\n\tlibgbm.so.1 => not found\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0000)\n";
    const linux = (uid: number): ProvisionDeps => {
      const d = deps();
      const run = d.run;
      return {
        ...d,
        system: { os: "linux", uid },
        run: async (cmd, args, opts) => {
          if (cmd === "ldd") return ldd.length > 1 ? ldd.shift()! : ldd[0]!;
          if (args[1] === "install-deps") {
            depsRun.push({ args, env: opts.env });
            return { code: 0, stdout: "", stderr: "" };
          }
          return run(cmd, args, opts);
        },
      };
    };
    beforeEach(() => {
      depsRun = [];
      ldd = [{ code: 0, stdout: "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0000)\n", stderr: "" }];
    });

    it("are checked, and nothing more happens when they're all there", async () => {
      const r = await provision(SPEC, linux(0));
      expect(depsRun).toEqual([]);
      expect(r.installed).toEqual(["@playwright/mcp@0.0.79", "chromium"]);
      // Looked up only to check its libraries: the spec didn't ask for the executable.
      expect(r.executablePath).toBeUndefined();
    });

    it("are installed with Playwright's install-deps as root, when some are missing", async () => {
      ldd = [
        { code: 0, stdout: MISSING, stderr: "" },
        { code: 0, stdout: MISSING, stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ];
      const r = await provision(SPEC, linux(0));
      expect(depsRun).toHaveLength(1);
      expect(depsRun[0]!.args).toEqual([join(prefixFor(root, SPEC), "node_modules", "playwright-core", "cli.js"), "install-deps", "chromium"]);
      expect(depsRun[0]!.env.DEBIAN_FRONTEND).toBe("noninteractive");
      expect(r.installed).toContain("system libraries for chromium");
    });

    it("fail the provision with their names when the login isn't root", async () => {
      ldd = [{ code: 0, stdout: MISSING, stderr: "" }];
      await expect(provision(SPEC, linux(1000))).rejects.toThrow(/lacks system libraries it needs \(libgbm\.so\.1, libnss3\.so\), and only root can install them/);
      expect(depsRun).toEqual([]);
    });

    it("fail it when they are still missing after installing them", async () => {
      ldd = [{ code: 0, stdout: MISSING, stderr: "" }];
      await expect(provision(SPEC, linux(0))).rejects.toThrow(/needs system libraries this machine lacks \(libgbm\.so\.1, libnss3\.so\)/);
    });

    it("aren't looked for when the browser's executable can't be found, unless the spec wanted it", async () => {
      const d = linux(1000);
      const run = d.run;
      let lddRan = false;
      const lost: ProvisionDeps = {
        ...d,
        run: async (cmd, args, opts) => {
          if (cmd === "ldd") lddRan = true;
          return args[0] === "-e" ? { code: 1, stdout: "", stderr: "Cannot find module 'playwright-core'" } : run(cmd, args, opts);
        },
      };
      await expect(provision(SPEC, lost)).resolves.toMatchObject({ installed: ["@playwright/mcp@0.0.79", "chromium"] });
      expect(lddRan).toBe(false);
      await expect(provision({ ...SPEC, executable: true }, lost)).rejects.toThrow(/executable wasn't found: Cannot find module/);
    });

    it("aren't held against it when ldd can't tell", async () => {
      ldd = [{ code: 127, stdout: "", stderr: "ldd: not found" }];
      await expect(provision(SPEC, linux(1000))).resolves.toMatchObject({ installed: ["@playwright/mcp@0.0.79", "chromium"] });
    });
  });

  it("says why npm failed, and leaves nothing half-installed", async () => {
    npmFails = "404 Not Found - @playwright/mcp@0.0.79";
    await expect(provision(SPEC, deps())).rejects.toThrow(/npm install @playwright\/mcp@0\.0\.79 failed \(exit 1\): npm ERR! 404/);
    const prefix = prefixFor(root, SPEC);
    expect(existsSync(prefix)).toBe(false);
    expect(existsSync(`${prefix}.lock`)).toBe(false);
  });

  it("keys a prefix by the exact set, in any order", () => {
    const a = { ...SPEC, packages: [{ name: "a", version: "1.0.0" }, { name: "b", version: "2.0.0" }], entry: { name: "a", bin: "x" } };
    const b = { ...a, packages: [...a.packages].reverse() };
    expect(prefixFor(root, a)).toBe(prefixFor(root, b));
    expect(prefixFor(root, a)).not.toBe(prefixFor(root, { ...a, packages: [{ name: "a", version: "1.0.1" }, { name: "b", version: "2.0.0" }] }));
  });

  it("waits for another install's lock, and takes over one whose owner is gone", async () => {
    const lock = join(root, "x.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${process.pid}\n`); // alive: wait
    let t = 0;
    const order: string[] = [];
    const d = { ...deps(), now: () => t, sleep: async () => void (t += 500, t === 1_500 && rmSync(lock, { recursive: true })) };
    await withLock(lock, d, async () => void order.push("ran"));
    expect(order).toEqual(["ran"]);
    expect(t).toBe(1_500);

    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999999\n"); // no such process
    await withLock(lock, deps(), async () => void order.push("took over"));
    expect(order).toEqual(["ran", "took over"]);
    expect(existsSync(lock)).toBe(false);
  });
});
