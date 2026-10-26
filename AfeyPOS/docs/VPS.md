# VPS setup: pos.afey.co.ke online, the shop working locally

The setup this guide builds:

```
                    internet
 ┌──────────────────────────────────────────┐
 │ VPS  https://pos.afey.co.ke               │  head office (HQ): API + database online,
 │ Afey POS (mode hq) + MongoDB + Caddy      │  M-Pesa callbacks, reports from anywhere
 └───────────────▲──────────────────────────┘
                 │ sync every ~20 s (HTTPS), catches up after an outage
 ┌───────────────┴──────────────────────────┐
 │ Shop PC  http://localhost:9999            │  branch server: own MongoDB, the web app
 │ Afey POS (mode branch) + MongoDB          │  and API run here, so the tills keep selling
 └───────────────▲──────────────────────────┘  with no internet
                 │ shop LAN
          tills: http://<shop PC IP>:9999
```

- **Online first, local when the internet is down.** The tills always use the shop PC. While the internet works,
  each sale reaches `pos.afey.co.ke` within about 20 seconds. When it drops, the tills carry on and the header shows
  *Offline · saved here, syncs when back*. When it returns, everything waiting is pushed and the header shows
  *Online · synced …*. Nobody switches anything.
- The tills do not switch between the online and the local database. If they did, the same stock and sales would
  change in two places and the counts would drift apart. With one local server per shop syncing to head office,
  each record has one owner and nothing is lost or counted twice (see [SYNC.md](SYNC.md)).
- **Just the web app on your PC, no local database** (the PC needs internet): see section C.

---

## A. The VPS (pos.afey.co.ke)

Ubuntu 22.04 or 24.04, at least 2 GB RAM and 20 GB disk, with a public IP.

### 1. Point the domain at the VPS

In the DNS settings for **afey.co.ke**, add:

| Type | Name | Value |
|---|---|---|
| A | `pos` | the VPS public IPv4 address |

Check from any computer (this can take a few minutes):

```bash
nslookup pos.afey.co.ke        # must show the VPS IP
```

### 2. Log in and prepare the server

```bash
ssh root@<VPS-IP>

apt-get update && apt-get -y upgrade
apt-get install -y git curl ufw
timedatectl set-timezone Africa/Nairobi

# Firewall: SSH first, so you keep access, then the web ports.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

### 3. Clone Afey POS

```bash
git clone -b claude/determined-maxwell-1zzhxx https://github.com/Muzamilafey/afeypos.git /opt/afeypos-src
```

### 4. Install everything (one command)

```bash
sudo bash /opt/afeypos-src/AfeyPOS/installer/install.sh \
  --source /opt/afeypos-src/AfeyPOS \
  --mode hq \
  --domain pos.afey.co.ke \
  --port 9999
```

Afey POS runs **its own MongoDB** (no login, listening on 127.0.0.1 only). If the VPS already has another
MongoDB (for example on 27017 with a password), the installer leaves it alone and gives Afey POS's database the
first free port from 27018 (the installer prints it: `Database port: …`).

Afey POS listens on port **9999** on the VPS. Caddy forwards `https://pos.afey.co.ke` (ports 80/443) to it, so 9999
stays closed to the internet and nobody types it in the address.

This installs:
- **Node.js 22** and **MongoDB 8**, as a replica set on this machine only;
- Afey POS, built for production, with the services `afeypos` and `afeypos-mongodb` (start at boot, restart if they
  stop) and the `afeypos` command;
- **Caddy**, which gets and renews the HTTPS certificate for `pos.afey.co.ke` by itself;
- `/opt/afeypos/app/server/.env` with new secrets, `API_PUBLIC_URL=https://pos.afey.co.ke` and secure cookies;
- daily backups.

### 4b. (Optional) use a MongoDB you already have, with a username and password

Only if you want Afey POS to use an existing MongoDB rather than its own. It must be a **replica set**: a
single-node one is fine, but a standalone server is not.

Put the login in `/opt/afeypos/app/server/.env`. Replace `USERNAME` and `PASSWORD` with the real ones; special
characters need no escaping here:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/afeypos?replicaSet=rs0
MONGODB_USERNAME=USERNAME
MONGODB_PASSWORD=PASSWORD
MONGODB_AUTH_SOURCE=admin
```

Or give them to the installer:

```bash
sudo bash /opt/afeypos-src/AfeyPOS/installer/install.sh --source /opt/afeypos-src/AfeyPOS --mode hq --domain pos.afey.co.ke --port 9999 \
  --mongo-uri 'mongodb://127.0.0.1:27017/afeypos?replicaSet=rs0' --mongo-user 'USERNAME' --mongo-password 'PASSWORD'
