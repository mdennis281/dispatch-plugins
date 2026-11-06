import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { McpBridge, type BridgeFiles, type BridgeInner } from "../src/mcp/bridge.js";
import { CHROME_PLAYWRIGHT_CORE, PlacementRefused, planProcess, takeOption } from "../src/mcp/plan.js";

const ctx = { label: "CVX Mac", desktop: false };
const paths = {
  node: "/h/.dispatch-host/runtime/node/bin/node",
  entry: "/h/.dispatch-host/mcp-packages/abc/node_modules/@playwright/mcp/cli.js",
  browsersPath: "/h/.dispatch-host/browsers",
  executablePath: "/h/.dispatch-host/browsers/chromium-1/chrome",
  dir: "/h/.dispatch-host/i/mcp/c1/playwright",
  out: "/h/.dispatch-host/i/mcp/c1/playwright/out",
  tmp: "/h/.dispatch-host/i/mcp/c1/playwright/tmp",
};
const playwright = (args: string[]) => ({
  name: "playwright",
  bundled: { server: "playwright", package: "@playwright/mcp", version: "0.0.79", bin: "cli.js", args },
});
const devtools = (args: string[]) => ({
  name: "chrome-devtools",
  bundled: {
    server: "chrome-devtools",
    package: "chrome-devtools-mcp",
    version: "1.7.0",
    bin: "build/src/bin/chrome-devtools-mcp.js",
    args,
    env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
  },
});

