# remote-host — run a chat's work on your own machines

Scope v2, 2026-10-31. It folds in research on core seams, proxmox-terminal reuse and macOS realities, plus an
adversarial edge-case review. Nothing has been built yet.

**First target:** `cvx-mac.lan`, at 10.0.10.16 on the same /20 as the Dispatch host.
- It answers ping.
- **TCP 22 is closed, so Remote Login is off.**
- The Dispatch host is Windows 11 and has ZeroTier at 10.69.69.69/24.

## 0. Decided by Michael, 2026-10-31
- **cvx-mac setup:** a dedicated non-admin `dispatch` user, FileVault OFF, auto-login ON. Nothing personal lives on that account.
- **cvx-mac hardware:** Apple silicon, macOS 15 or later. Everything in this scope applies, including current Playwright WebKit.
- **Sharing:** several chats may use one machine at once. Each gets its own worktree, Simulator clone, DerivedData and attributed ports. Real Safari is leased to one chat at a time.
- **Location ids are keyed by plugin name:** `remote-host/<host>`, e.g. `remote-host/cvx-mac`. Pickers group them by plugin. This makes **E12 required** in core, and it ships with the Phase 2 PRs.
  - The `<host>` slug is chosen at pairing and is **immutable**. Renaming a machine changes only its label, so chat pins, project.yaml defaults and cleanup rows are never stranded.
  - Unqualified ids keep working. proxmox-terminal's `proxmox` stays valid.
- **Browser MCPs follow the terminal location.** When a chat's default terminal location is a machine, playwright and chrome-devtools run there too. A project or chat can override this, in E7.
- **Next steps:** commit this doc to dispatch-plugins. Start Phase 1 (`remote-core`) and the first core PRs. Add `dispatch-plugins` as its own Dispatch project, with its own memory. Coordination runs across projects: the coordinator is chat `4xuTZkKSyXyxmC8ex7oJa` in the Dispatch project.

## 1. What we're building

`remote-host` is a plugin in the `mdennis281/dispatch-plugins` collection. You pair one or many of your own
machines (Mac first, then Linux, then Windows). Each paired machine becomes a terminal location in Dispatch.

A chat's managed terminals, a synced copy of its worktree and, later, its browser MCP servers
(playwright/chrome-devtools) can run on that machine. All traffic is SSH-encrypted.

On each machine runs `dispatch-host`, a small cross-platform client: a Node bundle on a pinned runtime.

Not in v1:
- running the agent runtime itself on the machine
- machines that can only dial in to Dispatch (ZeroTier or Tailscale already cover off-LAN)

```
dispatch-plugins/
  packages/remote-core/    ssh pool, three-way snapshot sync, port attribution, lifecycle queue  (lifted from proxmox-terminal)
  packages/host-agent/     dispatch-host: session supervisor (Tier A) + GUI agent (Tier B) — one bundle, one binary
  plugins/proxmox-terminal/  consumes remote-core
  plugins/remote-host/     NEW (id remote-host): pairing UI, one terminal backend per paired machine
```

CI must fail when a committed `server/index.js` is stale relative to its sources. The installer copies only the
member directory, and the update watcher hashes only that directory. So a remote-core fix reaches users only
through each plugin's rebuilt bundle.

## 2. Decisions

1. **Transport: SSH, through the machine's own sshd.**
   - Macs use Remote Login, Linux uses sshd, Windows uses OpenSSH Server.
   - Dispatch uses the `ssh2` library in-process, with one long-lived connection per machine and many channels on it.
   - OpenSSH supplies the crypto and auth, and on macOS sshd's children are exempt from Local Network Privacy.
   - Rejected:
     - Custom TLS or WebSocket: it rebuilds exec, forwarding and flow control; it triggers the macOS firewall prompt; and Local Network Privacy blocks an agent dialing a LAN IP.
     - Noise.
     - An ssh2 *server* embedded in the agent: a custom security surface on the LAN.