```

The user needs `readWrite` on `afeypos` and `clusterMonitor` (to check the replica set). For example, in `mongosh` as an admin:

```js
use admin
db.createUser({ user: "afeypos", pwd: "PASSWORD", roles: [{ role: "readWrite", db: "afeypos" }, { role: "clusterMonitor", db: "admin" }] })
```

If that MongoDB is not a replica set yet, add this to its `mongod.conf`, restart it and run `rs.initiate()` once in `mongosh`.
With a login enabled, a replica set also needs a key file (`openssl rand -base64 756 > /etc/mongo-keyfile`,
`chmod 400`, owned by the mongodb user):

```yaml
replication:
  replSetName: rs0
security:
  authorization: enabled
  keyFile: /etc/mongo-keyfile
```

### 5. Check it

```bash
afeypos status                              # both services active, Health: ok
curl -s https://pos.afey.co.ke/health       # {"status":"ok","mode":"hq",...}
afeypos logs                                # follow the logs (Ctrl+C to stop)
```

If HTTPS is not ready yet, DNS is usually still pointing elsewhere. Wait, then run `sudo systemctl reload caddy`.

### 6. Keep two things safe

```bash
sudo grep ENCRYPTION_KEY /opt/afeypos/app/server/.env
```

Copy the value somewhere safe (a password manager):
- every branch server needs this exact key (step B3);
- without it, saved M-Pesa, SMS and email credentials cannot be read after a reinstall.

Also keep a copy of the whole file:

```bash
sudo cp /opt/afeypos/app/server/.env /root/afeypos-env-backup
```

### 7. Set up the business

1. Open **https://pos.afey.co.ke** in a browser and create the business and the owner account (choose minimart or
   supermarket).
2. **Administration → Branches & tills**: create the shop as a branch, e.g. name *Afey Main*, code **AFY01**, with its
   store and tills.
3. Add products, staff and prices here at head office. They reach the shop automatically.
4. **Finance/Administration → Integrations**: set up M-Pesa here (callbacks must reach the public server). Then press
   **Register C2B URLs**. The URLs use `https://pos.afey.co.ke`, so Safaricom accepts them.
5. **Administration → Branch sync → Give it its own server** for AFY01. Copy the **sync token** shown. It is shown
   only once.

---

## B. The shop PC (branch server, works offline)

Windows 10/11 64-bit. **PowerShell → Run as administrator**.

### 1. Allow scripts for this session

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
```

### 2. (Optional) clone the code too

Do this if you also want to develop on this PC; the installer in step 3 downloads its own copy anyway.

```powershell
cd C:\Users\$env:USERNAME
git clone -b claude/determined-maxwell-1zzhxx https://github.com/Muzamilafey/afeypos.git
```

### 3. Install the branch server

Use the values from A6 and A7: the encryption key, branch code and sync token.

```powershell
$env:AFEY_ENCRYPTION_KEY = '<ENCRYPTION_KEY from the VPS>'
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1))) `
  -Mode branch -Port 9999 -HqUrl https://pos.afey.co.ke -BranchCode AFY01 -SyncToken '<sync token from Branch sync>'
```

This installs Node.js and MongoDB if missing, puts Afey POS in `C:\AfeyPOS\app` (local database in `C:\AfeyPOS\mongodb`),
starts it with Windows, schedules backups and opens port 9999 in the firewall for the shop network. Within a minute the shop
downloads the business, staff, products, prices and its stock from head office.

The branch must start on an **empty** database. If the PC already ran Afey POS as a standalone shop, uninstall that
first or use another PC.

### 4. Use it

- On the shop PC: **http://localhost:9999**. On the other tills: **http://\<shop PC IP\>:9999**. The installer prints
  the IP.
- Sign in with the same accounts as on head office.
- The header shows **Online · synced 5s ago** or **Offline · saved here, syncs when back**.
- **Administration → Branch sync** shows what is waiting, the last error and **Sync now**.
- Set the receipt printer once per till: **Hardware → This computer**.

### What goes where

