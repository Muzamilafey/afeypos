#!/usr/bin/env bash
# Afey POS server helper, installed as /usr/local/bin/afeypos by installer/install.sh.
#   afeypos status | logs | start | stop | restart | upgrade [--ref TAG] | rollback | backup | restore FILE
#   afeypos reset-password EMAIL NEWPASSWORD | config | uninstall [--remove-data]
set -euo pipefail
[ -f /etc/afeypos/install.conf ] && . /etc/afeypos/install.conf
DIR="${DIR:-/opt/afeypos}" PORT="${PORT:-4000}" REPO="${REPO:-Muzamilafey/afeypos}" REF="${REF:-HEAD}"
NODE="$DIR/runtime/node/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
APP="$DIR/app/server"
as_app() { if id afeypos >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then runuser -u afeypos -- "$@"; else "$@"; fi; }
script() { (cd "$APP" && as_app "$NODE" --env-file-if-exists=.env "dist/scripts/$1.js" "${@:2}"); }
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo afeypos $*"; exit 1; }; }

case "${1:-status}" in
  status)
    systemctl --no-pager --lines=0 status afeypos-mongodb afeypos 2>/dev/null || true
    printf '\nHealth: '; curl -fsS "http://127.0.0.1:$PORT/health" || echo "not answering"
    echo; echo "Version: $(readlink -f "$DIR/app")" ;;
  logs) journalctl -u afeypos -u afeypos-mongodb -n "${2:-200}" -f ;;
  start|stop|restart) need_root "$1"; systemctl "$1" afeypos-mongodb afeypos 2>/dev/null || systemctl "$1" afeypos ;;
  upgrade)
    need_root upgrade; shift
    # Take a backup, then re-run the installer of the chosen version (data and configuration are kept).
    script backup || echo "Backup failed; continuing with the upgrade"
    curl -fsSL "https://raw.githubusercontent.com/$REPO/${REF}/AfeyPOS/installer/install.sh" | bash -s -- "$@" ;;
  rollback)
    need_root rollback
    prev=$(ls -1dt "$DIR"/releases/* | sed -n 2p); [ -n "$prev" ] || { echo "No earlier version kept"; exit 1; }
    ln -sfn "$prev" "$DIR/app" && systemctl restart afeypos && echo "Now running $prev" ;;
  backup) script backup "${@:2}" ;;
  restore)
    need_root restore; [ -n "${2:-}" ] || { echo "Usage: afeypos restore FILE.ndjson.gz [--drop-existing]"; exit 1; }
    systemctl stop afeypos; script restore "${@:2}"; systemctl start afeypos ;;
  reset-password) script resetPassword "${@:2}" ;;
  config) need_root config; ${EDITOR:-nano} "$APP/.env" && systemctl restart afeypos ;;
  uninstall)
    need_root uninstall
    systemctl disable --now afeypos afeypos-mongodb 2>/dev/null || true
    rm -f /etc/systemd/system/afeypos.service /etc/systemd/system/afeypos-mongodb.service && systemctl daemon-reload
    if [ "${2:-}" = "--remove-data" ]; then
      read -r -p "Delete ALL Afey POS data in $DIR (sales, stock, customers)? Type DELETE: " a
      [ "$a" = DELETE ] && rm -rf "$DIR" /etc/afeypos && userdel afeypos 2>/dev/null; echo "Removed."
    else
      echo "Services removed. Data and configuration kept in $DIR (delete with: afeypos uninstall --remove-data)."
    fi
    rm -f /usr/local/bin/afeypos ;;
  *) sed -n '2,4p' "$0" ;;
esac
