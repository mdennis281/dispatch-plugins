// src/client.tsx → client/index.js: the Settings pane, one ES module that
// imports nothing. The SDK's preset resolves react, react/jsx-runtime and
// lucide-react to the host's copies on window.__dispatch.deps (a second React
// breaks every hook). client/ is served publicly, so nothing else goes there.
import { dirOf, dispatchClientBuild } from "@dispatch/plugin-sdk/vite";

export default dispatchClientBuild({ root: dirOf(import.meta.url), entry: "src/client.tsx" });
