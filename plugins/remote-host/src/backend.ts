/**
 * One paired machine as a terminal backend, `remote-host/<slug>`.
 *
 * A shell here is a dispatch-host session: the plugin execs the relay over
 * the machine's SSH connection and speaks host-agent's framed protocol to it
 * (session.ts). A Mac command must never become a PowerShell one, so the
 * backend refuses rather than falls back (`fallback: "refuse"`).
 *
 * A chat in a git repository gets its own checkout on the machine, kept in
 * step around every command by its ChatSync (sync/chat-sync.ts): the shell
 * starts there, and a command whose files can't be synced doesn't run.
 */
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type {
  PluginContext,
  PluginLog,
  TerminalAfterRunInfo,
  TerminalAfterRunResult,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalBeforeRunResult,
  TerminalChatEvent,
  TerminalPortForwardInput,
  TerminalRunInfo,
  TerminalSpawnInfo,
} from "@dispatch/plugin-sdk";
import type { Attribution, ChatDir, ForgetResult } from "@dispatch-plugins/host-agent";
import { CLT_DEVELOPER_DIR, XCODE_DEVELOPER_DIR, assertId, chatWorktreePath, instanceLayout, sq, type ProbeResult } from "@dispatch-plugins/host-agent";
import { errText, git } from "@dispatch-plugins/remote-core";
import type { HostConfig } from "./hosts.js";
import { agentCommand, type HostPaths } from "./install.js";
import type { HostLink } from "./link.js";
import { PortForwards } from "./ports.js";
import { HostShell, type HostShellOptions, type SessionOpener } from "./session.js";
import { ChatSync, DEFAULT_CAP_BYTES, type ChatSyncDeps } from "./sync/chat-sync.js";
import { linkRemote } from "./sync/link-remote.js";
import { repoName } from "./sync/local.js";
import type { RemoteSide } from "./sync/remote.js";

export interface HostBackendDeps {
  host: () => HostConfig;
  link: HostLink;
  instanceId: string;
  log: PluginLog;
  kv?: PluginContext["kv"];
  /** Overrides for tests: heartbeat, stall and give-up timings. */
  shell?: Partial<HostShellOptions>;
  /** Overrides for tests: the size cap, the batch size. */
  sync?: Pick<ChatSyncDeps, "capBytes" | "batchBytes">;
  /** Announce a forwarded port (`ctx.terminals.publishPort` for this backend); returns its withdraw. */
  publish?: (port: TerminalPortForwardInput) => () => void;
  /** Overrides for tests: how often listeners are polled. */
  portPollMs?: number;
}

export class HostBackend implements TerminalBackend {
  readonly shell = "bash" as const;
  readonly fallback = "refuse" as const;
  /** The first connect to a machine may push Node's ~50 MB runtime before the shell starts. */
  readonly spawnTimeoutMs = 5 * 60_000;
  /** A chat's first sync sends its whole worktree; it resumes if cut short, but give it room. */
  readonly runHookTimeoutMs = 30 * 60_000;
  label: string;
  /** The live shell per chat + terminal name, so `beforeRun` can mark its run in the journal. */
  private readonly shells = new Map<string, HostShell>();
  /** Each chat's checkout on the machine, by chat. */
  private readonly syncs = new Map<string, ChatSync>();
  private remote?: RemoteSide;
  /** The chats' dev servers there, forwarded here. */
  readonly ports: PortForwards;
  /** Chats known (this run) to have had a shell here; kv `served:<slug>:<chat>` remembers them across restarts. */
  private readonly served = new Set<string>();
  /**
   * The chats Dispatch says exist (its last reconcile), plus every chat that
   * has had a shell here since. Nothing in it is ever taken for an orphan.
   */
  private live?: Set<string>;
  /** When the last reconcile ran, while its orphan pass still waits for the machine. */
  private orphansSince?: number;
  private cleaning = false;
  /**
   * Chats deleted while the machine couldn't be reached. Core retries each on
   * its own backoff (1 min, 5 min, 15 min, 1 h, then every 6 h), so a Mac that
   * slept an hour would keep a deleted chat's checkout for hours after it
   * woke. These are forgotten the moment the machine is back instead; core's
   * retry then finds nothing left to do. Not kept across a restart: the
   * reconcile after it finds them by their `served:` records.
   */
  private readonly pendingDeletes = new Set<string>();
  private forgetting = false;

