/**
 * The COMMITTED client bundle, client/index.js, the way the SPA loads it: as
 * one module with the host's React and icons on window.__dispatch.deps. Build
 * before testing (`pnpm build`), or this tests old code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as jsxRuntime from "react/jsx-runtime";
import * as React from "react";
import * as lucide from "lucide-react";
import { isValidElement } from "react";

const dir = fileURLToPath(new URL("..", import.meta.url));
const bundle = readFileSync(`${dir}/client/index.js`, "utf8");

describe("the client bundle", () => {
  it("imports nothing, so it loads from the public /plugins/remote-host/ directory as it is", () => {
    // A bare import would 404 in the browser; a second React breaks every hook with "Invalid hook call".
    expect(bundle).not.toMatch(/^\s*import\s/m);
    expect(bundle).not.toMatch(/\bimport\(/);
    expect(bundle).not.toMatch(/react\.production|__SECRET_INTERNALS|ReactCurrentDispatcher/);
    expect(bundle).toContain('window.__dispatch.deps["react"]');
  });

  it("is the only file in its directory, since that whole directory is served without auth", () => {
    expect(readdirSync(`${dir}/client`)).toEqual(["index.js"]);
  });

  describe("activated against a fake host", () => {
    const g = globalThis as { window?: unknown };
    let had: unknown;
    beforeAll(() => {
      had = g.window;
      g.window = { __dispatch: { deps: { react: React, jsxRuntime, lucide } } };
    });
    afterAll(() => {
      g.window = had;
    });

    it("adds one Settings section, Remote hosts, and nothing else", async () => {
      const mod = (await import(pathToFileURL(`${dir}/client/index.js`).href)) as {
        default: { activate(host: unknown): void };
      };
      const sections: Array<{ id: string; label: string; icon: unknown; render: () => unknown }> = [];
      const other: string[] = [];
      const slots = new Proxy(
        {},
        {
          get: (_t, name: string) =>
            name === "settingsSection"
              ? (def: (typeof sections)[number]) => void sections.push(def)
              : () => void other.push(name),
        },
      );
      mod.default.activate({ slots });
      expect(other).toEqual([]);
      expect(sections.map((s) => [s.id, s.label])).toEqual([["hosts", "Remote hosts"]]);
      expect(sections[0]!.icon).toBe(lucide.Server);
      // The page itself is drawn by the host's React; here, only that render gives it an element.
      expect(isValidElement(sections[0]!.render())).toBe(true);
    });
  });
});
