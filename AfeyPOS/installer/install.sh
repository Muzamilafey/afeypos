#!/usr/bin/env bash
# Afey POS one-line installer for Linux (Ubuntu, Debian, RHEL/Rocky/Alma, Amazon Linux; x86_64 and arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh | sudo bash
#
# Pass options after "-s --":   ... | sudo bash -s -- --mode hq --public-url https://hq.myshop.co.ke --domain hq.myshop.co.ke
#
# It downloads and installs everything: Node.js 22 and MongoDB 8 (checksums verified, kept in /opt/afeypos/runtime,
# nothing else on the system is changed), the Afey POS app, a database replica set, the configuration with fresh
# secrets, and two services (afeypos-mongodb, afeypos) that start at boot. Run it again to upgrade: data,
# configuration and secrets are kept, and the previous version stays for rollback.
#
# Options:
#   --mode standalone|hq|branch    one shop (default), head office online, or a branch server
#   --port 9999                    port for the tills / browser
#   --public-url URL               address staff use (default http://<LAN IP>:<port>; required for hq)
#   --domain NAME                  get HTTPS for NAME with Caddy (needs ports 80/443 open to the internet)
#   --shop-host NAME               also serve the online shop for NAME
#   --hq-url URL --sync-token T --branch-code C   branch servers (from head office: Administration > Branch sync)
#   --encryption-key KEY           branch servers: head office's ENCRYPTION_KEY (from its server/.env)
#   --mongo-uri URI                use an existing MongoDB replica set (e.g. Atlas) instead of installing one
#   --mongo-user U --mongo-password P   login for that MongoDB (kept as MONGODB_USERNAME/PASSWORD in server/.env)
#   --dir /opt/afeypos             install location
#   --ref HEAD                     branch, tag or commit to install (HEAD = the default branch);   --repo owner/name (default Muzamilafey/afeypos)
#   --source DIR                   install from a local copy of the AfeyPOS folder instead of downloading
#   --mongod PATH                  use this mongod binary instead of downloading MongoDB
#   --no-service                   do not create system services (containers, testing): runs both in the background
#   GITHUB_TOKEN=...               environment variable for a private repository
set -euo pipefail

NODE_MAJOR=22
MONGO_VERSION="${MONGO_VERSION:-8.0.4}"
ENC_KEY="${AFEY_ENCRYPTION_KEY:-}"
MODE=standalone PORT=9999 PUBLIC_URL="" DOMAIN="" SHOP_HOST="" HQ_URL="" SYNC_TOKEN="" BRANCH_CODE="" MONGO_URI=""
DIR=/opt/afeypos REF=HEAD REPO=Muzamilafey/afeypos SOURCE="" MONGOD_BIN="" NO_SERVICE=0

say() { printf '\033[32m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Re-runs (upgrades) reuse the options of the first install unless given again.
[ -f /etc/afeypos/install.conf ] && . /etc/afeypos/install.conf
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift ;; --port) PORT="$2"; shift ;; --public-url) PUBLIC_URL="$2"; shift ;;
    --encryption-key) ENC_KEY="$2"; shift ;;
    --domain) DOMAIN="$2"; shift ;; --shop-host) SHOP_HOST="$2"; shift ;; --hq-url) HQ_URL="$2"; shift ;;
    --sync-token) SYNC_TOKEN="$2"; shift ;; --branch-code) BRANCH_CODE="$2"; shift ;; --mongo-uri) MONGO_URI="$2"; shift ;;
    --mongo-user) MONGO_USER="$2"; shift ;; --mongo-password) MONGO_PASSWORD="$2"; shift ;;
    --dir) DIR="$2"; shift ;; --ref) REF="$2"; shift ;; --repo) REPO="$2"; shift ;; --source) SOURCE="$2"; shift ;;
    --mongod) MONGOD_BIN="$2"; shift ;; --no-service) NO_SERVICE=1 ;;
    -h|--help) sed -n '2,32p' "$0" 2>/dev/null || echo "See installer/install.sh"; exit 0 ;;
    *) die "Unknown option $1 (see --help)" ;;
  esac
  shift
done
case "$MODE" in standalone|hq|branch) ;; *) die "--mode must be standalone, hq or branch" ;; esac
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[ -n "$DOMAIN" ] && [ -z "$PUBLIC_URL" ] && PUBLIC_URL="https://$DOMAIN"
[ "$MODE" = hq ] && [ -z "$PUBLIC_URL" ] && die "Head office needs --public-url https://... (or --domain NAME)"