describe("planProcess", () => {
  it("runs Dispatch's playwright headless on Playwright's Chromium, with its output there", () => {
    const p = planProcess(playwright(["--isolated", "--browser", "chrome", "--viewport-size", "1280x800", "--headless"]), ctx);
    expect(p.provision).toEqual({ packages: [{ name: "@playwright/mcp", version: "0.0.79" }], entry: { name: "@playwright/mcp", bin: "cli.js" }, browser: "chromium" });
    expect(p.argv(paths)).toEqual([
      paths.node,
      paths.entry,
      "--isolated",
      "--viewport-size",
      "1280x800",
      "--browser",
      "chromium",
      "--output-dir",
      paths.out,
      "--headless",
    ]);
    expect(p.env(paths)).toEqual({ PLAYWRIGHT_BROWSERS_PATH: paths.browsersPath, TMPDIR: paths.tmp });
    expect(p.ownRoots).toBe(true);
    expect(p.notes.join()).toMatch(/chrome → Playwright's Chromium/);
  });

  it("keeps firefox, and refuses WebKit and headed browsers without a desktop session", () => {
    expect(planProcess(playwright(["--browser", "firefox", "--headless"]), ctx).provision?.browser).toBe("firefox");
    expect(() => planProcess(playwright(["--browser", "webkit", "--headless"]), ctx)).toThrow(PlacementRefused);
    expect(() => planProcess(playwright(["--browser", "webkit", "--headless"]), ctx)).toThrow(/WebKit needs a desktop session on CVX Mac/);
    expect(() => planProcess(playwright(["--browser", "chrome"]), ctx)).toThrow(/headed browser .*needs a desktop session/);
    expect(() => planProcess(devtools(["--isolated"]), ctx)).toThrow(/needs a desktop session/);
    // With one, they would run.
    expect(planProcess(playwright(["--browser", "chrome"]), { ...ctx, desktop: true }).provision?.browser).toBe("chromium");
  });

  it("never passes on a Dispatch-host output directory", () => {
    const p = planProcess(playwright(["--headless", "--output-dir", "C:\\Users\\x\\AppData\\Local\\Temp\\out"]), ctx);
    expect(p.argv(paths).filter((a) => a.includes("AppData"))).toEqual([]);
  });

  it("points chrome-devtools-mcp at the same Chromium, with its own Playwright to install it", () => {
    const p = planProcess(devtools(["--isolated", "--viewport", "1280x800", "--headless"]), ctx);
    expect(p.provision).toEqual({
      packages: [
        { name: "chrome-devtools-mcp", version: "1.7.0" },
        { name: "playwright-core", version: CHROME_PLAYWRIGHT_CORE },
      ],
      entry: { name: "chrome-devtools-mcp", bin: "build/src/bin/chrome-devtools-mcp.js" },
      browser: "chromium",
      executable: true,
    });
    expect(p.argv(paths)).toEqual([paths.node, paths.entry, "--isolated", "--viewport", "1280x800", "--executablePath", paths.executablePath, "--headless"]);
    expect(p.env(paths)).toEqual({ CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", TMPDIR: paths.tmp });
  });

  it("runs a configured server as written, and refuses an unknown bundled one", () => {
    const p = planProcess({ name: "x", command: "npx", args: ["-y", "some-mcp"], env: { A: "1" } }, ctx);
    expect(p.provision).toBeUndefined();
    expect(p.argv(paths)).toEqual(["npx", "-y", "some-mcp"]);
    expect(p.env(paths)).toEqual({ A: "1" });
    expect(p.ownRoots).toBe(false);
    expect(() => planProcess({ name: "z", bundled: { server: "zap", package: "zap-mcp", version: "1.0.0", bin: "x.js", args: [] } }, ctx)).toThrow(/update the remote-host plugin/);
  });

  it("takeOption removes every spelling", () => {
    const a = ["--browser", "chrome", "--x", "--browser=firefox"];
    expect(takeOption(a, "--browser")).toBe("firefox");
    expect(a).toEqual(["--x"]);
  });
});

class FakeInner extends EventEmitter implements BridgeInner {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly written: string[] = [];
  ended = false;
  killed: Array<string | undefined> = [];
  readonly stdin = {
    write: (s: string) => void this.written.push(s),
    end: () => void (this.ended = true),
  };
  kill(sig?: string): void {
    this.killed.push(sig);
  }
  /** What the bridge sent the process, parsed. */
  sent(): Array<Record<string, any>> {
    return this.written.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  send(msg: object): void {
    this.stdout.emit("data", `${JSON.stringify(msg)}\n`);
  }
}

describe("McpBridge", () => {
  const local = mkdtempSync(join(tmpdir(), "rh-bridge-"));
  afterAll(() => rmSync(local, { recursive: true, force: true }));
  const DIR = "/Users/dispatch/.dispatch-host/i/mcp/c1/playwright";

  function setup(opts: { windows?: boolean; ownRoots?: boolean } = {}) {
    const inner = new FakeInner();
    const there = new Map<string, string>();
    const uploads: Array<[string, string]> = [];
    const fetches: string[] = [];
    let failUpload = false;
    const files: BridgeFiles = {
      fetch: async (remote, to) => {
        fetches.push(remote);
        const body = there.get(remote);
        if (body === undefined) return false;
        mkdirSync(join(to, ".."), { recursive: true });
        writeFileSync(to, body);
        return true;
      },
      upload: async (from, remote) => {
        if (failUpload) throw new Error("no link");
        uploads.push([from, remote]);
        there.set(remote, readFileSync(from, "utf8"));
      },
    };
    const b = new McpBridge(inner, {
      label: "CVX Mac",
      dir: DIR,
      out: `${DIR}/out`,
      checkout: { remote: "/Users/dispatch/.dispatch-host/i/chats/c1/repo", local: join(local, "repo") },
      localDir: join(local, "copies"),
      ownRoots: opts.ownRoots ?? true,
      files,
      windows: opts.windows ?? process.platform === "win32",
    });
    const lines: Array<Record<string, any>> = [];
    const events: string[] = [];
    b.stdout.on("data", (d: string) => {
      for (const l of String(d).split("\n").filter(Boolean)) {
        try {
          lines.push(JSON.parse(l));
        } catch {
          /* raw lines are checked on their own */
        }
      }
    });
    b.on("stalled", () => events.push("stalled"));
    b.on("resumed", () => events.push("resumed"));
    b.on("exit", () => events.push("exit"));
    return { inner, b, there, uploads, fetches, lines, events, failUploads: () => (failUpload = true) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("advertises roots and answers roots/list with the paths there", async () => {
    const s = setup();
    s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } })}\n`);
    await tick();
    expect(s.inner.sent()[0]!.params.capabilities.roots).toEqual({ listChanged: false });
    s.inner.send({ jsonrpc: "2.0", id: 7, method: "roots/list" });
    await tick();
    expect(s.lines).toEqual([]); // never reaches the client
    expect(s.inner.sent()[1]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        roots: [
          { uri: `file://${DIR}`, name: expect.any(String) },
          { uri: "file:///Users/dispatch/.dispatch-host/i/chats/c1/repo", name: expect.any(String) },
        ],
      },
    });
    // The client's own roots changing means nothing there.
    s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" })}\n`);
    await tick();
    expect(s.inner.sent()).toHaveLength(2);
  });

  it("leaves roots alone for a configured server", async () => {
    const s = setup({ ownRoots: false });
    s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } })}\n`);
    s.inner.send({ jsonrpc: "2.0", id: 7, method: "roots/list" });
    await tick();
    expect(s.inner.sent()[0]!.params.capabilities).toEqual({});
    expect(s.lines).toEqual([{ jsonrpc: "2.0", id: 7, method: "roots/list" }]);
  });

  it("copies the files a result names here, and names the copies", async () => {
    const s = setup();
    s.there.set(`${DIR}/out/page-1.png`, "PNG");
    s.there.set(`${DIR}/out/page-1.yml`, "- heading");
    s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_take_screenshot", arguments: {} } })}\n`);
    s.inner.send({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          { type: "text", text: "- [Screenshot of viewport](out/page-1.png)\n// save it as out/page-1.png\n- [Snapshot](out/page-1.yml)\nalso out/page-1.png.bak and xout/page-1.png" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: `absolute: ${DIR}/out/page-1.png. And file://${DIR}/out/page-1.yml` },
        ],
      },
    });
    await tick();
    const shot = join(local, "copies", "out", "page-1.png");
    const snap = join(local, "copies", "out", "page-1.yml");
    expect(readFileSync(shot, "utf8")).toBe("PNG");
    expect(readFileSync(snap, "utf8")).toBe("- heading");
    const [first, image, third] = s.lines[0]!.result.content;
    expect(first.text).toBe(
      `- [Screenshot of viewport](${shot})\n// save it as ${shot}\n- [Snapshot](${snap})\nalso out/page-1.png.bak and xout/page-1.png`,
    );
    expect(image).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(third.text).toBe(`absolute: ${shot}. And ${pathToFileURL(snap).href}`);
  });

  it("says so when a file it names couldn't be copied, and leaves its path", async () => {
    const s = setup();
    s.there.set(`${DIR}/out/big.zip`, "x");
    const files = (s.b as unknown as { o: { files: BridgeFiles } }).o.files;
    files.fetch = async () => {
      throw new Error("it is 300 MB");
    };
    s.inner.send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "- [Trace](out/big.zip)" }] } });
    await tick();
    const content = s.lines[0]!.result.content;
    expect(content[0].text).toBe("- [Trace](out/big.zip)");
    expect(content[1].text).toMatch(/big\.zip is on CVX Mac and wasn't copied here: it is 300 MB/);
  });

  it("copies a local file there before an upload, once", async () => {
    const s = setup();
    const f = join(local, "upload me.txt");
    writeFileSync(f, "hello");
    for (const id of [4, 5]) {
      s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_file_upload", arguments: { paths: [f] } } })}\n`);
    }
    await vi.waitFor(() => expect(s.inner.sent()).toHaveLength(2));
    expect(s.uploads).toHaveLength(1);
    const remote = s.uploads[0]![1];
    expect(remote).toMatch(new RegExp(`^${DIR}/uploads/[0-9a-f]{10}/upload me\\.txt$`));
    expect(s.inner.sent().map((m) => m.params.arguments.paths)).toEqual([[remote], [remote]]);
    // A result naming the upload names the local original; nothing is copied back.
    s.inner.send({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: `await fileChooser.setFiles(["${remote}"])` }] } });
    await vi.waitFor(() => expect(s.lines).toHaveLength(1));
    expect(s.lines[0]!.result.content[0].text).toBe(`await fileChooser.setFiles(["${f}"])`);
    expect(s.fetches).toEqual([]);
  });

  it("rewrites a file:// page to its copy there", async () => {
    const s = setup();
    const f = join(local, "page.html");
    writeFileSync(f, "<h1>x</h1>");
    s.b.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "browser_navigate", arguments: { url: pathToFileURL(f).href } } })}\n`,
    );
    await tick();
    expect(s.inner.sent()[0]!.params.arguments.url).toMatch(new RegExp(`^file://${DIR}/uploads/[0-9a-f]{10}/page\\.html$`));
  });

  it("saves a file where the agent asked: written there, copied to that local path", async () => {
    const s = setup();
    const want = join(local, "shots", "home.png");
    mkdirSync(join(local, "shots"), { recursive: true });
    s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "take_screenshot", arguments: { filePath: want } } })}\n`);
    await tick();
    const remote = s.inner.sent()[0]!.params.arguments.filePath as string;
    expect(remote).toMatch(new RegExp(`^${DIR}/out/[0-9a-f]{8}-home\\.png$`));
    s.there.set(remote, "IMG");
    s.inner.send({ jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: `Saved screenshot to ${remote}.` }] } });
    await tick();
    expect(readFileSync(want, "utf8")).toBe("IMG");
    expect(s.lines[0]!.result.content[0].text).toBe(`Saved screenshot to ${want}.`);
  });

  it("treats only drive paths as local on a Windows host", async () => {
    const s = setup({ windows: true });
    s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x", arguments: { filePath: "/etc/hosts", text: "C:\\nope" } } })}\n`);
    await tick();
    expect(s.inner.sent()[0]!.params.arguments).toEqual({ filePath: "/etc/hosts", text: "C:\\nope" });
  });

  it("fails a call whose file can't be copied there, without sending it", async () => {
    const s = setup();
    const f = join(local, "x.txt");
    writeFileSync(f, "x");
    s.failUploads();
    s.b.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "browser_file_upload", arguments: { paths: [f] } } })}\n`);
    await tick();
    expect(s.inner.sent()).toEqual([]);
    expect(s.lines[0]).toEqual({ jsonrpc: "2.0", id: 10, error: { code: -32000, message: expect.stringMatching(/couldn't copy .*x\.txt to CVX Mac.*no link/) } });
  });

  it("keeps the reconnect contract: stalled at once, resumed and exit after the lines before them", async () => {
    const s = setup();
    s.inner.stdout.emit("data", '{"jsonrpc":"2.0","id":1,"res');
    s.inner.emit("stalled", { detail: "lost" });
    expect(s.events).toEqual(["stalled"]);
    s.inner.stdout.emit("data", 'ult":{}}\nnot json\n');
    s.inner.emit("resumed");
    s.inner.emit("exit", 0);
    await tick();
    expect(s.events).toEqual(["stalled", "resumed", "exit"]);
    expect(s.lines[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("passes non-JSON through, and ends and kills the process", async () => {
    const s = setup();
    const raw: string[] = [];
    s.b.stdout.on("data", (d: string) => raw.push(d));
    s.inner.stdout.emit("data", "Debugger listening\n");
    s.b.stdin.end?.();
    s.b.kill();
    await tick();
    expect(raw).toEqual(["Debugger listening\n"]);
    expect(s.inner.ended).toBe(true);
    expect(s.inner.killed).toEqual([undefined]);
  });
});
