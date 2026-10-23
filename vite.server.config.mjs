// src/server.ts → server/index.js: one Node ES module with every npm
// dependency inlined. The host imports that file from the plugin directory,
// where there is no node_modules, so a bare import would fail at activate.
import { dirOf, dispatchServerBuild } from "@dispatch/plugin-sdk/vite";

const base = dispatchServerBuild({ root: dirOf(import.meta.url), entry: "src/server.ts" });

export default {
  ...base,
  build: {
    ...base.build,
    commonjsOptions: {
      // ssh2 tries two OPTIONAL native addons — its crypto binding and
      // cpu-features — each inside a try/catch, and falls back to pure JS
      // without them. A bundled plugin cannot ship a compiled .node file, and
      // rollup cannot resolve one (the build fails on "Could not resolve
      // ../build/Release/cpufeatures.node"). Leaving these two `require()`
      // calls unconverted makes them throw in the ESM bundle (`require` is not
      // defined there), which is exactly the failure ssh2 already catches.
      ignore: (id) => id === "cpu-features" || id.endsWith(".node"),
    },
  },
};