  constructor(
    readonly id: string,
    private readonly deps: HostBackendDeps,
  ) {
    this.label = deps.host().label;
    const { link, instanceId } = deps;
    this.ports = new PortForwards({
      list: () => link.agent<Attribution>(["ports", "--instance", instanceId], 30_000),
      dial: (host, port) => link.tcp(host, port),
      online: () => link.connected,
      publish: deps.publish ?? (() => () => {}),
      chats: () => this.chatsWithShells(),
      log: deps.log,
      label: () => this.label,
      ...(deps.portPollMs ? { intervalMs: deps.portPollMs } : {}),
    });
  }

  async spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle> {
    const chatId = assertId("chat", info.chatId);
    const linked = await this.deps.link.ready(info.signal);
    // Before anything is made there, so a delete always knows to clean up here.
    await this.markServed(chatId);
    // In a repository, the shell starts at the same place in the chat's
    // checkout there. The checkout itself is filled by the first command's
    // sync, not here: spawn stays quick.
    const root = await repoTop(info.worktreePath ?? info.repoPath);
    // git reports the top as a real path (macOS's /var is /private/var): compare like with like.
    const local = root ? await realpath(info.cwd).catch(() => info.cwd) : info.cwd;
    const cwd = root
      ? posix.join(chatWorktreePath(linked.paths.root, this.deps.instanceId, chatId, repoName(root)), within(root, local))
      : chatDir(linked.paths, this.deps.instanceId, chatId);
    if (root && this.syncs.get(chatId)?.root !== root) this.syncs.set(chatId, this.chatSync(chatId, root));
    const mk = await this.deps.link.exec(`mkdir -p ${sq(cwd)}`, { timeoutMs: 30_000 });
    if (mk.code !== 0) throw new Error(`could not make ${cwd} on ${this.label}: ${mk.stderr.trim() || `exit ${mk.code}`}`);

    const sid = newSid();
    const instance = this.deps.instanceId;
    const opener: SessionOpener = {
      open: async (resume) => {
        const l = await this.deps.link.ready();
        return this.deps.link.openSession(`exec ${sessionCommand(l.paths, { instance, chatId, sid, cwd, resume })}`);
      },
      killDetached: () => {
        void this.deps.link.agent(["kill", "--instance", instance, "--sid", sid], 15_000).catch((err: unknown) => {
          this.deps.log.info(`remote-host ${this.deps.host().slug}: could not end session ${sid}: ${errText(err)}`);
        });
      },
    };
    const sh = await HostShell.start(opener, { label: this.label, log: this.deps.log, ...this.deps.shell }, info.signal);
    const key = shellKey(info.chatId, info.name);
    this.shells.set(key, sh);
    sh.on("exit", () => {
      if (this.shells.get(key) === sh) this.shells.delete(key);
      // Whatever it was running is over, so it no longer holds the checkout.
      this.syncs.get(chatId)?.releaseTerminal(info.name);
      // Its last shell here is gone, and with it anything it served.
      if (!this.chatsWithShells().has(chatId)) this.ports.dropChat(chatId);
    });
    this.ports.wake();
    // A run is over there, even one core stopped waiting for.
    sh.on("runEnd", (m: { runId: string }) => this.syncs.get(chatId)?.runEnded(m.runId));
    return sh;
  }

  /**
   * End every shell this backend holds, KILL down each channel, and wait
   * (briefly) for the channels to close, so the KILLs are out before the
   * connections go. For teardown: removing the machine, the plugin stopping.
   */
  async killAll(waitMs = 1_500): Promise<void> {
    const shells = [...this.shells.values()];
    this.shells.clear();
    this.ports.dispose();
    for (const sh of shells) sh.kill();
    if (shells.length) await new Promise((r) => setTimeout(r, waitMs).unref?.());
  }

  /** Core unregistered the backend (the machine was removed, or the plugin is going down). */
  dispose(): void {
    this.ports.dispose();
  }

  /**
   * The chat went idle (core retired its session): its shells here end, and
   * with them what they were running. The checkout stays for when it comes
   * back. A machine that can't be reached now ends them itself once their
   * heartbeat stops.
   */
  async onChatIdle(e: TerminalChatEvent): Promise<void> {
    const chatId = e.chatId;
    if (!ID.test(chatId)) return;
    const ended = this.endShells(chatId);
    if (!ended && !(await this.wasServed(chatId))) return;
    if (!this.deps.link.connected) return;
    await this.deps.link.agent(["kill", "--instance", this.deps.instanceId, "--chat", chatId], 30_000).catch((err: unknown) => {
      this.deps.log.info(`remote-host ${this.deps.host().slug}: ending idle chat ${chatId}'s sessions: ${errText(err)}`);
    });
  }

