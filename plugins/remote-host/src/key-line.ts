/**
 * Which form of authorized_keys line a machine was paired with. On its own,
 * with no imports, so the Settings pane can import it without pulling server
 * code (hosts.ts needs node:net) into the browser bundle.
 *
 * 1 (no `keyLine` in settings): before 0.4.0, `permitopen="127.0.0.1:*"` only.
 * 2: also `permitopen="[::1]:*"`, so a dev server bound only to [::1] (Vite's
 *    `localhost` on macOS) can be forwarded.
 */
export const KEY_LINE = 2;
