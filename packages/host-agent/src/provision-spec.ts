/**
 * What `dispatch-host mcp-provision` is asked to put on the machine: an MCP
 * server's npm packages at exact versions, and the browser it drives. Shared
 * by the plugin (which builds the spec) and the agent (which installs it), so
 * both check it the same way. Everything here ends up in a path or an npm
 * argument there, so only plain names and exact versions get through.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mcpPackagesDir } from "./layout.js";

export interface ProvisionSpec {
  /** Installed together into one npm prefix, keyed by exactly this set. */
  packages: Array<{ name: string; version: string }>;
  /** The server's CLI: a package from `packages` and its `bin` path within it. */
  entry: { name: string; bin: string };
  /**
   * A browser to install with the prefix's own `playwright-core` (one of
   * `packages` must bring it). Into `~/.dispatch-host/browsers`, shared.
   */
  browser?: "chromium" | "firefox";
  /** Report that browser's executable (chrome-devtools-mcp is pointed at it). */
  executable?: boolean;
}

export interface ProvisionResult {
  /** Absolute path of the server's CLI script there. */
  entry: string;
  /** `PLAYWRIGHT_BROWSERS_PATH` for the server. */
  browsersPath: string;
  /** The browser's executable, when asked for. */
  executablePath?: string;
  /** What this call installed, for the log; empty when everything was there. */
  installed: string[];
}

/** The npm prefix there for exactly this set of packages, under `<root>/mcp-packages`. */
export function prefixFor(root: string, spec: Pick<ProvisionSpec, "packages">): string {
  const key = spec.packages
    .map((p) => `${p.name}@${p.version}`)
    .sort()
    .join("\n");
  return join(mcpPackagesDir(root), createHash("sha256").update(key).digest("hex").slice(0, 16));
}

const PKG = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BIN_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The spec as the agent accepts it, or a throw naming what is wrong. */
export function checkProvisionSpec(raw: unknown): ProvisionSpec {
  const o = raw as Partial<ProvisionSpec> | null;
  if (!o || typeof o !== "object") throw new Error("not a provisioning spec");
  if (!Array.isArray(o.packages) || !o.packages.length || o.packages.length > 8) throw new Error("packages must list 1 to 8 packages");
  const packages = o.packages.map((p) => {
    if (!p || typeof p.name !== "string" || !PKG.test(p.name) || p.name.length > 214) throw new Error(`not an npm package name: ${JSON.stringify(p?.name)}`);
    if (typeof p.version !== "string" || !VERSION.test(p.version) || p.version.length > 64) {
      throw new Error(`${p.name}: not an exact version: ${JSON.stringify(p.version)}`);
    }
    return { name: p.name, version: p.version };
  });
  const e = o.entry;
  if (!e || typeof e.name !== "string" || !packages.some((p) => p.name === e.name)) throw new Error("entry must name one of the packages");
  if (typeof e.bin !== "string" || e.bin.length > 200 || !e.bin.split("/").every((s) => BIN_PART.test(s))) {
    throw new Error(`not a path within the package: ${JSON.stringify(e.bin)}`);
  }
  if (o.browser !== undefined && o.browser !== "chromium" && o.browser !== "firefox") throw new Error(`not a browser this installs: ${JSON.stringify(o.browser)}`);
  if (o.executable && !o.browser) throw new Error("executable needs a browser");
  return {
    packages,
    entry: { name: e.name, bin: e.bin },
    ...(o.browser ? { browser: o.browser } : {}),
    ...(o.executable ? { executable: true } : {}),
  };
}