| Done at | What |
|---|---|
| Shop (branch server) | Selling, returns, shifts and cash counts, receiving stock, stocktakes, adjustments, customers |
| Head office (pos.afey.co.ke) | Products, prices, promotions, staff, roles, settings, integrations, reports for all shops |

Head office cannot change the shop's stock directly: the shop server owns it, so stock never conflicts.

---

## C. Only the web app on your PC, API online (no local database)

For a back-office PC or a shop with reliable internet. It does **not** work offline.

```powershell
git clone -b claude/determined-maxwell-1zzhxx https://github.com/Muzamilafey/afeypos.git
cd afeypos\AfeyPOS
npm install
npm run web:remote -- --api https://pos.afey.co.ke
```

- Open **http://localhost:9999**. Other PCs on the LAN can use **http://\<this PC IP\>:9999**.
- The address is remembered: next time just run `npm run web:remote`.
- The web app is built and served on this PC. Its API calls and live updates go to `https://pos.afey.co.ke` through
  this local app, so sign-in works without any cross-site cookie setup.
- Options:
  - `--dev` gives hot reload while developing;
  - `--port 8080` uses another port (9999 is the default; use another one if this PC also runs a branch server);
  - `--no-build` starts faster by reusing the last build.

---

## Updating

**VPS** (the options from the first install are remembered):

```bash
cd /opt/afeypos-src && git pull
sudo bash /opt/afeypos-src/AfeyPOS/installer/install.sh --source /opt/afeypos-src/AfeyPOS
```

`sudo afeypos rollback` goes back to the previous version if needed.

**Shop PC**: run the step B3 command again. Data, `server\.env` and the sync position are kept.

Update the VPS first, then the shops (head office understands older shops for a while, not the reverse).

## Day to day on the VPS

```bash
afeypos status          # health
afeypos logs            # logs
afeypos backup          # backup now (daily backups run automatically, in /opt/afeypos/data/backups)
sudo afeypos restart
afeypos reset-password owner@afey.co.ke 'NewPassw0rd!'
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Install stops with *command replSetGetStatus requires authentication* | Another MongoDB with a password is on that port. Re-run the install command: it now gives Afey POS its own database on a free port. Or use your MongoDB with a login (A4b) |
| *The MongoDB … is not a replica set* | Use Afey POS's own database (leave out `--mongo-uri`), or turn that MongoDB into a replica set (A4b) |
| *rejected the username or password* | Check `MONGODB_USERNAME`, `MONGODB_PASSWORD` and `MONGODB_AUTH_SOURCE` (where the user was created, usually `admin`) |
| *Job for caddy.service failed* | Usually another web server (nginx, Apache) already holds ports 80/443: `sudo ss -ltnp '( sport = :80 or sport = :443 )'`. Re-run the install command: it now adds Afey POS to that nginx or Apache (with a certbot certificate) instead of starting Caddy, and keeps your other sites. Caddy's own error: `journalctl -u caddy -n 50` |
| `pos.afey.co.ke` opens another site on the VPS (e.g. the main website) | Run `sudo afeypos doctor pos.afey.co.ke`: it says whether DNS, the web server's site for `pos`, or the HTTPS certificate is missing, with the command to fix it. Usually: re-run the install command, then `sudo certbot --nginx -d pos.afey.co.ke` |
| Editing `.env` has no effect | The live file is `/opt/afeypos/app/server/.env` (not the one in `/opt/afeypos-src`). After editing: `sudo afeypos restart` |
| `https://pos.afey.co.ke` does not open | `nslookup pos.afey.co.ke` must show the VPS IP; `ufw status` must allow 80 and 443; `journalctl -u caddy -n 50` |
| The shop stays *Offline* | On the shop PC open `https://pos.afey.co.ke/health` in a browser. **Branch sync** shows the last error. Wrong token → issue a new one at head office and rerun B3 with it |
| Branch sync shows "ENCRYPTION_KEY differs from head office" | The shop was installed with another key: rerun B3 with `$env:AFEY_ENCRYPTION_KEY` set to the VPS key, on an empty database |
| M-Pesa payments not arriving | Register C2B URLs at head office (A7 step 4); the VPS must be reachable over HTTPS |
| An older install still uses port 4000 | Rerun the install with `--port 9999` (VPS) or `-Port 9999` (shop PC); the port is saved in `server/.env` |
| Signed out on every reload (section C) | Use the address printed by `npm run web:remote`; do not mix `localhost` and the IP in one browser |
