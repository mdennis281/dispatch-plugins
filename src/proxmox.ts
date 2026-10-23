/**
 * A deliberately small Proxmox VE API client: the dozen calls this plugin
 * makes, over `node:https`, authenticated with an API token.
 *
 * Why not `fetch`: a Proxmox node serves a certificate signed by its own
 * cluster CA, and undici's fetch takes no per-request CA. `https.request` does
 * — so the right fix (paste the node's `pve-root-ca.pem` into the `caCert`
 * setting) is available, and `insecureTls` stays an explicit, named choice
 * rather than a global `NODE_TLS_REJECT_UNAUTHORIZED=0` that would weaken
 * every other HTTPS call the Dispatch server makes.
 *
 * Every call fails LOUDLY with the API's own message: pveproxy has had outages
 * on the box this was written against, and the plugin's job when that happens
 * is to tell Dispatch so it can fall back to a local shell and say why.
 */
import { request } from "node:https";

export interface ProxmoxOptions {
  /** e.g. `https://10.0.0.20:8006` — no trailing `/api2/json`. */
  apiUrl: string;
  /** `USER@REALM!TOKENID=SECRET`, exactly what the `PVEAPIToken=` header wants. */
  token: string;
  caCert?: string;
  insecureTls?: boolean;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
}

export class ProxmoxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class Proxmox {
  constructor(private readonly opts: ProxmoxOptions) {}

  /** One API call. `params` is a query string for GET/DELETE and a form body otherwise. */
  async call<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      form.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    const base = new URL(this.opts.apiUrl.replace(/\/+$/, "") + "/api2/json" + path);
    const body = method === "GET" || method === "DELETE" ? undefined : form.toString();
    if (!body && form.toString()) base.search = form.toString();
    return new Promise<T>((resolve, reject) => {
      const req = request(
        base,
        {
          method,
          headers: {
            Authorization: `PVEAPIToken=${this.opts.token}`,
            ...(body
              ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
              : {}),
          },
          ca: this.opts.caCert || undefined,
          rejectUnauthorized: !this.opts.insecureTls,
          timeout: this.opts.timeoutMs ?? 20_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              // Proxmox puts the useful part in the status line ("401 permission
              // denied - invalid PVE ticket") and sometimes per-field `errors`.
              let detail = res.statusMessage ?? "";
              try {
                const parsed = JSON.parse(text) as { errors?: Record<string, string>; message?: string };
                if (parsed.errors) detail += ` ${JSON.stringify(parsed.errors)}`;
                if (parsed.message) detail += ` ${parsed.message}`;
              } catch {
                /* not JSON — the status line is all there is */
              }
              reject(new ProxmoxError(`Proxmox ${method} ${path} → ${status} ${detail}`.trim(), status));
              return;
            }
            try {
              resolve((JSON.parse(text) as { data: T }).data);
            } catch {
              reject(new ProxmoxError(`Proxmox ${method} ${path}: unreadable response`));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new ProxmoxError(`Proxmox ${method} ${path}: no answer from ${base.host}`)));
      req.on("error", (err) =>
        reject(err instanceof ProxmoxError ? err : new ProxmoxError(`Proxmox API unreachable (${base.host}): ${err.message}`)),
      );
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * Wait for a task (a UPID) to finish; throw with its exit status when it did
   * not end `OK`. Clone, start, stop and destroy are all asynchronous tasks.
   */
  async waitTask(node: string, upid: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new ProxmoxError("cancelled");
      const st = await this.call<{ status: string; exitstatus?: string }>(
        "GET",
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (st.status === "stopped") {
        if (st.exitstatus === "OK") return;
        throw new ProxmoxError(`task ${upid.split(":")[5] ?? ""} failed: ${st.exitstatus ?? "unknown"}`);
      }
      if (Date.now() > deadline) throw new ProxmoxError(`task ${upid} still running after ${timeoutMs / 1000}s`);
      await sleep(1_000, signal);
    }
  }

  /** The IPv4 address of a running container's first non-loopback interface, or undefined. */
  async ipv4(node: string, vmid: number): Promise<string | undefined> {
    const ifaces = await this.call<
      Array<{ name: string; "ip-addresses"?: Array<{ "ip-address": string; "ip-address-type": string }> }>
    >("GET", `/nodes/${encodeURIComponent(node)}/lxc/${vmid}/interfaces`);
    for (const i of ifaces ?? []) {
      if (i.name === "lo") continue;
      const v4 = i["ip-addresses"]?.find((a) => a["ip-address-type"] === "inet" && !a["ip-address"].startsWith("127."));
      if (v4) return v4["ip-address"];
    }
    return undefined;
  }

  async status(node: string, vmid: number): Promise<string | undefined> {
    try {
      const s = await this.call<{ status: string }>("GET", `/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/current`);
      return s.status;
    } catch (err) {
      // 500 "does not exist" — gone is an answer, not an error, here.
      if (err instanceof ProxmoxError && /does not exist|no such|not found/i.test(err.message)) return undefined;
      throw err;
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new ProxmoxError("cancelled"));
      },
      { once: true },
    );
  });
}
