import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The POSIX end-to-end test starts real sessions under a real SSH server.
    testTimeout: 30_000,
  },
});
