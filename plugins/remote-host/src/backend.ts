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
import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type {
  PluginContext,
  PluginLog,
  TerminalAfterRunInfo,
  TerminalAfterRunResult,
  TerminalBackend,
  TerminalBackendHandle,
  TerminalBeforeRunResult,
  TerminalRunInfo,
  TerminalSpawnInfo,
} from "@dispatch/plugin-sdk";
import { assertId, chatWorktreePath, instanceLayout, sq, type ProbeResult } from "@dispatch-plugins/host-agent";
import { errText, git } from "@dispatch-plugins/remote-core";
import type { HostConfig } from "./hosts.js";
import { agentCommand, type HostPaths } from "./install.js";
import type { HostLink } from "./link.js";
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

  constructor(
    readonly id: string,
    private readonly deps: HostBackendDeps,
  ) {
    this.label = deps.host().label;
  }

  async spawn(info: TerminalSpawnInfo): Promise<TerminalBackendHandle> {
    const chatId = assertId("chat", info.chatId);
    const linked = await this.deps.link.ready(info.signal);
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
    });
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
    for (const sh of shells) sh.kill();
    if (shells.length) await new Promise((r) => setTimeout(r, waitMs).unref?.());
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
      `- Your files sync with this machine around every command. Before it, your worktree as it is (uncommitted and untracked ` +
        `files too, but not ignored ones) is copied to this chat's own checkout there, under ${where}, and the shell starts ` +
        `at the matching place in it. After it, files the command changed there come back here. Ignored files (node_modules, ` +
        `build output) are NOT synced: install and build there. Untracked files over ${Math.round(DEFAULT_CAP_BYTES / 1024 ** 2)} MB ` +
        `aren't sent.`,
      `- If a file changed both there and here, the next command is refused until you settle it: the machine's version is ` +
        `saved beside yours as \`<file>.from-${host.slug}\`. While one terminal of this chat runs a command there, the others ` +
        `are refused, so files never change under a running command. Outside a git repository nothing is synced.`,
      `- Only the terminal tool runs there. Your own Bash, file tools and git still act on THIS computer; commit here, not there.`,
      `- Other chats, and another Dispatch, may share this machine. Never kill processes by name or by port: stop what you ` +
        `started (Ctrl-C the terminal, \`kill %1\`).`,
    ].join("\n");
  }
}

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
  if (!dir) return undefined;
  const top = await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => "");
  return top ? resolve(top) : undefined;
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
