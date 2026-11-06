/**
 * The agent's own tools (core E8, `ctx.tools`, an optional capability):
 *
 *   remote_fetch    copy a file or folder from the chat's machine to here
 *   machine_status  what the machine is and what this chat has there
 *
 * The agent calls them as `mcp__dispatch-plugin-remote-host__<name>`, on
 * every runtime. Codex asks nobody before an MCP call, so a tool here never
 * does anything that can't be undone without the user's approval
 * (`ctx.approvals`): the one such thing is `remote_fetch` replacing a local
 * path that already exists.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { posix } from "node:path";
import type { PluginContext, PluginToolCall, PluginToolResult } from "@dispatch/plugin-sdk";
import { errText } from "@dispatch-plugins/remote-core";
import type { Approvals } from "../elevation.js";
import { backendId } from "../hosts.js";
import type { Entry, HostRegistry, HostView } from "../registry.js";
import { look, localName, mb, pull, type Pulled } from "./pull.js";

type ToolsApi = NonNullable<PluginContext["tools"]>;

/** `ctx.tools`, when this Dispatch has it (and granted the optional capability). */
export function toolsOf(ctx: unknown): ToolsApi | undefined {
  const t = (ctx as { tools?: { register?: unknown } } | undefined)?.tools;
  return t && typeof t.register === "function" ? (t as ToolsApi) : undefined;
}

export interface ToolDeps {
  registry: HostRegistry;
  approvals?: Approvals;
  log: PluginContext["log"];
}

/** Register the tools; returns their unregister. Nothing happens on a Dispatch without `ctx.tools`. */
export function registerTools(tools: ToolsApi | undefined, deps: ToolDeps): () => void {
  if (!tools) return () => {};
  const off = [
    tools.register<FetchArgs>({
      name: "remote_fetch",
      description: FETCH_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The file or folder on the machine. Relative: in the chat's checkout there, at the same place as your working directory. Absolute, or ~/… for the machine's home, also work.",
          },
          to: {
            type: "string",
            description:
              "Where to put the copy on this computer (absolute, or relative to your working directory). Omit it to use this chat's own folder for copies, which is outside the worktree.",
          },
          host: { type: "string", description: "The machine, by name: only needed when this chat uses more than one." },
          show: { type: "boolean", description: "For an image (PNG, JPEG, GIF, WebP) up to about 3.7 MB: also return it, to look at." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      handler: (args, call) => remoteFetch(deps, args, call),
    }),
    tools.register<StatusArgs>({
      name: "machine_status",
      description: STATUS_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { host: { type: "string", description: "One machine, by name. Omit it for this chat's machine, or every paired one." } },
        additionalProperties: false,
      },
      handler: (args, call) => machineStatus(deps, args, call),
    }),
  ];
  return () => off.forEach((f) => f());
}

const FETCH_DESCRIPTION =
  "Copy a file or a whole folder from the remote machine this chat's terminals run on (remote-host) to this computer, " +
  "and say where the copy is. Use it for what the terminal's sync doesn't bring back: build outputs and anything git " +
  "ignores, an .xcresult bundle, a screenshot, a test or coverage report, a crash log, or a file outside the checkout. " +
  "Files the chat's checkout tracks come back by themselves after each terminal command; don't fetch those. " +
  "A folder comes whole (files and folders; links are skipped). Up to 1 GB. By default the copy goes in this chat's own " +
  "folder for copies on this computer, outside the worktree, and is deleted with the chat; a later fetch of the same " +
  "name replaces it. With `to`, a path that already exists is replaced only if the user approves.";

const STATUS_DESCRIPTION =
  "Report the remote machines this chat's terminals run on (remote-host): whether each can be reached and why not, " +
  "what it is (OS, CPU architecture, free disk, git, Xcode, Homebrew), whether root with approval is set up, and what " +
  "this chat has there now (terminals, MCP servers, forwarded ports, its checkout's path). Read-only and quick. Use it " +
  "when a remote command fails in a way that looks like the machine, before a long build, or to learn its paths.";

