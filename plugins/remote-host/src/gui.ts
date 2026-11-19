/**
 * Tier B, the GUI agent, as the plugin reports it: in the machine's status
 * for a human, and in the agent note for the model.
 *
 * A Mac with nobody logged in at its screen as the paired user has no login
 * session for the GUI agent to run in. FileVault rules out auto-login, so
 * that is every Mac after a reboot until someone logs in. Shells still work
 * (Tier A), so the machine stays usable, but it reports DEGRADED: "Tier A
 * only, log in at the Mac", so the reason the Simulator won't start is on
 * the status line, not discovered by a failing test.
 */
import type { ProbeResult } from "@dispatch-plugins/host-agent";

/** A name the machine reported (a user, a process), safe to show and to put in a prompt. */
export function nameToken(v: string | null | undefined, max = 40): string | undefined {
  const m = (v ?? "").match(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
  return m ? m[0].slice(0, max) : undefined;
}

/** What Tier B adds to the status line: faults (degrade it) and notes (don't). */
export function guiStatus(probe: ProbeResult): { issues: string[]; notes: string[] } {
  const g = probe.gui;
  const issues: string[] = [];
  const notes: string[] = [];
  if (!g || g.state === "unsupported") return { issues, notes };
  const user = nameToken(probe.user) ?? "the paired user";
  switch (g.state) {
    case "no-gui-session": {
      const at = nameToken(g.consoleUser);
      issues.push(
        `Tier A only, log in at the Mac: nobody is logged in there as ${user}` +
          (at && at !== "root" ? ` (the screen shows ${at})` : "") +
          `, so the Simulator, UI tests and Safari can't run`,
      );
      break;
    }
    case "not-loaded":
      issues.push(`Tier A only: the GUI agent isn't loaded${g.detail ? ` (${g.detail})` : ""}; log out and back in at the Mac as ${user}`);
      break;
    case "not-answering":
      issues.push(`the GUI agent isn't answering${g.detail ? ` (${g.detail})` : ""}`);
      break;
    case "running": {
      const a = g.agent;
      const dialogs = (a.dialogs ?? []).map((d) => nameToken(d.owner)).filter(Boolean);
      if (dialogs.length) {
        issues.push(
          `a dialog is waiting on the Mac's screen (${[...new Set(dialogs)].join(", ")}): someone has to answer it there; ` +
            `UI tests and the Simulator stall behind it`,
        );
      }
      if (a.session?.screenLocked) notes.push("the Mac's screen is locked: UI tests may stall until it is unlocked");
      if (a.session && a.session.onConsole === false) {
        notes.push(`${user}'s login session isn't the one on screen (another user's is): UI tests and screenshots may not work`);
      }
      if (!a.simulators.usable && a.simulators.reason) notes.push(`no Simulator: ${a.simulators.reason}`);
      break;
    }
  }
  return { issues, notes };
}

/** The agent note's part about Tier B. */
export function guiNote(probe: ProbeResult | undefined): string | undefined {
  const g = probe?.gui;
  if (!g || g.state === "unsupported") return undefined;
  const user = nameToken(probe?.user) ?? "its user";
  const how =
    "`dispatch-gui run <cmd> [args…]` runs a command inside the Mac's login session and streams its output here; Ctrl-C " +
    "stops it. Use it for anything that needs the screen: `xcodebuild test` (UI tests), `xcrun simctl boot`, Playwright " +
    "WebKit (headless WebKit hangs in a plain shell there), safaridriver. Everything else runs in the terminal as usual.";
  const sim =
    "This chat has its own Simulator: `dispatch-gui sim` prints its UDID (made on first use; shells started afterwards " +
    "also have it as `$DISPATCH_SIM_UDID`). Use only that one, e.g. " +
    "`-destination \"id=$(dispatch-gui sim)\"`; other chats on this Mac have theirs. Build with " +
    '`-derivedDataPath "$DISPATCH_DERIVED_DATA"`, this chat\'s own.';
  const safari =
    "Real Safari is one chat's at a time: `dispatch-gui safari` leases it and prints safaridriver's URL (WebDriver); run " +
    "it again within 30 minutes to keep it, and `dispatch-gui safari --release` when done. If another chat holds it, " +
    "say so; don't wait in a loop.";
  if (g.state !== "running") {
    return (
      `- \`dispatch-gui\` (the Mac's login session: UI tests, the Simulator, Safari, Playwright WebKit) is NOT available ` +
      `now: nobody is logged in at the Mac as ${user}, or its GUI agent isn't running. Commands that need the screen will ` +
      `hang or fail. Don't work around it; tell the user someone has to log in as ${user} at the Mac.`
    );
  }
  const a = g.agent;
  const lines = [`- ${how}`];
  lines.push(a.simulators.usable ? `- ${sim}` : `- No Simulator can be made there now (${a.simulators.reason ?? "unknown"}); tell the user if you need one.`);
  lines.push(`- ${safari}`);
  const dialogs = (a.dialogs ?? []).map((d) => nameToken(d.owner)).filter(Boolean);
  if (dialogs.length) {
    lines.push(
      `- A dialog is open on the Mac's screen (${[...new Set(dialogs)].join(", ")}). Anything that needs the screen may stall ` +
        `behind it; only someone at the Mac can answer it.`,
    );
  }
  return lines.join("\n");
}

/**
 * Whether a server may run in the machine's desktop session now: its GUI
 * agent runs, in the paired user's own session, which is the one on screen.
 * Files go to that user's home, so another user's session won't do. As of
 * the last probe; if the session went since, `dispatch-gui run` fails at once
 * and says why.
 */
export function desktopOf(probe: ProbeResult | undefined): { ok: boolean; why?: string } {
  const g = probe?.gui;
  if (!probe || !g) return { ok: false };
  if (g.state === "unsupported") return { ok: false, why: g.detail };
  if (g.state === "no-gui-session") return { ok: false, why: `nobody is logged in there as ${probe.user}` };
  if (g.state !== "running") return { ok: false, why: "its GUI agent isn't answering" };
  if (probe.consoleUser && probe.consoleUser !== probe.user) {
    return { ok: false, why: `the screen shows another user's session, not ${probe.user}'s` };
  }
  return { ok: true };
}
