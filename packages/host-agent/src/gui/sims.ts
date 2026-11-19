/**
 * Simulators, through `xcrun simctl`, from inside the login session.
 *
 * Every chat gets its OWN device, a clone of one base device, so chats sharing
 * the Mac never boot, erase or install over each other's. The base is made
 * once, from the newest iOS runtime and the newest iPhone it supports, and is
 * never booted. Someone who wants every chat to start from a prepared device
 * (settings, a signed-in account) can boot the base once, set it up, and
 * shut it down: clones made after that start from it.
 *
 * simctl runs with Xcode's developer directory. The shell's is the Command
 * Line Tools', which have no simctl.
 */
import { existsSync } from "node:fs";
import { XCODE_DEVELOPER_DIR } from "../git-env.js";
import type { Run } from "./launchd.js";

export interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
}

export interface SimDeviceType {
  identifier: string;
  name: string;
}

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
}

/** What chats' devices are made from. */
export interface SimChoice {
  runtime: SimRuntime;
  deviceType: SimDeviceType;
}

export type SimCheck = { usable: true; choice: SimChoice } | { usable: false; reason: string };

/** The base every chat's device is cloned from. Named for what it is, so a newer runtime gets a new base. */
export function baseName(c: SimChoice): string {
  return `Dispatch base (${c.deviceType.name}, ${c.runtime.name})`;
}

/** A chat's device. The instance is shortened: names show in Xcode's device list. */
export function chatDeviceName(instance: string, chat: string): string {
  return `Dispatch ${instance.slice(0, 8)} ${chat}`;
}

/** simctl's environment: Xcode's developer directory, whatever the caller's is. */
export function simEnv(base: NodeJS.ProcessEnv, xcode = XCODE_DEVELOPER_DIR): NodeJS.ProcessEnv {
  const env = { ...base };
  const dev = env.DEVELOPER_DIR;
  if (!(dev && /\.app\/Contents\/Developer\/?$/.test(dev)) && existsSync(xcode)) env.DEVELOPER_DIR = xcode;
  return env;
}

function versionKey(v: string): number[] {
  return v.split(".").map((n) => Number(n) || 0);
}

function newer(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

interface RawRuntime {
  identifier?: string;
  name?: string;
  version?: string;
  platform?: string;
  isAvailable?: boolean;
  supportedDeviceTypes?: Array<{ identifier?: string; name?: string; productFamily?: string }>;
}

/** The newest available iOS runtime and the newest iPhone it runs, from `simctl list -j runtimes`. */
export function chooseSim(json: string): SimCheck {
  let raw: { runtimes?: RawRuntime[] };
  try {
    raw = JSON.parse(json);
  } catch {
    return { usable: false, reason: "simctl printed something that isn't its JSON" };
  }
  const ios = (raw.runtimes ?? []).filter(
    (r) => r.isAvailable !== false && r.identifier && r.version && (r.platform === "iOS" || /\.iOS-/.test(r.identifier)),
  );
  if (!ios.length) {
    return {
      usable: false,
      reason: "no iOS Simulator runtime is installed (Xcode → Settings → Components, or `xcodebuild -downloadPlatform iOS`)",
    };
  }
  ios.sort((a, b) => newer(b.version!, a.version!));
  for (const r of ios) {
    const phones = (r.supportedDeviceTypes ?? []).filter(
      (d) => d.identifier && d.name && (d.productFamily === "iPhone" || /iPhone/.test(d.identifier)),
    );
    const phone = phones.at(-1); // simctl lists them oldest first
    if (phone) {
      return {
        usable: true,
        choice: {
          runtime: { identifier: r.identifier!, name: r.name ?? `iOS ${r.version}`, version: r.version! },
          deviceType: { identifier: phone.identifier!, name: phone.name! },
        },
      };
    }
  }
  return { usable: false, reason: "the installed iOS runtimes support no iPhone" };
}

/** Every device, from `simctl list -j devices`. */
export function parseDevices(json: string): SimDevice[] {
  let raw: { devices?: Record<string, Array<Partial<SimDevice>>> };
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const out: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(raw.devices ?? {})) {
    for (const d of list ?? []) {
      if (!d.udid || !d.name) continue;
      out.push({ udid: d.udid, name: d.name, state: d.state ?? "Unknown", runtime, isAvailable: d.isAvailable !== false });
    }
  }
  return out;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export class Simctl {
  constructor(
    private readonly run: Run,
    private readonly env: () => NodeJS.ProcessEnv,
  ) {}

  private async simctl(args: string[], timeoutMs = 60_000) {
    return this.run("/usr/bin/xcrun", ["simctl", ...args], timeoutMs, simEnv(this.env()));
  }

  private fail(what: string, r: { code: number; stderr: string; stdout: string }): Error {
    return new Error(`simctl ${what} exited ${r.code}: ${firstLine(r.stderr || r.stdout)}`);
  }

  /** Whether chats can have Simulators here, and what they'd be. */
  async check(): Promise<SimCheck> {
    const r = await this.simctl(["list", "-j", "runtimes"], 30_000);
    if (r.code !== 0) {
      const why = firstLine(r.stderr || r.stdout);
      if (/license/i.test(why)) {
        return { usable: false, reason: "Xcode's license isn't accepted (the Mac's owner runs `sudo xcodebuild -license accept`)" };
      }
      if (/unable to find utility|not a developer tool|xcode-select/i.test(why)) {
        return { usable: false, reason: "Xcode isn't installed (simctl comes with it, not with the Command Line Tools)" };
      }
      return { usable: false, reason: `simctl won't run: ${why || `exit ${r.code}`}` };
    }
    return chooseSim(r.stdout);
  }

  async devices(): Promise<SimDevice[]> {
    const r = await this.simctl(["list", "-j", "devices"], 30_000);
    if (r.code !== 0) throw this.fail("list devices", r);
    return parseDevices(r.stdout);
  }

  /** The base device for `choice`, made if it isn't there. */
  async base(choice: SimChoice): Promise<string> {
    const name = baseName(choice);
    const have = (await this.devices()).find((d) => d.name === name && d.isAvailable);
    if (have) return have.udid;
    const r = await this.simctl(["create", name, choice.deviceType.identifier, choice.runtime.identifier]);
    const udid = r.stdout.trim();
    if (r.code !== 0 || !UDID.test(udid)) throw this.fail("create", r);
    return udid;
  }

  /** A new device named `name`, cloned from `base` (which must be shut down: it is never booted by us). */
  async clone(base: string, name: string): Promise<string> {
    const r = await this.simctl(["clone", base, name], 120_000);
    const udid = r.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (r.code !== 0 || !UDID.test(udid)) throw this.fail("clone", r);
    return udid;
  }

  /** Shut a device down. A device already shut down, or gone, is fine. */
  async shutdown(udid: string): Promise<void> {
    const r = await this.simctl(["shutdown", udid]);
    if (r.code !== 0 && !/current state: Shutdown|Invalid device|not found/i.test(r.stderr + r.stdout)) throw this.fail("shutdown", r);
  }

  /** Delete a device (shutting it down first). One already gone is fine. */
  async delete(udid: string): Promise<void> {
    await this.shutdown(udid).catch(() => {});
    const r = await this.simctl(["delete", udid]);
    if (r.code !== 0 && !/Invalid device|not found/i.test(r.stderr + r.stdout)) throw this.fail("delete", r);
  }
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
