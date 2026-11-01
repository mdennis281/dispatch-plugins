/**
 * The plugin's settings, as Settings → Plugins → Proxmox terminal edits them
 * (settings.schema.json is the form). Read live at every spawn, so a change
 * applies to the next container without restarting anything.
 */
import { coerceSettings } from "@dispatch-plugins/remote-core";

export interface Settings {
  apiUrl: string;
  node: string;
  templateVmid: number;
  pool: string;
  bridge: string;
  cores: number;
  memory: number;
  vmidStart: number;
  vmidEnd: number;
  idleStopMinutes: number;
  destroyUnusedDays: number;
  sshUser: string;
  sshKeyPath: string;
  workDir: string;
  spawnTimeoutSeconds: number;
  caCert: string;
  insecureTls: boolean;
}

export const DEFAULTS: Settings = {
  apiUrl: "",
  node: "pve",
  templateVmid: 9000,
  pool: "dispatch-terminals",
  bridge: "vmbr0",
  cores: 2,
  memory: 4096,
  vmidStart: 9001,
  vmidEnd: 9099,
  idleStopMinutes: 30,
  destroyUnusedDays: 7,
  sshUser: "root",
  sshKeyPath: "",
  workDir: "/root/work",
  spawnTimeoutSeconds: 240,
  caCert: "",
  insecureTls: false,
};

/** Merge what is stored over the defaults, coercing the obvious mistakes. */
export function readSettings(raw: Record<string, unknown>): Settings {
  return coerceSettings(DEFAULTS, raw);
}