[ "$(id -u)" -eq 0 ] || [ "$NO_SERVICE" = 1 ] || die "Run as root: curl ... | sudo bash"
[ "$(uname -s)" = Linux ] || die "This installer is for Linux. On Windows use installer/windows/install-online.ps1; on a Mac use 'npm run local'."
case "$(uname -m)" in x86_64|amd64) NARCH=x64 MARCH=x86_64 ;; aarch64|arm64) NARCH=arm64 MARCH=aarch64 ;; *) die "Unsupported CPU $(uname -m)" ;; esac
. /etc/os-release 2>/dev/null || true

RUNTIME="$DIR/runtime" DATA="$DIR/data" RELEASES="$DIR/releases"
mkdir -p "$RUNTIME" "$DATA" "$RELEASES" "$DIR/mongodb/db" "$DIR/mongodb/log" "$DIR/tmp"

# ---------- system packages (only what downloading and MongoDB need) ----------
say "Checking system packages"
need=()
for c in curl tar xz sha256sum; do command -v "$c" >/dev/null || need+=("$c"); done
if command -v apt-get >/dev/null; then
  pkgs=(ca-certificates curl tar xz-utils coreutils)
  [ -z "$MONGO_URI" ] && pkgs+=(libcurl4 openssl)
  dpkg -s "${pkgs[@]}" >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pkgs[@]}" >/dev/null || [ ${#need[@]} -eq 0 ] || die "Could not install: ${pkgs[*]}"; }
elif command -v dnf >/dev/null || command -v yum >/dev/null; then
  pm=$(command -v dnf || command -v yum)
  pkgs=(ca-certificates curl tar xz coreutils); [ -z "$MONGO_URI" ] && pkgs+=(libcurl openssl)
  rpm -q "${pkgs[@]}" >/dev/null 2>&1 || "$pm" install -y -q "${pkgs[@]}" >/dev/null || [ ${#need[@]} -eq 0 ] || die "Could not install: ${pkgs[*]}"
elif [ ${#need[@]} -gt 0 ]; then
  die "Please install: ${need[*]}"
fi

fetch() { # url dest
  local auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && [[ "$1" == *github* ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fSL --retry 3 --retry-delay 2 --progress-bar "${auth[@]}" -o "$2" "$1" || die "Download failed: $1"
}

# ---------- Node.js ----------
NODE="$RUNTIME/node/bin/node"
sys_node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)'; }
if [ -x "$NODE" ] && "$NODE" -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)'; then
  note "Node.js $("$NODE" -v) (already installed)"
elif sys_node_ok; then
  NODE="$(command -v node)"; note "Using Node.js $(node -v) from the system"
else
  say "Downloading Node.js $NODE_MAJOR"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$DIR/tmp/node-SHASUMS256.txt"; fetch "$base/SHASUMS256.txt" "$sums"
  file=$(grep -m1 -o "node-v[0-9.]*-linux-${NARCH}.tar.xz" "$sums"); [ -n "$file" ] || die "No Node.js build for linux-$NARCH"
  fetch "$base/$file" "$DIR/tmp/$file"
  (cd "$DIR/tmp" && grep " $file\$" "$sums" | sha256sum -c --status) || die "Node.js checksum mismatch"
  rm -rf "$RUNTIME/node" && mkdir -p "$RUNTIME/node" && tar -xJf "$DIR/tmp/$file" -C "$RUNTIME/node" --strip-components=1
  note "Node.js $("$NODE" -v)"
fi
export PATH="$(dirname "$NODE"):$PATH"

# ---------- MongoDB ----------
if [ -z "$MONGO_URI" ]; then
  if [ -z "$MONGOD_BIN" ]; then
    if [ -x "$RUNTIME/mongodb/bin/mongod" ]; then MONGOD_BIN="$RUNTIME/mongodb/bin/mongod"
    elif command -v mongod >/dev/null; then MONGOD_BIN="$(command -v mongod)"; fi
  fi
  if [ -z "$MONGOD_BIN" ]; then
    say "Downloading MongoDB $MONGO_VERSION"
    v="${VERSION_ID:-}"; id="${ID:-}"
    case "$id" in
      ubuntu) case "$v" in 24.*) t=ubuntu2404 ;; 22.*) t=ubuntu2204 ;; 20.*) t=ubuntu2004 ;; *) t=ubuntu2404 ;; esac ;;
      debian) case "$v" in 11*) t=debian11 ;; *) t=debian12 ;; esac ;;
      rhel|rocky|almalinux|centos|ol) case "$v" in 8*) t=rhel8 ;; *) t=rhel90 ;; esac ;;
      amzn) t=amazon2023 ;;
      *) note "Unknown distribution '$id', trying the Ubuntu 22.04 build"; t=ubuntu2204 ;;
    esac
    [ "$MARCH" = aarch64 ] && [[ "$t" == rhel8 ]] && t=rhel82
    file="mongodb-linux-${MARCH}-${t}-${MONGO_VERSION}.tgz"
    fetch "https://fastdl.mongodb.org/linux/$file" "$DIR/tmp/$file"
    fetch "https://fastdl.mongodb.org/linux/$file.sha256" "$DIR/tmp/$file.sha256"
    (cd "$DIR/tmp" && echo "$(awk '{print $1}' "$file.sha256")  $file" | sha256sum -c --status) || die "MongoDB checksum mismatch"
    rm -rf "$RUNTIME/mongodb" && mkdir -p "$RUNTIME/mongodb" && tar -xzf "$DIR/tmp/$file" -C "$RUNTIME/mongodb" --strip-components=1
    MONGOD_BIN="$RUNTIME/mongodb/bin/mongod"
  fi
  "$MONGOD_BIN" --version >/dev/null 2>&1 || die "mongod at $MONGOD_BIN does not run (missing system libraries?)"
  note "MongoDB: $("$MONGOD_BIN" --version | sed -n 1p)"
  LOCAL_DB=1
