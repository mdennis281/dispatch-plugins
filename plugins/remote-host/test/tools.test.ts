import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Approvals, ApprovalRequest } from "../src/elevation.js";
import type { HostRegistry } from "../src/registry.js";
import { registerTools, remotePath } from "../src/tools/index.js";
import { SH, localRemote } from "./local-remote.js";

/** Paths as the machine's `sh` takes them (Git's sh on Windows reads C:/…). */
const fwd = (p: string) => p.replace(/\\/g, "/");
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? `[${c.type}]`).join("\n");

/** A 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe.skipIf(!SH)("the agent's tools (the machine played by the local sh)", () => {
  const work = mkdtempSync(join(tmpdir(), "rh-tools-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const there = join(work, "there"); // the machine: home, and the chat's checkout under it
  const checkout = join(there, "checkout");
  const here = join(work, "here"); // this computer: the chat's worktree
  const copies = join(work, "copies");
  mkdirSync(join(checkout, "app", "build", "Run.xcresult", "Data"), { recursive: true });
  mkdirSync(join(here, "app"), { recursive: true });
  writeFileSync(join(checkout, "app", "build", "report.txt"), "all green");
  writeFileSync(join(checkout, "app", "build", "Run.xcresult", "Info.plist"), "<plist/>");
  writeFileSync(join(checkout, "app", "build", "Run.xcresult", "Data", "db"), "DB");
  writeFileSync(join(checkout, "app", "shot.png"), PNG);
  writeFileSync(join(there, "home-file.log"), "from home");

  let asked: ApprovalRequest[] = [];
  let decision: "approved" | "denied" = "approved";
  const approvals: Approvals = {
    request: async (_chat, req) => {
      asked.push(req);
      return { decision, by: "Tester", at: Date.now() };
    },
  };
  beforeEach(() => {
    asked = [];
    decision = "approved";
  });

  function machine(slug: string, label: string, knows: string[]) {
    const remote = localRemote();
    return {
      host: { slug, label },
      backend: {
        whereThere: async (_chat: string, cwd?: string) => ({
          cwd: fwd(join(checkout, cwd && cwd.startsWith(join(here, "app")) ? "app" : "")),
          checkout: fwd(checkout),
          home: fwd(there),
        }),
        remoteSide: () => remote,
        knowsChat: async (chat: string) => knows.includes(chat),
        fetchedDir: (chat: string) => join(copies, slug, chat, "fetched"),
        chatActivity: (chat: string) => ({
          shells: knows.includes(chat) ? ["build"] : [],
          servers: [],
          ports: knows.includes(chat) ? [{ remotePort: 5173, url: "http://localhost:41000" }] : [],
        }),
      },
    };
  }

  function setup(machines: ReturnType<typeof machine>[], withApprovals = true) {
    const t = createTestContext({ id: "remote-host" });
    const registry = {
      all: () => machines,
      list: () =>
        machines.map((m) => ({
          slug: m.host.slug,
          label: m.host.label,
          id: `remote-host/${m.host.slug}`,
          status: { state: "online" as const },
          address: "10.0.4.5",
          probe: {
            agentVersion: "0.4.0",
            platform: "darwin",
            arch: "arm64",
            os: { name: "macOS", version: "27.2" },
            user: "dispatch",
            home: "/Users/dispatch",
            consoleUser: "mikedennis",
            freeDiskBytes: 120 * 1024 ** 3,
            tools: { git: "/usr/bin/git", node: null, pnpm: null, xcodebuild: "/usr/bin/xcodebuild", xcodeFirstLaunchDone: false },
            brew: { path: "/opt/homebrew/bin/brew", version: "Homebrew 7.0.12", writable: true },
          },
          elevation: { on: false, canAsk: true },
        })),
    } as unknown as HostRegistry;
    registerTools(t.ctx.tools, { registry, log: t.ctx.log, ...(withApprovals ? { approvals } : {}) });
    return t;
  }
  const cvx = () => machine("cvx-mac", "CVX Mac", ["chat-1"]);
  const call = { chatId: "chat-1", cwd: join(here, "app") };

  it("registers remote_fetch and machine_status, both within the agent-facing name limit", () => {
    const t = setup([cvx()]);
    expect(t.tools.list()).toEqual(["machine_status", "remote_fetch"]);
    expect(t.tools.get("remote_fetch")!.qualifiedName).toBe("mcp__dispatch-plugin-remote-host__remote_fetch");
  });

  it("does nothing on a Dispatch without ctx.tools", () => {
    expect(() => registerTools(undefined, { registry: {} as HostRegistry, log: createTestContext().ctx.log })()).not.toThrow();
  });

  it("copies a file named relative to the working directory into the chat's own folder", async () => {
    const t = setup([cvx()]);
    const r = await t.tools.call("remote_fetch", { path: "build/report.txt" }, call);
    const dest = join(copies, "cvx-mac", "chat-1", "fetched", "report.txt");
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe(`Copied ${fwd(join(checkout, "app", "build", "report.txt"))} from CVX Mac to ${dest} (1 KB).`);
    expect(readFileSync(dest, "utf8")).toBe("all green");
  });

  it("copies a whole folder (an .xcresult)", async () => {
    const t = setup([cvx()]);
    const r = await t.tools.call("remote_fetch", { path: "build/Run.xcresult" }, call);
    const dest = join(copies, "cvx-mac", "chat-1", "fetched", "Run.xcresult");
    expect(text(r)).toMatch(/^Copied the folder .*Run\.xcresult from CVX Mac to .*: 2 files in 2 folders/);
    expect(readFileSync(join(dest, "Info.plist"), "utf8")).toBe("<plist/>");
    expect(readFileSync(join(dest, "Data", "db"), "utf8")).toBe("DB");
    // Again: the copy is replaced, not nested.
    await t.tools.call("remote_fetch", { path: "build/Run.xcresult" }, call);
    expect(existsSync(join(dest, "Run.xcresult"))).toBe(false);
  });

  it("takes ~/ in the machine's home and an absolute path as written", async () => {
    expect(remotePath("~/x/y", { cwd: "/w", home: "/Users/dispatch" })).toBe("/Users/dispatch/x/y");
    expect(remotePath("/abs/../p", { cwd: "/w" })).toBe("/p");
    expect(remotePath("a/b", { cwd: "/w" })).toBe("/w/a/b");
    expect(() => remotePath("~other/x", { cwd: "/w" })).toThrow(/Only your own home/);
    const t = setup([cvx()]);
    const r = await t.tools.call("remote_fetch", { path: "~/home-file.log" }, call);
    expect(readFileSync(join(copies, "cvx-mac", "chat-1", "fetched", "home-file.log"), "utf8")).toBe("from home");
    expect(r.isError).toBeUndefined();
  });

  it("says where it looked when there is nothing there", async () => {
    const t = setup([cvx()]);
    const r = await t.tools.call("remote_fetch", { path: "build/nope.txt" }, call);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^There is nothing at .*app\/build\/nope\.txt on CVX Mac \(a relative path is taken in .*checkout\/app\)\.$/);
  });

  it("puts it at `to`, and says so when that is inside the working directory", async () => {
    const t = setup([cvx()]);
    const r = await t.tools.call("remote_fetch", { path: "build/report.txt", to: "out/report.txt" }, call);
    expect(readFileSync(join(here, "app", "out", "report.txt"), "utf8")).toBe("all green");
    expect(text(r)).toMatch(/inside your working directory, so git sees it/);
    expect(asked).toEqual([]); // nothing was there: nothing to approve
  });

  it("replaces an existing `to` only with the user's approval", async () => {
    const t = setup([cvx()]);
    const mine = join(work, "mine.txt");
    writeFileSync(mine, "precious");
    decision = "denied";
    const no = await t.tools.call("remote_fetch", { path: "build/report.txt", to: mine }, call);
    expect(no.isError).toBe(true);
    expect(text(no)).toMatch(/^The user said no, so .*mine\.txt was left as it was/);
    expect(readFileSync(mine, "utf8")).toBe("precious");
    expect(asked[0]).toMatchObject({ title: "Replace a local file with a copy from CVX Mac", machine: "CVX Mac" });

    decision = "approved";
    const yes = await t.tools.call("remote_fetch", { path: "build/report.txt", to: mine }, call);
    expect(yes.isError).toBeUndefined();
    expect(readFileSync(mine, "utf8")).toBe("all green");
  });

  it("replaces nothing when the call is cancelled, even after the user approved", async () => {
    const t = setup([cvx()]);
    const mine = join(work, "mine3.txt");
    writeFileSync(mine, "precious");
    const r = await t.tools.call("remote_fetch", { path: "build/report.txt", to: mine }, { ...call, signal: AbortSignal.abort() as never });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`Cancelled: nothing was copied; ${mine} is as it was.`);
    expect(asked).toHaveLength(1);
    expect(readFileSync(mine, "utf8")).toBe("precious");
  });

  it("says plainly when the machine can't be reached", async () => {
    const m = cvx();
    m.backend.whereThere = async () => {
      throw new Error("10.0.4.250: no answer (asleep, off, or off the network)");
    };
    const t = setup([m]);
    const r = await t.tools.call("remote_fetch", { path: "build/report.txt" }, call);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      "CVX Mac can't be reached right now (10.0.4.250: no answer (asleep, off, or off the network)), so nothing was copied. machine_status says when it is back.",
    );
  });

  it("says the connection dropped, and that nothing was written here, when a copy is cut off", async () => {
    for (const what of ["build/report.txt", "build/Run.xcresult"]) {
      const m = cvx();
      const real = m.backend.remoteSide();
      // The channel closes with no exit status: what a dropped connection looks like.
      m.backend.remoteSide = () => ({ ...real, stream: async () => ({ code: null, stderr: "" }) });
      const t = setup([m]);
      const mine = join(work, `cut-${what.length}.txt`);
      writeFileSync(mine, "precious");
      const r = await t.tools.call("remote_fetch", { path: what, to: mine }, call);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(
        new RegExp(
          `^Couldn't copy .*${what.replace(".", "\\.")} from CVX Mac: the connection to the machine dropped during the copy\\. ` +
            `Nothing was written on this computer; .*cut-${what.length}\\.txt is as it was\\. Try again once CVX Mac is reachable`,
        ),
      );
      expect(readFileSync(mine, "utf8")).toBe("precious");
      expect(readdirSync(work).filter((n) => n.includes(".part-"))).toEqual([]);
    }
  });

  it("refuses to replace anything on a Dispatch that can't ask", async () => {
    const t = setup([cvx()], false);
    const mine = join(work, "mine2.txt");
    writeFileSync(mine, "precious");
    const r = await t.tools.call("remote_fetch", { path: "build/report.txt", to: mine }, call);
    expect(text(r)).toMatch(/can't ask the user whether to replace it/);
    expect(readFileSync(mine, "utf8")).toBe("precious");
  });

  it("shows an image when asked", async () => {
    const t = setup([cvx()]);
    const r = await t.tools.call("remote_fetch", { path: "shot.png", show: true }, call);
    expect(r.content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
  });

  it("asks which machine when the chat's isn't clear, and takes one by name", async () => {
    const t = setup([machine("cvx-mac", "CVX Mac", []), machine("mini", "Mac mini", [])]);
    const r = await t.tools.call("remote_fetch", { path: "build/report.txt" }, call);
    expect(text(r)).toBe("This chat hasn't used a machine yet, and more than one is paired (CVX Mac, Mac mini); say which with `host`.");
    const named = await t.tools.call("remote_fetch", { path: "build/report.txt", host: "mac mini" }, call);
    expect(named.isError).toBeUndefined();
    const unknown = await t.tools.call("remote_fetch", { path: "x", host: "nas" }, call);
    expect(text(unknown)).toBe("No paired machine is called nas. Paired: CVX Mac, Mac mini.");
  });

  it("machine_status: the chat's machine, what it is and what the chat has there", async () => {
    const t = setup([cvx(), machine("mini", "Mac mini", [])]);
    const r = await t.tools.call("machine_status", {}, call);
    const out = text(r);
    expect(out).toContain("CVX Mac (terminal location remote-host/cvx-mac): online");
    expect(out).toContain("macOS 27.2 on arm64");
    expect(out).toContain("Xcode (license not accepted; xcodebuild won't run)");
    expect(out).toContain("root with approval: off (sudo is refused)");
    expect(out).toContain("this chat there: terminals build; forwarded ports 5173 → http://localhost:41000");
    expect(out).toContain(`this chat's checkout there: ${fwd(checkout)}`);
    expect(out).not.toContain("Mac mini"); // only the chat's own machine
  });
});
