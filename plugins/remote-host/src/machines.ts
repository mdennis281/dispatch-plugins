/**
 * `machines@1`: remote-host running what happens on machines other plugins
 * provision (the plugin-dependencies design §2). Served through core's
 * `ctx.provides` where this Dispatch has it; on an older one, nothing is
 * served and remote-host works as before.
 *
 * A caller gets only what it made: its own provisioned backends, never the
 * paired machines, another caller's machines, or remote-host's secrets. Core
 * names the caller (`PluginCaller`, from its validated manifest), and
 * everything kept for it is under `x/<callerId>/`.
 */
import type { PluginCaller, PluginContext, PluginLog } from "@dispatch/plugin-sdk";
import { errText, type SshTarget } from "@dispatch-plugins/remote-core";
import type { MachinesV1, ProvisionedBackendOptions } from "@dispatch-plugins/remote-host-api";
import type { AgentBundle, RuntimeSource } from "./agent.js";
import type { LinkConnection } from "./link.js";
import { MachinesError } from "./machines-error.js";
import { ProvisionedMachines, callerPrefixes, forgetChatRecords, type ProvisionedDeps } from "./provisioned.js";
import type { ReservedPort } from "./ports.js";
import type { RunsView } from "./sync/run-lock.js";

/** This export's minor version: what a caller can feature-detect (`contract.minor`). */
export const MACHINES_MINOR = 0;

