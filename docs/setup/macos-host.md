# Preparing a Mac to be a remote host

This is the one-time setup for a Mac that `remote-host` will run chats' terminals on. It was written for
`cvx-mac` (Apple silicon, macOS 15 or later), but works for any Mac. The design behind it is
[docs/design/remote-host.md](../design/remote-host.md), §5.

**Who does what.**
- You do every step yourself, at the Mac or over Screen Sharing, signed in to **your own admin account**.
- Commands that start with `sudo` run in Terminal under that admin account.
- Dispatch never signs in to your account and never asks for its password. It only ever connects as `dispatch`,
  and it never runs `sudo`.

**How far to go.**
- **Part 1 (steps 1–3) is all that pairing needs.** Do it, then send the step 3 output back and stop.
- **Part 2** is needed before the first live run of Phase 3 (terminals and sync on the Mac).
- **Part 3** is for the GUI tier (Phase 4: Simulator, UI tests, browsers). It can wait.

Steps marked **UNVERIFIED** haven't been tried on a real Mac yet (design doc §8). Do them, and say what happened.

---

## Part 1: critical path (pairing)

### 1. Create a standard user called `dispatch`

1. Open **System Settings → Users & Groups**.
2. Click **Add User…** and enter your admin password.
3. Fill in:
   - **New User:** Standard. Never Administrator.
   - **Full Name:** `Dispatch`
   - **Account Name:** `dispatch`
   - **Password:** a new one you don't use anywhere else. If you pick the password way of pairing, you type it
     into Dispatch once; Dispatch never stores it.
4. Click **Create User**. Don't sign this user in to an Apple Account.

Nothing personal should ever live on this account: no Apple Account, no keys, no browser profiles.

**Verify** in Terminal:

```sh
id dispatch
dseditgroup -o checkmember -m dispatch admin
```

- `id` prints a line that starts `uid=…(dispatch)`.
- The second command must say `no dispatch is NOT a member of admin`.

### 2. Turn on Remote Login for `dispatch` only

1. Open **System Settings → General → Sharing**.
2. Turn on **Remote Login**, then click the **ⓘ** next to it.
3. Turn **Allow full disk access for remote users** OFF.
4. Under **Allow access for**, choose **Only these users**.
5. Select **Administrators** in the list and click **−** to remove it.
6. Click **+** and add **Dispatch**. The list should now hold only Dispatch.
7. Click **Done**.

If the macOS firewall is on, leave it on. Remote Login is let through automatically.

**Verify** in Terminal (still in your admin account):

```sh
dseditgroup -o checkmember -m dispatch com.apple.access_ssh
dseditgroup -o checkmember -m "$USER" com.apple.access_ssh
ssh dispatch@localhost 'id -un'
ssh "$USER"@localhost true
```

- The first line must say `yes dispatch is a member…`.
- The second must say `no … is NOT a member…`.
- The first `ssh` asks you to trust a host key. Its `SHA256:` fingerprint must match one of the
  `ssh host keys` lines that step 3 prints. Type `yes`, then `dispatch`'s password. It must print `dispatch`.
- The last `ssh` must FAIL with `Permission denied` or `Connection closed`. If it lets you in, Administrators
  is still on the list. Go back to step 2.5.

### 3. Report the Mac's details

Paste this whole block into Terminal and send back everything it prints:

```sh
{
  echo "== macOS";       sw_vers
  echo "== chip";        uname -m; sysctl -n machdep.cpu.brand_string
  echo "== model";       system_profiler SPHardwareDataType | grep -E 'Model (Name|Identifier)|Chip|Memory'
  echo "== battery";     system_profiler SPPowerDataType | grep -E 'Cycle Count|Condition|Maximum Capacity'
  echo "== filevault";   fdesetup status
  echo "== free disk";   df -h /System/Volumes/Data | tail -1
  echo "== addresses";   for i in en0 en1; do printf '%s ' "$i"; ipconfig getifaddr "$i" || echo none; done
  echo "== ssh host keys"; for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
  echo "== dispatch user"; id dispatch
  echo "== ssh access";  dseditgroup -o checkmember -m dispatch com.apple.access_ssh
} 2>&1
```

Everything here is safe to share. The host key fingerprints are public: they're what Dispatch pins, and the Pair
dialog shows one for you to compare against this output.

**Stop here if:**
- `uname -m` says `x86_64` (an Intel Mac), or
- `ProductVersion` is 14 or lower.

Either rules out parts of the design (§5 pre-flight). Send the output anyway.

---

## Part 2: before the first live run (Phase 3)

### 4. Make sshd drop dead sessions fast

A Wi-Fi blip can leave a session half-open. With this, sshd notices within about 45 seconds instead of hours.

