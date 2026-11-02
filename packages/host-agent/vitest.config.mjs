import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The POSIX integration tests start real shells and wait out short
    // heartbeat windows; a loaded box needs more than vitest's 5 s.
    testTimeout: 30_000,
  },
});
