import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError, main, parseArgs } from "../src/cli.js";
import { assertId, chatWorktreePath, repoPath, sessionPaths, socketPath } from "../src/layout.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("reads a command, --key value pairs and bare flags", () => {
    const a = parseArgs(["kill", "--instance", "i1", "--all", "--sid", "s1"]);
    expect(a.cmd).toBe("kill");
    expect(a.opts).toEqual({ instance: "i1", sid: "s1" });
    expect([...a.flags]).toEqual(["all"]);
    expect(() => parseArgs(["list", "stray"])).toThrow(UsageError);
  });
});

describe("main", () => {
  it("refuses an unknown command and a missing or unsafe id", async () => {
    await expect(main(["frobnicate"])).rejects.toThrow(UsageError);
    await expect(main(["list"])).rejects.toThrow(/--instance is required/);
    await expect(main(["list", "--instance", "../stable"])).rejects.toThrow(/must match/);
  });

  it("lists nothing for a fresh instance and notes the contact", async () => {
    const root = mkdtempSync(join(tmpdir(), "dh-cli-"));
    dirs.push(root);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    expect(await main(["list", "--instance", "inst", "--root", root])).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual([]);
  });
});

describe("layout", () => {
  it("namespaces everything by instance, and keeps socket paths short", () => {
    const root = "/Users/dispatch/.dispatch-host";
    const inst = "3f2b8c1e-9a4d-4e7b-8f21-0c5d6e7f8a9b";
    expect(repoPath(root, inst, "dispatch-plugins-1a2b")).toBe(`${root}/${inst}/repos/dispatch-plugins-1a2b.git`);
    expect(chatWorktreePath(root, inst, "4xuTZkKSyXyxmC8ex7oJa", "dispatch-plugins")).toBe(
      `${root}/${inst}/chats/4xuTZkKSyXyxmC8ex7oJa/dispatch-plugins`,
    );
    expect(sessionPaths(root, inst, "s1").record).toBe(`${root}/${inst}/sessions/s1/session.json`);
    // macOS caps sun_path at 104 bytes.
    expect(socketPath(root, inst, "x".repeat(64)).length).toBeLessThan(104);
    expect(socketPath(root, inst, "a")).not.toBe(socketPath(root, "other", "a"));
  });

  it("refuses ids that would leave their directory or need quoting", () => {
    for (const bad of ["", "..", "a/b", "a b", "a'b", "x".repeat(65), "$(id)"]) expect(() => assertId("chat", bad)).toThrow();
    expect(assertId("chat", "4xuTZkKSyXyxmC8ex7oJa")).toBe("4xuTZkKSyXyxmC8ex7oJa");
  });
});
