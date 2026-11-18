# Setting up Afey POS online (VPS) with shops that keep selling offline

Head office runs on a server on the internet (a VPS), on **your own domain**. Each shop runs its own copy on
a computer in the shop, so it keeps selling when the internet is down and syncs everything up when it is back.

You choose the domain and the port everywhere in this guide. Three values are used throughout — write yours
down and use them in every command:

| In this guide | Means | Your value |
|---|---|---|
| `pos.example.co.ke` | the domain head office answers on | |
| `9999` | the port the Afey POS backend listens on | |
| `MSA01` | a branch's short code | |

> **About the port.** You may use any free port: 9999 (the default), 8080, 3000, 4000… With a domain, that
> port stays **inside the server** (Caddy answers the internet on 443 and passes requests to it), so you never
> type it in the address. Without a domain, people open `http://<server IP>:<port>` and the port must be open
> in the firewall.

---

## Part 1 — Head office on the VPS

### 1.1 Get a server

Any provider (Hetzner, DigitalOcean, Linode, Contabo, AWS Lightsail, a local Kenyan host). Choose:

- **Ubuntu 22.04 or 24.04 LTS** (Debian, Rocky, Alma and Amazon Linux work too)
- **2 CPU, 4 GB memory, 80 GB disk** for a few shops; 4 CPU / 8 GB from about ten shops
- A location close to your shops (Europe or South Africa is usually the lowest latency to Kenya)

Note its **public IP address**, e.g. `203.0.113.10`.

### 1.2 Point your domain at it

At your domain provider (Safaricom Domains, Truehost, KenyaWebExperts, Namecheap, Cloudflare…), add an
**A record**:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `pos` (for `pos.example.co.ke`) | `203.0.113.10` | automatic / 300 |

For the online shop on its own name as well, add a second A record, e.g. `shop` → the same IP.

Wait until it answers, then check from your own computer:

```bash
dig +short pos.example.co.ke
# must print 203.0.113.10
```

> **Cloudflare users:** set the record to **DNS only** (grey cloud) for the first install, so the certificate
> can be issued. You can switch the orange cloud back on afterwards.

### 1.3 Sign in to the server

```bash
ssh root@203.0.113.10
```

(If your provider gave you another user: `ssh ubuntu@203.0.113.10`, and put `sudo` in front of the commands.)

### 1.4 Update it and set the clock

```bash
apt update && apt -y upgrade
timedatectl set-timezone Africa/Nairobi
```

### 1.5 Open the firewall

HTTPS needs 80 and 443. Only open the Afey POS port itself if you are **not** using a domain.

```bash
apt -y install ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
# Only without a domain — replace 9999 with your port:
# ufw allow 9999/tcp
ufw --force enable
ufw status
```

Also open 80 and 443 in your provider's own firewall or security group, if it has one.

### 1.6 Install Afey POS as head office

One command. Replace the domain with yours, and `--port` with the port you chose:

```bash
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh \
  | sudo bash -s -- \
      --mode hq \
      --port 9999 \
      --domain pos.example.co.ke \
      --public-url https://pos.example.co.ke
```

What each option does:

| Option | Meaning |
|---|---|
| `--mode hq` | head office: branches sync to it |
| `--port 9999` | the port the backend listens on (your choice) |
| `--domain pos.example.co.ke` | installs Caddy and gets a free HTTPS certificate for that name |
| `--public-url https://pos.example.co.ke` | the address staff and Safaricom use; it goes into emails and callbacks |

Serving the online shop on a second name as well:

```bash
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh \
  | sudo bash -s -- --mode hq --port 9999 \
      --domain pos.example.co.ke --public-url https://pos.example.co.ke \
      --shop-host shop.example.co.ke
```

The installer puts Node.js 22 and MongoDB 8 in `/opt/afeypos/runtime` (nothing else on the server is touched),
builds the app, creates the database with a replica set, writes `server/.env` with fresh secrets, sets up
HTTPS, and creates two services that start at boot: `afeypos-mongodb` and `afeypos`.

### 1.7 Check it

```bash
systemctl status afeypos --no-pager
curl -s http://127.0.0.1:9999/health          # your port
curl -s https://pos.example.co.ke/health      # from the internet
```

Both should print `{"status":"ok",...}`. Then open **https://pos.example.co.ke** in a browser and create the
owner account.

### 1.8 Already have a domain pointing elsewhere on the same server?

