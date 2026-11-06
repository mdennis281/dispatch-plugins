/**
 * The command lines for Tier B.
 *
 * For the plugin, over SSH (`dispatch-host gui <sub>`), each printing one line of JSON:
 *   gui install                       place this build (never backwards), write the plist, load it if someone is logged in
 *   gui status                        the agent's status, or why there is none (client.ts `GuiState`)
 *   gui release --instance I [--chat C] [--forget]
 *                                     a chat went idle (or was deleted, --forget); without --chat, every chat of I
 *   gui renew --instance I --chats C1,C2
 *                                    keep the Safari lease of whichever of those chats holds it (they have runs in flight)
 *   gui uninstall                     boot it out, remove the plist
 *   gui serve                         (launchd) the agent itself
 *
 * For the agent in a chat shell, `dispatch-gui <sub>` (a shim on the shell's PATH):
 *   dispatch-gui run [--] CMD [ARGS…]  run CMD in the Mac's login session, output here
 *   dispatch-gui sim                   print this chat's own Simulator's UDID (cloned on first use)
 *   dispatch-gui safari [--release]    lease real Safari: print safaridriver's URL
 *   dispatch-gui status                what the GUI agent says, or why there isn't one
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { assertId } from "../layout.js";
import { guiCall, guiRun, guiState, installGui, uninstallGui, GUI_UNAVAILABLE, type GuiState } from "./client.js";
import { guiPaths } from "./launchd.js";
import type { GuiAgentStatus, SafariLease, SimLease } from "./protocol.js";
import { GuiServer, readGuiState } from "./server.js";

export interface GuiCliContext {
  root: string;
  home: string;
  /** This bundle's own path. */
  script: string;
  print: (v: unknown) => void;
}

/** Ask the agent to let go of a chat (or a whole instance). When it can't be asked and the chat is gone, leave a note for it. */
export async function releaseGui(
  ctx: Pick<GuiCliContext, "root" | "home">,
  instance: string,
  chat: string | undefined,
  forget: boolean,
): Promise<{ answered: boolean; pending?: boolean; runs?: number; sims?: string[]; safari?: boolean; errors?: string[] }> {
  const p = guiPaths(ctx.root, ctx.home);
  const r = await guiCall<{ runs: number; sims: string[]; safari: boolean; errors?: string[] }>(
    p.socket,
    { op: "release", instance, ...(chat ? { chat } : {}), ...(forget ? { forget: true } : {}) },
    120_000,
  );
  if (r?.ok) {
    const { ok: _ok, ...rest } = r;
    return { answered: true, ...rest };
  }
  // Nothing running there now; but a deleted chat's Simulator must still go, when the agent next starts.
  if (forget) {
    const state = readGuiState(p.state);
    const has = Object.values(state.sims).some((s) => s.instance === instance && (!chat || s.chat === chat));
    if (has) {
      mkdirSync(p.pending, { recursive: true, mode: 0o700 });
      writeFileSync(posix.join(p.pending, `${instance}.${chat ?? "*"}`), `${new Date().toISOString()}\n`, { mode: 0o600 });
      return { answered: false, pending: true };
    }
  }
  return { answered: false };
}