2. **`dispatch-host` is required from v1. It has two roles in one binary.**
   - **Tier A, the session supervisor.** sshd launches `dispatch-host session` for every shell, instead of a bare `exec bash`. The supervisor:
     - owns the shell's session and process groups;
     - journals each run (exit code, output offsets), so a dropped connection can be resumed instead of losing the result;
     - attributes listening ports to the chat that owns them;
     - kills its own tree after 60 s without a heartbeat;
     - runs each command with stdin from `/dev/null`;
     - records `{instance, chat, sid}` on disk so orphans can be swept on reconnect.

     A persistent machine has no "stop the container" to hide leaks, which is why this is mandatory.
   - **Tier B, the GUI agent.** A per-user LaunchAgent in the Aqua session. On Linux it's a `systemd --user` unit with linger; on Windows a logon Scheduled Task. It listens only on a local unix socket (on Windows, loopback plus mutual challenge-response), reached through an SSH channel. It owns everything that dies outside the GUI session: Simulator, UI tests, safaridriver, headed browsers, keychain-backed codesign, screen capture, MCP servers. It also handles leases and dialog detection.
3. **Fail closed.** The command does NOT run, and the agent is told why, when any of these happen:
   - sync fails;
   - a remote edit conflicts with a local one;
   - the cwd is missing on the machine (never `cd ~`);
   - the machine is offline;
   - another terminal holds the checkout's foreground lock.

   The backend declares `fallback: "refuse"`. A Mac terminal never quietly becomes a Windows shell.
4. **Three-way sync** around each run, with the last snapshot as the base:
   - **Push:** snapshot the local worktree (temp `GIT_INDEX_FILE`, deterministic `commit-tree`), apply a per-chat exec-bit overlay, and check it out on the machine.
   - **Pull back:** host-made changes come back to the local worktree wherever the local file hasn't changed since the base. That covers tracked edits, new non-ignored files, mode changes, and HEAD moving away from the snapshot (a commit made on the host). Examples: `pnpm install` rewriting the lockfile, `vitest -u`, codegen.
   - **Conflict:** the run is blocked and the agent is told.
   - **Detect after every run as well, not just before the next one,** so each change is attributed to the command that made it.
5. **Each machine is identified by an immutable id minted at pairing** (e.g. `rh-7k2q9x`). The name, OS and tier go in a mutable label and status. Renaming a machine never strands chat pins, project.yaml defaults or cleanup rows.
6. **Its pinned SSH host key is what identifies the machine**, not its name. Addresses are tried in order: `.lan`, `.local`, last-known IP, overlay name. A key mismatch at one address means "not this host". It never becomes a re-pin prompt, because the router lets any device claim `cvx-mac.lan`. Re-pinning is only possible from Settings.
7. **Security baseline. These are requirements, not recommendations.**
   - A dedicated non-admin `dispatch` user on each machine.
   - One keypair per machine, written to `authorized_keys` as `restrict,port-forwarding,permitopen="127.0.0.1:*",permitlisten="127.0.0.1:<allowed>",from="<dispatch LAN IP>,<overlay IP>"`.
   - No Full Disk Access.
   - An allow-list for the captured login environment: PATH, HOMEBREW_*, LANG/LC_*, JAVA_HOME, DEVELOPER_DIR. `$SHELL -lc env` would otherwise leak `GITHUB_TOKEN`/`NPM_TOKEN` into transcripts.
   - Allow-listed ignored files such as `.env.local` are injected as env at run time, never written to the shared disk.
8. **Reverse forwards (Dispatch → machine) are off by default.**
   - Opt in per sub-app with `exposeToHosts: true`.
   - Never forward a port that a Dispatch process serves.
   - Refuse to forward at all while Dispatch auth is off.

   Otherwise any process on the Mac could reach `localhost:4319/api`, create a chat and run commands on Windows.
9. **Agent upgrades are side by side and never downgrade.**
   - Sessions outlive an agent restart and re-attach.
   - `kickstart` only runs when no sessions are live in either instance.
   - The install takes a host-side lock.

   Stable and dev share `config/` but run different plugin builds. Without this they kill and downgrade each other's agent.
10. **Transfers are shallow, resumable and size-capped, and run outside the spawn timeout.**
    - `spawn` returns as soon as the shell is up. Seeding happens in the first run, with progress output.
    - There is one shared bare repo per (instance, repo) on the machine, with `git worktree add` per chat.
    - Untracked files over a size cap are excluded and reported.
    - LFS: check out on the machine with the smudge filter disabled and ship the objects from local. Submodules are snapshotted recursively.

