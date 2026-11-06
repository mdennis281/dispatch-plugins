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
- **Your files are busy here.** A terminal on this computer is running a command in the same files (of this chat or any other), or this chat has a terminal on another machine, or at another plugin's location, doing so. Syncing would read files that command is halfway through writing, and bring changes back over its work. Between two machines, the command that started first goes ahead. This needs Dispatch #514, which reports every terminal's commands to the plugin. On an older Dispatch only the machine's own terminals are counted.
- **A file changed there mid-sync.** It is never overwritten; run the command again and it comes back first.
- **A bulk delete there.** Files deleted on the machine that would delete more than half the files here, or more than 50, are not deleted here. If you meant it, delete them here too and run the next command. Otherwise just run the next command: they are put back there from your files. (Found after a command, it is reported instead, and the next command does the same.)
- **The sync failed**, or the machine is offline.

**The other way round,** nothing asks the plugin before a terminal on this computer starts a command. If one starts in the same files while a command runs on the machine, that command's changes wait for it to finish (up to 2 minutes) before they come back, and the result says so. If it takes longer, they come back before the next command on the machine.

**Deletes are trusted least**, since a damaged checkout there looks like a command that deleted files. Each checkout gets an id in its `.git` when it is set up, and Dispatch keeps it. A checkout that is gone, has lost its `.git`, or has another id is never compared with the last sync: it is set up again from your files, and files there that differ from yours become `<file>.from-<machine>` copies, as on a first sync. A new terminal never makes a bare directory where a checkout was; only setup makes one. Every delete that is brought back names the snapshot of your files from just before it, with the one `git restore` line that gets them back.

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
- **Never a port Dispatch keeps for itself,** even while nothing holds it: both instances' ports (4318, 4319, or wherever the installed one runs), the dev server's live-reload socket (24678), and the ports Dispatch's plugins run their processes on. A dev server there on 4319, forwarded onto 4319 here, would stop the dev instance from starting. Such a server is forwarded to another port, and Dispatch's log says why. The list comes from Dispatch (`ctx.runner`, Dispatch #517); the three fixed ports are kept clear even without it.
- **Loopback only, on both ends.** It listens on 127.0.0.1 here, and dials the machine's 127.0.0.1 or ::1. A listener on all interfaces is reached through its loopback; one bound only to a LAN address isn't forwarded. The key's `permitopen` allows nothing else. Machines paired before 0.4.0 have only the IPv4 loopback in it, so a server bound only to `[::1]` (Vite's `localhost` on macOS) needs **Pair again**.
- **It survives a dropped connection.** The port here stays open; while the machine is offline a connection to it is refused, and it works again after the reconnect.
- It goes when the chat's last terminal there does, or when the server stops (the machine is asked every 4 s while a terminal is open).

Dispatch never asks the machine to reach back to this computer (no reverse forwards).

## Root, with your approval

The account Dispatch logs in as has no sudo password, and never gets one. Instead, `sudo <command>` (or `dispatch-elevate <command>`) in a chat's terminal there asks **you**:

- **What you see.** A card in Dispatch's attention queue, like a tool permission request: the exact command, its directory, the machine and the chat. Approve runs it once. Deny, or no answer within 5 minutes, runs nothing, and the command fails with the reason.
- **How it runs.** Only on approval, Dispatch logs in to the machine a second time, with a separate key only it holds (`REMOTE_HOST_ELEVATE_KEY_<NAME>`). That login can do one thing: hand the request to a root-owned helper, which logs it and runs it as root in the same directory, with root's own environment and no input. Its output and exit code come back to the terminal.
- **One at a time per machine.** A second request waits for the first to finish before you're asked.
- **Waiting doesn't use up the command's time.** While it waits on you, the terminal shows as stalled and the command's timeout is paused.
- **Interrupting it** (Ctrl-C, the terminal ending) withdraws the card, or stops the command on the machine.
- **What `sudo` can't do here** is refused with the reason: another user (`-u`), keeping the environment (`-E`), a root shell (`-s`, `-i`), `-n`. `-v` and `-k` succeed and do nothing.

