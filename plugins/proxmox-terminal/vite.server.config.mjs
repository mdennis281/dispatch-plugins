// src/server.ts → server/index.js: one Node ES module with every npm
// dependency inlined. The host imports that file from the plugin directory,
// where there is no node_modules, so a bare import would fail at activate.
// withSsh2 adds the two fixes bundling ssh2 needs (see remote-core's vite/ssh2.mjs).
import { dirOf, dispatchServerBuild } from "@dispatch/plugin-sdk/vite";
import { withSsh2 } from "@dispatch-plugins/remote-core/vite";

export default withSsh2(dispatchServerBuild({ root: dirOf(import.meta.url), entry: "src/server.ts" }));
