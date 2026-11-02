/** Session records and the instance's contact stamp, on the host's disk. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { instanceLayout, type SessionRecord } from "./layout.js";
import { sameProcess, type ProcRow } from "./procs.js";

export function readRecord(file: string): SessionRecord | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
  } catch {
    return undefined;
  }
}

/** Write through a temp file and rename, so a reader never sees half a record. */
export function writeRecord(file: string, rec: SessionRecord): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Every session record of `instance`, with the directory it is in. */
export function listRecords(root: string, instance: string): Array<{ dir: string; rec: SessionRecord }> {
  const { sessionsDir } = instanceLayout(root, instance);
  if (!existsSync(sessionsDir)) return [];
  const out: Array<{ dir: string; rec: SessionRecord }> = [];
  for (const name of readdirSync(sessionsDir)) {
    const dir = join(sessionsDir, name);
    const rec = readRecord(join(dir, "session.json"));
    if (rec) out.push({ dir, rec });
  }
  return out;
}

/** Note that Dispatch talked to this instance just now. */
export function touchContact(root: string, instance: string, now = new Date()): void {
  const { dir, contactFile } = instanceLayout(root, instance);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(contactFile, now.toISOString() + "\n", { mode: 0o600 });
}

/** When Dispatch last talked to this instance (epoch ms), or undefined if it never has. */
export function lastContact(root: string, instance: string): number | undefined {
  try {
    return statSync(instanceLayout(root, instance).contactFile).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Whether a session's owner is still the very process that recorded it (pid AND start time). */
export function ownerLive(rows: readonly ProcRow[], rec: SessionRecord): boolean {
  return rec.state !== "exited" && sameProcess(rows, rec.ownerPid, rec.ownerStart);
}

/**
 * Create the record only if there is none: the one relay that wins this
 * starts the owner, so two `session` calls racing on a new id can't start
 * two. False when a record was already there.
 */
export function claimRecord(file: string, rec: SessionRecord): boolean {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}