interface FetchArgs {
  path?: unknown;
  to?: unknown;
  host?: unknown;
  show?: unknown;
  [k: string]: unknown;
}

interface StatusArgs {
  host?: unknown;
  [k: string]: unknown;
}

/** An answer the agent reads as a failure, with what to do about it. */
class ToolRefusal extends Error {}

async function remoteFetch(deps: ToolDeps, args: FetchArgs, call: PluginToolCall): Promise<PluginToolResult> {
  try {
    const path = text(args.path, "path");
    if (!path) throw new ToolRefusal("`path` is required: the file or folder on the machine to copy.");
    const to = args.to === undefined ? undefined : text(args.to, "to");
    const e = await pickOne(deps.registry, call.chatId, args.host === undefined ? undefined : text(args.host, "host"));
    const label = e.host.label;
    const signal = call.signal as unknown as AbortSignal;
    const there = await e.backend.whereThere(call.chatId, call.cwd, signal);
    const from = remotePath(path, there);
    const remote = e.backend.remoteSide();
    const found = await look(remote, from);
    if (found.kind === "missing") {
      const rel = path.startsWith("/") || path.startsWith("~") ? "" : ` (a relative path is taken in ${there.cwd})`;
      throw new ToolRefusal(`There is nothing at ${from} on ${label}${rel}.`);
    }
    if (found.kind === "other") throw new ToolRefusal(`${from} on ${label} is neither a file nor a folder.`);

    let dest: string;
    if (to) {
      if (!isAbsolute(to) && !call.cwd) throw new ToolRefusal("`to` is relative, and this chat has no working directory to take it in; give an absolute path.");
      dest = isAbsolute(to) ? resolve(to) : resolve(call.cwd!, to);
      if (existsSync(dest)) await mayReplace(deps, call, dest, `${label}:${from}`, label);
    } else {
      dest = resolve(e.backend.fetchedDir(call.chatId), localName(from));
    }

    const got = await pull(remote, from, found, dest, { signal });
    deps.log.info(`remote-host ${e.host.slug}: remote_fetch for ${call.chatId}: ${from} → ${dest} (${mb(got.bytes)})`);
    return await answer(got, from, dest, label, call, args.show === true);
  } catch (err) {
    if (err instanceof ToolRefusal) return { content: [{ type: "text", text: err.message }], isError: true };
    throw new Error(`remote_fetch failed: ${errText(err)}`);
  }
}

/** Ask the user before replacing what is at `dest`; throws a refusal unless they approve. */
async function mayReplace(deps: ToolDeps, call: PluginToolCall, dest: string, source: string, label: string): Promise<void> {
  if (!deps.approvals) {
    throw new ToolRefusal(
      `${dest} already exists, and this Dispatch can't ask the user whether to replace it. Give a path that doesn't exist yet, or omit \`to\`.`,
    );
  }
  const res = await deps.approvals.request(call.chatId, {
    title: `Replace a local file with a copy from ${label}`,
    detail: `The agent's remote_fetch would delete what is at this path on this computer and put a copy of ${source} there instead.`,
    command: `remote_fetch ${source} → ${dest}`,
    ...(call.cwd ? { cwd: call.cwd } : {}),
    machine: label,
    timeoutSeconds: 300,
    signal: call.signal as unknown as AbortSignal,
  });
  if (res.decision === "approved") return;
  const why = res.decision === "denied" ? "The user said no" : res.decision === "timeout" ? "Nobody answered in 5 minutes" : "It was cancelled";
  throw new ToolRefusal(`${why}, so ${dest} was left as it was and nothing was copied. Give a path that doesn't exist yet, or omit \`to\`.`);
}

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** 5,000,000 base64 characters, core's cap for one image. */
const MAX_IMAGE_BYTES = 3_700_000;

