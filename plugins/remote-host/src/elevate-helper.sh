#!/bin/bash
# dispatch-elevate: runs one command as root for Dispatch's remote-host
# plugin, after the user approved that exact command in the chat that asked.
#
# Installed root-owned by the setup command from Settings → Remote hosts, and
# run only as the forced command of the hidden elevation account's one
# authorized_keys line. Only that Dispatch holds the key, and it logs in with
# it only after an approval. The account may run this file as root (sudoers),
# and nothing else.
#
#   run <id> <base64>  one command as root: the base64 of its directory and
#                      each argument, each ended by a NUL. No shell parses it.
#   check              print this helper's version and the uid it runs as
#   uninstall          remove the account, its key, its sudoers rule and this
#                      file; the log stays
#
# By hand, as an administrator:  sudo <this file> uninstall
#
# Bash 3.2 (macOS's /bin/bash): no `local -n`, no `${x,,}`, no `set -u`
# (an empty array is "unbound" there).

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
HELPER=@HELPER@
VERSION=@VERSION@
ACCOUNT=@ACCOUNT@
ACCOUNT_HOME=@HOME@
SUDOERS=@SUDOERS@
LOG=@LOG@
SUDO=@SUDO@
DSCL=@DSCL@
ROOT_UID=@ROOT_UID@
# The request's base64, in characters. dispatch-host caps argv at 32 KiB.
MAX=65536
ID_RE='^[A-Za-z0-9-]{1,64}$'
B64_RE='^[A-Za-z0-9+/]+=*$'

say() { printf 'dispatch-elevate: %s\n' "$*" >&2; }
# 125: the helper refused, so nothing ran (a command's own codes stay its own).
refuse() {
  say "$*"
  exit 125
}

valid() {
  [[ $1 =~ $ID_RE ]] || refuse "not a request id"
  [ ${#2} -le $MAX ] || refuse "the request is too long"
  [[ $2 =~ $B64_RE ]] || refuse "not a request"
}

# The account's half: the forced command. It checks the request's shape and
# hands it to sudo, which lets this account run only this file.
forced() {
  case $SSH_ORIGINAL_COMMAND in
    check | uninstall) exec "$SUDO" -n "$HELPER" --root "$SSH_ORIGINAL_COMMAND" ;;
    "run "*) ;;
    *) refuse "not a request this helper takes" ;;
  esac
  set -f
  # shellcheck disable=SC2086 # split on purpose: three words, globbing off
  set -- $SSH_ORIGINAL_COMMAND
  [ $# -eq 3 ] || refuse "not a request this helper takes"
  valid "$2" "$3"
  exec "$SUDO" -n "$HELPER" --root run "$2" "$3"
}

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG"; }

# Root's half. Everything is checked again: sudoers lets the account pass any
# arguments after --root.
as_root() {
  [ "$(id -u)" = "$ROOT_UID" ] || refuse "--root is for sudo, through the elevation account"
  # Nothing runs without a line in the log first.
  (umask 077 && : >>"$LOG") 2>/dev/null || refuse "can't write $LOG, so nothing ran"
  case $1 in
    check)
      [ $# -eq 1 ] || refuse "not a request"
      log "check"
      echo "dispatch-elevate $VERSION uid=$(id -u)"
      ;;
    uninstall)
      [ $# -eq 1 ] || refuse "not a request"
      uninstall
      ;;
    run)
      [ $# -eq 3 ] || refuse "not a request"
      valid "$2" "$3"
      run "$2" "$3"
      ;;
    *) refuse "not a request this helper takes" ;;
  esac
}

run() {
  local id=$1 a cwd pid watcher rc
  local -a args
  # NUL-separated, so any byte but NUL survives; a shell never sees it.
  while IFS= read -r -d '' a; do args[${#args[@]}]=$a; done < <(printf '%s' "$2" | base64 --decode 2>/dev/null)
  [ ${#args[@]} -ge 2 ] || refuse "not a request"
  cwd=${args[0]}
  case $cwd in /*) ;; *) refuse "not an absolute directory" ;; esac
  log "run $id in $(printf '%q' "$cwd"):$(printf ' %q' "${args[@]:1}")"
  cd "$cwd" 2>/dev/null || {
    log "run $id: no such directory"
    refuse "there is no directory $cwd here, so nothing ran"
  }
  # Dispatch closes the channel to cancel; this script's stdin then ends.
  # The command reads nothing (no one could type into it), runs in its own
  # process group, and a watcher stops that group when stdin ends.
  exec 3<&0
  set -m
  env -i -- PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root USER=root LOGNAME=root SHELL=/bin/sh TMPDIR=/tmp \
    "${args[@]:1}" </dev/null 3<&- &
  pid=$!
  (
    cat <&3 >/dev/null 2>&1
    kill -TERM -- "-$pid" 2>/dev/null
    sleep 5
    kill -KILL -- "-$pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  watcher=$!
  # Out of the job table at once. With job control on, bash reports a job it
  # finds killed by a signal ("[2]+ Terminated  ( cat …") on its own stderr,
  # which is the command's stderr here, whenever it next looks: the watcher is
  # always killed below, so that line now and then followed the command's own
  # output. A disowned job is never reported, and is still killed by group.
  # (By pid; failing that, the current job, which is the watcher just started.)
  disown "$watcher" 2>/dev/null || disown 2>/dev/null
  exec 3<&-
  trap 'kill -TERM -- "-$pid" 2>/dev/null' HUP INT TERM
  wait "$pid" 2>/dev/null
  rc=$?
  # A trapped signal interrupts wait; the command's own end comes after.
  while kill -0 "$pid" 2>/dev/null; do
    wait "$pid" 2>/dev/null
    rc=$?
  done
  kill -- "-$watcher" 2>/dev/null
  log "run $id: exit $rc"
  return $rc
}

uninstall() {
  local ok=1
  case $ACCOUNT_HOME in /?*/?*) ;; *) refuse "unexpected home directory $ACCOUNT_HOME" ;; esac
  log "uninstall"
  # The key first, so nothing logs in while the rest goes.
  rm -f "$ACCOUNT_HOME/.ssh/authorized_keys" || ok=0
  rm -f "$SUDOERS" || ok=0
  if "$DSCL" . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
    "$DSCL" . -delete /Groups/com.apple.access_ssh GroupMembership "$ACCOUNT" >/dev/null 2>&1
  fi
  if "$DSCL" . -read "/Users/$ACCOUNT" >/dev/null 2>&1; then "$DSCL" . -delete "/Users/$ACCOUNT" || ok=0; fi
  if "$DSCL" . -read "/Groups/$ACCOUNT" >/dev/null 2>&1; then "$DSCL" . -delete "/Groups/$ACCOUNT" || ok=0; fi
  rm -rf "$ACCOUNT_HOME" || ok=0
  rm -f "$HELPER" || ok=0
  if [ $ok = 1 ]; then
    log "uninstalled"
    echo "removed: the account $ACCOUNT, its key, $SUDOERS and $HELPER (the log, $LOG, stays)"
  else
    log "uninstall: something was left"
    echo "partly removed: see the errors above" >&2
    exit 1
  fi
}

if [ "$1" = --root ]; then
  shift
  as_root "$@"
  exit $?
fi
if [ $# -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND+set}" ]; then forced; fi
if [ $# -eq 1 ] && [ "$1" = uninstall ] && [ "$(id -u)" = "$ROOT_UID" ]; then
  as_root uninstall
  exit $?
fi
echo "usage: sudo $HELPER uninstall    (everything else is for Dispatch's elevation login)" >&2
exit 2