If the server already runs nginx or Apache, the installer notices and writes its own site file instead of
taking the ports. See [VPS.md](VPS.md) for that case, including a shared wildcard certificate.

### 1.8b A second business on the same server

One VPS can run several businesses, each fully separate (its own database, port, settings, domain and backups).
Give each extra one a short name with `--instance`, its own `--port` and its own domain:

```bash
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh \
  | sudo bash -s -- \
      --instance walalaha \
      --mode hq \
      --port 9998 \
      --domain walalaha.example.co.ke \
      --dir /opt/walalaha/AfeyPOS
```

| The first business | A business installed with `--instance walalaha` |
|---|---|
| services `afeypos`, `afeypos-mongodb` | `afeypos-walalaha`, `afeypos-walalaha-mongodb` |
| helper `afeypos status` | `afeypos-walalaha status` |
| settings `/etc/afeypos/install.conf` | `/etc/afeypos/walalaha/install.conf` |
| files `/opt/afeypos` | `/opt/afeypos-walalaha`, or the `--dir` you chose |

The installer refuses a port that is already taken, picks a free database port by itself, and adds its own
site to nginx, Apache or Caddy without touching the other business's site. The first business keeps running
the whole time. To update the second one later: `sudo afeypos-walalaha upgrade`.

### 1.9 Back up the encryption key

```bash
cat /opt/afeypos/app/server/.env | grep ENCRYPTION_KEY
```

Copy that line somewhere safe and private. Branch servers need **the same key**, and without it stored
secrets cannot be read even from a good backup. Never put it in a chat or an email.

---

## Part 2 — Head office settings

Open `https://pos.example.co.ke` and sign in as the owner.

1. **Administration → Settings** — business name, KRA PIN, currency, timezone, logo.
2. **Administration → Branches & tills** — add every branch, with a short code (`MSA01`, `THK01`), and its
   tills.
3. **Administration → Users** — the people, their roles, usernames, staff cards.
4. **Inventory** — units, categories, brands, then the products (or Import products).
5. **Settings → Integrations** — M-Pesa, SMS, email, KRA eTIMS. Each can be set for the whole business, for
   chosen branches, or for single tills.
6. **Administration → Checkout rules** — ways to pay, customer phone and loyalty, how M-Pesa behaves.

### M-Pesa (now that there is a public address)

Settings → Integrations → M-Pesa → **Register C2B URLs**. Safaricom then sends every Till/Paybill payment to
`https://pos.example.co.ke/...`, which is why prompts (STK) and automatic matching work on this setup but not
on a shop-only one.

---

## Part 3 — A shop that keeps selling offline

Each shop runs its own server. It holds its own database, sells without internet, and syncs with head office
every 20 seconds when the internet is there.

### 3.1 Get the branch's token (at head office)

1. **Administration → Branch sync**.
2. Next to the branch, press **Give it its own server**.
3. An owner or administrator confirms (fingerprint, staff card, or username/email with PIN or password).
4. Copy the block that appears. **It is shown once.** It looks like:

   ```
   DEPLOYMENT_MODE=branch
   BRANCH_CODE=MSA01
   SYNC_ENABLED=true
   SYNC_HQ_URL=https://pos.example.co.ke
   SYNC_TOKEN=<long token>
   ```

### 3.2 Install on the shop computer

**Windows** (PowerShell as administrator) — one line, with your values:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1))) `
  -Mode branch `
  -Port 9999 `
  -HqUrl https://pos.example.co.ke `
  -BranchCode MSA01 `
  -SyncToken '<long token>' `
  -EncryptionKey '<head office ENCRYPTION_KEY>'
```

**Ubuntu / Debian:**

```bash
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh \
  | sudo bash -s -- \
      --mode branch \
      --port 9999 \
      --hq-url https://pos.example.co.ke \
      --branch-code MSA01 \
      --sync-token '<long token>' \
      --encryption-key '<head office ENCRYPTION_KEY>'
```

Within a minute the shop computer downloads the business, staff, products and prices from head office. Staff
sign in with their **head-office accounts**.

### 3.3 The shop's tills

Exactly as in the local guide: open `http://<shop computer IP>:9999` on each till and install it as an app.
The tills talk to the **shop's own server**, never over the internet, so they are fast and keep working when
the line is down.

### 3.4 Check the sync

- At head office: **Administration → Branch sync** shows each branch as online, when it last synced, and how
  much is waiting to be sent.
- At the shop: **Administration → Branch sync** shows the last run and anything that needs attention.

