// src/server.ts → server/index.js: one Node ES module with every npm
// dependency inlined. The host imports that file from the plugin directory,
// where there is no node_modules, so a bare import would fail at activate.
import { dirOf, dispatchServerBuild } from "@dispatch/plugin-sdk/vite";

const base = dispatchServerBuild({ root: dirOf(import.meta.url), entry: "src/server.ts" });

/**
 * ssh2 tries two OPTIONAL native addons, each inside a try/catch, and falls
 * back to pure JS without them: `require('cpu-features')()` and
 * `require('./crypto/build/Release/sshcrypto.node')`. A bundled plugin cannot
 * ship a compiled .node file, and rollup cannot resolve one ("Could not
 * resolve ../build/Release/cpufeatures.node"). Leaving the `require()` in place
 * worked at runtime but Dispatch's install inspector rightly reads a bare
 * `require('cpu-features')` in the bundle as "would fail to load". So each is
 * replaced, before CommonJS conversion, with an expression that throws — the
 * exact failure ssh2 already catches.
 */
const stubNativeAddons = {
  name: "stub-ssh2-native-addons",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]ssh2[\\/]lib[\\/]/.test(id)) return null;
    const out = code
      .replace(/require\(\s*'cpu-features'\s*\)/g, "(() => { throw new Error('cpu-features is not bundled'); })")
      .replace(
        /require\(\s*'[^']*sshcrypto\.node'\s*\)/g,
        "(() => { throw new Error('the ssh2 native binding is not bundled'); })()",
      );
    return out === code ? null : { code: out, map: null };
  },
};

export default {
  ...base,
  plugins: [stubNativeAddons],
};