  /**
   * The chat was deleted: its sessions, checkout and records go from the
   * machine. Core retries this until it resolves, so it rejects when the
   * machine can't be reached (asleep, off) and is a no-op for a chat this
   * machine never served, which must not wait for it.
   */
  async onChatDeleted(e: TerminalChatEvent): Promise<void> {
    const chatId = e.chatId;
    if (!ID.test(chatId)) return;
    this.endShells(chatId);
    this.syncs.delete(chatId);
    this.live?.delete(chatId);
    if (!(await this.wasServed(chatId))) return;
    try {
      await this.forget(chatId);
      this.pendingDeletes.delete(chatId);
    } catch (err) {
      if (!this.deps.link.connected) this.pendingDeletes.add(chatId);
      throw err;
    }
  }

  /**
   * Dispatch listed the chats that exist (after every activation). Anything
   * this machine holds for a chat not among them was deleted while the plugin
   * wasn't listening, and goes: now, or once the machine is next reachable.
   */
  reconcile(live: ReadonlySet<string>, at: number): void {
    this.live = new Set([...live, ...this.chatsWithShells()]);
    this.orphansSince = at;
    void this.cleanOrphans();
  }

  /** The link (re)connected: deletes and an orphan pass that were waiting for the machine run. */
  onConnected(): void {
    if (this.pendingDeletes.size) void this.forgetPending();
    if (this.orphansSince !== undefined) void this.cleanOrphans();
  }

  /** Forget the chats deleted while the machine was away. One that fails stays only while it is unreachable: core's retry has the rest. */
  private async forgetPending(): Promise<void> {
    if (this.forgetting) return;
    this.forgetting = true;
    try {
      for (const chat of [...this.pendingDeletes]) {
        try {
          await this.forget(chat);
          this.pendingDeletes.delete(chat);
        } catch (err) {
          if (this.deps.link.connected) this.pendingDeletes.delete(chat);
          this.deps.log.warn(`remote-host ${this.deps.host().slug}: removing deleted chat ${chat}'s files failed: ${errText(err)}`);
        }
      }
    } finally {
      this.forgetting = false;
    }
  }

  /** The plugin is being uninstalled: end every session of this instance there and remove its files. */
  async forgetAll(timeoutMs: number): Promise<void> {
    await this.killAll(0);
    if (!this.deps.link.connected) return;
    await this.deps.link.agent<ForgetResult>(["forget", "--instance", this.deps.instanceId, "--all"], timeoutMs);
  }

  private async cleanOrphans(): Promise<void> {
    const since = this.orphansSince;
    if (since === undefined || this.cleaning || !this.deps.link.connected) return;
    this.cleaning = true;
    const slug = this.deps.host().slug;
    try {
      const prefix = `served:${slug}:`;
      const served = ((await this.deps.kv?.list(prefix)) ?? []).map((k) => k.slice(prefix.length));
      const dirs = await this.deps.link.agent<ChatDir[]>(["chats", "--instance", this.deps.instanceId], 60_000);
      const orphans = new Set<string>();
      const alive = (chat: string) => this.live?.has(chat) || this.chatsWithShells().has(chat);
      for (const chat of served) if (!alive(chat)) orphans.add(chat);
      // A directory with no record (kv was lost): only an old one. A chat made
      // around the time of the listing must never be taken for an orphan.
      for (const d of dirs) if (!alive(d.chat) && d.mtimeMs < since - ORPHAN_GRACE_MS) orphans.add(d.chat);
      // One at a time, each on its own: one that fails (git refusing to run
      // there, say) doesn't keep the others. Any failure leaves the pass
      // pending, to be tried again at the next connect.
      let failed = 0;
      for (const chat of orphans) {
        if (!ID.test(chat) || alive(chat)) continue;
        try {
          await this.forget(chat);
          this.deps.log.info(`remote-host ${slug}: removed chat ${chat}'s files there; it was deleted while Dispatch wasn't watching`);
        } catch (err) {
          failed++;
          this.deps.log.warn(`remote-host ${slug}: removing deleted chat ${chat}'s files there failed: ${errText(err)}`);
        }
      }
      if (!failed && this.orphansSince === since) this.orphansSince = undefined;
    } catch (err) {
      // Stays pending: tried again at the next connect.
      this.deps.log.warn(`remote-host ${slug}: looking for deleted chats' files failed: ${errText(err)}`);
    } finally {
      this.cleaning = false;
    }
  }

