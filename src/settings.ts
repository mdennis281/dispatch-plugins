/**
 * The plugin's settings, as Settings → Plugins → Proxmox terminal edits them
 * (settings.schema.json is the form). Read live at every spawn, so a change
 * applies to the next container without restarting anything.
 */
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
  sshUser: "root",
  sshKeyPath: "",
  workDir: "/root/work",
  spawnTimeoutSeconds: 240,
  caCert: "",
  insecureTls: false,
};

/** Merge what is stored over the defaults, coercing the obvious mistakes. */
export function readSettings(raw: Record<string, unknown>): Settings {
  const out: Settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = raw[key];
    if (v === undefined || v === null || v === "") continue;
    const d = DEFAULTS[key];
    if (typeof d === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) (out as unknown as Record<string, unknown>)[key] = n;
    } else if (typeof d === "boolean") {
      (out as unknown as Record<string, unknown>)[key] = v === true || v === "true";
    } else {
      (out as unknown as Record<string, unknown>)[key] = String(v).trim();
    }
  }
  return out;
}
