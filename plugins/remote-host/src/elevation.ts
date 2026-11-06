/**
 * Running a command as root on a paired machine, with the user's approval.
 *
 * THE RULE: the approval gate is enforced OFF the machine. The agent's own
 * account there (`dispatch`) has no sudo password, no NOPASSWD rule and no
 * credential cache, and nothing it can do elevates anything. Instead:
 *
 * 1. `sudo <cmd>` or `dispatch-elevate <cmd>` in a chat shell sends the
 *    request up the session's channel (host-agent's elevate.ts, shims.ts).
 * 2. Here, the user is asked (`ctx.approvals.request`, core E31), with the
 *    exact command, its directory, the machine and the chat.
 * 3. Only on approval, the plugin logs in over a SEPARATE connection with the
 *    machine's elevation key (`REMOTE_HOST_ELEVATE_KEY_<SLUG>`, held only
 *    here) as a hidden account whose one authorized_keys line forces a
 *    root-owned helper (`/usr/local/libexec/dispatch-elevate`). The helper
 *    logs the request and runs it with `sudo -n`, which only that account may.
 * 4. Its output and exit code go back down to the waiting `dispatch-elevate`.
 *
 * One elevation at a time per machine; a second waits its turn. A request
 * waiting on the user holds its shell as stalled, so core pauses the running
 * command's timeout (up to core's 10 min cap; the approval itself times out
 * after 5). Cancelling the command (Ctrl-C, the shell ending) withdraws the
 * approval card, or stops the command there.
 */
import type { PluginLog } from "@dispatch/plugin-sdk";
import { checkElevate, ELEVATE_ID, type ElevateEndMsg, type ElevateRequestMsg } from "@dispatch-plugins/host-agent";
import { SshConnection, channelExit, errText, pinnedHostKey, type SshTarget } from "@dispatch-plugins/remote-core";
import type { ClientChannel } from "ssh2";
import { dialFamily, hostKeyAlgorithms, type HostConfig } from "./hosts.js";

/** The hidden account on the machine that the elevation key logs in as. */
export const ELEVATE_USER = "_dispatchelevate";
/** The root-owned helper its key is forced to run. */
export const HELPER_PATH = "/usr/local/libexec/dispatch-elevate";

/**
 * What the helper is asked to run, as the SSH command (the forced command
 * reads it from `SSH_ORIGINAL_COMMAND`): `run <id> <base64>`, the base64 of
 * the directory and every argument, each ended by a NUL. Nothing in it is
 * ever parsed by a shell.
 */
export function runCommand(id: string, cwd: string, argv: readonly string[]): string {
  if (!ELEVATE_ID.test(id)) throw new Error("bad elevation id");
  const payload = [cwd, ...argv].map((s) => `${s}\0`).join("");
  return `run ${id} ${Buffer.from(payload, "utf8").toString("base64")}`;
}

