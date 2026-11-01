import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The snapshot tests run real git against a throwaway repo; on a loaded
    // Windows box one snapshot alone has taken over 5 s (vitest's default).
    testTimeout: 30_000,
  },
});