```sh
grep -n '^Include' /etc/ssh/sshd_config
sudo tee /etc/ssh/sshd_config.d/200-dispatch.conf >/dev/null <<'EOF'
# Dispatch remote-host: drop half-open sessions fast.
ClientAliveInterval 15
EOF
sudo sshd -t && echo "sshd config OK"
sudo sshd -T | grep -i '^clientalive'
```

- `grep` must print `Include /etc/ssh/sshd_config.d/*`. If it prints nothing, stop and tell us. Don't edit
  `/etc/ssh/sshd_config` itself; macOS updates replace it.
- `sshd -t` must print `sshd config OK`.
- `sshd -T` must show `clientaliveinterval 15`.

macOS starts sshd fresh for each connection, so the next connection picks this up with no restart. If a new
connection doesn't seem to, turn Remote Login off and on again.

### 5. Make `git` work for `dispatch`

Sync needs git on the Mac. `/usr/bin/git` is only a stub until Apple's developer tools are installed.

```sh
xcode-select -p
```

- If it prints a path, the tools are there. Go to the check below.
- If it errors, run `xcode-select --install` and click **Install** in the dialog. If you'd rather have full
  Xcode, do step 14 now instead; it includes git.

**Verify:**

```sh
ssh dispatch@localhost 'git --version'
```

It must print `git version …`. If it prints `xcrun: error: invalid active developer path`, the tools aren't
installed yet.

### 6. Install what your builds need

`dispatch` runs your project's commands with the `PATH` its login shell gives it. Dispatch installs its own Node
for its own use only; that one is not on `PATH`. So whatever your builds call (node, pnpm, and so on) must be
installed for `dispatch` to see.

The simplest way is Homebrew under your admin account, made visible to every user:

```sh
# Skip the first line if `brew --version` already works in your account.
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node pnpm
echo /opt/homebrew/bin | sudo tee /etc/paths.d/homebrew
```

**Verify:**

```sh
ssh dispatch@localhost 'zsh -lc "command -v node pnpm git"'
```

It must print three paths. `zsh -lc` matters: it's the login shell, which is where Dispatch reads `PATH` from.

### 7. Keep it awake

1. Keep it plugged in, with the **lid open**. With the lid closed and no external display it sleeps, even on
   power.
2. **System Settings → Battery → Options…**:
   - Turn **Prevent automatic sleeping on power adapter when the display is off** ON.
   - Set **Wake for network access** to **Always** or **Only on Power Adapter**.
3. In Terminal, one line at a time:

   ```sh
   sudo pmset -c sleep 0
   sudo pmset -c disksleep 0
   sudo pmset -c womp 1
   sudo pmset -c powernap 0
   sudo pmset -a standby 0
   sudo pmset -a hibernatemode 0
   pmset -g
   ```

   **UNVERIFIED on Apple silicon:** `standby` and `hibernatemode` may be refused or ignored there. If a line
   errors, carry on with the rest and send the `pmset -g` output.

The display may still turn off. That's fine for Phase 3.

### 8. Keep its network address stable

Ethernet is best. On Wi-Fi:

1. Open **System Settings → Wi-Fi** and click **Details…** next to the connected network.
2. Set **Private Wi-Fi address** to **Off**.
3. In your router, give the Mac a DHCP reservation. If its address changed, send the new one.

Dispatch tries the `.lan` name, the `.local` name and the last address it saw. The pinned host key, not the
address, is what tells it this is the right Mac.

### 9. Turn off automatic updates

An update that lands mid-run restarts the Mac. An Xcode update also breaks git and clang until someone accepts
the new license.

1. Open **System Settings → General → Software Update** and click the **ⓘ** next to **Automatic Updates**.
   - **Download new updates when available:** OFF.
   - **Install macOS updates:** OFF.
   - **Install application updates from the App Store:** OFF.
   - **Install Security Responses and system files:** leave ON. They're small. If one restarts the Mac,
     Dispatch shows it offline until it's back.
2. In the **App Store**, open **App Store → Settings** and turn **Automatic Updates** OFF.

Update the Mac yourself when nothing is running on it. If Xcode updated, redo step 14's `sudo` lines.

### 10. Set a battery charge limit

A warm garage and a battery held at 100% around the clock make batteries swell.

- **macOS 26.4 or later:** **System Settings → Battery**, click the **ⓘ** next to **Charging**, and set
  **Charge Limit** to 80%.
- **macOS 15 to 26.3** has no manual limit. Under **System Settings → Battery**, click the **ⓘ** next to
  **Battery Health** and make sure **Optimized Battery Charging** is ON. **UNVERIFIED:** whether it holds at 80%
  on a Mac that is never unplugged.

Don't install a third-party charge limiter without telling us first. They run a root helper.

---

## Part 3: GUI tier (Phase 4, can wait)

