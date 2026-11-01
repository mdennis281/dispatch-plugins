# dispatch-plugins

Plugins for [Dispatch](https://github.com/mdennis281/dispatch). Each one lives in its own directory under `plugins/` and is installed on its own: Dispatch copies only that directory.

| Plugin | id | What it does |
|---|---|---|
| [Proxmox terminal](plugins/proxmox-terminal) | `proxmox-terminal` | Runs each chat's managed terminals in its own Proxmox LXC, with the local worktree synced in before every command. |

## Planned

- **Remote host** (`remote-host`): run a chat's terminals, a synced worktree and its browser MCPs on your own machines, Mac first. Design: [docs/design/remote-host.md](docs/design/remote-host.md).

## Install

In Dispatch: **Settings → Plugins → Inspect from URL**, paste

```
https://github.com/mdennis281/dispatch-plugins
```

and tick the plugins you want. Each one gets its own report (what it asks for, what it touches) before anything is installed. A plugin's own URL, e.g. `https://github.com/mdennis281/dispatch-plugins/tree/main/plugins/proxmox-terminal`, goes straight to its report.

From a shell:

```bash
dispatch plugin add https://github.com/mdennis281/dispatch-plugins --plugin proxmox-terminal
```

Dispatch records the repository URL plus the plugin's directory, so **Check for updates** follows that one plugin. A push that only touches another plugin is not an update to it.

Every plugin needs a Dispatch restart to load, and has its own setup. Read its README.

## Moving an install from the old URL

Proxmox terminal used to be the whole of `mdennis281/dispatch-proxmox-terminal`, which is now this repository. A copy installed from that URL recorded the repository **root** as the plugin, and the root is now a collection. Its Check for updates fails with *"no plugin.yaml at the repository root … found one in: plugins/proxmox-terminal"*, and Update is refused the same way. The background check doesn't toast an error, so the row just stays stale.

Point it at its new home by installing the collection's copy **over** it:

1. Settings → Plugins → **Inspect from URL** → `https://github.com/mdennis281/dispatch-plugins`.
2. The **Proxmox terminal** row says *Installed v0.1.0 — open to update* (an installed plugin can't be ticked). Open it with the chevron, review the report, press **Update to 0.1.1** (or newer) and confirm.
3. Restart Dispatch. Stable and dev share the plugin directory, so restart both.

Settings, the enabled switch, secrets and the plugin's kv store (which records the containers it owns) are kept by plugin id outside the plugin's directory, so all of them survive. From then on, updates follow `plugins/proxmox-terminal`.

**Do not uninstall and reinstall** to do this. Uninstalling Proxmox terminal destroys every container it made.

## Layout

```
dispatch-plugins.yaml        which directories are plugins; Dispatch lists exactly these
plugins/<name>/              one plugin: plugin.yaml, README, LICENSE, src/, test/, and
  server/index.js            its BUILT server module, committed
packages/<name>/             code two or more plugins share (none yet)
```

- **A plugin directory stands alone.** Dispatch installs it with no `node_modules` and nothing from outside it, so it carries its own `README.md` and `LICENSE`, and its built output.
- **Built output is committed.** The URL installer copies the directory as-is and never builds. Rebuild and commit `server/index.js` with every source change.
- **Shared code is bundled, never imported at runtime.** A plugin depends on a `packages/*` package as `workspace:*`, and its build inlines it into `server/index.js`. A change to a shared package becomes an update to a plugin only when that plugin's rebuilt bundle changes, so rebuild and commit every plugin that uses it.
- **Add a plugin** by creating `plugins/<name>/` (start from `dispatch plugin init`), adding it to `dispatch-plugins.yaml`, and adding a row to the table above. Plugin ids may not start with `dispatch-`; that prefix is reserved.

## Develop

The plugin SDK (`@dispatch/plugin-sdk`) is not on npm. Packages here depend on it as `link:../../.dispatch-sdk`. That is a gitignored link to a Dispatch checkout's `packages/plugin-sdk`, which `pnpm install` makes (`scripts/link-dispatch-sdk.mjs`). It uses `DISPATCH_REPO` when set. Otherwise it uses a checkout named `claude-manager` or `dispatch` **beside** this repository's primary checkout, which git worktrees of this repository find too.

```bash
git clone https://github.com/mdennis281/dispatch claude-manager
cd claude-manager && pnpm install && pnpm --filter @dispatch/shared --filter @dispatch/plugin-sdk build && cd ..
git clone https://github.com/mdennis281/dispatch-plugins && cd dispatch-plugins
pnpm install                                   # also links .dispatch-sdk
pnpm typecheck && pnpm build && pnpm test      # every plugin; build first, because the tests load the built bundle
```

CI (`.github/workflows/ci.yml`) does the same against a pinned Dispatch commit, and fails when a committed `server/index.js` differs from its rebuild.

## License

MIT
