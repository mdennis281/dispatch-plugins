/**
 * Windows on the Mac's screen that wait for a human: a permission prompt, the
 * "install the command line developer tools?" offer, a keychain password, a
 * crash alert. Each stops whatever is behind it (a UI test, a codesign, a
 * Simulator boot) with no error, so the health probe names them.
 *
 * Asked of the window server from inside the login session (only the GUI
 * agent can), through JXA's bridge to CoreGraphics:
 *
 * - `CGWindowListCopyWindowInfo` gives every on-screen window's owner and
 *   layer. Window TITLES need Screen Recording, which would itself be a
 *   prompt, so they are never asked for; the owner is enough to say what it is.
 * - `CGSessionCopyCurrentDictionary` says whether this session is the one on
 *   the screen and whether it is locked.
 *
 * No Apple Events, so no Automation prompt either.
 */
import type { Dialog } from "./protocol.js";
import { runFile, type Run } from "./launchd.js";

/** Processes whose windows are always a question for a human. */
export const DIALOG_OWNERS: ReadonlySet<string> = new Set([
  "CoreServicesUIAgent", // Gatekeeper: "… downloaded from the Internet", app verification
  "UserNotificationCenter", // CFUserNotification alerts: crashes, kernel extensions, some consent prompts
  "SecurityAgent", // authorization and keychain password prompts
  "coreautha", // LocalAuthentication: password / Touch ID
  "universalAccessAuthWarn", // "… would like to control this computer using accessibility features"
  "Install Command Line Developer Tools",
  "CoreLocationAgent",
  "Software Update",
  "Setup Assistant", // after a macOS update, per user, at the next login
  "Problem Reporter",
]);

/** System chrome that is on screen all the time; never a dialog, whatever its layer. */
const CHROME: ReadonlySet<string> = new Set([
  "Window Server",
  "WindowServer",
  "Dock",
  "SystemUIServer",
  "Control Center",
  "Notification Center",
  "NotificationCenter",
  "Spotlight",
  "Wallpaper",
  "TextInputMenuAgent",
  "TextInputSwitcher",
  "loginwindow",
  "WindowManager",
]);

/** `kCGModalPanelWindowLevel`: a sheet or alert that blocks its app. */
const MODAL_LAYER = 8;

export interface ScreenWindow {
  owner: string;
  pid: number;
  layer: number;
  alpha?: number;
  w?: number;
  h?: number;
}

export interface ScreenState {
  session: { user: string; onConsole: boolean | null; screenLocked: boolean | null } | null;
  windows: ScreenWindow[] | null;
  error?: string;
}

/**
 * The JXA program. Prints one line of JSON. It says `ObjC["import"]`, not
 * `ObjC.import`: the same call, but the bundle test would read the other as a
 * module import.
 */
export const SCREEN_JXA = `
ObjC["import"]("CoreGraphics");
function un(r) { return r ? ObjC.deepUnwrap(ObjC.castRefToObject(r)) : null; }
var out = {};
try { out.session = un($.CGSessionCopyCurrentDictionary()); } catch (e) { out.sessionError = String(e); }
try {
  // kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16); kCGNullWindowID (0)
  var w = un($.CGWindowListCopyWindowInfo(1 | 16, 0)) || [];
  out.windows = w.map(function (x) {
    var b = x.kCGWindowBounds || {};
    return { owner: String(x.kCGWindowOwnerName || ''), pid: x.kCGWindowOwnerPID | 0, layer: x.kCGWindowLayer | 0,
             alpha: x.kCGWindowAlpha, w: b.Width, h: b.Height };
  });
} catch (e) { out.windowsError = String(e); }
JSON.stringify(out);
`;

/** Turn the JXA's output into a {@link ScreenState}. Tolerates anything. */
export function parseScreen(stdout: string): ScreenState {
  let raw: {
    session?: Record<string, unknown> | null;
    windows?: unknown;
    sessionError?: string;
    windowsError?: string;
  };
  try {
    raw = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return { session: null, windows: null, error: `unreadable: ${stdout.trim().slice(0, 200) || "no output"}` };
  }
  const s = raw.session;
  const bool = (v: unknown) => (v === undefined || v === null ? null : Boolean(v));
  const session = s
    ? {
        user: String(s.kCGSSessionUserNameKey ?? ""),
        onConsole: bool(s.kCGSSessionOnConsoleKey),
        // Absent when unlocked, on every macOS that has it.
        screenLocked: s.CGSSessionScreenIsLocked === undefined ? false : Boolean(s.CGSSessionScreenIsLocked),
      }
    : null;
  const windows = Array.isArray(raw.windows)
    ? (raw.windows as ScreenWindow[]).filter((w) => w && typeof w.owner === "string" && typeof w.pid === "number")
    : null;
  const error = [raw.sessionError, raw.windowsError].filter(Boolean).join("; ") || undefined;
  return { session, windows, ...(error ? { error } : {}) };
}

/** The windows that are waiting for someone, one per owning process. */
export function findDialogs(windows: readonly ScreenWindow[]): Dialog[] {
  const out = new Map<string, Dialog>();
  for (const w of windows) {
    if (!w.owner || CHROME.has(w.owner)) continue;
    if (w.alpha !== undefined && w.alpha <= 0) continue;
    // A sliver (a status item, a 1-pixel tracking window) is never a dialog.
    if ((w.w ?? 100) < 40 || (w.h ?? 100) < 40) continue;
    const kind = DIALOG_OWNERS.has(w.owner) ? "known" : w.layer === MODAL_LAYER ? "modal" : undefined;
    if (!kind) continue;
    const key = `${w.owner}\0${w.pid}`;
    if (!out.has(key)) out.set(key, { owner: w.owner, pid: w.pid, kind });
  }
  return [...out.values()];
}

/** Ask the window server. Only meaningful from inside a login session. */
export async function readScreen(run: Run = runFile): Promise<ScreenState> {
  const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", SCREEN_JXA], 15_000);
  if (r.code !== 0) {
    return { session: null, windows: null, error: `osascript exited ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}` };
  }
  return parseScreen(r.stdout);
}