async function answer(got: Pulled, from: string, dest: string, label: string, call: PluginToolCall, show: boolean): Promise<PluginToolResult> {
  const lines: string[] = [];
  if (got.kind === "file") {
    lines.push(`Copied ${from} from ${label} to ${dest} (${mb(got.bytes)}).`);
  } else {
    const u = got.unpacked!;
    lines.push(`Copied the folder ${from} from ${label} to ${dest}: ${u.files} files in ${u.dirs + 1} folders, ${mb(got.bytes)}.`);
    if (u.skipped.length) {
      const list = u.skipped.slice(0, 10).join("; ");
      lines.push(`Not copied (${u.skipped.length}): ${list}${u.skipped.length > 10 ? "; …" : ""}.`);
    }
  }
  if (call.cwd) {
    const rel = relative(resolve(call.cwd), dest);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      lines.push("It is inside your working directory, so git sees it, and the next terminal command's sync takes it to the machine too.");
    }
  }
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: (typeof IMAGE_TYPES)[string] }> = [
    { type: "text", text: lines.join("\n") },
  ];
  if (show) {
    const mime = IMAGE_TYPES[extname(dest).toLowerCase()];
    if (got.kind !== "file" || !mime) content.push({ type: "text", text: "(show: only a PNG, JPEG, GIF or WebP file can be shown.)" });
    else if (got.bytes > MAX_IMAGE_BYTES) content.push({ type: "text", text: `(show: it is ${mb(got.bytes)}, too big to show; open the copy instead.)` });
    else content.push({ type: "image", data: (await readFile(dest)).toString("base64"), mimeType: mime });
  }
  return { content };
}

/** `path` as the machine names it: absolute, under its home (~), or in the chat's place there. */
export function remotePath(path: string, there: { cwd: string; home?: string }): string {
  if (/[\0\n\r]/.test(path)) throw new ToolRefusal("`path` has a control character in it.");
  if (path === "~" || path.startsWith("~/")) {
    if (!there.home) throw new ToolRefusal("The machine's home isn't known yet; give an absolute path.");
    return posix.normalize(posix.join(there.home, path.slice(1)));
  }
  if (path.startsWith("~")) throw new ToolRefusal("Only your own home (~/…) can be named with ~; give an absolute path.");
  return posix.normalize(path.startsWith("/") ? path : posix.join(there.cwd, path));
}