## 3. Pairing flow
1. On the Mac: create the `dispatch` user, then turn on Remote Login for that user only.
2. In Dispatch: Settings → Remote hosts → **Add**. Enter a name and address(es). The plugin mints the host id and a keypair, and stores them with E5.
3. Bootstrap one of two ways:
   - paste a one-liner on the Mac that installs the restricted key line, or
   - enter the `dispatch` password once. In that case the host key is **pinned BEFORE the password is sent**, and the password is never stored.
4. The plugin pushes `dispatch-host` and the pinned Node runtime over SSH, through exec stdin, so no quarantine xattr gets set.
   - The runtime lives at a fixed path, `~/.dispatch-host/runtime/node/bin/node`, replaced in place. A versioned path, or Homebrew's node, changes the identity macOS grants permissions to, so the grants silently drop.
   - The plugin writes the LaunchAgent and runs `launchctl enable` plus `bootstrap gui/<uid>`. That step is unverified from SSH; test it first. If there is no console login, there is no GUI domain, and the machine is "Tier A only, log in at the Mac".
5. A health probe runs on every connect and its results are cached for the label and the agent note:
   - OS, arch, version;
   - git/node/pnpm/xcodebuild versions, and `-checkFirstLaunchStatus`;
   - console user, screen lock, keychain lock;
   - free disk;
   - blocking system dialogs.
6. **Remove machine** deletes its key line, boots the agent out, and hands its cleanup rows over (E22).

## 4. How a chat uses it
- **Terminal locations.** Each machine is a location in the existing `terminalLocations` machinery. Set it per project, not app-wide, so the Mac's long note doesn't land in every chat. The agent picks `location` per terminal, and a chat or project may pin the Mac as its default.
- **Agent note (per host).** It covers:
  - OS, arch and tier, and that `/bin/bash` is version 3.2;
  - the host path ↔ local path mapping, with short stable host paths;
  - deps install on the host, never node_modules sync;
  - remote edits come back automatically, conflicts block;
  - never kill by port;
  - its own Bash, Edit and git stay on Windows;
  - how to fetch artifacts.
- **Ports.**
  - One probe loop per host connection: `lsof` on macOS, `ss` on Linux, `Get-NetTCPConnection` on Windows.
  - Only listeners descended from the chat's sessions are published. Unattributed ones (AirPlay :5000/:7000, other chats, the other instance) are named in the note but never forwarded.
  - The local port equals the remote port when it's free, so OAuth redirects, CORS and cookies survive reconnects.
- **Leases.**
  - Each chat gets its own cloned Simulator, exported as `DISPATCH_SIM_UDID`.
  - Safari is only reachable through the MCP path, which holds the one-session lease.
  - Per-chat `-derivedDataPath`.
  - Optional per-chat `PORT` ranges.
- **MCP on the machine (Phase 5).**
  - playwright and chrome-devtools run as children of the Tier B agent, behind a stdio shim on Windows. The shim never exits on transport loss. It returns JSON-RPC errors for in-flight calls and re-attaches to the same MCP child, without a second `initialize`.
  - The bridge rewrites `roots/list` and `--output-dir` to host paths, turns host file paths in results into fetched local copies or inline bytes, and uploads files before upload calls.
  - Default to headless Chromium. Use WebKit for engine checks (Playwright ≥1.59 needs macOS ≥15). Real Safari only on request.
  - Profiles are per chat.
- **Lifecycle.**
  - **Chat idle:** kill the chat's session groups.
  - **Chat deleted:** kill and `worktree remove`, through the pending-cleanup queue with backoff (a sleeping laptop is the new "PVE down").
  - **Unused for N days:** remove the worktree only if the three-way check shows no host-only edits.
  - Periodic `git gc`; free-disk floor; per-chat DerivedData and simulators deleted with the chat.
  - **Dead-man switch:** if the agent has heard from no Dispatch for N hours, it kills its children and releases `caffeinate`. After N days it boots itself out, which covers a plugin that was disabled or uninstalled.

## 5. Mac preparation
One-time, at the Mac or over Screen Sharing:
- **Pre-flight checks.** Find the chip and the macOS version. Intel, or macOS 14 or older, rules out FileVault unlock over SSH and recent Playwright WebKit.
- **Remote Login.** On, for the `dispatch` user only. Add an sshd drop-in with `ClientAliveInterval 15`, so half-open sessions die fast.
- **FileVault versus auto-login. Decide this explicitly.**
  - With FileVault on, auto-login is impossible. After any reboot the machine has no GUI session, so Tier B is down until someone logs in.
  - For a garage dev box I recommend: dedicated user, FileVault off, auto-login on.
  - The trade-off: anyone who takes the laptop gets an unlocked session. So keep no personal accounts, keys or browser profiles on that user.
