#!/usr/bin/env bash
# Afey POS server helper, installed as /usr/local/bin/afeypos by installer/install.sh.
#   afeypos status | logs | start | stop | restart | upgrade [--ref TAG] | rollback | backup | restore FILE
#   afeypos reset-password EMAIL NEWPASSWORD | config | doctor [DOMAIN] | uninstall [--remove-data]
set -euo pipefail
[ -f /etc/afeypos/install.conf ] && . /etc/afeypos/install.conf
DIR="${DIR:-/opt/afeypos}" PORT="${PORT:-9999}" REPO="${REPO:-Muzamilafey/afeypos}" REF="${REF:-HEAD}"
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
  doctor)
    # Why does the domain open something else? Checks the app, DNS, who holds 80/443, and where the web
    # server sends DOMAIN over HTTP and HTTPS (asking this server directly, so DNS cannot hide the answer).
    d="${2:-${DOMAIN:-}}"; [ -n "$d" ] || { echo "Usage: afeypos doctor pos.example.com"; exit 1; }
    ok() { printf '  \033[32mOK\033[0m   %s\n' "$*"; }; bad() { printf '  \033[31mFIX\033[0m  %s\n' "$*"; }; tip() { printf '       %s\n' "$*"; }
    echo "Afey POS check for $d"
    if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"service":"afeypos"'; then ok "Afey POS answers on 127.0.0.1:$PORT"; else bad "Afey POS does not answer on port $PORT"; tip "sudo afeypos restart; afeypos logs"; fi
    ips=$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
    mine=$(hostname -I 2>/dev/null || true)
    if [ -z "$ips" ]; then bad "DNS: $d does not resolve"; tip "Add an A record: pos -> this server's public IP"
    else
      match=0; for ip in $ips; do case " $mine " in *" $ip "*) match=1 ;; esac; done
      if [ "$match" = 1 ]; then ok "DNS: $d -> $ips (this server)"
      else bad "DNS: $d -> $ips, but this server's addresses are: $mine"; tip "If that is not this VPS (e.g. a wildcard *.afey.co.ke or the website host), set the A record for 'pos' to this VPS's public IP"; fi
    fi
    owner=$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -o 'users:(("[^"]*"' | sed 's/users:(("//; s/"//' | sort -u | tr '\n' ' ' || true)
    echo "  ..   Ports 80/443 are served by: ${owner:-nothing}"
    if curl -fsS -m 5 -H "Host: $d" "http://127.0.0.1/health" 2>/dev/null | grep -q '"service":"afeypos"'; then ok "http://$d reaches Afey POS"
    else
      bad "http://$d reaches another site, not Afey POS"
      case "$owner" in
        *nginx*)
          if [ -e /etc/nginx/sites-enabled/afeypos.conf ] || [ -e /etc/nginx/conf.d/afeypos.conf ]; then tip "nginx has an Afey POS site, but another site claims $d: sudo nginx -T | grep -n server_name"
          else tip "nginx has no Afey POS site yet: run the install command again (it adds one)"; fi ;;
        *apache*|*httpd*) tip "Apache has no Afey POS site for $d yet: run the install command again" ;;
        *caddy*) tip "Check /etc/caddy/Caddyfile imports sites/*.caddy, then: sudo systemctl reload caddy" ;;
        *) tip "Point the web server on ports 80/443 at http://127.0.0.1:$PORT for $d" ;;
      esac
    fi
    if curl -fsS -m 5 -k --resolve "$d:443:127.0.0.1" "https://$d/health" 2>/dev/null | grep -q '"service":"afeypos"'; then
      if curl -fsS -m 5 --resolve "$d:443:127.0.0.1" "https://$d/health" >/dev/null 2>&1; then ok "https://$d reaches Afey POS with a valid certificate"
      else bad "https://$d reaches Afey POS but the certificate is not valid for $d"; tip "sudo certbot --nginx -d $d   (or --apache; Caddy renews by itself)"; fi
    else
      bad "https://$d does not reach Afey POS (HTTPS goes to another site, usually because $d has no certificate yet)"
      case "$owner" in
        *nginx*) tip "sudo certbot --nginx -d $d" ;;
        *apache*|*httpd*) tip "sudo certbot --apache -d $d" ;;
        *caddy*) tip "journalctl -u caddy -n 50   (Caddy gets the certificate once DNS points here)" ;;
      esac
    fi ;;
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
