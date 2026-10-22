# Cloud deployment (multi-tenant SaaS)

## Topology

```
 *.afeypos.com  ──► reverse proxy (Caddy / Nginx, TLS) ──► Afey POS server(s) :4000 ──► MongoDB Atlas (replica set)
 admin.afeypos.com (platform portal, same app)                                  └► shared UPLOAD_DIR / BACKUP_DIR
```

No Docker or Kubernetes is required. A single VM (2 vCPU / 4 GB) runs the server with a process manager; scale by adding instances behind the proxy.

## Steps

1. **Database**: create a MongoDB Atlas cluster (M10+ for production; replica set with automated backups). Create a database user and allow the server IPs. Use the `mongodb+srv://...` URI.
2. **Server**: Ubuntu 24.04 (or similar) with Node.js 22 LTS.
   ```bash
   git clone <repo> /opt/afeypos && cd /opt/afeypos/AfeyPOS
   npm ci && npm run build
   cp server/.env.example server/.env   # edit, see below
   ```
3. **Environment** (`server/.env`), placeholders only:
   ```ini
   NODE_ENV=production
   DEPLOYMENT_MODE=cloud
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/afeypos?retryWrites=true&w=majority
   JWT_ACCESS_SECRET=<48+ random bytes>
   ENCRYPTION_KEY=<32 random bytes, base64>
   BASE_DOMAIN=afeypos.com
   PLATFORM_SUBDOMAIN=admin
   PUBLIC_APP_URL=https://afeypos.com
   API_PUBLIC_URL=https://api.afeypos.com     # any HTTPS host that reaches this server; used for M-Pesa callbacks
   CORS_ORIGINS=https://afeypos.com
   TRUST_PROXY=loopback
   COOKIE_SECURE=true
   ALLOW_TENANT_HEADER=false
   PLATFORM_OWNER_EMAIL=<you@example.com>
   PLATFORM_OWNER_PASSWORD=<strong temporary password>   # remove after first start
   SMTP_HOST=<smtp host>  SMTP_USER=<user>  SMTP_PASSWORD=<password>  SMTP_FROM=Afey POS <no-reply@afeypos.com>
   WEB_DIST_DIR=/opt/afeypos/AfeyPOS/web/dist
   UPLOAD_DIR=/var/lib/afeypos/uploads
   BACKUP_DIR=/var/lib/afeypos/backups
   ```
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
   `systemctl enable --now afeypos`. Several instances can run against the same database: jobs and scheduled tasks are claimed atomically and de-duplicated. Socket.IO then needs sticky sessions at the proxy (or the Socket.IO Redis adapter, not included).
5. **DNS**: create records for the apex, a **wildcard** and the API host:
   ```
   afeypos.com        A     <server ip>
   *.afeypos.com      A     <server ip>
   api.afeypos.com    A     <server ip>
   ```
6. **HTTPS**: wildcard certificates require the DNS-01 challenge. With Caddy (and a DNS provider plugin, e.g. Cloudflare):
   ```
   afeypos.com, *.afeypos.com, api.afeypos.com {
     tls { dns cloudflare {env.CF_API_TOKEN} }
     reverse_proxy 127.0.0.1:4000
   }
   ```
   Nginx alternative: `certbot certonly --dns-<provider> -d afeypos.com -d '*.afeypos.com'`, then `proxy_pass http://127.0.0.1:4000;` with `proxy_set_header Host $host; X-Forwarded-For; X-Forwarded-Proto` and WebSocket upgrade headers for `/socket.io/`.
7. **Custom domains**: the tenant points `shop.example.co.ke` (CNAME) to the server; the platform owner adds the domain on the tenant's page in the portal; the proxy must obtain a certificate for it (Caddy *on-demand TLS* with an `ask` endpoint restricted to registered domains is the simplest).
8. Open `https://admin.afeypos.com/platform`, sign in as the platform owner, then remove `PLATFORM_OWNER_PASSWORD` from `.env` and restart.

## Tenant lifecycle

- Self-service registration at `https://afeypos.com/register` creates the tenant, owner, branch, warehouse and till and starts the plan's trial.
- An hourly job moves expired trials to `past_due` and suspends tenants 7 days past due. The platform owner records payment by setting *Paid until* on the tenant (online subscription billing is not integrated).
- Suspended tenants cannot sign in or use the API; data is kept; reactivation is immediate.

## Backups in the cloud

Rely on Atlas continuous backups / snapshots for disaster recovery; tenant exports (`POST /backups` by the owner, or `npm run backup -- --tenant <id>`) let you restore or move a single tenant. See BACKUP.md.
