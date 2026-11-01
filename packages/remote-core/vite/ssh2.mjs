// The two build fixes every plugin that bundles ssh2 (through remote-core)
// needs on top of @dispatch/plugin-sdk's dispatchServerBuild:
//
//   import { dirOf, dispatchServerBuild } from "@dispatch/plugin-sdk/vite";
//   import { withSsh2 } from "@dispatch-plugins/remote-core/vite";
//   export default withSsh2(dispatchServerBuild({ root: dirOf(import.meta.url), entry: "src/server.ts" }));

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
export const stubSsh2NativeAddons = {
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

/**
 * ssh2 is CommonJS and reads `__dirname` (its poly1305 WASM loader and its
 * agent module) at load time. Inlined into an ES module that name does not
 * exist, and activation died with "ReferenceError: __dirname is not defined in
 * ES module scope". Define both from `import.meta.url` at the top of the bundle.
 */
export const esmDirnameBanner = [
  'import { fileURLToPath as __pt_fileURLToPath } from "node:url";',
  'import { dirname as __pt_dirname } from "node:path";',
  "const __filename = __pt_fileURLToPath(import.meta.url);",
  "const __dirname = __pt_dirname(__filename);",
].join("\n");

/** `base` (a dispatchServerBuild config) with both fixes applied. */
export function withSsh2(base) {
  return {
    ...base,
    plugins: [...(base.plugins ?? []), stubSsh2NativeAddons],
    build: {
      ...base.build,
      rollupOptions: {
        ...base.build.rollupOptions,
        output: { ...base.build.rollupOptions.output, banner: esmDirnameBanner },
      },
    },
  };
}
