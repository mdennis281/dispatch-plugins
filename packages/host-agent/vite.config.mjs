// src/cli.ts → dist/dispatch-host.mjs: ONE Node ES module that imports only
// `node:` builtins. It runs on the remote machine under the pinned runtime
// (~/.dispatch-host/runtime/node/bin/node), where there is no node_modules.
// The remote-host plugin inlines this file into its own bundle and pushes it
// over SSH, so dist/ is build output and is not committed.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "src/cli.ts",
    outDir: "dist",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { format: "es", entryFileNames: "dispatch-host.mjs" },
    },
  },
  // Bundle everything that isn't a Node builtin. There is nothing else today,
  // and a stray npm import must fail the bundle test, not the Mac.
  ssr: { noExternal: true, target: "node" },
});
