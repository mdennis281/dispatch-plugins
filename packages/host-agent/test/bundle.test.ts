/**
 * dist/dispatch-host.mjs runs on a host with nothing but the pinned Node: no
 * node_modules. Checked after `pnpm build` (CI's order); skipped before it.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../dist/dispatch-host.mjs", import.meta.url));

describe.skipIf(!existsSync(DIST))("the built agent", () => {
  it("imports nothing but node: builtins", () => {
    const src = readFileSync(DIST, "utf8");
    const specifiers = [...src.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s!.startsWith("node:"))).toEqual([]);
  });
});