async function machineStatus(deps: ToolDeps, args: StatusArgs, call: PluginToolCall): Promise<PluginToolResult> {
  try {
    const name = args.host === undefined ? undefined : text(args.host, "host");
    const all = deps.registry.all();
    if (!all.length) return "No machines are paired. The user pairs one in Settings → Remote hosts.";
    let chosen: Entry[];
    if (name) chosen = [byName(all, name)];
    else {
      const mine = await chatsMachines(all, call.chatId);
      chosen = mine.length ? mine : all;
    }
    const views = new Map(deps.registry.list().map((v) => [v.slug, v]));
    const blocks: string[] = [];
    for (const e of chosen) {
      const v = views.get(e.host.slug);
      if (v) blocks.push(await describe(e, v, call));
    }
    return blocks.join("\n\n");
  } catch (err) {
    if (err instanceof ToolRefusal) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

async function describe(e: Entry, v: HostView, call: PluginToolCall): Promise<string> {
  const p = v.probe;
  const lines = [`${v.label} (terminal location ${v.id}): ${v.status.state}${v.status.detail ? `, ${v.status.detail}` : ""}`];
  const facts: string[] = [];
  if (v.address) facts.push(`at ${v.address}`);
  if (p) {
    const os = [p.os.name, p.os.version].filter(Boolean).join(" ") || p.platform;
    facts.push(`${os} on ${p.arch}`, `user ${p.user}, home ${p.home}`);
    if (p.freeDiskBytes !== null) facts.push(`${gb(p.freeDiskBytes)} free`);
    facts.push(`dispatch-host ${p.agentVersion}`);
  } else {
    facts.push("not reached yet this run, so nothing more is known");
  }
  lines.push(`  ${facts.join(" · ")}`);
  if (p) {
    const tools: string[] = [];
    tools.push(p.tools.git ? "git" : "no git");
    if (p.tools.xcodebuild) tools.push(p.tools.xcodeFirstLaunchDone === false ? "Xcode (license not accepted; xcodebuild won't run)" : "Xcode");
    if (p.brew) {
      const brew = p.brew.blocked ? `Homebrew, blocked: ${p.brew.blocked}` : p.brew.writable ? "Homebrew" : "Homebrew (another account's: usable, not installable into)";
      tools.push(brew);
    }
    if (p.tools.node) tools.push("node");
    if (p.tools.pnpm) tools.push("pnpm");
    lines.push(`  tools: ${tools.join(", ")}`);
    if (p.consoleUser === "root") lines.push("  nobody is logged in at its screen (no desktop session)");
  }
  lines.push(`  root with approval: ${v.elevation.on ? (v.elevation.canAsk ? "on (sudo asks the user)" : "set up, but this Dispatch can't ask the user") : "off (sudo is refused)"}`);
  const act = e.backend.chatActivity(call.chatId);
  const mine: string[] = [];
  if (act.shells.length) mine.push(`terminals ${act.shells.join(", ")}`);
  if (act.servers.length) mine.push(`MCP servers ${act.servers.join(", ")}`);
  if (act.ports.length) mine.push(`forwarded ports ${act.ports.map((f) => `${f.remotePort} → ${f.url}`).join(", ")}`);
  lines.push(`  this chat there: ${mine.length ? mine.join("; ") : "nothing running"}`);
  if (v.status.state !== "offline") {
    try {
      const there = await withTimeout(e.backend.whereThere(call.chatId, call.cwd, call.signal as unknown as AbortSignal), 5_000);
      lines.push(`  this chat's ${there.checkout ? `checkout there: ${there.checkout} (your working directory is ${there.cwd})` : `directory there: ${there.cwd}`}`);
    } catch {
      /* not reachable right now: the status line says so */
    }
  }
  return lines.join("\n");
}

/** The one machine a call means: `name`, else the one this chat uses, else the only one paired. */
async function pickOne(registry: HostRegistry, chatId: string, name: string | undefined): Promise<Entry> {
  const all = registry.all();
  if (!all.length) throw new ToolRefusal("No machines are paired. The user pairs one in Settings → Remote hosts.");
  if (name) return byName(all, name);
  const mine = await chatsMachines(all, chatId);
  if (mine.length === 1) return mine[0]!;
  if (!mine.length && all.length === 1) return all[0]!;
  const among = (mine.length ? mine : all).map((e) => e.host.label).join(", ");
  throw new ToolRefusal(
    mine.length
      ? `This chat uses more than one machine (${among}); say which with \`host\`.`
      : `This chat hasn't used a machine yet, and more than one is paired (${among}); say which with \`host\`.`,
  );
}

async function chatsMachines(all: Entry[], chatId: string): Promise<Entry[]> {
  const known = await Promise.all(all.map((e) => e.backend.knowsChat(chatId).catch(() => false)));
  return all.filter((_, i) => known[i]);
}

function byName(all: Entry[], name: string): Entry {
  const n = name.trim().toLowerCase();
  const e = all.find((x) => x.host.slug === n || x.host.label.toLowerCase() === n || backendId(x.host.slug) === n);
  if (!e) throw new ToolRefusal(`No paired machine is called ${name}. Paired: ${all.map((x) => x.host.label).join(", ")}.`);
  return e;
}

function text(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ToolRefusal(`\`${field}\` must be a string.`);
  return v.trim();
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error("timeout")), ms);
    }),
  ]);
}
