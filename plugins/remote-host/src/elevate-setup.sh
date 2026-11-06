#!/bin/bash
# Lets Dispatch's remote-host plugin run a command as root on this Mac, each
# time only after you approve that exact command in the chat that asked. Run
# it once, with sudo, as an administrator. It:
#
#  1. checks that nobody but root can write anywhere above the helper;
#  2. creates a hidden account with no password. It can log in over SSH only
#     with one key, which only Dispatch holds, only from that computer's
#     addresses, and only to run the helper;
#  3. installs the helper, root-owned;
#  4. lets that account, and nobody else, run the helper as root without a
#     password: a sudoers.d rule, checked with visudo first;
#  5. starts the helper's log, readable by root only.
#
# Running it again replaces the key and the helper. To undo it all:
#   sudo <the helper> uninstall
#
# Everything is in main(), which runs only once bash has read all of it.

main() {
  MACHINE=@SLUG@
  ACCOUNT=@ACCOUNT@
  ACCOUNT_HOME=@HOME@
  HELPER=@HELPER@
  SUDOERS=@SUDOERS@
  LOG=@LOG@
  KEY_LINE=@KEY_LINE@
  PATH=/usr/bin:/bin:/usr/sbin:/sbin
  export PATH
  umask 022

  [ "$(id -u)" = 0 ] || fail "run it with sudo"
  [ "$(uname -s)" = Darwin ] || fail "this sets up a Mac"
  echo "Setting up root-with-your-approval for Dispatch ($MACHINE):"

  # 1. Root-owned all the way down: otherwise `dispatch` (an admin), or
  # anyone, could swap the helper for something else.
  local d
  for d in / /usr /usr/local /private /private/var; do safe_dir "$d"; done
  [ -e /usr/local/libexec ] && safe_dir /usr/local/libexec
  if [ ! -e /usr/local/libexec ]; then
    mkdir -m 755 /usr/local/libexec && chown root:wheel /usr/local/libexec || fail "can't create /usr/local/libexec"
  fi
  step "nobody but root can write above $HELPER"

  # 2. The account. Its id is free as both a user and a group id, below 500
  # (hidden, like the system's own); it keeps its id when set up again.
  local id gid
  if dscl . -read "/Users/$ACCOUNT" >/dev/null 2>&1; then
    id=$(dscl . -read "/Users/$ACCOUNT" UniqueID | awk '{print $2}')
    gid=$(dscl . -read "/Users/$ACCOUNT" PrimaryGroupID | awk '{print $2}')
    [ -n "$id" ] && [ -n "$gid" ] || fail "$ACCOUNT exists but has no ids; remove it first"
  else
    local used n
    used=" $(dscl . -list /Users UniqueID | awk '{print $2}' | tr '\n' ' ') $(dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | tr '\n' ' ') "
    n=401
    while [ $n -le 498 ]; do
      case $used in *" $n "*) n=$((n + 1)) ;; *) break ;; esac
    done
    [ $n -le 498 ] || fail "no id between 401 and 498 is free for $ACCOUNT"
    id=$n
    gid=$n
    if ! dscl . -read "/Groups/$ACCOUNT" >/dev/null 2>&1; then
      dscl . -create "/Groups/$ACCOUNT" PrimaryGroupID "$gid" &&
        dscl . -create "/Groups/$ACCOUNT" RealName "Dispatch elevation" &&
        dscl . -create "/Groups/$ACCOUNT" Password '*' || fail "can't create the group $ACCOUNT"
    else
      gid=$(dscl . -read "/Groups/$ACCOUNT" PrimaryGroupID | awk '{print $2}')
    fi
    dscl . -create "/Users/$ACCOUNT" &&
      dscl . -create "/Users/$ACCOUNT" UniqueID "$id" &&
      dscl . -create "/Users/$ACCOUNT" PrimaryGroupID "$gid" || fail "can't create the account $ACCOUNT"
  fi
  dscl . -create "/Users/$ACCOUNT" UserShell /bin/bash &&
    dscl . -create "/Users/$ACCOUNT" NFSHomeDirectory "$ACCOUNT_HOME" &&
    dscl . -create "/Users/$ACCOUNT" RealName "Dispatch elevation" &&
    dscl . -create "/Users/$ACCOUNT" Password '*' &&
    dscl . -create "/Users/$ACCOUNT" IsHidden 1 || fail "can't set up the account $ACCOUNT"
  # Remote Login limited to some users: this one may log in too.
  if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
    dseditgroup -o edit -a "$ACCOUNT" -t user com.apple.access_ssh || fail "can't let $ACCOUNT use Remote Login"
  fi
  step "the hidden account $ACCOUNT (uid $id), with no password"

  # Its home and key are root's: the account can't change what it may run.
  mkdir -p "$ACCOUNT_HOME/.ssh" &&
    chown root:wheel "$ACCOUNT_HOME" "$ACCOUNT_HOME/.ssh" &&
    chmod 755 "$ACCOUNT_HOME" "$ACCOUNT_HOME/.ssh" || fail "can't create $ACCOUNT_HOME"
  local t
  t="$ACCOUNT_HOME/.ssh/.authorized_keys.new"
  printf '%s\n' "$KEY_LINE" >"$t" && chown root:wheel "$t" && chmod 644 "$t" &&
    mv -f "$t" "$ACCOUNT_HOME/.ssh/authorized_keys" || fail "can't write its key"
  step "its one key, which may only run the helper"

  # 3. The helper.
  t=$(mktemp "$HELPER.XXXXXX") || fail "can't write next to $HELPER"
  cat >"$t" <<'DISPATCH_ELEVATE_HELPER_EOF'
