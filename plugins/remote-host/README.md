# Remote host (`remote-host`)

A [Dispatch](https://github.com/mdennis281/dispatch) plugin, part of [dispatch-plugins](https://github.com/mdennis281/dispatch-plugins), that runs a chat's **managed terminals** (the agent's `terminal` tool and the Terminals panel) on **your own machines** over SSH. Macs come first. Each machine you pair becomes a terminal location, `remote-host/<name>`, that a project or chat can pick.

> **Status: being built, not offered for install yet.** This version pairs machines and runs shells on them, but nothing syncs the chat's worktree yet: a shell starts in an empty directory of its own. Syncing, forwarded ports, cleanup when a chat ends and the Settings pane come next. The design is [docs/design/remote-host.md](../../docs/design/remote-host.md). Until the plugin is usable it is left out of `dispatch-plugins.yaml`, so the collection doesn't list it.

## What it does

- **SSH to the machine's own sshd**, in-process (ssh2), with one connection per machine. No extra daemon listens on the machine, and macOS needs nothing beyond Remote Login.
- **Each shell runs under `dispatch-host`**, a small supervisor this plugin installs on the machine (`packages/host-agent`). It owns the shell's processes, journals its output, and keeps the shell running when the connection drops. Dispatch re-attaches, gets the output from the last byte it saw, and the command in flight carries on. The agent sees the command pause (`stalled`), not fail. If nobody comes back, dispatch-host kills the shell after 60 s (sleep doesn't count), and kills every session left by a Dispatch that hasn't been in touch for 12 hours.
- **Fails closed.** A machine that is asleep, off, or answering with the wrong host key is reported **offline**. A command sent to it is refused at once with the reason. It never runs in PowerShell on the Dispatch computer instead (`fallback: "refuse"`).
- **Stable and dev share machines safely.** Everything the plugin leaves on a machine lives under that Dispatch instance's id (`~/.dispatch-host/<instance>/`), so one instance's cleanup never touches the other's sessions.

## Pairing a machine

Prepare the machine first: [docs/setup/macos-host.md](../../docs/setup/macos-host.md) makes a dedicated, non-admin `dispatch` account and turns on Remote Login for it alone. Then, from Dispatch (the Settings pane comes in a later version; until then these are the plugin's routes under `/api/plugins/remote-host/`):

1. **Scan** (`POST /pair/scan {address}`). Dispatch connects far enough to see the machine's SSH host key, and logs in to nothing. Compare the fingerprint with what the machine prints itself:
   ```
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```
2. **Start** (`POST /pair/start {slug, label, address, user, hostKey}`). Give the confirmed fingerprint. Dispatch mints a keypair for this machine alone and returns its `authorized_keys` line:
   ```
   restrict,port-forwarding,permitopen="127.0.0.1:*",from="<this computer's addresses>" ssh-ed25519 AAAA… dispatch-remote-host:<slug>@<this computer>
   ```
   The key can't get a terminal, forward an agent or X11, or run `~/.ssh/rc`. It may only forward to the machine's own loopback (to reach a dev server), and only from this computer. Dispatch never asks for a reverse forward.
3. **Finish** (`POST /pair/finish {pairingId, password?}`). Either:
   - paste the returned one-liner into a terminal on the machine, logged in as `dispatch`, then finish with no password; or
   - finish with the `dispatch` account's password, once. It is sent only after the machine has shown the host key you confirmed, used to add the line, and never stored.

   Either way, the new key must then log in on its own before anything is saved.

On the first connection the plugin installs, over SSH and checked by SHA-256 on both ends:
- a pinned Node runtime at `~/.dispatch-host/runtime/node`;
- `dispatch-host` at `~/.dispatch-host/agent/<version>-<hash>/`.

Nothing else on the machine changes.

**Where things are kept:**
- The machine (its name, host key, addresses, account) goes in the plugin's settings. Only pairing, renaming and removing write there.
- Its private key goes in Dispatch's secret store, as `REMOTE_HOST_KEY_<NAME>`.

**Identity:**
- The **host key is the machine's identity**. Addresses are tried in order, the last one that worked first. A different key at an address means "not this machine", and that address is skipped. It never prompts you to trust the new key. Only pairing again changes it.
- The name in `remote-host/<name>` is fixed when you pair. Renaming changes only the label (`PUT /hosts/<name> {label}`).

## Removing a machine

`DELETE /hosts/<name>` does three things:
- ends this Dispatch's sessions on the machine;
- takes the key's line out of its `authorized_keys`;
- forgets the machine and deletes its key.

If the machine can't be reached, the rest still happens, and the response says which line to delete by hand. `~/.dispatch-host` stays on the machine. Delete it yourself if you want it gone.

## Status

Each machine reports one of three states to Dispatch, re-checked every 30 s:
- **online**;
- **degraded**, with the reason: low disk, no git, an unreadable login environment;
- **offline**, with the reason: no answer, refused, the key refused, a different host key.

`GET /hosts` lists the machines with their status and their last probe (OS, architecture, tools, free disk, who is logged in at the screen). `POST /hosts/<name>/check` reconnects now.