else
  LOCAL_DB=0
fi

# ---------- the app ----------
say "Getting Afey POS"
rel="$RELEASES/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$rel"
# A failed run removes its half-made version; the running one is untouched.
trap '[ -n "${rel:-}" ] && [ -d "$rel" ] && [ "$(readlink -f "$DIR/app" 2>/dev/null)" != "$(readlink -f "$rel")" ] && rm -rf "$rel"' EXIT
if [ -n "$SOURCE" ]; then
  [ -f "$SOURCE/package.json" ] && [ -d "$SOURCE/server" ] || die "--source must be the AfeyPOS folder (with package.json and server/)"
  tar -C "$SOURCE" --exclude=node_modules --exclude=./data --exclude=server/.env --exclude='*/dist' --exclude=test-results -cf - . | tar -C "$rel" -xf -
else
  fetch "https://codeload.github.com/$REPO/tar.gz/$REF" "$DIR/tmp/app.tar.gz"
  # Extract into an empty folder and take its only top-level directory (no "| head": SIGPIPE under pipefail).
  rm -rf "$DIR/tmp/src" && mkdir -p "$DIR/tmp/src" && tar -xzf "$DIR/tmp/app.tar.gz" -C "$DIR/tmp/src"
  top=""; for d in "$DIR/tmp/src"/*/; do top="${d%/}"; break; done
  src="$top/AfeyPOS"; [ -d "$src" ] || src="$top"
  [ -n "$top" ] && [ -f "$src/package.json" ] || die "The download does not contain Afey POS (repo $REPO, ref $REF)"
  cp -a "$src/." "$rel/" && rm -rf "$DIR/tmp/src" "$DIR/tmp/app.tar.gz"
fi
# Keep the configuration (secrets) of the current version: the running app's server/.env, or one placed in
# $DIR/server/.env. Losing it would mean new secrets and an ENCRYPTION_KEY that cannot read saved credentials.
if [ -f "$DIR/app/server/.env" ]; then cp -p "$DIR/app/server/.env" "$rel/server/.env"
elif [ -f "$DIR/server/.env" ]; then cp -p "$DIR/server/.env" "$rel/server/.env"; fi
mkdir -p /etc/afeypos

# ---------- service user and database ----------
if [ "$NO_SERVICE" = 0 ]; then
  id afeypos >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin afeypos
  RUN_AS=(runuser -u afeypos --)
else
  RUN_AS=()
fi

port_busy() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ "$LOCAL_DB" = 1 ]; then
  say "Setting up the database (replica set, listening on 127.0.0.1 only)"
  # Afey POS runs its own MongoDB. Another MongoDB already on this server (often on 27017 with a password)
  # must never be used by mistake: stop ours, keep its remembered port if free, else take the first free
  # port from 27018. To use an existing MongoDB instead, pass --mongo-uri (see docs/VPS.md).
  if [ "$NO_SERVICE" = 0 ]; then systemctl stop afeypos-mongodb 2>/dev/null || true; sleep 1; fi
  if [ -z "${MONGO_PORT:-}" ] && [ -f "$DIR/mongodb/mongod.conf" ]; then MONGO_PORT="$(sed -n 's/^ *port: *\([0-9]*\).*/\1/p' "$DIR/mongodb/mongod.conf" | head -n1)"; fi
  MONGO_PORT="${MONGO_PORT:-27018}"
  if port_busy "$MONGO_PORT"; then
    note "Port $MONGO_PORT is used by another program (another MongoDB?); Afey POS keeps its own database on a free port"
    MONGO_PORT=27018
    while port_busy "$MONGO_PORT"; do MONGO_PORT=$((MONGO_PORT + 1)); [ "$MONGO_PORT" -le 27100 ] || die "No free port for the Afey POS database between 27018 and 27100"; done
  fi
  MONGO_URI="mongodb://127.0.0.1:$MONGO_PORT/afeypos?replicaSet=rs0"
  note "Database port: $MONGO_PORT"
  cat > "$DIR/mongodb/mongod.conf" <<EOF