  /** Everything this instance keeps for `chatId` on the machine goes, then the records of it here. Rejects while unreachable. */
  private async forget(chatId: string): Promise<void> {
    await this.deps.link.ready();
    const r = await this.deps.link.agent<ForgetResult>(["forget", "--instance", this.deps.instanceId, "--chat", chatId], 50_000);
    this.served.delete(chatId);
    await this.deps.kv?.delete(this.servedKey(chatId));
    await this.deps.kv?.delete(`sync:${chatId}`);
    if (r.removed || r.killed.length) {
      this.deps.log.info(
        `remote-host ${this.deps.host().slug}: deleted chat ${chatId}'s checkout there` + (r.killed.length ? `, ending ${r.killed.length} session(s)` : ""),
      );
    }
  }

  /** End this backend's shells for one chat, and its forwards. Returns how many shells there were. */
  private endShells(chatId: string): number {
    let n = 0;
    for (const [k, sh] of [...this.shells]) {
      if (k.slice(0, k.indexOf("\u0000")) !== chatId) continue;
      this.shells.delete(k);
      sh.kill();
      n++;
    }
    this.ports.dropChat(chatId);
    return n;
  }

  private servedKey(chatId: string): string {
    return `served:${this.deps.host().slug}:${chatId}`;
  }

  private async markServed(chatId: string): Promise<void> {
    this.live?.add(chatId);
    if (this.served.has(chatId)) return;
    try {
      await this.deps.kv?.set(this.servedKey(chatId), { at: Date.now() });
      this.served.add(chatId);
    } catch (err) {
      // Not fatal: reconcile still finds the directory there, by its age.
      this.deps.log.warn(`remote-host ${this.deps.host().slug}: could not record chat ${chatId}: ${errText(err)}`);
    }
  }

  private async wasServed(chatId: string): Promise<boolean> {
    if (this.served.has(chatId)) return true;
    try {
      return (await this.deps.kv?.get(this.servedKey(chatId))) !== undefined;
    } catch {
      return true; // can't tell: clean up rather than leave it
    }
  }

  /** The chats with at least one live shell here. */
  chatsWithShells(): Set<string> {
    return new Set([...this.shells.keys()].map((k) => k.slice(0, k.indexOf("\u0000"))));
  }

  /** Sync the chat's files there (fail closed), then mark the run in the session's journal. */
  async beforeRun(info: TerminalRunInfo): Promise<TerminalBeforeRunResult> {
    const sync = this.syncs.get(info.chatId);
    const r = sync ? await sync.beforeRun(info) : {};
    if (!r.refuse) this.shells.get(shellKey(info.chatId, info.terminal))?.runBegin(info.runId, info.background);
    return r;
  }

  /** Bring back what the command changed there. */
  async afterRun(info: TerminalAfterRunInfo): Promise<TerminalAfterRunResult> {
    return (await this.syncs.get(info.chatId)?.afterRun(info)) ?? {};
  }

  private chatSync(chatId: string, root: string): ChatSync {
    this.remote ??= linkRemote(this.deps.link);
    const host = this.deps.host();
    return new ChatSync({
      chatId,
      root,
      label: host.label,
      slug: host.slug,
      instanceId: this.deps.instanceId,
      hostRoot: async () => (await this.deps.link.ready()).paths.root,
      remote: this.remote,
      log: this.deps.log,
      ...(this.deps.kv ? { kv: this.deps.kv } : {}),
      ...this.deps.sync,
    });
  }