/** A command as a person reads it: words bare, anything else single-quoted. */
export function displayCommand(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

// ---- core E31, feature-detected: older Dispatches have no `ctx.approvals`.

export interface ApprovalRequest {
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  machine?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface ApprovalResult {
  decision: "approved" | "denied" | "timeout" | "cancelled";
  /** Who answered, when someone did. */
  by?: string;
  at: number;
}

export interface Approvals {
  request(chatId: string, req: ApprovalRequest): Promise<ApprovalResult>;
}

/** `ctx.approvals`, when this Dispatch has it (and the plugin declared the capability). */
export function approvalsOf(ctx: unknown): Approvals | undefined {
  const a = (ctx as { approvals?: { request?: unknown } } | undefined)?.approvals;
  return a && typeof a.request === "function" ? (a as Approvals) : undefined;
}

// ----

/** One shell's side of an elevation: answer it, and hold the shell while it waits. HostShell is one. */
export interface ElevationShell {
  elevateOutput(id: string, stream: 1 | 2, data: Buffer): void;
  elevateEnd(m: ElevateEndMsg): void;
  hold(id: string, detail: string): void;
  release(id: string): void;
}

/** The connection the elevation key logs in with. `SshConnection` is one; tests pass fakes. */
export interface ElevationConnection {
  connect(deadlineMs: number, signal?: AbortSignal): Promise<void>;
  channel(command: string): Promise<ClientChannel>;
  close(): void;
}

export interface ElevationDeps {
  host: () => HostConfig;
  /** The address the machine last answered at with its pinned key. */
  address: () => string | undefined;
  /** The elevation key, if elevation is set up on this machine. */
  key: () => Promise<string | undefined>;
  /** Absent: this Dispatch can't ask for approval, so nothing is ever elevated. */
  approvals?: Approvals;
  log: PluginLog;
  connect?: (target: SshTarget) => ElevationConnection;
  /** How long the user has to answer. Default 300 (core's default too). */
  approvalTimeoutSeconds?: number;
  /** How long logging in as the helper's account may take. */
  connectTimeoutMs?: number;
}

/** Where a request came from, for the approval card and the log. */
export interface ElevationOrigin {
  chatId: string;
  /** The terminal's name. */
  terminal: string;
}

interface Job {
  id: string;
  origin: ElevationOrigin;
  shell: ElevationShell;
  abort: AbortController;
}

/** Whether this machine can elevate now, for the agent note. */
export type ElevationState = "on" | "off" | "unsupported";

const DONE_KEPT = 256;

export class Elevation {
  private readonly active = new Map<string, Job>();
  /** Recently finished ids: the owner sends open requests again after a reconnect, and one may have just finished. */
  private readonly done = new Set<string>();
  private busy = false;
  private readonly waiting: Array<() => void> = [];
  private stateNow?: ElevationState;

  constructor(private readonly deps: ElevationDeps) {}

  /** Whether elevation is set up here (as last seen), for the agent note. Undefined until {@link refresh} ran. */
  get state(): ElevationState | undefined {
    return this.stateNow;
  }

  /** Look again: the key may have been added or removed (the Settings pane, the other instance). */
  async refresh(): Promise<ElevationState> {
    const state: ElevationState = !this.deps.approvals ? "unsupported" : (await this.deps.key().catch(() => undefined)) ? "on" : "off";
    this.stateNow = state;
    return state;
  }

  /** A shell's `dispatch-elevate` asked. Answers it (always, unless the id is unusable), however it ends. */
  async handle(req: ElevateRequestMsg, origin: ElevationOrigin, shell: ElevationShell): Promise<void> {
    if (typeof req.id !== "string" || !ELEVATE_ID.test(req.id)) {
      this.deps.log.warn(`remote-host ${this.deps.host().slug}: an elevation request with an unusable id was ignored`);
      return;
    }
    const id = req.id;
    if (this.active.has(id) || this.done.has(id)) return; // sent again after a reconnect
    const job: Job = { id, origin, shell, abort: new AbortController() };
    this.active.set(id, job);
    let end: Omit<ElevateEndMsg, "id">;
    try {
      end = await this.process(job, req);
    } catch (err) {
      end = { code: null, error: `elevation failed: ${errText(err)}` };
    } finally {
      this.active.delete(id);
      this.done.add(id);
      if (this.done.size > DONE_KEPT) this.done.delete(this.done.values().next().value!);
      shell.release(id);
    }
    shell.elevateEnd({ id, ...end });
  }

  /** The asker went away (Ctrl-C): withdraw the card, or stop the command there. */
  cancel(id: string): void {
    this.active.get(id)?.abort.abort();
  }

  /** The shell ended: everything it asked for is withdrawn. */
  cancelShell(shell: ElevationShell): void {
    for (const job of this.active.values()) if (job.shell === shell) job.abort.abort();
  }

  private async process(job: Job, req: ElevateRequestMsg): Promise<Omit<ElevateEndMsg, "id">> {
    const host = this.deps.host();
    const label = host.label;
    const { id, shell, abort } = job;
    const note = (line: string) => shell.elevateOutput(id, 2, Buffer.from(`dispatch-elevate: ${line}\n`, "utf8"));
    let msg;
    try {
      msg = checkElevate(req);
    } catch (err) {
      return { code: null, error: errText(err) };
    }
    const cmd = displayCommand(msg.argv);
    const approvals = this.deps.approvals;
    if (!approvals) {
      return {
        code: null,
        error:
          `nothing can run as root on ${label}: this Dispatch has no way to ask the user for approval (it needs a newer ` +
          `Dispatch). Don't try to work around it; tell the user what needs root, and why.`,
      };
    }
    if (!(await this.deps.key())) {
      return {
        code: null,
        error:
          `elevation isn't set up on ${label}, so nothing can run as root there. The user can turn it on in Settings → ` +
          `Remote hosts → ${label}. Don't try to work around it; tell the user what needs root, and why.`,
      };
    }

    // One at a time per machine: a card the user is reading says exactly what will run, and nothing else does meanwhile.
    if (this.busy) {
      note(`another command is waiting for approval or running as root on ${label}; this one waits its turn`);
      shell.hold(id, `waiting for another root command on ${label} to finish`);
    }
    if (!(await this.acquire(abort.signal))) return { code: null, error: "cancelled while it waited its turn; nothing ran" };
    try {
      note(`asking the user to approve running this as root on ${label}: ${cmd}`);
      shell.hold(id, `waiting for the user to approve: sudo ${cmd}`.slice(0, 180));
      const where = `${job.origin.chatId}/${job.origin.terminal}`;
      let answer: ApprovalResult;
      try {
        answer = await approvals.request(job.origin.chatId, {
          title: `Run as root on ${label}`,
          detail:
            `A command in this chat's terminal "${job.origin.terminal}" on ${label} asked for root (sudo). Approving runs ` +
            `it once, as root, in that directory, with no input. Nothing else is allowed by it.`,
          command: cmd,
          cwd: msg.cwd,
          machine: label,
          timeoutSeconds: this.deps.approvalTimeoutSeconds ?? 300,
          signal: abort.signal,
        });
      } catch (err) {
        if (abort.signal.aborted) return { code: null, error: "cancelled; nothing ran" };
        return { code: null, error: `asking the user for approval failed (${errText(err)}); nothing ran` };
      }
      shell.release(id);
      const by = answer.by ? ` by ${answer.by}` : "";
      this.deps.log.info(`remote-host ${host.slug}: elevation ${id} from ${where}: ${cmd} → ${answer.decision}${by}`);
      if (abort.signal.aborted || answer.decision === "cancelled") return { code: null, error: "cancelled; nothing ran" };
      if (answer.decision === "denied") return { code: null, error: `the user denied running this as root${by}; nothing ran` };
      if (answer.decision !== "approved") {
        return { code: null, error: `no answer from the user within ${this.deps.approvalTimeoutSeconds ?? 300} s; nothing ran` };
      }
      note(`approved${by}; running as root on ${label}`);
      return await this.run(job, msg.cwd, msg.argv);
    } finally {
      this.releaseTurn();
    }
  }

  /** Log in as the helper's account with the elevation key, and run it there. */
  private async run(job: Job, cwd: string, argv: string[]): Promise<Omit<ElevateEndMsg, "id">> {
    const host = this.deps.host();
    const key = await this.deps.key();
    if (!key) return { code: null, error: `elevation was turned off on ${host.label} meanwhile; nothing ran` };
    const address = this.deps.address() ?? host.addresses[0]!;
    const family = dialFamily(address, host.allowFrom);
    const target: SshTarget = {
      host: address,
      port: host.port,
      username: ELEVATE_USER,
      privateKey: key,
      hostVerifier: pinnedHostKey(host.hostKey),
      algorithms: { serverHostKey: hostKeyAlgorithms(host.hostKeyType) as never },
      // A dead link is noticed in about 15 s, like the shells'.
      keepalive: { intervalMs: 5_000, countMax: 3 },
      ...(family ? { family } : {}),
    };
    const conn = this.deps.connect ? this.deps.connect(target) : (new SshConnection(target) as ElevationConnection);
    const { abort, shell, id } = job;
    try {
      try {
        await conn.connect(this.deps.connectTimeoutMs ?? 20_000, abort.signal);
      } catch (err) {
        if (abort.signal.aborted) return { code: null, error: "cancelled; nothing ran" };
        const why = errText(err);
        return {
          code: null,
          error: /authentication/i.test(why)
            ? `${host.label} refused the elevation key, so nothing ran. Elevation may have been removed there; the user ` +
              `can turn it off and set it up again in Settings → Remote hosts.`
            : /host denied/i.test(why)
              ? `a different host key answered at ${address}; nothing ran`
              : `could not reach ${host.label} to run it (${why}); nothing ran`,
        };
      }
      let ch: ClientChannel;
      try {
        ch = await conn.channel(runCommand(id, cwd, argv));
      } catch (err) {
        return { code: null, error: `the root helper on ${host.label} did not start (${errText(err)}); nothing ran` };
      }
      // Cancelled while the channel opened: the helper may have started it already, and stops it once the channel closes.
      if (abort.signal.aborted) {
        try {
          ch.close();
        } catch {
          /* closed already */
        }
        return { code: null, error: `cancelled as it started; ${host.label} was told to stop it` };
      }
      return await new Promise<Omit<ElevateEndMsg, "id">>((resolve) => {
        let code: number | null = null;
        let signal: string | null = null;
        let exited = false;
        // The helper stops the command when its stdin closes, so closing the channel is the cancel.
        const onAbort = () => {
          try {
            ch.close();
          } catch {
            /* closed already */
          }
        };
        abort.signal.addEventListener("abort", onAbort, { once: true });
        ch.on("data", (d: Buffer) => shell.elevateOutput(id, 1, d));
        ch.stderr.on("data", (d: Buffer) => shell.elevateOutput(id, 2, d));
        ch.on("exit", (c: number | null, s?: string) => {
          exited = true;
          code = typeof c === "number" ? c : null;
          signal = s ?? null;
        });
        ch.on("error", () => {
          /* 'close' follows */
        });
        ch.on("close", () => {
          abort.signal.removeEventListener("abort", onAbort);
          if (abort.signal.aborted) return resolve({ code: null, error: `cancelled while it ran; ${host.label} was told to stop it` });
          // A quick command's exit can come before these listeners did (remote-core's channelExit).
          const early = exited ? undefined : channelExit(ch);
          if (early) {
            exited = true;
            code = early.code;
            signal = early.signal ?? null;
          }
          if (!exited) {
            return resolve({
              code: null,
              error: `the connection to ${host.label} ended while it ran; it was stopped there, or it may have finished`,
            });
          }
          resolve({ code, ...(signal ? { signal } : {}) });
        });
      });
    } finally {
      conn.close();
    }
  }

  /** Wait for this machine's turn. False if cancelled meanwhile. */
  private acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const go = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(go);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(go);
    });
  }

  private releaseTurn(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.busy = false;
  }
}