storage:
  dbPath: $DIR/mongodb/db
systemLog:
  destination: file
  path: $DIR/mongodb/log/mongod.log
  logAppend: true
net:
  bindIp: 127.0.0.1
  port: $MONGO_PORT
replication:
  replSetName: rs0
EOF
  if [ "$NO_SERVICE" = 0 ]; then
    chown -R afeypos:afeypos "$DIR/mongodb"
    cat > /etc/systemd/system/afeypos-mongodb.service <<EOF
[Unit]
Description=Afey POS database (MongoDB)
After=network.target

[Service]
User=afeypos
ExecStart=$MONGOD_BIN --config $DIR/mongodb/mongod.conf
Restart=always
RestartSec=5
LimitNOFILE=64000
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload && systemctl enable afeypos-mongodb >/dev/null
    systemctl restart afeypos-mongodb
  else
    "$MONGOD_BIN" --config "$DIR/mongodb/mongod.conf" --fork >/dev/null
  fi
  # Our own database must be the one answering before going on.
  up=0
  for _ in $(seq 1 30); do if port_busy "$MONGO_PORT"; then up=1; break; fi; sleep 1; done
  if [ "$up" = 0 ] || { [ "$NO_SERVICE" = 0 ] && ! systemctl is-active --quiet afeypos-mongodb; }; then
    tail -n 20 "$DIR/mongodb/log/mongod.log" 2>/dev/null || true
    [ "$NO_SERVICE" = 0 ] && journalctl -u afeypos-mongodb -n 20 --no-pager 2>/dev/null || true
    die "The Afey POS database did not start on port $MONGO_PORT (see the log above)"
  fi
fi

# ---------- configure and build ----------
say "Configuring and building (a few minutes the first time)"
[ "$NO_SERVICE" = 0 ] && chown -R afeypos:afeypos "$rel" "$DATA"
setup=(--mode "$MODE" --port "$PORT" --mongo-uri "$MONGO_URI" --data-dir "$DATA" --app-dir "$DIR/app")
[ -n "${MONGO_USER:-}" ] && setup+=(--mongo-user "$MONGO_USER" --mongo-password "${MONGO_PASSWORD:-}")
[ -n "$PUBLIC_URL" ] && setup+=(--public-url "$PUBLIC_URL")
[ -n "$SHOP_HOST" ] && setup+=(--shop-host "$SHOP_HOST")
[ -n "$HQ_URL" ] && setup+=(--hq-url "$HQ_URL")
[ -n "$SYNC_TOKEN" ] && setup+=(--sync-token "$SYNC_TOKEN")
[ -n "$BRANCH_CODE" ] && setup+=(--branch-code "$BRANCH_CODE")
[ -n "$ENC_KEY" ] && setup+=(--encryption-key "$ENC_KEY")
mkdir -p "$DIR/.npm"; [ "$NO_SERVICE" = 0 ] && chown afeypos:afeypos "$DIR/.npm" "$DIR"
(cd "$rel" && "${RUN_AS[@]}" env PATH="$PATH" HOME="$DIR" npm_config_cache="$DIR/.npm" "$NODE" scripts/setup.mjs "${setup[@]}") || die "Setup failed (the previous version, if any, is still running)"

