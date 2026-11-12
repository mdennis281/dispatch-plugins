/**
 * What `machines@1` throws: an Error with the contract's `code`, which core's
 * membrane carries across to the caller as `PluginCallError.code` (it drops
 * everything else but the message and stack).
 */
import type { MachinesErrorCode } from "@dispatch-plugins/remote-host-api";

export class MachinesError extends Error {
  constructor(
    readonly code: MachinesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MachinesError";
  }
}

/** Whether `err` is one with `code`, from this bundle or (through the membrane) as a plain object. */
export function machinesCode(err: unknown): MachinesErrorCode | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? (code as MachinesErrorCode) : undefined;
}