These let Dispatch use the Mac's screen session: Simulator, UI tests and browsers. Nothing in Phase 3 needs them.

### 11. Turn FileVault off

**The trade-off, decided 2026-10-31:** with FileVault on, the Mac can't log in by itself after a reboot, so the GUI
tier stays down until someone types a password at it. With it off, the whole disk is unencrypted, **including
your own account's files**. Anyone who takes the laptop can read them, and gets an unlocked session as
`dispatch`. If your account on this Mac holds anything sensitive, move it off first.

1. In Terminal: `fdesetup status`. If it says `FileVault is Off.`, skip to step 12.
2. Open **System Settings → Privacy & Security**, scroll to **FileVault**, and click **Turn Off…**.
3. Decrypting takes a while. Keep it plugged in. `fdesetup status` shows the progress.

### 12. Log in as `dispatch` automatically

1. Log out of your account, then log in once as **Dispatch** at the Mac. In Setup Assistant:
   - skip the Apple Account;
   - turn Siri, Screen Time and analytics off.
2. Do step 13 while you're in there, then log out.
3. Log back in to your admin account. Open **System Settings → Users & Groups**, set
   **Automatically log in as** to **Dispatch**, and enter `dispatch`'s password. The option is missing while
   FileVault is on or still decrypting.
4. Restart. The Mac should come up at Dispatch's desktop without asking for anything.

**UNVERIFIED (design §8):** starting Dispatch's GUI agent in that session from SSH
(`launchctl bootstrap gui/<uid>`). That's Phase 4's first test, and there's nothing to do for it now.

### 13. Turn the screen lock off for `dispatch`

Do this while logged in as Dispatch. It's a per-user setting.

1. Open **System Settings → Lock Screen**.
2. **Start Screen Saver when inactive:** Never.
3. **Require password after screen saver begins or display is turned off:** Never.

### 14. Accept the Xcode license and run its first launch

1. In your admin account, install **Xcode** from the App Store, signed in with your own Apple Account. Never
   sign in as `dispatch`. It installs into `/Applications`, where every user can run it.
2. In Terminal:

   ```sh
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   sudo xcodebuild -runFirstLaunch
   ```

**Verify:**

```sh
ssh dispatch@localhost 'xcodebuild -version; xcodebuild -checkFirstLaunchStatus; echo "first-launch exit $?"'
```

It must print Xcode's version and `first-launch exit 0`. Simulator runtimes come later; Phase 4 will say which.

### 15. Let UI tests run without a password prompt

```sh
sudo automationmodetool enable-automationmode-without-authentication
sudo DevToolsSecurity -enable
sudo dseditgroup -o edit -a dispatch -t user _developer
sudo safaridriver --enable
automationmodetool
```

The last line must say that the device does NOT require user authentication to enable Automation Mode.

**UNVERIFIED:**
- whether `dispatch` needs to be in `_developer` once `DevToolsSecurity` is enabled;
- whether `safaridriver --enable` run from your account turns remote automation on for `dispatch`, or only for
  you.

The keychain setup for code signing needs `dispatch`'s keychain password. It's a Phase 4 step.

---

## What Dispatch does on the Mac

When you pair the Mac, Dispatch:
- pins the Mac's SSH host key BEFORE it sends any password. A different key at any address means "not this Mac",
  never "trust the new key". You can only re-pin from Settings.
- writes one line to `/Users/dispatch/.ssh/authorized_keys`. That line accepts Dispatch's key only from the
  Dispatch machine's own addresses, gives it no terminal device and no agent or X11 forwarding, and lets it
  forward only to ports on the Mac's own `127.0.0.1`.
- installs its agent and a pinned Node under `/Users/dispatch/.dispatch-host/`.

It writes nothing outside `dispatch`'s home folder, and it never uses `sudo`.

## Undo it all

1. **System Settings → Users & Groups:** delete the Dispatch user, and choose to delete its home folder.
2. **System Settings → General → Sharing:** turn Remote Login off.
3. In Terminal:

   ```sh
   sudo rm /etc/ssh/sshd_config.d/200-dispatch.conf
   sudo rm -f /etc/paths.d/homebrew
   sudo pmset restoredefaults
   ```

4. Turn auto-login, automatic updates and FileVault back to how you want them.

## Still unknown (design §8)

None of these block Phase 3. They're tested first in the phase that needs them.
- Starting the GUI agent from SSH (`launchctl bootstrap gui/<uid>`) on macOS 15 and later. Reported to fail with
  errors 5 or 125 on some versions.
- Whether processes started under sshd are exempt from Local Network Privacy, as Apple's TN3179 says.
- Whether headless Playwright WebKit needs the window server.
- Whether the official Node macOS binary is Developer ID signed.