# Switch to the new version; keep the last three.
ln -sfn "$rel" "$DIR/app"
ls -1dt "$RELEASES"/* 2>/dev/null | tail -n +4 | xargs -r rm -rf

# ---------- app service ----------
if [ "$NO_SERVICE" = 0 ]; then
  say "Starting the Afey POS service"
  cat > /etc/systemd/system/afeypos.service <<EOF
[Unit]
Description=Afey POS
After=network-online.target$([ "$LOCAL_DB" = 1 ] && echo " afeypos-mongodb.service")
Wants=network-online.target
$([ "$LOCAL_DB" = 1 ] && echo "Requires=afeypos-mongodb.service")

[Service]
User=afeypos
WorkingDirectory=$DIR/app/server
ExecStart=$NODE --env-file-if-exists=.env dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable afeypos >/dev/null && systemctl restart afeypos
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    if [ -n "$DOMAIN" ]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; else ufw allow "$PORT/tcp" >/dev/null; fi
    note "Firewall (ufw) opened"
  fi
else
  say "Starting Afey POS in the background (no service)"
  pkill -f "$DIR/app/server/dist/server.js" 2>/dev/null || true
  (cd "$DIR/app/server" && nohup "$NODE" --env-file-if-exists=.env "$DIR/app/server/dist/server.js" > "$DATA/afeypos.log" 2>&1 &)
fi

# ---------- HTTPS ----------
if [ -n "$DOMAIN" ] && [ "$NO_SERVICE" = 0 ]; then
  say "Setting up HTTPS for $DOMAIN (Caddy)"
  if ! command -v caddy >/dev/null; then
    if command -v apt-get >/dev/null; then
      apt-get install -y -qq caddy >/dev/null 2>&1 || {
        # Not in this release's own packages (e.g. Ubuntu 22.04): use Caddy's official repository.
        apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
        curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -qq && apt-get install -y -qq caddy >/dev/null
      } || note "Install Caddy yourself: https://caddyserver.com/docs/install"
    else (command -v dnf >/dev/null && dnf install -y -q caddy >/dev/null) || note "Install Caddy yourself: https://caddyserver.com/docs/install"; fi
  fi
  if command -v caddy >/dev/null; then
    hosts="$DOMAIN"; [ -n "$SHOP_HOST" ] && hosts="$DOMAIN, $SHOP_HOST"
    # Live updates (websockets) pass through reverse_proxy as they are; uploads up to 20 MB.
    printf '%s {\n\tencode gzip\n\trequest_body {\n\t\tmax_size 20MB\n\t}\n\treverse_proxy 127.0.0.1:%s\n}\n' "$hosts" "$PORT" > /etc/caddy/Caddyfile
    systemctl enable --now caddy >/dev/null 2>&1 || true
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    note "Caddy gets the certificate automatically once DNS for $DOMAIN points here"
  fi
fi

# ---------- remember options, helper command ----------
cat > /etc/afeypos/install.conf <<EOF 2>/dev/null || true
MODE=$(printf %q "$MODE") PORT=$(printf %q "$PORT") PUBLIC_URL=$(printf %q "$PUBLIC_URL") DOMAIN=$(printf %q "$DOMAIN") SHOP_HOST=$(printf %q "$SHOP_HOST")
HQ_URL=$(printf %q "$HQ_URL") BRANCH_CODE=$(printf %q "$BRANCH_CODE") DIR=$(printf %q "$DIR") REF=$(printf %q "$REF") REPO=$(printf %q "$REPO")
$([ "$LOCAL_DB" = 0 ] && echo "MONGO_URI=$(printf %q "$MONGO_URI")")
$([ "$LOCAL_DB" = 1 ] && echo "MONGO_PORT=$(printf %q "$MONGO_PORT")")
EOF
[ -f /etc/afeypos/install.conf ] && chmod 600 /etc/afeypos/install.conf
cp "$rel/installer/afeypos-cli.sh" /usr/local/bin/afeypos 2>/dev/null && chmod 755 /usr/local/bin/afeypos || true

say "Waiting for Afey POS to answer"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then ok=1; break; fi
  sleep 2
done
url=$(grep -m1 '^PUBLIC_APP_URL=' "$DIR/app/server/.env" | cut -d= -f2-)
echo
if [ "$ok" = 1 ]; then
  printf '\033[32mAfey POS is running.\033[0m\n'
  note "Open $url (or http://localhost:$PORT here) and create the owner account."
else
  printf '\033[33mAfey POS did not answer yet.\033[0m Check: afeypos status   and   afeypos logs\n'
fi
note "Configuration: $DIR/app/server/.env  (back it up: it holds the encryption key)"
note "Data: $DATA   Database: $DIR/mongodb   Manage: afeypos status|logs|restart|upgrade|backup"
[ "$ok" = 1 ] || exit 1