@HELPER_SCRIPT@
DISPATCH_ELEVATE_HELPER_EOF
  chown root:wheel "$t" && chmod 755 "$t" && mv -f "$t" "$HELPER" || {
    rm -f "$t"
    fail "can't install $HELPER"
  }
  step "the helper, $HELPER"

  # 4. sudo: this account, only the helper, no password. A name with a dot
  # in it is one sudo skips, so the rule is checked before it counts.
  grep -Eq '^[#@]includedir[[:space:]]+(/private)?/etc/sudoers\.d/?[[:space:]]*$' /etc/sudoers ||
    fail "/etc/sudoers doesn't read /etc/sudoers.d"
  t="$(dirname "$SUDOERS")/.dispatch-elevate.new"
  {
    echo "# Dispatch remote-host elevation: written by its setup, removed by"
    echo "# sudo $HELPER uninstall"
    echo "$ACCOUNT ALL=(root) NOPASSWD: $HELPER --root *"
  } >"$t" && chown root:wheel "$t" && chmod 440 "$t" || fail "can't write the sudoers rule"
  if ! visudo -cf "$t" >/dev/null; then
    rm -f "$t"
    fail "the sudoers rule didn't pass visudo's check, so nothing changed in sudo"
  fi
  mv -f "$t" "$SUDOERS" || fail "can't install $SUDOERS"
  if ! visudo -c >/dev/null; then
    rm -f "$SUDOERS"
    fail "sudo's configuration didn't pass visudo's check with the rule in it, so the rule was taken out again"
  fi
  step "the sudoers rule, $SUDOERS (checked with visudo)"

  # 5. The log.
  (umask 077 && : >>"$LOG") && chown root:wheel "$LOG" && chmod 600 "$LOG" || fail "can't create $LOG"
  step "the log, $LOG"

  echo "Done. Back in Dispatch, press Verify."
}

fail() {
  printf 'dispatch-elevate setup: %s\n' "$*" >&2
  exit 1
}

step() { printf '  done: %s\n' "$*"; }

safe_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] || fail "$1 isn't a plain directory"
  local owner mode
  owner=$(stat -f '%u' "$1") && mode=$(stat -f '%Lp' "$1") || fail "can't read $1"
  [ "$owner" = 0 ] || fail "$1 isn't owned by root, so a root helper under it wouldn't be safe"
  case ${mode:1:2} in *[2367]*) fail "$1 is writable by others than root (mode $mode)" ;; esac
}

main
