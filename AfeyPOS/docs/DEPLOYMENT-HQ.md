# Head-office (HQ) server online

Use this when the business has several branches: one **HQ server** online, and either tills that connect to it
directly, or **branch servers** (one per branch, own database, keeps selling offline) that sync with it. A single shop
does not need this: run a standalone installation (INSTALL-WINDOWS.md).

## Topology

```
 https://hq.myshop.co.ke ──► reverse proxy (Caddy / Nginx, TLS) ──► Afey POS server (DEPLOYMENT_MODE=hq) :4000 ──► MongoDB replica set
        ▲                                                         (also receives M-Pesa / gateway callbacks)
        │ HTTPS sync every ~20 s while online
 Branch server MSA01 (DEPLOYMENT_MODE=branch, own MongoDB) ◄── tills on the branch LAN
 Branch server THK01 (DEPLOYMENT_MODE=branch, own MongoDB) ◄── tills on the branch LAN
```

No Docker or Kubernetes is required. A small VM (2 vCPU / 4 GB) is enough for most chains.

## HQ server

1. **Database**: MongoDB 7 as a replica set (MongoDB Atlas M10+ with backups, or a self-managed replica set).
2. **Server**: Ubuntu 24.04 (or similar) with Node.js 22 LTS.
   ```bash
   git clone <repo> /opt/afeypos && cd /opt/afeypos/AfeyPOS
   npm ci && npm run build
   cp server/.env.example server/.env   # edit, see below
   ```
3. **Environment** (`server/.env`), placeholders only:
   ```ini
   NODE_ENV=production
   DEPLOYMENT_MODE=hq
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/afeypos?retryWrites=true&w=majority
   JWT_ACCESS_SECRET=<48+ random bytes>
   ENCRYPTION_KEY=<32 random bytes, base64>      # every branch server must use this same key
   PUBLIC_APP_URL=https://hq.myshop.co.ke
   API_PUBLIC_URL=https://hq.myshop.co.ke        # branches sync here; M-Pesa/gateway callbacks arrive here
   CORS_ORIGINS=https://hq.myshop.co.ke
   TRUST_PROXY=loopback
   COOKIE_SECURE=true
   WEB_DIST_DIR=/opt/afeypos/AfeyPOS/web/dist
   UPLOAD_DIR=/var/lib/afeypos/uploads
   BACKUP_DIR=/var/lib/afeypos/backups
   ```
   `node scripts/generate-secrets.mjs` prints fresh values for the two secrets. Keep a safe copy of `ENCRYPTION_KEY`.
4. **Process manager** (systemd):
   ```ini
   # /etc/systemd/system/afeypos.service
   [Service]
   WorkingDirectory=/opt/afeypos/AfeyPOS/server
   ExecStart=/usr/bin/node --env-file=.env dist/server.js
   Restart=always
   User=afeypos
   [Install]
   WantedBy=multi-user.target
   ```
5. **DNS and HTTPS**: one A record (`hq.myshop.co.ke`) and a certificate. With Caddy:
   ```
   hq.myshop.co.ke {
     reverse_proxy 127.0.0.1:4000
   }
   ```
   Nginx: `proxy_pass http://127.0.0.1:4000;` with `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and WebSocket upgrade headers for `/socket.io/`.
6. Open `https://hq.myshop.co.ke`, complete the one-time setup (business, owner), then add branches, stores and tills
   under **Settings → Branches & tills**, and products, staff and integrations as usual.

## Adding a branch server

See SYNC.md for what syncs and how conflicts are handled. In short:

1. At HQ: **Settings → Branch sync → Give it its own server** for the branch. Copy the lines shown (shown once).
2. On the branch PC (Windows or Linux) install Afey POS as for a standalone shop, but put those lines in `server/.env`
   together with HQ's `ENCRYPTION_KEY`, and start it on an **empty** database:
   ```ini
   DEPLOYMENT_MODE=branch
   BRANCH_CODE=MSA01
   SYNC_ENABLED=true
   SYNC_HQ_URL=https://hq.myshop.co.ke
   SYNC_TOKEN=<token from HQ>
   ENCRYPTION_KEY=<same as HQ>
   ```
3. Within a minute the branch downloads the business, staff, products, prices and its own stock. Staff sign in with
   their usual email and password or PIN. The branch's tills connect to the branch server on the LAN.

## Backups

Back up the HQ database (Atlas snapshots or `npm run backup`) and each branch server (automatic local backups). A lost
branch server can be rebuilt from HQ: issue a new token, start a new branch server on an empty database, and it
downloads everything, including its last synced stock.
