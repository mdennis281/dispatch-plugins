/** Re-exports and small shared bits for the tests. */
export { backendId, keySecretName, readHosts } from "../src/hosts.js";

/** Core's backend id rule (`TERMINAL_BACKEND_ID_PATTERN`), restated so a test can check ids against it. */
export const TERMINAL_ID = /^(?:[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,47}$/;