/** A backend id as core takes it (`TERMINAL_BACKEND_ID_PATTERN`). */
const BACKEND_ID = /^(?:[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,47}$/;

/** Reconciles in a row a caller must be gone for before what is kept for it goes (a mid-update plugin is briefly unreadable). */
export const CALLER_GONE_RECONCILES = 3;

export interface MachinesServiceDeps {
  instanceId: string;
  log: PluginLog;
  kv?: PluginContext["kv"];
  agent: AgentBundle;
  runtime: RuntimeSource;
  runs?: RunsView;
  reservedPorts?: () => Promise<readonly ReservedPort[]>;
  agentTools?: boolean;
  /** A location's name by backend id (paired machines'), for the lock's messages. */
  where?: (backend: string) => string | undefined;
  /** Whether a backend is one of remote-host's paired machines, for the lock. */
  paired?: (backend: string) => boolean;
  /** `ctx.provides.dependents()`: the installed plugins that use remote-host, any state. */
  dependents?: () => Array<{ id: string }>;
  /** Tests. */
  connect?: (target: SshTarget) => LinkConnection;
  overrides?: Partial<Pick<ProvisionedDeps, "timing" | "shell" | "sync" | "portPollMs" | "lockWaitMs" | "mcpLocalRoot">>;
}

export class MachinesService {
  private readonly backends = new Set<ProvisionedMachines>();
  private disposed = false;

  constructor(private readonly d: MachinesServiceDeps) {}

  /** Serve `machines@1` (during activate only). True when this Dispatch has plugin dependencies. */
  serve(ctx: PluginContext): boolean {
    const provides = (ctx as { provides?: NonNullable<PluginContext["provides"]> }).provides;
    if (!provides) return false;
    provides.serve<MachinesV1>("machines", 1, (caller) => this.api(caller));
    return true;
  }

  /** What one caller gets: its own factory of provisioned backends. */
  api(caller: PluginCaller): MachinesV1 {
    return {
      contract: { name: "machines", major: 1, minor: MACHINES_MINOR },
      createProvisionedBackend: (opts) => this.create(caller, opts).facade(),
    };
  }

  /** Is `backend` one of the provisioned backends served now? */
  serves(backend: string): boolean {
    for (const b of this.backends) if (b.id === backend) return true;
    return false;
  }

  /** The lock's "is this run remote-host's": paired machines, and every provisioned backend. */
  mine = (backend: string): boolean => this.serves(backend) || !!this.d.paired?.(backend);

  /** A location's name, for the lock: a paired machine's label, a provisioned backend's, or its id. */
  where = (backend: string): string => {
    for (const b of this.backends) if (b.id === backend) return b.label;
    return this.d.where?.(backend) ?? backend;
  };

  /** The provisioned backends with a machine for `chatId` this run (the agent's tools). */
  forChat(chatId: string): ProvisionedMachines[] {
    return [...this.backends].filter((b) => b.knows(chatId));
  }

  /**
   * Dispatch listed the chats that exist. What is kept for any other chat of
   * any caller goes (running or not: a caller that is off can't say). Then a
   * caller no longer installed for {@link CALLER_GONE_RECONCILES} reconciles
   * in a row has everything kept for it removed.
   */
  async reconcile(live: ReadonlySet<string>): Promise<void> {
    const kv = this.d.kv;
    if (!kv) return;
    try {
      for (const k of await kv.list("pchat:x/")) {
        const cut = k.lastIndexOf(":");
        const chatId = k.slice(cut + 1);
        if (live.has(chatId)) continue;
        const base = k.slice("pchat:".length, cut);
        const running = [...this.backends].find((b) => b.base === base);
        if (running) await running.forgetChat(chatId);
        else await forgetChatRecords(kv, base, chatId);
      }
      await this.collectCallers();
    } catch (err) {
      this.d.log.warn(`remote-host: tidying what other plugins' machines left failed: ${errText(err)}`);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.backends].map((b) => b.dispose()));
    this.backends.clear();
  }

  private create(caller: PluginCaller, opts: ProvisionedBackendOptions): ProvisionedMachines {
    if (this.disposed || caller.signal.aborted) throw new MachinesError("revoked", "remote-host is shutting down");
    if (!caller.capabilities.includes("terminals")) {
      throw new MachinesError("forbidden", `${caller.name} may not run terminals (it wasn't granted the \`terminals\` capability)`);
    }
    if (!opts || typeof opts !== "object") throw new Error("createProvisionedBackend needs its options");
    if (typeof opts.id !== "string" || !BACKEND_ID.test(opts.id) || opts.id === "local") {
      throw new Error(`createProvisionedBackend: ${JSON.stringify(opts.id)} isn't a backend id`);
    }
    if (typeof opts.label !== "string" || !opts.label.trim() || opts.label.length > 80) throw new Error("createProvisionedBackend: `label` must be 1 to 80 characters");
    if (typeof opts.provision !== "function") throw new Error("createProvisionedBackend: `provision` must be a function");
    if (!opts.io || typeof opts.io.publishPort !== "function") throw new Error("createProvisionedBackend: `io.publishPort` must be a function");
    if (/^remote-host\//.test(opts.id) || this.serves(opts.id)) throw new Error(`createProvisionedBackend: ${opts.id} is already served`);
    const pm = new ProvisionedMachines(
      opts,
      {
        callerId: caller.id,
        signal: caller.signal as unknown as AbortSignal,
        instanceId: this.d.instanceId,
        log: this.d.log,
        ...(this.d.kv ? { kv: this.d.kv } : {}),
        agent: this.d.agent,
        runtime: this.d.runtime,
        ...(this.d.runs ? { runs: this.d.runs } : {}),
        where: this.where,
        mine: this.mine,
        ...(this.d.reservedPorts ? { reservedPorts: this.d.reservedPorts } : {}),
        ...(this.d.agentTools ? { agentTools: true } : {}),
        ...(this.d.connect ? { connect: this.d.connect } : {}),
        ...this.d.overrides,
      },
      () => this.backends.delete(pm),
    );
    this.backends.add(pm);
    this.d.log.info(`remote-host: serving ${opts.id} (${opts.label}) for ${caller.id}`);
    return pm;
  }

  private async collectCallers(): Promise<void> {
    const kv = this.d.kv;
    const dependents = this.d.dependents?.();
    // Without the list there is no telling who is gone: keep everything.
    if (!kv || !dependents) return;
    const present = new Set(dependents.map((d) => d.id));
    const callers = new Set<string>();
    for (const kind of ["served:", "sync:", "pchat:", "ptoken:"]) {
      const all = `${kind}x/`;
      for (const k of await kv.list(all)) {
        const caller = k.slice(all.length).split("/")[0];
        if (caller) callers.add(caller);
      }
    }
    for (const k of await kv.list("pgone:")) callers.add(k.slice("pgone:".length));
    for (const caller of callers) {
      const counter = `pgone:${caller}`;
      if (present.has(caller)) {
        await kv.delete(counter);
        continue;
      }
      const n = ((await kv.get<{ n?: number }>(counter).catch(() => undefined))?.n ?? 0) + 1;
      if (n < CALLER_GONE_RECONCILES) {
        await kv.set(counter, { n });
        continue;
      }
      for (const prefix of callerPrefixes(caller)) for (const k of await kv.list(prefix)) await kv.delete(k);
      await kv.delete(counter);
      this.d.log.info(`remote-host: removed what it kept for ${caller}'s machines; ${caller} is no longer installed`);
    }
  }
}

