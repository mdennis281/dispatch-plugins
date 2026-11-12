/**
 * How an MCP server core places on a machine is run there: what to install,
 * the command line, the environment. Pure, so every rule is tested.
 *
 * - **Bundled servers** (`info.bundled`): Dispatch's playwright and
 *   chrome-devtools, at the exact version whose tool list the agent was given.
 *   Their packages go into `~/.dispatch-host` with the pinned runtime's npm
 *   (no sudo). The browser is Playwright's Chromium (Chrome for Testing),
 *   installed beside them, and BOTH servers drive it: a system Chrome would
 *   need an admin to install, and Chrome's own updater needs one too.
 * - **Headed browsers and WebKit need the desktop session.** WebKit hangs
 *   even headless over plain SSH (cvx-mac, 2026-11-06). A plan for one says
 *   `desktop: true`, and the backend runs it inside the machine's login
 *   session through dispatch-host's GUI agent (Tier B, `dispatch-gui run
 *   --stdin`). A machine without one refuses it with that reason, never
 *   quietly runs something else.
 * - **Configured servers** (`info.command`): run as written, in the chat's
 *   directory there. Their paths are the project's to get right.
 * - **A root login** (a Linux box): Chrome won't start as root with its
 *   sandbox on, so both browser servers get it turned off (`--no-sandbox`;
 *   chrome-devtools-mcp passes it on with `--chrome-arg`).
 */
import type { TerminalProcessSpawnInfo } from "@dispatch/plugin-sdk";
import type { ProvisionSpec } from "@dispatch-plugins/host-agent";

/**
 * The Playwright that installs the browser chrome-devtools-mcp drives (its
 * package has no Playwright of its own). Pinned: the browser build comes
 * with it.
 */
export const CHROME_PLAYWRIGHT_CORE = "1.65.0";

export interface McpPlan {
  /** What `mcp-provision` installs first; absent for a configured server. */
  provision?: ProvisionSpec;
  /** The program and its arguments there, once provisioning said where things are. */
  argv(p: PlanPaths): string[];
  /** Extra environment for it. */
  env(p: PlanPaths): Record<string, string>;
  /** Whether the bridge should answer the server's `roots/list` itself (bundled servers). */
  ownRoots: boolean;
  /** It must run in the machine's desktop session (a headed browser, WebKit). */
  desktop: boolean;
  /** For the log: what was changed from what core asked. */
  notes: string[];
}

export interface PlanPaths {
  /** The pinned runtime there. */
  node: string;
  /** The server's CLI script, from provisioning. */
  entry?: string;
  browsersPath?: string;
  executablePath?: string;
  /** This chat's directory for this server there, and its parts. */
  dir: string;
  out: string;
  tmp: string;
}

export interface PlanContext {
  /** The machine, for messages. */
  label: string;
  /** Whether the machine has a desktop session a headed browser could use (Tier B). */
  desktop: boolean;
  /** Why it hasn't, for the refusal, when there is more to say than "not set up". */
  noDesktop?: string;
  /** The login there is root: the browser runs without Chrome's sandbox, which refuses root. */
  root?: boolean;
}

/** Refused before anything is installed: the agent's call fails with this. */
export class PlacementRefused extends Error {}

export function planProcess(info: Pick<TerminalProcessSpawnInfo, "bundled" | "command" | "args" | "env" | "name">, ctx: PlanContext): McpPlan {
  const b = info.bundled;
  if (b) {
    if (b.server === "playwright" || b.package === "@playwright/mcp") return planPlaywright(b, ctx);
    if (b.server === "chrome-devtools" || b.package === "chrome-devtools-mcp") return planChromeDevtools(b, ctx);
    throw new PlacementRefused(`${ctx.label} doesn't know how to run Dispatch's bundled server ${JSON.stringify(b.server)} (${b.package}@${b.version}); update the remote-host plugin`);
  }
  if (!info.command) throw new PlacementRefused(`MCP server ${info.name} names nothing to run`);
  const argv = [info.command, ...(info.args ?? [])];
  const env = { ...(info.env ?? {}) };
  return { argv: () => argv, env: () => env, ownRoots: false, desktop: false, notes: [] };
}

type Bundled = NonNullable<TerminalProcessSpawnInfo["bundled"]>;

