/**
 * The bridge between core's MCP relay and a server running on a machine.
 *
 * It sits on the handle's lines, both ways, and maps what crosses machines:
 *
 * - **Roots.** The client's roots are paths on THIS computer, meaningless
 *   there. For Dispatch's bundled servers the bridge answers `roots/list`
 *   itself, with the chat's directory for the server there (first, so a
 *   relative path in a result resolves against it) and the chat's checkout
 *   there, and advertises roots in `initialize` so the server asks.
 * - **Files a result names.** A path there (a screenshot, a snapshot, a
 *   trace) is copied here, into the chat's local folder for the server, and
 *   the result names the copy. Images a server inlines need nothing.
 * - **Files a call names.** A local file in a path argument (an upload, a
 *   `file://` page) is copied there first and the argument rewritten. A local
 *   path that doesn't exist yet is where the agent wants a file saved: the
 *   server saves it there, and the result's copy lands at that local path.
 *
 * Order is kept: lines each way go through one queue, so a result that waits
 * for a copy never overtakes the next line. Core's reconnect contract passes
 * through untouched: `stalled` at once, `resumed` and `exit` after the lines
 * before them.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PluginLog, TerminalProcessHandle } from "@dispatch/plugin-sdk";

/** The process side: a HostShell (or a fake). */
export interface BridgeInner {
  stdin: { write(chunk: string): unknown; end?(): unknown };
  stdout: EventEmitter;
  stderr?: EventEmitter;
  kill(signal?: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface BridgeFiles {
  /** Copy a file there to `local`. False when there is no such file there. Rejects when it can't (too big, no link). */
  fetch(remote: string, local: string): Promise<boolean>;
  /** Copy a local file to `remote` there. */
  upload(local: string, remote: string): Promise<void>;
}

export interface BridgeOptions {
  /** The machine, for messages. */
  label: string;
  /** This chat's directory for the server there: the first root, and where the server's own files go. */
  dir: string;
  /** Where files the agent asks to be saved are written there (inside `dir`). */
  out: string;
  /** The chat's checkout there, and the local worktree it mirrors. */
  checkout?: { remote: string; local: string };
  /** Where copies of the server's files go here. */
  localDir: string;
  /** Answer `roots/list` here (bundled servers); otherwise roots pass through as they are. */
  ownRoots: boolean;
  files: BridgeFiles;
  log?: PluginLog;
  /** Whether local paths are Windows paths. Default: this process's platform. */
  windows?: boolean;
}

/** Larger results than this aren't scanned for paths (a big inline image is base64, never a path). */
const SCAN_MAX = 4 * 1024 * 1024;
/** Characters a path in a result is made of: up to whitespace, quotes, brackets. */
const PATH_CHARS = "[^\\s\"'<>()\\[\\]{}`|,;]";

type Json = Record<string, unknown>;

export class McpBridge extends EventEmitter implements TerminalProcessHandle {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: TerminalProcessHandle["stdin"];

  private inBuf = "";
  private outBuf = "";
  private inQueue: Promise<void> = Promise.resolve();
  private outQueue: Promise<void> = Promise.resolve();
  /** Files the agent asked to have saved, per request id: written there, copied to the local path after. */
  private readonly saves = new Map<string, Array<{ remote: string; local: string }>>();
  /** Local files already copied there, by path + size + mtime. */
  private readonly uploaded = new Map<string, string>();
  /** The other way: an upload's path there → the local file it came from. A result naming it names that file. */
  private readonly uploadedFrom = new Map<string, string>();
  private readonly windows: boolean;
  private ended = false;

  constructor(
    private readonly inner: BridgeInner,
    private readonly o: BridgeOptions,
  ) {
    super();
    this.windows = o.windows ?? process.platform === "win32";
    this.stdin = {
      write: (chunk: string) => {
        this.fromClient(String(chunk));
        return true;
      },
      end: () => {
        this.inQueue = this.inQueue.then(() => void this.inner.stdin.end?.());
      },
      on: () => undefined,
    };
    inner.stdout.on("data", (d: string | Buffer) => this.fromServer(String(d)));
    inner.stderr?.on("data", (d: string | Buffer) => this.stderr.emit("data", String(d)));
    // Stalled now: core must fail calls in flight at once, not after a copy finishes.
    inner.on("stalled", (info?: unknown) => this.emit("stalled", info));
    inner.on("resumed", () => this.afterOut(() => this.emit("resumed")));
    inner.on("error", (err: Error) => this.afterOut(() => this.emit("error", err)));
    inner.on("exit", (code: number | null, reason?: unknown) =>
      this.afterOut(() => {
        this.ended = true;
        if (this.outBuf) this.stdout.emit("data", this.outBuf);
        this.outBuf = "";
        this.emit("exit", code, reason);
      }),
    );
  }

  kill(signal?: string): void {
    this.inner.kill(signal);
  }

  // ---- client → server ------------------------------------------------------

  private fromClient(chunk: string): void {
    this.inBuf += chunk;
    let nl: number;
    while ((nl = this.inBuf.indexOf("\n")) >= 0) {
      const line = this.inBuf.slice(0, nl);
      this.inBuf = this.inBuf.slice(nl + 1);
      this.inQueue = this.inQueue.then(() => this.clientLine(line)).catch((err: unknown) => {
        this.o.log?.warn(`remote-host ${this.o.label}: MCP bridge (to the machine): ${errText(err)}`);
      });
    }
  }

  private async clientLine(line: string): Promise<void> {
    const msg = parse(line);
    if (!msg) return void this.inner.stdin.write(`${line}\n`);
    if (this.o.ownRoots && msg.method === "initialize") {
      const params = (msg.params ??= {}) as Json;
      const caps = (params.capabilities ??= {}) as Json;
      caps.roots = { listChanged: false };
    } else if (this.o.ownRoots && msg.method === "notifications/roots/list_changed") {
      return; // the roots here don't change
    } else if (msg.method === "tools/call" && msg.id !== undefined) {
      const params = msg.params as Json | undefined;
      if (params && params.arguments && typeof params.arguments === "object") {
        try {
          await this.mapArguments(String(msg.id), params.arguments as Json);
        } catch (err) {
          this.saves.delete(String(msg.id));
          // Answered here: the server would only say the file isn't there.
          this.emitLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: errText(err) } });
          return;
        }
      }
    }
    this.inner.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** Rewrite the local paths in a call's arguments into paths there, copying files first. */
  private async mapArguments(id: string, args: Json): Promise<void> {
    const walk = async (holder: Json | unknown[], key: string | number, pathy: boolean, urly: boolean): Promise<void> => {
      const v = (holder as Record<string | number, unknown>)[key];
      if (typeof v === "string") {
        const mapped = urly ? await this.mapUrl(v) : pathy ? await this.mapPath(id, v) : undefined;
        if (mapped !== undefined) (holder as Record<string | number, unknown>)[key] = mapped;
      } else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) await walk(v, i, pathy, urly);
      } else if (v && typeof v === "object") {
        for (const k of Object.keys(v)) await walk(v as Json, k, pathKey(k), urlKey(k));
      }
    };
    for (const k of Object.keys(args)) await walk(args, k, pathKey(k), urlKey(k));
  }

  private async mapUrl(v: string): Promise<string | undefined> {
    if (!v.startsWith("file:")) return undefined;
    let local: string;
    try {
      local = fileURLToPath(v);
    } catch {
      return undefined;
    }
    if (!this.isLocalPath(local) || (await kind(local)) !== "file") return undefined;
    const remote = await this.uploadFile(local);
    return `file://${encodeURI(remote)}`;
  }

  private async mapPath(id: string, v: string): Promise<string | undefined> {
    if (!this.isLocalPath(v)) return undefined;
    const k = await kind(v);
    if (k === "file") return this.uploadFile(v);
    if (k === undefined && (await kind(dirname(v))) === "dir") {
      // Somewhere to save a file: the server writes it there, the copy comes here after.
      const remote = posix.join(this.o.out, `${randomBytes(4).toString("hex")}-${safeName(basename(v))}`);
      const list = this.saves.get(id) ?? [];
      list.push({ remote, local: v });
      this.saves.set(id, list);
      return remote;
    }
    return undefined;
  }

  private async uploadFile(local: string): Promise<string> {
    const st = await stat(local);
    const key = `${local}\0${st.size}\0${st.mtimeMs}`;
    const have = this.uploaded.get(key);
    if (have) return have;
    const tag = createHash("sha256").update(key).digest("hex").slice(0, 10);
    const remote = posix.join(this.o.dir, "uploads", tag, safeName(basename(local)));
    try {
      await this.o.files.upload(local, remote);
    } catch (err) {
      throw new Error(`couldn't copy ${local} to ${this.o.label} for the browser there: ${errText(err)}`);
    }
    this.uploaded.set(key, remote);
    this.uploadedFrom.set(remote, local);
    return remote;
  }

  /** An absolute path on THIS computer, as opposed to one there (or a relative one). */
  private isLocalPath(p: string): boolean {
    if (this.windows) return /^[A-Za-z]:[\\/]/.test(p);
    if (!p.startsWith("/")) return false;
    return !this.remoteRoots().some((r) => within(r, p));
  }

  // ---- server → client ------------------------------------------------------

  private fromServer(chunk: string): void {
    this.outBuf += chunk;
    let nl: number;
    while ((nl = this.outBuf.indexOf("\n")) >= 0) {
      const line = this.outBuf.slice(0, nl);
      this.outBuf = this.outBuf.slice(nl + 1);
      this.outQueue = this.outQueue.then(() => this.serverLine(line)).catch((err: unknown) => {
        this.o.log?.warn(`remote-host ${this.o.label}: MCP bridge (from the machine): ${errText(err)}`);
        this.stdout.emit("data", `${line}\n`);
      });
    }
  }

  private afterOut(fn: () => void): void {
    this.outQueue = this.outQueue.then(fn, fn);
  }

  private emitLine(msg: Json): void {
    if (!this.ended) this.stdout.emit("data", `${JSON.stringify(msg)}\n`);
  }

  private async serverLine(line: string): Promise<void> {
    const msg = line.length <= SCAN_MAX ? parse(line) : undefined;
    if (!msg) return void this.stdout.emit("data", `${line}\n`);
    if (this.o.ownRoots && msg.method === "roots/list" && msg.id !== undefined) {
      this.inner.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { roots: this.roots() } })}\n`);
      return;
    }
    if (msg.id !== undefined && msg.method === undefined && msg.result !== undefined) {
      await this.mapResult(String(msg.id), msg.result);
    } else if (msg.id !== undefined && msg.method === undefined) {
      this.saves.delete(String(msg.id));
    }
    this.emitLine(msg);
  }

  private roots(): Array<{ uri: string; name: string }> {
    const roots = [{ uri: `file://${encodeURI(this.o.dir)}`, name: "dispatch: this chat's files for this server" }];
    if (this.o.checkout) roots.push({ uri: `file://${encodeURI(this.o.checkout.remote)}`, name: "the chat's checkout" });
    return roots;
  }

  private remoteRoots(): string[] {
    return [this.o.dir, ...(this.o.checkout ? [this.o.checkout.remote] : [])];
  }

  /** Copy here the files a result names there, and name the copies instead. */
  private async mapResult(id: string, result: unknown): Promise<void> {
    const notes: string[] = [];
    // path there → what to call it here; filled by saves first, then by what the text names.
    const swap = new Map<string, string>();
    for (const s of this.saves.get(id) ?? []) {
      try {
        if (await this.o.files.fetch(s.remote, s.local)) swap.set(s.remote, s.local);
      } catch (err) {
        notes.push(`[remote-host] ${s.local} wasn't copied from ${this.o.label} (${errText(err)}); it is at ${s.remote} there.`);
      }
    }
    this.saves.delete(id);

    const tokens = new Map<string, string>(); // as written → absolute path there
    const found = (written: string, abs: string) => {
      if (!tokens.has(written)) tokens.set(written, abs);
    };
    const roots = this.remoteRoots();
    const absRe = new RegExp(`(?:file://)?(?:${roots.map(escapeRe).join("|")})(?:/${PATH_CHARS}*)?`, "g");
    const linkRe = /\]\(([^)\s]+)\)/g;
    eachString(result, (s) => {
      for (const m of s.matchAll(absRe)) {
        const written = trimTrailing(m[0]);
        const abs = written.startsWith("file://") ? decodeURIComponentSafe(written.slice(7)) : written;
        found(written, abs);
      }
      for (const m of s.matchAll(linkRe)) {
        const target = m[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) continue;
        const abs = posix.normalize(posix.join(this.o.dir, target.replace(/\\/g, "/")));
        if (roots.some((r) => within(r, abs))) found(target, abs);
      }
    });

    const copied = new Map<string, string>(); // absolute there → local copy
    for (const [remote, local] of swap) copied.set(remote, local);
    // Uploads are known exactly, spaces and all: the scan above stops at whitespace.
    if (this.uploadedFrom.size) {
      const seen = new Set<string>();
      eachString(result, (s) => {
        for (const remote of this.uploadedFrom.keys()) if (s.includes(remote)) seen.add(remote);
      });
      for (const remote of seen) copied.set(remote, this.uploadedFrom.get(remote)!);
    }
    for (const abs of new Set(tokens.values())) {
      if (copied.has(abs) || !roots.some((r) => within(r, abs)) || abs === this.o.dir) continue;
      // The front of a known path with a space in it, cut short by the scan.
      if ([...copied.keys()].some((k) => k.length > abs.length && k.startsWith(abs))) continue;
      const from = this.uploadedFrom.get(abs);
      if (from) {
        copied.set(abs, from); // a file that went there from here: name the original, copy nothing
        continue;
      }
      const local = this.localCopyPath(abs);
      if (!local) continue;
      try {
        if (await this.o.files.fetch(abs, local)) copied.set(abs, local);
      } catch (err) {
        notes.push(`[remote-host] ${abs} is on ${this.o.label} and wasn't copied here: ${errText(err)}.`);
      }
    }
    if (copied.size) {
      // Longest first, so a path is never replaced inside a longer one.
      const pairs: Array<[string, string]> = [];
      for (const [written, abs] of tokens) {
        const local = copied.get(abs);
        if (local) pairs.push([written, written.startsWith("file://") ? pathToFileURL(local).href : local]);
      }
      for (const [remote, local] of copied) if (!tokens.has(remote)) pairs.push([remote, local]);
      pairs.sort((a, b) => b[0].length - a[0].length);
      mapStrings(result, (s) => replaceTokens(s, pairs));
    }
    if (notes.length) {
      const content = (result as Json | undefined)?.content;
      if (Array.isArray(content)) content.push({ type: "text", text: notes.join("\n") });
    }
  }

  /** Where the copy of a file there goes here: under the chat's folder for this server. */
  private localCopyPath(abs: string): string | undefined {
    const from = within(this.o.dir, abs) ? this.o.dir : this.o.checkout && within(this.o.checkout.remote, abs) ? this.o.checkout.remote : undefined;
    if (!from) return undefined;
    const rel = posix.relative(from, abs);
    if (!rel || rel.startsWith("..")) return undefined;
    const base = from === this.o.dir ? this.o.localDir : join(this.o.localDir, "checkout");
    const local = join(base, ...rel.split("/"));
    const back = relative(base, local);
    return back && !back.startsWith("..") && !isAbsolute(back) && !back.split(sep).includes("..") ? local : undefined;
  }
}

