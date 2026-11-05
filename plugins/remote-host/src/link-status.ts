/**
 * The status details a machine's link reports while it is (re)connecting
 * rather than because something is wrong. link.ts reports them; the Settings
 * pane shows them in a neutral tone instead of as "Degraded"/"Offline". One
 * module for both, with nothing else in it, so the client bundle can import it
 * without pulling in ssh2, and the pane can't drift from what the link says.
 */
export const CONNECTING = "connecting";
export const SETTINGS_CHANGED = "its settings changed; reconnecting";
export const CONNECTION_LOST = "connection lost; reconnecting";

/** What the pane says for each, whatever `state` it came with. */
export const RECONNECTING_WORDS: Readonly<Record<string, string>> = {
  [CONNECTING]: "Connecting",
  [SETTINGS_CHANGED]: "Reconnecting: its settings changed",
  [CONNECTION_LOST]: "Reconnecting: the connection was lost",
};
