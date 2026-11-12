/**
 * What a chat shell gets for Tier B, besides `dispatch-gui` itself (a shim
 * next to the agent build, written with the others in shims.ts):
 *
 * - `DISPATCH_HOST_INSTANCE`, `DISPATCH_HOST_CHAT`, `DISPATCH_HOST_SID`: whose
 *   shell this is, so `dispatch-gui` can say which chat a run or lease is for.
 * - `DISPATCH_DERIVED_DATA`: the chat's own Xcode DerivedData, inside its
 *   chat directory, so it goes when the chat does. Two chats building one
 *   project must not share one, and Xcode's default is per project, not per chat.
 * - `DISPATCH_SIM_UDID`: the chat's own Simulator, once it has one
 *   (`dispatch-gui sim` makes it). Read from the GUI agent's state file, so
 *   starting a shell never waits on the agent.
 */
import { posix } from "node:path";
import { instanceLayout } from "../layout.js";
import { guiPaths } from "./launchd.js";
import { simFor } from "./server.js";

/** A chat's DerivedData: `<instance>/chats/<chat>/.DerivedData`. A dot, so it can never be a checkout's name. */
export function derivedDataPath(root: string, instance: string, chat: string): string {
  return posix.join(instanceLayout(root, instance).chatsDir, chat, ".DerivedData");
}

export function guiShellEnv(o: { root: string; home: string; instance: string; chat: string; sid: string }): Record<string, string> {
  const env: Record<string, string> = {
    DISPATCH_HOST_INSTANCE: o.instance,
    DISPATCH_HOST_CHAT: o.chat,
    DISPATCH_HOST_SID: o.sid,
    DISPATCH_HOST_ROOT: o.root,
    DISPATCH_DERIVED_DATA: derivedDataPath(o.root, o.instance, o.chat),
  };
  const udid = simFor(guiPaths(o.root, o.home).state, { instance: o.instance, chat: o.chat });
  if (udid) env.DISPATCH_SIM_UDID = udid;
  return env;
}