/** Argument names that hold a file path: `path`, `paths`, `filename`, `filePath`, `outputFile`, `dir`… */
function pathKey(k: string): boolean {
  return /^(paths?|files?|filenames?|dir|directory)$/i.test(k) || /(Path|Paths|File|Files|Filename|FileName|Dir)$/.test(k);
}

function urlKey(k: string): boolean {
  return /^(url|uri)$/i.test(k) || /(Url|Uri|URL)$/.test(k);
}

function parse(line: string): Json | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const m = JSON.parse(t) as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Json) : undefined;
  } catch {
    return undefined;
  }
}

async function kind(p: string): Promise<"file" | "dir" | undefined> {
  try {
    const st = await stat(p);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : undefined;
  } catch {
    return undefined;
  }
}

/** `abs` is `root` or inside it (POSIX paths there). */
function within(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function eachString(v: unknown, fn: (s: string) => void): void {
  if (typeof v === "string") {
    if (v.length <= SCAN_MAX) fn(v);
  } else if (Array.isArray(v)) for (const x of v) eachString(x, fn);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) if (k !== "data" && k !== "blob") eachString(x, fn);
  }
}

function mapStrings(v: unknown, fn: (s: string) => string): void {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] === "string") v[i] = fn(v[i] as string);
      else mapStrings(v[i], fn);
    }
  } else if (v && typeof v === "object") {
    const o = v as Json;
    for (const k of Object.keys(o)) {
      if (k === "data" || k === "blob") continue;
      if (typeof o[k] === "string") o[k] = fn(o[k] as string);
      else mapStrings(o[k], fn);
    }
  }
}

/** Replace each written path where it stands as a whole token, never inside a longer path. */
function replaceTokens(s: string, pairs: ReadonlyArray<[string, string]>): string {
  let out = s;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) continue;
    const re = new RegExp(`(?<![\\w./\\\\-])${escapeRe(from)}(?![\\w/\\\\-]|\\.\\w)`, "g");
    out = out.replace(re, () => to);
  }
  return out;
}

function trimTrailing(p: string): string {
  return p.replace(/[.:]+$/, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** A file name safe to put in a path there. */
function safeName(name: string): string {
  const n = name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return n || "file";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
