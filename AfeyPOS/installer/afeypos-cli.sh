#!/usr/bin/env bash
# Afey POS server helper, installed as /usr/local/bin/afeypos by installer/install.sh
# (as /usr/local/bin/afeypos-NAME for an installation made with --instance NAME).
#   afeypos status | logs | start | stop | restart | upgrade [--ref TAG] | rollback | backup | restore FILE
#   afeypos reset-password EMAIL NEWPASSWORD | config | doctor [DOMAIN] | uninstall [--remove-data]
set -euo pipefail
# Which installation: taken from this command's own name (afeypos-walalaha -> instance "walalaha").
AFEY_NAME="$(basename "$0")"; case "$AFEY_NAME" in afeypos-*) INSTANCE="${AFEY_NAME#afeypos-}" ;; *) AFEY_NAME=afeypos INSTANCE="" ;; esac
CONF="/etc/afeypos${INSTANCE:+/$INSTANCE}/install.conf"
[ -f "$CONF" ] && . "$CONF"
SVC="$AFEY_NAME" DB_SVC="$AFEY_NAME-mongodb" APP_USER="$AFEY_NAME"
MARK="# Afey POS${INSTANCE:+ $INSTANCE} (written by the Afey POS installer)"
DIR="${DIR:-/opt/$AFEY_NAME}" PORT="${PORT:-9999}" REPO="${REPO:-Muzamilafey/afeypos}" REF="${REF:-HEAD}"
NODE="$DIR/runtime/node/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
APP="$DIR/app/server"
as_app() { if id "$APP_USER" >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then runuser -u "$APP_USER" -- "$@"; else "$@"; fi; }
script() { (cd "$APP" && as_app "$NODE" --env-file-if-exists=.env "dist/scripts/$1.js" "${@:2}"); }
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $AFEY_NAME $*"; exit 1; }; }

