/**
 * The wire between a client (`dispatch-host gui …` run over SSH, or
 * `dispatch-gui` in a chat shell) and the GUI agent's unix socket.
 *
 * It reuses the session protocol's frames (protocol.ts): `[type u8][len u32][payload]`.
 * A client writes ONE request frame. For most requests the agent answers with
 * one reply frame and closes. For `run` it answers `started`, then streams
 * the child's stdout/stderr as output frames and ends with `exit`. The client
 * may send `signal` frames meanwhile. A client that goes away (its socket
 * closes) takes its run with it: the agent kills the child's process group.
 *
 * Both Dispatch instances on a machine (stable and dev) talk to the same GUI
 * agent, possibly from different builds. So an agent must answer every request
 * an older client sends, and a client must cope with an older agent: a reply
 * of `{ ok: false, code: "unknown-op" }` means "update the agent", never a crash.
 */
import { F } from "../protocol.js";

/** Bumped when a request or reply gains something an older peer must know about. */
export const GUI_PROTOCOL_VERSION = 1;

/** Frame types. Client → agent below 0x80, agent → client from 0x80. */
export const GF = {
  /** JSON {@link GuiRequest}. The first and (except for signals) only frame a client sends. */
  request: 0x20,
  /** JSON `{ signal }`: deliver a signal to the run's process group. */
  signal: F.signal,
  /** JSON {@link GuiReply}. */
  reply: 0xa0,
  /** JSON {@link RunStarted}. */
  started: 0xa1,
  /** u64 offset + bytes, as protocol.ts's output frames. */
  stdout: F.stdout,
  stderr: F.stderr,
  /** JSON {@link RunExit}. */
  exit: F.exit,
} as const;

/** Who a request is for. Every lease and run belongs to one chat of one instance. */
export interface ChatRef {
  instance: string;
  chat: string;
}

export type GuiRequest =
  | { v: number; op: "status" }
  | {
      v: number;
      op: "run";
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      /** The chat shell it came from, when it came from one: its runs end with the chat. */
      instance?: string;
      chat?: string;
      sid?: string;
    }
  | ({ v: number; op: "sim" } & ChatRef)
  | ({ v: number; op: "safari"; release?: boolean } & ChatRef)
  /**
   * Keep the Safari lease of whichever of `chats` holds it, without starting
   * anything: the plugin sends this while a chat has a command running there
   * (core's runs in flight, E28), so a long test doesn't lose Safari mid-run.
   */
  | { v: number; op: "renew"; instance: string; chats: string[] }
  | {
      v: number;
      op: "release";
      instance: string;
      /** One chat, or (absent) every chat of the instance. */
      chat?: string;
      /** The chat (or instance) is gone for good: delete its Simulator too, not just shut it down. */
      forget?: boolean;
    };

export type GuiOp = GuiRequest["op"];

export type GuiErrorCode =
  /** An older agent that doesn't know the op. */
  | "unknown-op"
  | "bad-request"
  /** The Simulator can't be used on this machine (no Xcode, license, no runtime). */
  | "sim-unavailable"
  /** Another chat holds the Safari lease. */
  | "leased"
  | "spawn-failed"
  | "internal";

export type GuiReply<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; code: GuiErrorCode; error: string };

export interface RunStarted {
  runId: string;
  pid: number;
}

export interface RunExit {
  code: number | null;
  signal: string | null;
}

/** A window on the Mac's screen that waits for a human: a permission prompt, an installer, an alert. */
export interface Dialog {
  /** The process that owns it (`kCGWindowOwnerName`). Titles need Screen Recording, so this is all there is. */
  owner: string;
  pid: number;
  /** Why it counts: a known dialog process, or a modal panel. */
  kind: "known" | "modal";
}

export interface SimLease {
  udid: string;
  name: string;
  runtime?: string;
  deviceType?: string;
  createdAt: string;
}

export interface SafariLease extends ChatRef {
  port: number;
  since: string;
  /** Renewed by every `dispatch-gui safari`; dropped (and safaridriver stopped) when it passes. */
  expiresAt: string;
}

/** What `status` answers, and `dispatch-host gui status` prints when the agent answers. */
export interface GuiAgentStatus {
  agentVersion: string;
  protocol: number;
  pid: number;
  startedAt: string;
  /** The build directory it runs from (`agent/<build>/`). */
  build: string;
  /** A newer build is installed and the agent restarts into it once nothing of its own is running. */
  upgradePending?: string;
  /** The login session it runs in. Null when the window server couldn't be asked. */
  session: { user: string; onConsole: boolean | null; screenLocked: boolean | null } | null;
  /** Windows waiting for a human. Null when they couldn't be listed (`dialogsError` says why). */
  dialogs: Dialog[] | null;
  dialogsError?: string;
  simulators: { usable: boolean; reason?: string; runtime?: string; deviceType?: string };
  runs: number;
  sims: number;
  safari?: SafariLease;
  /** How long since any Dispatch instance last talked to this machine. */
  silentForMs: number;
}
