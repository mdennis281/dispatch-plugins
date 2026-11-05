# Remote host (`remote-host`)

A [Dispatch](https://github.com/mdennis281/dispatch) plugin, part of [dispatch-plugins](https://github.com/mdennis281/dispatch-plugins), that runs a chat's **managed terminals** (the agent's `terminal` tool and the Terminals panel) on **your own machines** over SSH. Macs come first. Each machine you pair becomes a terminal location, `remote-host/<name>`, that a project or chat can pick.

> **Status:** terminals only (Tier A of the design), macOS first. It pairs machines (Settings → Remote hosts), runs shells on them, keeps each chat's worktree in sync with a checkout there, forwards the chat's dev servers here, and cleans up after a chat when it goes idle or is deleted. The GUI side (Simulator, UI tests, Safari) and browser MCPs on the machine come later. The design is [docs/design/remote-host.md](../../docs/design/remote-host.md).

## What it does

- **SSH to the machine's own sshd**, in-process (ssh2), with one connection per machine. No extra daemon listens on the machine, and macOS needs nothing beyond Remote Login.
- **Each shell runs under `dispatch-host`**, a small supervisor this plugin installs on the machine (`packages/host-agent`). It owns the shell's processes, journals its output, and keeps the shell running when the connection drops. Dispatch re-attaches, gets the output from the last byte it saw, and the command in flight carries on. The agent sees the command pause (`stalled`), not fail. If nobody comes back, dispatch-host kills the shell after 3 minutes (sleep doesn't count), and kills every session left by a Dispatch that hasn't been in touch for 12 hours.
- **Forwards the chat's dev servers** to this computer, on the same port when it is free (see [Forwarded ports](#forwarded-ports)).
- **Syncs the chat's files around every command**, three ways (see [Syncing](#syncing)): your edits go there before it, its edits come back after it, and a conflict stops the next command instead of losing either side.
- **Fails closed.** A machine that is asleep, off, or answering with the wrong host key is reported **offline**. A command sent to it is refused at once with the reason. It never runs in PowerShell on the Dispatch computer instead (`fallback: "refuse"`). The same goes for a sync that fails: the command doesn't run against stale files.
- **Cleans up after a chat** (see [When a chat ends](#when-a-chat-ends)): idle, its shells end; deleted, its checkout there goes too.
- **Stable and dev share machines safely.** Everything the plugin leaves on a machine lives under that Dispatch instance's id (`~/.dispatch-host/<instance>/`), so one instance's cleanup never touches the other's sessions.

## Pairing a machine

Prepare the machine first: [docs/setup/macos-host.md](../../docs/setup/macos-host.md) makes a dedicated, non-admin `dispatch` account and turns on Remote Login for it alone. Then, in Dispatch, open **Settings → Remote hosts → Pair a machine**. It takes three steps. (The pane is a front for the plugin's routes under `/api/plugins/remote-host/`, given in brackets, if you'd rather script it.)

1. **Where it is** (`POST /pair/scan {address, port?}`). Give its address. Dispatch connects far enough to see the machine's SSH host key, and logs in to nothing.
2. **Is it really that machine?** Compare the fingerprint the pane shows with what the machine prints itself:
   ```
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```
   Then name it (the `<name>` in `remote-host/<name>`), and check the account (`dispatch`) and the addresses this computer connects from, which the pane fills in from what it just saw. Trusting it (`POST /pair/start {slug, label, address, user, hostKey, allowFrom}`) makes Dispatch mint a keypair for this machine alone, with this `authorized_keys` line:
   ```
   restrict,port-forwarding,permitopen="127.0.0.1:*",permitopen="[::1]:*",from="<this computer's addresses>" ssh-ed25519 AAAA… dispatch-remote-host:<slug>@<this computer>
   ```
   The key can't get a terminal, forward an agent or X11, or run `~/.ssh/rc`. It may only forward to the machine's own loopback (to reach a dev server), and only from this computer. Dispatch never asks for a reverse forward.
3. **Let this computer in** (`POST /pair/finish {pairingId, password?}`). Either:
   - copy the one-liner the pane shows into a terminal on the machine, logged in as `dispatch`, then press **I ran it, finish**; or
   - give the `dispatch` account's password, once. It is sent only after the machine has shown the host key you confirmed, used to add the line, and never stored.

   Either way, the new key must then log in on its own before anything is saved. The pane then says which address the machine saw this computer as. A pairing left unfinished expires after 30 minutes.

Each machine's row in the pane shows its status, its last probe (macOS version, architecture, free disk, the tools on its PATH) and its pinned host key, with buttons to check it now, rename it, pair it again and remove it.

On the first connection the plugin installs, over SSH and checked by SHA-256 on both ends:
- a pinned Node runtime at `~/.dispatch-host/runtime/node`;
- `dispatch-host` at `~/.dispatch-host/agent/<version>-<hash>/`.

Nothing else on the machine changes.

**Where things are kept:**
- The machine (its name, host key, addresses, account) goes in the plugin's settings. Only pairing, renaming and removing write there.
- Its private key goes in Dispatch's secret store, as `REMOTE_HOST_KEY_<NAME>`.

**Identity:**
- The **host key is the machine's identity**. Addresses are tried in order, the last one that worked first. A different key at an address means "not this machine", and that address is skipped. It never prompts you to trust the new key. Only pairing again changes it.
- The name in `remote-host/<name>` is fixed when you pair. **Edit** changes only the label and the addresses (`PUT /hosts/<name> {label, addresses}`).

## Syncing

A chat working in a git repository gets its own checkout on the machine, `~/.dispatch-host/<instance>/chats/<chat>/<repo>`, and its shells start at the matching place in it. The base of the sync is the last snapshot both sides agreed on.

**Before each command:**
1. Bring back anything that changed on the machine since then (a dev server's codegen, say). If that fails, the agent is told and step 3 still goes ahead: it never overwrites a change there.
2. Snapshot the local worktree as `git status` sees it: committed, staged, unstaged, and untracked-but-not-ignored. A file marked assume-unchanged or skip-worktree goes as it is on disk. The snapshot is a commit in a temp index; your index, HEAD and branches are never touched.
3. Send the machine only the objects it lacks, then check the snapshot out there.

**After it:** bring back what the command changed there: edits, new files, deletions, an exec bit.

**What is shared and what isn't:**
- Ignored files are never synced, either way: install dependencies and build on the machine.
- The machine gets the tree, never the history (a commit made there comes back as uncommitted changes; commit on your own computer).
- One bare repository per local repository is shared by every chat's checkout on that machine, so a second chat sends almost nothing.

**When it refuses (the command doesn't run, and the agent is told why):**
- **A conflict.** A file changed both there and here since the last sync. The machine's version is saved beside yours as `<file>.from-<machine>`, which is never synced. Merge what you want into your file and delete the copy; your version then goes there. To keep the machine's version, move the copy over your file. The same happens when your files add a path the machine already has outside the sync (a file ignored there, say, or one already in the checkout's place on the first sync): it is never overwritten. Where the machine's file is the same as yours, it simply joins the sync.
- **The checkout is busy.** Another terminal of the same chat is running a command there, so files can't change under it. A command that timed out or was cancelled may still be running, so it holds the checkout against every terminal, its own included, until the shell there reports it ended (finished, or Ctrl-C'd) or the shell ends. Background commands (dev servers, watchers) don't hold it.
- **A file changed there mid-sync.** It is never overwritten; run the command again and it comes back first.
- **The sync failed**, or the machine is offline.

**Never overwritten, on either side:** just before writing, the worktree is snapshotted again, exactly as a push would see it, and each file is checked against that. An edit made here while the machine's changes were on their way becomes a conflict. Some changes there are set aside instead: left as they are on both sides, and reported once. That covers a file here that git doesn't sync (ignored, or too big to send, even if it matches theirs), a directory where a file goes (unless the same changes empty it) or the reverse, a name Windows can't hold, and anything inside `.git`. A file there that can't be read is left out of the sync rather than stopping it.

**Limits:**
- Untracked files over 50 MB aren't sent, and new files over 50 MB made on the machine aren't brought back. Each is reported once.
- Transfers go in batches of up to 32 MB, and the machine keeps each batch it receives. A connection lost mid-way costs one batch: the next command sends only what is still missing. The first sync, which sends the whole worktree, runs in the first command's sync, not in starting the shell.
- Submodules and Git LFS objects aren't synced yet.
- On Windows, where files can't carry an exec bit or be symlinks, the plugin remembers those modes from the machine so they survive the round trip. A file made there that git would store differently here (CRLF line endings under `core.autocrlf`) goes back exactly as it came, and so does a conflict copy moved over your file.

## Forwarded ports

A server a chat starts in its terminal there (`pnpm dev`, say) is reachable on this computer while that terminal lives:

- **Only the chat's own.** dispatch-host works out which session's processes hold each TCP listener on the machine. A chat's listeners are forwarded; nothing else there ever is: not AirPlay on 5000/7000, not another chat's, not the other Dispatch's, not the account's own.
- **The same port here when it's free,** so OAuth redirects, CORS origins and cookies set for `localhost:3000` keep working. Otherwise another free port. Either way the terminal result and Ports & processes give the URL to open.
- **Loopback only, on both ends.** It listens on 127.0.0.1 here, and dials the machine's 127.0.0.1 or ::1. A listener on all interfaces is reached through its loopback; one bound only to a LAN address isn't forwarded. The key's `permitopen` allows nothing else. Machines paired before 0.4.0 have only the IPv4 loopback in it, so a server bound only to `[::1]` (Vite's `localhost` on macOS) needs **Pair again**.
- **It survives a dropped connection.** The port here stays open; while the machine is offline a connection to it is refused, and it works again after the reconnect.
- It goes when the chat's last terminal there does, or when the server stops (the machine is asked every 4 s while a terminal is open).

Dispatch never asks the machine to reach back to this computer (no reverse forwards).

## When a chat ends

- **Idle.** When Dispatch retires an idle chat's session, its shells on the machine end, and whatever they were running (a dev server, a watcher) with them. Its checkout stays, so it picks up where it was when the chat is used again.
- **Deleted.** The chat's sessions end, and its checkout, its session records (which hold its output) and its refs in the shared repository are deleted there. The checkout is moved aside at once and deleted in the background, so a big `node_modules` doesn't hold anything up. If the machine is asleep or off, Dispatch keeps the delete and tries again until the machine answers. A machine the chat never used is never asked.
- **Deleted while Dispatch wasn't listening** (the plugin was off, or Dispatch was down). After every start Dispatch lists the chats that exist, and anything a machine holds for any other chat goes: at once, or when the machine is next reachable. A chat directory made in the last ten minutes is never taken for one of these.
- **Garbage, once a day per machine.** dispatch-host empties its trash, deletes a shared repository no chat has used for a week, and lets git collect garbage in the rest once enough has piled up. A chat's checkout borrows its objects from the shared repository, so before that repository is collected, each checkout's commits are pinned in it. Only objects unreachable for two weeks are pruned.
- **This Dispatch's old id.** If this Dispatch's data directory moved or was copied, it got a new instance id, and what it left on a machine under the old one is shown on the machine's row. It is never adopted or cleaned up from here, since the old id may still be a live Dispatch: delete it there once you know it isn't. dispatch-host ends its sessions after 12 hours without contact either way.
- **Uninstalling the plugin** ends this Dispatch's sessions on every machine it can reach and deletes its files there (`~/.dispatch-host/<instance>`). The key lines stay in each machine's `authorized_keys`: remove the machines first to take them out as well. Disabling the plugin, or stopping Dispatch, keeps everything; a session left without Dispatch ends itself when its heartbeat stops.

## Removing a machine

**Remove** on its row (`DELETE /hosts/<name>`) does three things:
- ends this Dispatch's sessions on the machine;
- takes the key's line out of its `authorized_keys`;
- forgets the machine and deletes its key.

If the machine can't be reached, the rest still happens, and a notice says which line to delete by hand. `~/.dispatch-host` stays on the machine. Delete it yourself if you want it gone.

## Status

Each machine reports one of three states to Dispatch, re-checked every 30 s:
- **online**;
- **degraded**, with the reason: low disk, an unreadable login environment, or git that sync can't run. The reason
  names that git and says why: none on the PATH, no developer tools, or (exit 69) Xcode's license not accepted,
  with the fix. On a Mac, sync's git is the Command Line Tools'. It runs with `DEVELOPER_DIR` unset, so an Xcode
  update can't block it ([macOS setup](../../docs/setup/macos-host.md), step 5);
- **offline**, with the reason: no answer, refused, the key refused, a different host key.

The pane shows it on each machine's row, and refreshes every 5 s while it is open. `GET /hosts` lists the machines with their status and their last probe (OS, architecture, tools, free disk, who is logged in at the screen). **Check now** (`POST /hosts/<name>/check`) reconnects at once.