case "${1:-status}" in
  status)
    systemctl --no-pager --lines=0 status "$DB_SVC" "$SVC" 2>/dev/null || true
    printf '\nHealth: '; curl -fsS "http://127.0.0.1:$PORT/health" || echo "not answering"
    echo; echo "Version: $(readlink -f "$DIR/app")" ;;
  logs) journalctl -u "$SVC" -u "$DB_SVC" -n "${2:-200}" -f ;;
  start|stop|restart) need_root "$1"; systemctl "$1" "$DB_SVC" "$SVC" 2>/dev/null || systemctl "$1" "$SVC" ;;
  upgrade)
    need_root upgrade; shift
    # Take a backup, then re-run the installer of the chosen version (data and configuration are kept).
    script backup || echo "Backup failed; continuing with the upgrade"
    curl -fsSL "https://raw.githubusercontent.com/$REPO/${REF}/AfeyPOS/installer/install.sh" | bash -s -- ${INSTANCE:+--instance "$INSTANCE"} "$@" ;;
  rollback)
    need_root rollback
    prev=$(ls -1dt "$DIR"/releases/* | sed -n 2p); [ -n "$prev" ] || { echo "No earlier version kept"; exit 1; }
    ln -sfn "$prev" "$DIR/app" && systemctl restart "$SVC" && echo "Now running $prev" ;;
  backup) script backup "${@:2}" ;;
  restore)
    need_root restore; [ -n "${2:-}" ] || { echo "Usage: $AFEY_NAME restore FILE.ndjson.gz [--drop-existing]"; exit 1; }
    systemctl stop "$SVC"; script restore "${@:2}"; systemctl start "$SVC" ;;
  reset-password) script resetPassword "${@:2}" ;;
  config) need_root config; ${EDITOR:-nano} "$APP/.env" && systemctl restart "$SVC" ;;
  doctor)
    # Why does the domain open something else? Checks the app, DNS (Cloudflare aware), which web server holds
    # 80/443 and whether it loads the Afey POS site, and what it answers for the domain over HTTP and HTTPS
    # (asked on this server directly), printing what came back and the command that fixes each problem.
    d="${2:-${DOMAIN:-}}"; [ -n "$d" ] || { echo "Usage: $AFEY_NAME doctor pos.example.com"; exit 1; }
    ok() { printf '  \033[32mOK\033[0m   %s\n' "$*"; }; bad() { printf '  \033[31mFIX\033[0m  %s\n' "$*"; }; tip() { printf '       %s\n' "$*"; }; info() { printf '  ..   %s\n' "$*"; }
    is_cloudflare() { case "$1" in 104.1[6-9].*|104.2[0-9].*|104.3[01].*|172.6[4-9].*|172.7[01].*|188.114.9[6-9].*|188.114.10[0-9].*|188.114.11[01].*|162.158.*|141.101.*|108.162.*|190.93.*|197.234.*|198.41.*|173.245.*|103.21.*|103.22.*|103.31.*|131.0.7[2-5].*) return 0 ;; esac; return 1; }
    # What a request answered: code, redirect target or page title.
    answer() { local f; f=$(mktemp); local r; r=$(curl -s -m 8 -o "$f" -w '%{http_code} %{redirect_url}' "$@" 2>/dev/null) || r="no answer"; local t; t=$(grep -o -i '<title>[^<]*' "$f" 2>/dev/null | head -n1 | sed 's/<title>//I' || true); [ -n "$t" ] || t=$(head -c 80 "$f" | tr -d '\r\n' || true); rm -f "$f"; echo "$r | $t"; }
    echo "Afey POS check for $d"
    if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"service":"afeypos"'; then ok "Afey POS answers on 127.0.0.1:$PORT"; else bad "Afey POS does not answer on port $PORT"; tip "sudo $AFEY_NAME restart; $AFEY_NAME logs"; fi
    ips=$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
    mine=$(hostname -I 2>/dev/null || true)
    if [ -z "$ips" ]; then bad "DNS: $d does not resolve"; tip "Add an A record: pos -> this server's public IP"
    else
      match=0 cf=1; for ip in $ips; do case " $mine " in *" $ip "*) match=1 ;; esac; is_cloudflare "$ip" || cf=0; done
      if [ "$match" = 1 ]; then ok "DNS: $d -> $ips (this server)"
      elif [ "$cf" = 1 ]; then
        info "DNS: $d -> $ips = Cloudflare proxy. Cloudflare decides which server gets it; this server cannot see that from here."
        tip "In Cloudflare > DNS: the record for 'pos' must be type A -> $(echo "$mine" | awk '{print $1}') (not a CNAME to afey.co.ke, not the HMIS server's IP)."
        tip "In Cloudflare > SSL/TLS: use 'Full (strict)' (or 'Full'); 'Flexible' causes redirect loops. Then purge Cloudflare's cache."
      else bad "DNS: $d -> $ips, but this server's addresses are: $mine"; tip "Set the A record for 'pos' to this VPS's public IP"; fi
    fi
    owner=$(ss -ltnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -o 'users:(("[^"]*"' | sed 's/users:(("//; s/"//' | sort -u | tr '\n' ' ' || true)
    info "Ports 80/443 are served by: ${owner:-nothing}"
    case "$owner" in *nginx*)
      conf=$(nginx -T 2>/dev/null || true)
      if printf '%s' "$conf" | grep -qxF "$MARK"; then ok "nginx loads the Afey POS site"
      else bad "nginx does not load the Afey POS site (its nginx.conf does not include that folder)"; tip "Run the install command again (it now puts the site where nginx reads it), or: sudo cp /etc/nginx/sites-available/$AFEY_NAME.conf /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx"; fi
      clash=$(printf '%s' "$conf" | awk -v d="$d" '/^# configuration file /{f=$4; sub(/:$/,"",f)} f !~ /afeypos/ && match($0,/server_name[[:space:]][^;]*/) {n=split(substr($0,RSTART,RLENGTH),t,/[[:space:]]+/); for(i=2;i<=n;i++) if (t[i]==d) print f}' | sort -u | tr '\n' ' ' || true)
      if [ -n "$clash" ]; then bad "Another nginx site also uses $d: $clash"; tip "Remove $d from the server_name lines in that file (keep its other names), then: sudo nginx -t && sudo systemctl reload nginx"; fi
      wild=$(printf '%s' "$conf" | awk -v w="*.${d#*.}" '/^# configuration file /{f=$4; sub(/:$/,"",f)} f !~ /afeypos/ && match($0,/server_name[[:space:]][^;]*/) {n=split(substr($0,RSTART,RLENGTH),t,/[[:space:]]+/); for(i=2;i<=n;i++) if (t[i]==w) print f}' | sort -u | tr '\n' ' ' || true)
      [ -n "$wild" ] && info "$wild also covers $d through *.${d#*.}: fine as long as the Afey POS site has both an HTTP and an HTTPS part (an exact name wins)"
      certfile=$(printf '%s' "$conf" | awk -v d="$d" '/^# configuration file /{f=$4; sub(/:$/,"",f)} /ssl_certificate[[:space:]]/ && index($0,"/live/" d "/") && f !~ /afeypos/ {print f}' | sort -u | tr '\n' ' ' || true)
      if [ -n "$certfile" ]; then bad "The certificate for $d is also used by: $certfile"; tip "That site was probably given $d's certificate by 'certbot --nginx -d $d'. Put back its own ssl_certificate lines (e.g. /etc/letsencrypt/live/<its domain>/...), then: sudo nginx -t && sudo systemctl reload nginx"; fi
      info "nginx sites (file: names):"
      printf '%s' "$conf" | awk '/^# configuration file /{f=$4; sub(/:$/,"",f)} /server_name[[:space:]]/ {if (match($0,/server_name[[:space:]][^;]*/)) print "       " f ": " substr($0,RSTART,RLENGTH)}' | sort -u | head -n 20 || true ;;
    esac
    h=$(answer -H "Host: $d" "http://127.0.0.1/health")
    if curl -fsS -m 5 -H "Host: $d" "http://127.0.0.1/health" 2>/dev/null | grep -q '"service":"afeypos"'; then ok "http://$d reaches Afey POS"
    elif printf '%s' "$h" | grep -q "^30[1278] https://$d"; then ok "http://$d redirects to https://$d"
    else bad "http://$d reaches another site, not Afey POS (answer: $h)"; fi
    s=$(answer -k --resolve "$d:443:127.0.0.1" "https://$d/health")
    if curl -fsS -m 5 -k --resolve "$d:443:127.0.0.1" "https://$d/health" 2>/dev/null | grep -q '"service":"afeypos"'; then
      if curl -fsS -m 5 --resolve "$d:443:127.0.0.1" "https://$d/health" >/dev/null 2>&1; then ok "https://$d reaches Afey POS with a valid certificate"
      else bad "https://$d reaches Afey POS but the certificate is not valid for $d"; tip "sudo certbot --nginx -d $d"; fi
    else
      bad "https://$d does not reach Afey POS (answer: $s)"
      case "$owner" in
        *nginx*)
          if ! printf '%s' "$conf" | awk '/^# configuration file /{f=$4} f ~ /afeypos/ && /listen[[:space:]]+(\[::\]:)?443/ {x=1} END {exit !x}'; then
            tip "The Afey POS site has no HTTPS part yet, so another site (e.g. one for *.${d#*.}) answers HTTPS."
          fi
          tip "Run the install command again: it gives Afey POS its own HTTPS part with the certificate for $d."
          tip "Do not use 'certbot --nginx -d $d': it installs the certificate into whichever site matches first (e.g. the *.${d#*.} site)." ;;
        *apache*|*httpd*) tip "sudo certbot --apache -d $d" ;;
      esac
    fi
    if command -v openssl >/dev/null; then
      cert=$(echo | timeout 8 openssl s_client -connect 127.0.0.1:443 -servername "$d" 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' || true)
      info "Certificate this server shows for $d: ${cert:-none}"
    fi ;;
  uninstall)
    need_root uninstall
    systemctl disable --now "$SVC" "$DB_SVC" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SVC.service" "/etc/systemd/system/$DB_SVC.service" && systemctl daemon-reload
    if [ "${2:-}" = "--remove-data" ]; then
      read -r -p "Delete ALL Afey POS data in $DIR (sales, stock, customers)? Type DELETE: " a
      [ "$a" = DELETE ] && rm -rf "$DIR" && rm -f "$CONF" && { [ -z "$INSTANCE" ] || rmdir "$(dirname "$CONF")" 2>/dev/null || true; } && userdel "$APP_USER" 2>/dev/null; echo "Removed."
    else
      echo "Services removed. Data and configuration kept in $DIR (delete with: $AFEY_NAME uninstall --remove-data)."
    fi
    rm -f "/usr/local/bin/$AFEY_NAME" ;;
  *) sed -n '2,4p' "$0" ;;
esac
