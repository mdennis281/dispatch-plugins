/**
 * Cleaning up after sessions whose owner can no longer do it.
 *
 * A live owner kills its own tree: when the shell exits, on a KILL, and once
 * Dispatch has been silent past the heartbeat timeout. Two cases are left:
 *
 * - **The owner died first** (crashed, OOM-killed). Its shell and anything it
 *   started are orphans. The sweep finds them from the record the owner kept
 *   (the shell's pid, which is also its session id, plus tracked escapees).
 * - **Dead-man switch.** No Dispatch has talked to this instance for
 *   `deadManMs`, so every session of it still alive is killed, owner and all.
 *   That's the backstop if a watchdog never fires. "Talked" means anything
 *   that touches the instance's `contact` stamp: a heartbeat, an attach, or any
 *   CLI call.
 *
 * The sweep runs whenever the plugin connects (`dispatch-host sweep`) and
 * every minute inside every live owner. So any session of an instance reaps
 * its crashed siblings, and no persistent daemon is needed for it.
 *
 * Exited sessions' directories (journal, record) are removed once they are
 * `keepExitedMs` old.
 */
import { rmSync } from "node:fs";
import { socketPath } from "./layout.js";
import { killTree, type KillIo } from "./procs.js";
import { lastContact, listRecords, writeRecord } from "./records.js";
import type { SessionRecord } from "./layout.js";
import { join } from "node:path";

export interface SweepOptions {
  root: string;
  instance: string;
  /** Epoch ms. */
  now: number;
  /** Dead-man switch: kill every session once there has been no contact for this long. */
  deadManMs: number;
  /** Remove an exited session's directory this long after it exited. Default 24 h. */
  keepExitedMs?: number;
  /** The calling process, never signalled. */
  self: number;
  /** The caller's own session, skipped (an owner sweeping its siblings). */
  selfSid?: string;
  io: KillIo;
}

export interface SweepResult {
  /** Sessions whose owner was gone; their trees were killed. */
  reaped: string[];
  /** Live sessions the dead-man switch killed. */
  deadMan: string[];
  /** Exited sessions whose directories were removed. */
  removed: string[];
}

export async function sweepInstance(o: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { reaped: [], deadMan: [], removed: [] };
  const contact = lastContact(o.root, o.instance);
  const silentFor = contact === undefined ? 0 : o.now - contact;
  const records = listRecords(o.root, o.instance);
  if (!records.length) return result;
  const rows = await o.io.listProcs();
  for (const { dir, rec } of records) {
    if (rec.sid === o.selfSid) continue;
    if (rec.state === "exited") {
      const at = Date.parse(rec.exit?.at ?? rec.startedAt);
      if (Number.isFinite(at) && o.now - at > (o.keepExitedMs ?? 24 * 3_600_000)) {
        rmSync(dir, { recursive: true, force: true });
        result.removed.push(rec.sid);
      }
      continue;
    }
    const owner = rows.find((r) => r.pid === rec.ownerPid);
    const ownerLive = Boolean(owner) && (!rec.ownerStart || owner!.start === rec.ownerStart);
    if (!ownerLive) {
      await killTree(o.io, { root: rec.shellPid, tracked: rec.tracked, self: o.self });
      finish(dir, rec, o, "killed", "its owner process was gone");
      result.reaped.push(rec.sid);
    } else if (silentFor > o.deadManMs) {
      await killTree(o.io, { root: rec.shellPid, tracked: rec.tracked, self: o.self });
      if (rec.ownerPid !== o.self) o.io.kill(rec.ownerPid, "SIGKILL");
      finish(dir, rec, o, "dead-man", `no Dispatch contact for ${Math.round(silentFor / 3_600_000)}h`);
      result.deadMan.push(rec.sid);
    }
  }
  return result;
}

function finish(dir: string, rec: SessionRecord, o: SweepOptions, reason: string, detail: string): void {
  writeRecord(join(dir, "session.json"), {
    ...rec,
    state: "exited",
    exit: { code: null, signal: "SIGKILL", reason, detail, at: new Date(o.now).toISOString() },
  });
  rmSync(socketPath(o.root, o.instance, rec.sid), { force: true });
}