  agentNote(info: { chatId: string }): string {
    const host = this.deps.host();
    const probe = this.deps.link.probe;
    const paths = this.deps.link.paths;
    const where = paths ? chatDir(paths, this.deps.instanceId, info.chatId) : `~/.dispatch-host/…/chats/${info.chatId}`;
    return [
      `- This terminal runs on ${host.label}${describe(probe)}, over SSH as \`${host.user}\`, under dispatch-host. A dropped ` +
        `connection pauses the command and picks it up again; it is not restarted.`,
      `- The shell is the machine's \`/bin/bash\`${probe?.platform === "darwin" ? " (version 3.2 on macOS: no `declare -A`, no `${x,,}`)" : ""}, ` +
        `with PATH and locale from the login shell. On it: ${tools(probe)}.`,
      ...(probe?.platform === "darwin" ? [xcodeNote(probe)] : []),
      ...(probe?.brew ? [brewNote(probe.brew)] : []),
      `- Your files sync with this machine around every command. Before it, your worktree as it is (uncommitted and untracked ` +
        `files too, but not ignored ones) is copied to this chat's own checkout there, under ${where}, and the shell starts ` +
        `at the matching place in it. After it, files the command changed there come back here. Ignored files (node_modules, ` +
        `build output) are NOT synced: install and build there. Untracked files over ${Math.round(DEFAULT_CAP_BYTES / 1024 ** 2)} MB ` +
        `aren't sent.`,
      `- If a file changed both there and here, the next command is refused until you settle it: the machine's version is ` +
        `saved beside yours as \`<file>.from-${host.slug}\`. While one terminal of this chat runs a command there, the others ` +
        `are refused, so files never change under a running command; one that timed out holds every terminal until it ends ` +
        `(Ctrl-C it). Outside a git repository nothing is synced.`,
      `- A server you start in this terminal there (a dev server, say) is forwarded to this computer while the terminal lives: ` +
        `on the same port when it is free here, else on another, which the terminal result and Ports & processes give. Open ` +
        `that URL, not the machine's address. Only listeners on its loopback or on all interfaces are forwarded, and only those ` +
        `started from this chat's terminals; nothing else on the machine is.`,
      `- When this chat goes idle its shells there end, and what they were running with them; deleting the chat deletes its ` +
        `checkout there.`,
      `- Only the terminal tool runs there. Your own Bash, file tools and git still act on THIS computer; commit here, not there.`,
      `- Other chats, and another Dispatch, may share this machine. Never kill processes by name or by port: stop what you ` +
        `started (Ctrl-C the terminal, \`kill %1\`).`,
    ].join("\n");
  }
}

/** Chat ids that are safe as a path component there (dispatch-host's own check). */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A chat directory there newer than this, relative to the reconcile, is never taken for an orphan (clocks differ). */
const ORPHAN_GRACE_MS = 10 * 60_000;

/** A chat's directory on the machine: its checkouts are inside, and a chat outside a repository starts here. */
export function chatDir(paths: HostPaths, instanceId: string, chatId: string): string {
  return posix.join(instanceLayout(paths.root, instanceId).chatsDir, assertId("chat", chatId));
}

/**
 * The top of the git repository `dir` is in, or undefined outside one: a
 * chat with no repository (or a project folder that isn't one) isn't synced,
 * and a sub-directory never stands in for its repository.
 */
export async function repoTop(dir: string | undefined): Promise<string | undefined> {
  if (!dir || !(await stat(dir).catch(() => undefined))?.isDirectory()) return undefined;
  try {
    const top = await git(dir, ["rev-parse", "--show-toplevel"], { LC_ALL: "C" });
    return top ? resolve(top) : undefined;
  } catch (err) {
    if (/not a git repository|must be run in a work tree/i.test(errText(err))) return undefined;
    // A repository git won't read (one it doesn't trust, say) must not pass
    // for no repository: the shell would start in an empty checkout.
    throw new Error(`can't read the git repository at ${dir}, so its files can't be synced: ${errText(err)}`);
  }
}