What travels where:

| Down to the shop | Up to head office |
|---|---|
| products, prices, promotions, staff, settings, M-Pesa and eTIMS setup | sales, returns, shifts, cash movements, stock, customers, expenses |

An **owner or administrator** can also add products and staff on the shop's own server; those changes sync up
to head office too.

---

## Part 4 — Keeping it running

### Daily

Nothing. Both the VPS service and the Windows task restart themselves if they ever stop, and start again
after a reboot.

### Backups

- The VPS writes a backup every day into `/opt/afeypos/data/backups`, keeping the last 14.
- **Copy them off the server** — your provider's snapshots, or from your own computer:

  ```bash
  rsync -avz root@203.0.113.10:/opt/afeypos/data/backups/ ~/afeypos-backups/
  ```

- Keep `server/.env` (the encryption key) somewhere separate and safe.

### Updating

Run the same install command again, on head office first, then the shops. Data, settings and secrets are
kept, and the previous version stays for rollback.

```bash
# head office (same options as the first time)
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh \
  | sudo bash -s -- --mode hq --port 9999 --domain pos.example.co.ke --public-url https://pos.example.co.ke
```

### Useful commands on the VPS

```bash
systemctl status afeypos            # is it running
journalctl -u afeypos -f            # live log
systemctl restart afeypos           # restart it
systemctl status afeypos-mongodb    # the database
caddy validate --config /etc/caddy/Caddyfile   # check the HTTPS setup
systemctl reload caddy              # apply a Caddyfile change
```

### Changing the port later

Edit `PORT=` in `/opt/afeypos/app/server/.env`, change the port in `/etc/caddy/Caddyfile` (the
`reverse_proxy 127.0.0.1:<port>` line), then:

```bash
systemctl restart afeypos && systemctl reload caddy
```

With no domain, also open the new port and close the old one in `ufw`.

### Changing the domain later

1. Point the new name at the server (A record), and wait for `dig +short newname` to answer.
2. Run the installer again with `--domain newname --public-url https://newname`.
3. Settings → Integrations → M-Pesa → **Register C2B URLs** again, so Safaricom sends payments to the new
   address. Each branch server's `SYNC_HQ_URL` must be changed too (in its `server/.env`), then restarted.

---

## Part 5 — If something goes wrong

| What you see | What to do |
|---|---|
| The domain does not open | `dig +short pos.example.co.ke` must show the server's IP. Check 80 and 443 are open in `ufw` **and** at the provider. |
| "Certificate" errors | `journalctl -u caddy -n 50`. Usually DNS has not propagated yet, or Cloudflare's orange cloud was on during the first install. |
| The site is up but shows nothing | `systemctl status afeypos`, then `journalctl -u afeypos -n 100`. |
| A branch shows offline | On the shop computer: can it open `https://pos.example.co.ke/health`? Check `SYNC_HQ_URL` and `SYNC_TOKEN` in its `server/.env`. |
| "ENCRYPTION_KEY differs from head office" | The shop server was installed with a different key. Copy head office's into its `server/.env` and restart. |
| M-Pesa prompt: "Merchant does not exist" | Safaricom's own answer: the shortcode is not registered for Lipa Na M-Pesa Online. For Buy Goods the "shortcode" is the **store (head office) number** and the till number goes in "Till number"; the passkey must belong to that shortcode. |
| Payments arrive but no prompt | Register the C2B URLs, and confirm Safaricom enabled STK for that shortcode. Meanwhile the till watches the Till and finishes the sale by itself. |
| Disk filling up | `du -sh /opt/afeypos/data/*`. Old backups are kept for 14 days; copy them off and delete the rest. |

More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md), [VPS.md](VPS.md), [SYNC.md](SYNC.md).

---

## Part 6 — A quick checklist

- [ ] Domain points at the VPS (`dig +short` shows the IP)
- [ ] 80 and 443 open in `ufw` and at the provider
- [ ] Head office installed with `--mode hq --domain … --public-url https://…`
- [ ] `https://yourdomain/health` answers `ok`
- [ ] Owner account created, business settings and logo saved
- [ ] Branches, tills, staff, products in place
- [ ] M-Pesa connected and C2B URLs registered
- [ ] `ENCRYPTION_KEY` copied somewhere safe
- [ ] Each shop installed with `--mode branch` and its own token
- [ ] Branch sync shows every shop online
- [ ] Backups copied off the server