- **Power and display.**
  - `pmset -c sleep 0 disksleep 0 womp 1 powernap 0; pmset -a standby 0 hibernatemode 0`.
  - Keep the lid open. With the lid closed and no display, it sleeps even on AC.
  - Screen lock off.
  - Set a battery Charge Limit. A warm garage plus 100% charge around the clock swells batteries.
- **Updates.**
  - Turn off auto-install of macOS updates.
  - Turn off App Store auto-updates for Xcode. An Xcode update breaks git and clang until `-license accept`/`-runFirstLaunch`.
- **Network.** Turn off Private Wi-Fi Address, or use Ethernet, so the DHCP reservation holds.
- **Developer tooling and permissions.**
  - `automationmodetool enable-automationmode-without-authentication`.
  - `DevToolsSecurity -enable`.
  - `safaridriver --enable`.
  - Xcode first launch, and the simulator runtimes.
  - The keychain partition list for codesign.

## 6. Dispatch core enhancements (plugin-support side)
Sizes: S is under a day, M is a few days, L is about a week, XL is more.

**Required before remote-host v1**

| # | Enhancement | Why | Size |
|---|---|---|---|
| E1/E21 | `ctx.terminals.setStatus` / `updateBackend(id,{label,status})` without detaching shells; per-backend `unregisterBackend`; offline status in `TerminalBackendInfo` and pickers; `locations()` treats offline as unavailable, so spawn fails in milliseconds | Today a machine going offline can only make spawn reject, after a 120 s timeout, and then fall back to local | M |
| E2 | `TerminalBackend.fallback: "local" \| "refuse"` | `xcodebuild` or POSIX `rm -rf` must never run in PowerShell | S |
| E3/E20 | `beforeRun` (can veto or fail the run, attaches notices, sync time doesn't count against the command timeout) and `afterRun`; `branch`/`worktreePath` in spawn info | Fail-closed sync, after-run remote-edit attribution; replaces stdin sniffing | M |
| E5 | `ctx.secrets.set/delete` for declared names (or prefixes) | Per-machine SSH keys. Nothing a plugin can write today is shared, encrypted and survives updates | S |
| E18/E19 | Exit reason on handle exit ("transport lost, outcome unknown"); a stalled/resumed handle state that pauses the run timeout; a notice when a shell is respawned and its cwd/env reset | A Wi-Fi blip today reports `exit=n/a` with `isError:false`, then silently resets the shell | M |
| E24 | Per-command stdin isolation | Without a PTY, programs that read stdin swallow core's sentinel and later commands | M |
| E25 | `ctx.instance` (id, stable/dev role, data-dir fingerprint) | Namespacing on the machine. A copied `data/` must not let dev reap stable's work | S |
| E29 | Offer `location` whenever any backend is allowed, validated per call | Today the param is frozen at session build and absent if the machine was offline then | S |
| E4 | `ctx.settings.set`, a documented client `host.settings.set`, schema validation on PUT | The host list; the form can't edit arrays of objects, so the plugin's settingsSection owns it | M |
| E12 | Qualified `<plugin>/<backend>` location ids (e.g. `remote-host/cvx-mac`), grouped by plugin in every picker. Unqualified ids stay valid. Extends the id regex in `terminal-backend.ts`; covers pins, project.yaml and cleanup rows | Michael's choice: "keyed by plugin name" | S–M |

**Required for MCP on the machine**

| # | Enhancement | Size |
|---|---|---|
| E7 | MCP placement. A backend can host stdio processes (`spawnProcess`). Core relays the placed servers, keeping the bundled lazy shim and auto gate. Config: `mcpServers.<name>.location`, a chat override, or "browser MCPs follow terminal location". The reconnect contract is part of the API. | L |
| E8 | Plugin-contributed agent tools (`ctx.tools.register`): `remote_fetch` for xcresults, screenshots and reports, and machine status | M |
| E23 | `remoteUrl` on forwards. Results name both the Windows-side URL and the URL a browser on the host should use. Today core tells every agent "use the forwarded local URL", which is wrong for a browser running on the Mac. | S |
| E10/E26 | `ctx.runner.list()` with port ownership, plus a deny-list for Dispatch's own and plugins' ports | S |

**Quality and later**

| # | Enhancement | Size |
|---|---|---|
| E22 | Retire or hand over a removed backend's cleanup rows | S |
| E27 | A shared coordination primitive in `config/` (lock, or plugin state that survives updates) for both instances | M |
| E28 | Backends see which runs are in flight per chat and terminal, for the foreground lock | S |
| E9 | `run_subapp` with `location` | M |
| E11 | Plugin tool guard / `localShellPolicy` for the agent's local Bash in remote-default chats | M |
| E13 | `{execPath}` MCP token; reloadable plugin MCP contributions | S |
| E14 | Plugin update follows a plugin that moved into a collection. Measured 2026-10-31: an install from the old single-plugin URL gets a check-update error and its update 404s. The workaround is to inspect the collection URL and run "Update" on the member row, which keeps settings and kv | S |
| E15 | `dispatch plugin verify`: rebuild and diff committed bundles | S |
| E30 | **Publish `@dispatch/plugin-sdk`**, versioned against `PLUGIN_API_VERSION` (npm or GitHub Packages). Today it is private and `link:`ed through a relative path to a Dispatch checkout. So plugin repos can't build in CI, and they can't build in a worktree, because the relative path breaks. Found 2026-10-31 by the dispatch-plugins setup chat. The interim fix lives in the plugin repo: resolve the SDK through an env var, or through the primary checkout's sibling found via `git rev-parse --git-common-dir`. | M |
| — | Terminal tool text: stop promising "visible in Ports & processes / reaped with chat" for remote shells | S |
| E16 | Provider spawn decorator: run the agent runtime on the machine | XL |
| E17 | Reverse-connect (plugin WS routes, integration-token scope, `ctx.pairing`), only if a machine can't be dialed | L |

## 7. Build order

| Phase | Where | What | Depends on |
|---|---|---|---|
| 0 | plugins repo | Repo becomes the `dispatch-plugins` collection (child chat, in flight) | — |
| 1 | plugins repo | Extract `remote-core` from proxmox-terminal, and fix inherited bugs: stale repo state after re-provision, `cat-file --batch-check`, UTF-8 stream decode, unborn HEAD, no `cd ~` fallback. proxmox-terminal consumes it. CI checks bundle freshness. | 0 |
| 2 | core | E1/E21, E2, E3/E20, E5, E18/E19, E24, E25, E29, E12 (+ minimal E4). About 9 small PRs. | — (runs in parallel with 1) |
| 3 | plugins repo | `dispatch-host` Tier A supervisor and `remote-host` v1, macOS only: pairing, restricted keys, health, three-way sync, port attribution, lifecycle, dead-man switch. **First usable milestone: builds and tests on the Mac.** | 1, 2 |
| 4 | plugins repo | Tier B GUI agent: LaunchAgent, leases, dialog detection, side-by-side upgrades (+ core E27, E28) | 3 |
| 5 | core + plugins | E7, E8, E23, E10/E26: playwright and chrome-devtools on the Mac, artifact fetch, opt-in reverse forwards | 4 |
| 6 | core | E9, E11, E13, E22, terminal tool text | as needed |
| 7 | plugins repo | Linux machines (headless only), then Windows machines. Windows needs `administrators_authorized_keys`, cmd as the default shell (so `powershell -EncodedCommand`), session-0 sshd, locked-file checkouts, and a loopback port that needs mutual auth. | 4 |

## 8. Unverified, test before building on it
- `launchctl bootstrap gui/<uid>` run from an SSH session as the console user. It's reported to fail with errors 5 or 125 on some versions.
- Whether processes under sshd are exempt from Local Network Privacy (TN3179 says so), and whether the `com.apple.network.local-network` allow-list key exists.
- FileVault unlock over SSH on Tahoe, and whether a GUI session exists afterwards. Also whether the pre-boot sshd has its own host key.
- Whether Playwright WebKit headless needs the window server.
- Whether the official Node macOS binary is Developer-ID signed (`codesign -dv`).
- Claude Code's behaviour when a stdio MCP server exits: does it restart it or mark it failed for the session? This decides how hard the shim must work.
