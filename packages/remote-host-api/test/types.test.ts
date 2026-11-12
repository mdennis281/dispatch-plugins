/**
 * The package is types and one constant. These pin the shape callers
 * compile against: a change here is a change to `machines@1`.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { TerminalBackend } from "@dispatch/plugin-sdk";
import { MACHINES, type MachineLease, type MachinesErrorCode, type MachinesV1, type ProvisionedBackend } from "../src/index.js";

describe("machines@1", () => {
  it("names the export a caller declares and asks for", () => {
    expect(MACHINES).toEqual({ plugin: "remote-host", name: "machines", major: 1 });
  });

  it("keeps the contract's shape", () => {
    expectTypeOf<MachinesV1["contract"]>().toEqualTypeOf<{ name: "machines"; major: 1; minor: number }>();
    expectTypeOf<ProvisionedBackend["backend"]>().toEqualTypeOf<TerminalBackend>();
    expectTypeOf<MachineLease["hostKey"]>().toEqualTypeOf<{ pin: string[] } | { trust: "provisioner" }>();
    expectTypeOf<MachinesErrorCode>().toEqualTypeOf<"forbidden" | "bad-lease" | "unreachable" | "host-key-mismatch" | "wrong-machine" | "revoked">();
  });
});