export async function guiMain(sub: string, opts: Record<string, string>, flags: Set<string>, ctx: GuiCliContext): Promise<number> {
  switch (sub) {
    case "install":
      ctx.print(await installGui(ctx));
      return 0;
    case "status":
      ctx.print(await guiState(ctx));
      return 0;
    case "uninstall":
      ctx.print(await uninstallGui(ctx));
      return 0;
    case "renew": {
      const instance = assertId("instance", opts.instance);
      const chats = (opts.chats ?? "").split(",").filter(Boolean).map((c) => assertId("chat", c));
      const r = await guiCall<{ renewed: boolean; expiresAt?: string }>(guiPaths(ctx.root, ctx.home).socket, { op: "renew", instance, chats }, 30_000);
      ctx.print(r?.ok ? { renewed: r.renewed, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}) } : { renewed: false, ...(r ? { error: r.error } : { answered: false }) });
      return 0;
    }
    case "release": {
      const instance = assertId("instance", opts.instance);
      const chat = opts.chat === undefined ? undefined : assertId("chat", opts.chat);
      ctx.print(await releaseGui(ctx, instance, chat, flags.has("forget")));
      return 0;
    }
    case "serve": {
      const server = new GuiServer({ root: ctx.root, home: ctx.home, script: ctx.script });
      try {
        await server.start();
      } catch (e) {
        server.log(`not starting: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      const bye = (sig: string) => {
        server.log(`${sig}: stopping`);
        void server.stop().finally(() => process.exit(0));
      };
      process.on("SIGTERM", () => bye("SIGTERM"));
      process.on("SIGINT", () => bye("SIGINT"));
      process.on("SIGHUP", () => bye("SIGHUP"));
      return -1; // keep running
    }
    default:
      throw new Error(`unknown gui command ${JSON.stringify(sub)} (install, status, release, renew, uninstall, serve)`);
  }
}

const HELP = `dispatch-gui: run things in this Mac's login session (Tier B)

  dispatch-gui run [--] CMD [ARGS…]   run CMD in the login session; its output comes here, Ctrl-C stops it.
                                      For UI tests, the Simulator, Playwright WebKit, anything that needs the screen.
  dispatch-gui sim                    print this chat's own Simulator's UDID (made on first use; also $DISPATCH_SIM_UDID
                                      in shells started after that)
  dispatch-gui safari [--release]     lease the Mac's real Safari (one chat at a time): prints safaridriver's URL.
                                      Run it again within 30 min to keep the lease; --release gives it back.
  dispatch-gui status                 the GUI agent's state
`;

export interface DispatchGuiIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  onSignal?: (forward: (sig: NodeJS.Signals) => void) => void;
}

/** `dispatch-gui …`, in a chat shell. Returns the exit code. */
export async function dispatchGui(argv: readonly string[], ctx: Pick<GuiCliContext, "root" | "home">, io: DispatchGuiIo): Promise<number> {
  const [sub, ...rest] = argv;
  const say = (s: string) => io.stderr.write(`dispatch-gui: ${s}\n`);
  const chat = () => {
    const instance = io.env.DISPATCH_HOST_INSTANCE;
    const c = io.env.DISPATCH_HOST_CHAT;
    if (!instance || !c) throw new Error("not in a Dispatch chat shell (DISPATCH_HOST_INSTANCE / DISPATCH_HOST_CHAT are unset)");
    return { instance: assertId("instance", instance), chat: assertId("chat", c) };
  };
  const p = guiPaths(ctx.root, ctx.home);
  /** Why there's no agent, for a human. */
  const why = async (): Promise<string> => explain(await guiState(ctx));

  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.stdout.write(HELP);
      return sub ? 0 : 2;

    case "status": {
      const s = await guiState(ctx);
      io.stdout.write(JSON.stringify(s, null, 2) + "\n");
      return s.state === "running" ? 0 : GUI_UNAVAILABLE;
    }

    case "run": {
      const args = rest[0] === "--" ? rest.slice(1) : rest;
      if (!args.length) {
        say("run needs a command: dispatch-gui run xcodebuild test …");
        return 2;
      }
      let ref: { instance?: string; chat?: string; sid?: string } = {};
      try {
        ref = { ...chat(), ...(io.env.DISPATCH_HOST_SID ? { sid: io.env.DISPATCH_HOST_SID } : {}) };
      } catch {
        /* outside a chat shell: the run belongs to nobody, and ends with its client */
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(io.env)) if (typeof v === "string") env[k] = v;
      const r = await guiRun(p.socket, { op: "run", argv: args, cwd: io.cwd, env, ...ref }, io);
      if (typeof r === "number") return r;
      say(r.code === GUI_UNAVAILABLE ? `${r.error}: ${await why()}` : r.error);
      return r.code;
    }

    case "sim": {
      const r = await guiCall<SimLease>(p.socket, { op: "sim", ...chat() }, 5 * 60_000);
      if (!r) {
        say(await why());
        return GUI_UNAVAILABLE;
      }
      if (!r.ok) {
        say(r.error);
        return 1;
      }
      io.stdout.write(`${r.udid}\n`);
      return 0;
    }

    case "safari": {
      const release = rest.includes("--release");
      const r = await guiCall<SafariLease & { renewed?: boolean; released?: boolean }>(p.socket, { op: "safari", ...chat(), ...(release ? { release } : {}) }, 60_000);
      if (!r) {
        say(await why());
        return GUI_UNAVAILABLE;
      }
      if (!r.ok) {
        say(r.error);
        return 1;
      }
      if (release) {
        say(r.released ? "Safari released" : "this chat didn't hold Safari");
        return 0;
      }
      io.stdout.write(`http://127.0.0.1:${r.port}\n`);
      say(`Safari is this chat's until ${r.expiresAt} (run \`dispatch-gui safari\` again to keep it; --release to give it back)`);
      return 0;
    }

    default:
      say(`unknown command ${JSON.stringify(sub)}`);
      io.stderr.write(HELP);
      return 2;
  }
}

/** One sentence on why there's no GUI agent to use, and what a human does about it. */
export function explain(s: GuiState): string {
  switch (s.state) {
    case "running":
      return "the GUI agent is running";
    case "no-gui-session":
      return (
        `nobody is logged in at the Mac as ${s.user}${s.consoleUser && s.consoleUser !== "root" ? ` (the screen shows ${s.consoleUser})` : ""}, ` +
        `so there is no login session to run in: this machine is Tier A only. Someone has to log in as ${s.user} at the Mac ` +
        `(after a reboot with FileVault on, nobody is).`
      );
    case "not-loaded":
      return `launchd hasn't loaded the GUI agent${s.detail ? ` (${s.detail})` : ""}; logging out and in at the Mac as ${s.user} loads it.`;
    case "not-answering":
      return `the GUI agent isn't answering${s.detail ? ` (${s.detail})` : ""}.`;
    case "unsupported":
      return s.detail;
  }
}

export type { GuiAgentStatus };