function desktopNeeded(ctx: PlanContext, what: string): PlacementRefused {
  return new PlacementRefused(
    `${what} needs a desktop session on ${ctx.label}, which it doesn't have now (${ctx.noDesktop ?? "its GUI agent isn't running"}). ` +
      `Use the default headless Chromium there, or set this server's location to local.`,
  );
}

function planPlaywright(b: Bundled, ctx: PlanContext): McpPlan {
  const args = [...b.args];
  const notes: string[] = [];
  const headless = takeFlag(args, "--headless");
  const engine = takeOption(args, "--browser") ?? "chrome";
  takeOption(args, "--output-dir"); // ours to choose: never a Dispatch-host path
  if (engine === "webkit" && !ctx.desktop) throw desktopNeeded(ctx, "WebKit");
  if (!headless && !ctx.desktop) throw desktopNeeded(ctx, "A headed browser (browser.headless: false)");
  let browser: "chromium" | "firefox" | "webkit";
  if (engine === "firefox") browser = "firefox";
  else if (engine === "webkit") browser = "webkit";
  else {
    browser = "chromium";
    if (engine !== "chromium") notes.push(`${engine} → Playwright's Chromium (Chrome for Testing); no system ${engine} is installed for it there`);
  }
  if (ctx.root) {
    takeFlag(args, "--no-sandbox");
    notes.push("root: the browser's sandbox is off (--no-sandbox)");
  }
  return {
    provision: { packages: [{ name: b.package, version: b.version }], entry: { name: b.package, bin: b.bin }, browser },
    argv: (p) => [
      p.node,
      need(p.entry, "entry"),
      ...args,
      "--browser",
      browser,
      "--output-dir",
      p.out,
      ...(headless ? ["--headless"] : []),
      ...(ctx.root ? ["--no-sandbox"] : []),
    ],
    env: (p) => ({ ...(b.env ?? {}), PLAYWRIGHT_BROWSERS_PATH: need(p.browsersPath, "browsersPath"), TMPDIR: p.tmp }),
    ownRoots: true,
    // WebKit even headless: it never finishes launching outside the login session.
    desktop: !headless || browser === "webkit",
    notes,
  };
}

function planChromeDevtools(b: Bundled, ctx: PlanContext): McpPlan {
  const args = [...b.args];
  const headless = takeFlag(args, "--headless");
  // Ours to choose: the browser there, and its profile (--isolated keeps it in TMPDIR, per chat).
  takeOption(args, "--executablePath");
  takeOption(args, "-e");
  takeOption(args, "--channel");
  if (!headless && !ctx.desktop) throw desktopNeeded(ctx, "A headed browser (browser.headless: false)");
  return {
    provision: {
      packages: [
        { name: b.package, version: b.version },
        { name: "playwright-core", version: CHROME_PLAYWRIGHT_CORE },
      ],
      entry: { name: b.package, bin: b.bin },
      browser: "chromium",
      executable: true,
    },
    argv: (p) => [
      p.node,
      need(p.entry, "entry"),
      ...args,
      "--executablePath",
      need(p.executablePath, "executablePath"),
      ...(headless ? ["--headless"] : []),
      ...(ctx.root ? ["--chrome-arg=--no-sandbox"] : []),
    ],
    env: (p) => ({ ...(b.env ?? {}), TMPDIR: p.tmp }),
    ownRoots: true,
    desktop: !headless,
    notes: ["Chrome → Playwright's Chromium (Chrome for Testing) there", ...(ctx.root ? ["root: the browser's sandbox is off (--chrome-arg=--no-sandbox)"] : [])],
  };
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`provisioning gave no ${what}`);
  return v;
}

/** Remove a boolean flag (and any `--flag=…` spelling); true when it was there. */
export function takeFlag(args: string[], flag: string): boolean {
  let had = false;
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === flag || args[i] === `${flag}=true`) {
      args.splice(i, 1);
      had = true;
    } else if (args[i] === `${flag}=false`) args.splice(i, 1);
  }
  return had;
}

/** Remove `--opt value` / `--opt=value` (every occurrence); returns the last value. */
export function takeOption(args: string[], opt: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; ) {
    const a = args[i]!;
    if (a === opt && i + 1 < args.length) {
      value = args[i + 1];
      args.splice(i, 2);
    } else if (a.startsWith(`${opt}=`)) {
      value = a.slice(opt.length + 1);
      args.splice(i, 1);
    } else i++;
  }
  return value;
}