/** `cwd` relative to `root`, POSIX-style; "" for the root itself or anywhere outside it. */
export function within(root: string, cwd: string): string {
  const rel = relative(root, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "";
  return rel.split(/[\\/]+/).join("/");
}

export function sessionCommand(
  paths: HostPaths,
  s: { instance: string; chatId: string; sid: string; cwd: string; resume?: { out: number; err: number } },
): string {
  return agentCommand(paths, [
    "session",
    "--instance",
    s.instance,
    "--chat",
    s.chatId,
    "--sid",
    s.sid,
    "--cwd",
    s.cwd,
    "--heartbeat-ms",
    String(HEARTBEAT_TIMEOUT_MS),
    ...(s.resume ? ["--resume-out", String(s.resume.out), "--resume-err", String(s.resume.err)] : []),
  ]);
}

/**
 * How long a session waits for Dispatch after its connection drops before
 * the machine ends it. Time asleep doesn't count. Long enough to ride out a
 * Wi-Fi drop and the reconnect after it; short enough that what an abandoned
 * shell started doesn't run on for long.
 */
export const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;

/** A session id: sortable by start, unique, and within dispatch-host's id alphabet. */
export function newSid(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function shellKey(chatId: string, name: string): string {
  return `${chatId}\u0000${name}`;
}

/**
 * A string the machine reported, made safe to put in the agent's prompt: the
 * account on the machine controls its PATH, so a "version" could be
 * anything, instructions included. Only a short, version-like token gets through.
 */
export function token(v: string | null | undefined, max = 32): string | undefined {
  const m = (v ?? "").match(/[A-Za-z0-9][A-Za-z0-9._+-]*/);
  return m ? m[0].slice(0, max) : undefined;
}

function describe(probe: ProbeResult | undefined): string {
  if (!probe) return "";
  const name = (probe.os.name ?? "").match(/^[A-Za-z][A-Za-z ]{0,20}$/)?.[0];
  const os = [name, token(probe.os.version, 16)].filter(Boolean).join(" ") || token(probe.platform, 16) || "unknown OS";
  return ` (${os}, ${token(probe.arch, 16) ?? "?"})`;
}

/**
 * A Mac's developer directories, for the agent. With the Command Line Tools
 * (sync's git runs from them), dispatch-host gives the shell their
 * DEVELOPER_DIR, so git works whatever Xcode's license says; Xcode's tools
 * then need Xcode's, per command.
 */
function xcodeNote(probe: ProbeResult): string {
  const xcode = `\`DEVELOPER_DIR=${XCODE_DEVELOPER_DIR} xcodebuild …\``;
  if (probe.syncGit?.developerDir === CLT_DEVELOPER_DIR) {
    return (
      `- The shell has \`DEVELOPER_DIR=${CLT_DEVELOPER_DIR}\` (unless the login shell sets its own), so git, clang and swift ` +
      `come from the Command Line Tools, which an Xcode update can't block. For Xcode's own tools (xcodebuild, xcrun simctl), ` +
      `override it on that command: ${xcode}. Don't export Xcode's in the shell: git would become Xcode's, which every ` +
      `Xcode update blocks until its license is accepted.`
    );
  }
  return `- If Xcode's tools (xcodebuild, xcrun simctl) say they need Xcode, set its developer directory on that command: ${xcode}.`;
}

/**
 * Homebrew, for the agent: where tools come from on a machine it can't sudo
 * on. When brew is blocked (see host-agent's checkBrew), the agent is told
 * not to work around it, because the fix needs the owner's password.
 */
function brewNote(brew: NonNullable<ProbeResult["brew"]>): string {
  // The machine's own strings go into the prompt only when they look like what they claim to be.
  const at = /^\/[\w./+-]+$/.test(brew.path) ? ` (\`${brew.path}\`)` : "";
  if (brew.blocked) {
    return (
      `- Homebrew is installed there${at} but won't run: Xcode's license isn't accepted, and brew ignores DEVELOPER_DIR. ` +
      `Don't try sudo or work around it; tell the user the Mac's owner has to run ` +
      `\`sudo xcode-select -s ${CLT_DEVELOPER_DIR}\` once.`
    );
  }
  const ver = token(brew.version?.replace(/^\D*(?=\d)/, ""));
  return (
    `- Homebrew${ver ? ` ${ver}` : ""} is installed there${at}: install a tool the machine lacks with ` +
    `\`brew install <formula>\`. No sudo: never \`sudo brew\`. It stays installed for every chat using this machine, so ` +
    `say what you installed.`
  );
}

function tools(probe: ProbeResult | undefined): string {
  if (!probe) return "not probed yet";
  const t = probe.tools;
  const has = (name: string, v: string | null) => {
    // "git version 2.39.2 (Apple Git-143)" → "2.39.2"; "Xcode 14.3.1" → "14.3.1".
    const ver = token(v?.replace(/^\D*(?=\d)/, ""));
    return v ? `${name}${ver ? ` ${ver}` : ""}` : `no ${name}`;
  };
  const list = [has("git", t.git), has("node", t.node), has("pnpm", t.pnpm)];
  if (probe.platform === "darwin") list.push(has("Xcode", t.xcodebuild));
  return list.join(", ");
}