It needs a Dispatch with plugin approval requests (Dispatch #512) and its reserved-port list (#517): this version declares the `approvals` and `runner` capabilities, so an older Dispatch won't load it. Until elevation is set up on the machine, `sudo` there says so and fails, and the agent is told to ask you instead.

### Setting it up

Once per machine, from Settings → Remote hosts → the machine's **Root: off · Set up**:

1. **Make the setup command.** Dispatch mints the machine's elevation key, keeps it in memory, and shows one line to paste at the machine. **Show what it runs** shows the script it unpacks.
2. **Run it at the machine**, in Terminal, as an administrator: it asks for your password (`sudo`). It does this, and says so as it goes:
   - It refuses unless `/`, `/usr`, `/usr/local` and `/usr/local/libexec` are owned by root and writable by nobody else, so no one else could swap the helper. It creates the last two (root's, 755) on a Mac that doesn't have them yet.
   - It creates a hidden account, `_dispatchelevate` (a free id below 500, no password, shell `/bin/bash`). Its home `/private/var/dispatch-elevate` and its one `authorized_keys` line are root's: `restrict,command="/usr/local/libexec/dispatch-elevate",from="<this computer's addresses>" <key>`. The `from=` list is the one the machine was paired with.
   - It installs the helper, `/usr/local/libexec/dispatch-elevate`, owned by root.
   - It writes `/etc/sudoers.d/dispatch-elevate`: that account, and nobody else, may run the helper as root without a password. The rule is checked with `visudo -cf` before it is installed, and the whole configuration with `visudo -c` after; if that fails, the rule is taken out again.
   - It starts the helper's log, `/var/log/dispatch-elevate.log`, readable by root only.

   Running it again is safe: it replaces the key and the helper.
3. **Verify.** Dispatch logs in with the new key and has the helper prove it runs as root (`uid=0`). Only then is the key stored, and the row says **Root: with your approval, each time**.

The command is good for 2 hours. Verify needs no approval card: it runs one fixed check, nothing of the agent's.

### Turning it off

**Manage → Turn off** logs in with the elevation key once more and runs the helper's `uninstall`. That removes the account, its key line, the sudoers rule and the helper; the log stays. Then the key is deleted here. **Removing the machine** and **uninstalling the plugin** do the same first.

If the machine can't be reached, the key is deleted here anyway (nothing can use it then), and you get the command to run there yourself:

```sh
sudo /usr/local/libexec/dispatch-elevate uninstall
```

## When a chat ends

- **Idle.** When Dispatch retires an idle chat's session, its shells on the machine end, and whatever they were running (a dev server, a watcher) with them. Its checkout stays, so it picks up where it was when the chat is used again.
- **Deleted.** The chat's sessions end, and its checkout, its session records (which hold its output) and its refs in the shared repository are deleted there. The checkout is moved aside at once and deleted in the background, so a big `node_modules` doesn't hold anything up. If the machine is asleep or off, Dispatch keeps the delete and tries again until the machine answers. A machine the chat never used is never asked.
- **Deleted while Dispatch wasn't listening** (the plugin was off, or Dispatch was down). After every start Dispatch lists the chats that exist, and anything a machine holds for any other chat goes: at once, or when the machine is next reachable. A chat directory made in the last ten minutes is never taken for one of these.
- **Garbage, once a day per machine.** dispatch-host empties its trash, deletes a shared repository no chat has used for a week, and lets git collect garbage in the rest once enough has piled up. A chat's checkout borrows its objects from the shared repository, so before that repository is collected, each checkout's commits are pinned in it. Only objects unreachable for two weeks are pruned.
- **This Dispatch's old id.** If this Dispatch's data directory moved or was copied, it got a new instance id, and what it left on a machine under the old one is shown on the machine's row. It is never adopted or cleaned up from here, since the old id may still be a live Dispatch: delete it there once you know it isn't. dispatch-host ends its sessions after 12 hours without contact either way.
- **Uninstalling the plugin** ends this Dispatch's sessions on every machine it can reach and deletes its files there (`~/.dispatch-host/<instance>`). Root with approval is taken out of every machine that has it and can be reached. On one that can't, it stays (the log says so), and its key is kept, so the plugin installed again can still take it out. The key lines stay in each machine's `authorized_keys`: remove the machines first to take them out as well. Disabling the plugin, or stopping Dispatch, keeps everything; a session left without Dispatch ends itself when its heartbeat stops.

## Removing a machine

**Remove** on its row (`DELETE /hosts/<name>`) does four things:
- turns root with approval off there, if it was on (see [Turning it off](#turning-it-off));
- ends this Dispatch's sessions on the machine;
- takes the key's line out of its `authorized_keys`;
- forgets the machine and deletes its key.

If the machine can't be reached, the rest still happens, and a notice says which line to delete by hand. `~/.dispatch-host` stays on the machine. Delete it yourself if you want it gone.

## Status

Each machine reports one of three states to Dispatch, re-checked every 30 s:
- **online**, sometimes with a note that isn't a fault: Homebrew builds nothing from source because the Command Line
  Tools are older than it needs on that macOS (brew's own `check_clt_minimum_version`). Bottled formulae still
  install. The agent is told so, and not to update them itself;
- **degraded**, with the reason: low disk, an unreadable login environment, or git that sync can't run. The reason
  names that git and says why: none on the PATH, no developer tools, or (exit 69) Xcode's license not accepted,
  with the fix. On a Mac with the Command Line Tools installed, sync's git runs with
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools`, and so does a chat's shell by default. An Xcode update then
  can't block git, with no `sudo` and whatever `xcode-select` chose ([macOS setup](../../docs/setup/macos-host.md),
  step 5). Also a Homebrew that won't run there: brew ignores `DEVELOPER_DIR`, so it stops at an Xcode whose license
  isn't accepted until `xcode-select` points at the Command Line Tools (step 6). When brew runs, the agent is told to
  install missing tools with `brew install`, without `sudo`;
- **offline**, with the reason: no answer, refused, the key refused, a different host key.

The pane shows it on each machine's row, and refreshes every 5 s while it is open. `GET /hosts` lists the machines with their status and their last probe (OS, architecture, tools, free disk, who is logged in at the screen). **Check now** (`POST /hosts/<name>/check`) reconnects at once.
