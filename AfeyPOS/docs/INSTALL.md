# Installing Afey POS (one command)

One command installs everything a server needs and leaves it running:

- **Node.js 22** and **MongoDB 8**, downloaded from nodejs.org and mongodb.org with their checksums verified;
- **Afey POS** itself, built for production;
- the **database** as a single-node replica set (needed for transactions), listening on this computer only;
- the **configuration** (`server/.env`) with new random secrets;
- **services** that start at boot and restart if they stop.

Run the same command again to **upgrade**. Data, configuration and secrets are kept, and the previous version stays available for rollback.

## Linux server

Ubuntu 20.04–24.04, Debian 11–12, RHEL/Rocky/Alma 8–9 or Amazon Linux 2023, on x86_64 or arm64:

```bash
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh | sudo bash
```

Add options after `-s --`:

```bash
# Head office online, with HTTPS (Caddy gets a certificate once DNS points here)
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh | sudo bash -s -- \
  --mode hq --domain hq.myshop.co.ke --shop-host shop.myshop.co.ke

# Branch server (values from head office: Administration > Branch sync)
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh | sudo bash -s -- \
  --mode branch --hq-url https://hq.myshop.co.ke --branch-code MSA01 --sync-token <token>
```

| Option | Meaning |
|---|---|
| `--mode standalone\|hq\|branch` | One shop (default), head office online, or a branch server |
| `--port 4000` | Port for tills and browsers |
| `--public-url URL` | Address staff use (default `http://<LAN IP>:<port>`; head office needs one) |
| `--domain NAME` | HTTPS for NAME with Caddy (ports 80/443 open to the internet) |
| `--shop-host NAME` | Also serve the online shop website for NAME |
| `--hq-url`, `--sync-token`, `--branch-code` | Branch servers: where and how to sync |
| `--mongo-uri URI` | Use an existing replica set (e.g. MongoDB Atlas) instead of installing MongoDB |
| `--dir /opt/afeypos` | Install location |
| `--ref HEAD` | Branch, tag or commit to install (HEAD = the repository's default branch) |
| `--source DIR` | Install from a local copy of the `AfeyPOS` folder (no download) |
| `--mongod PATH` | Use this `mongod` instead of downloading MongoDB |
| `--no-service` | No system services (containers, testing): runs both in the background |

For a private copy of the repository, set `GITHUB_TOKEN` first: `curl ... | sudo GITHUB_TOKEN=... bash`.

**What goes where:**
- `/opt/afeypos/app`: the current version (`releases/` keeps the last three);
- `/opt/afeypos/app/server/.env`: the configuration;
- `/opt/afeypos/data`: uploads and backups;
- `/opt/afeypos/mongodb`: the database;
- `/opt/afeypos/runtime`: Node.js and MongoDB;
- services `afeypos` and `afeypos-mongodb`, running as the `afeypos` system user;
- options of the first install are remembered in `/etc/afeypos/install.conf`.

**Managing it** with the `afeypos` command:

```bash
afeypos status                 # services and health
afeypos logs                   # follow the logs
sudo afeypos restart           # or start / stop
sudo afeypos upgrade           # backup, then install the latest version (same options)
sudo afeypos rollback          # back to the previous version
afeypos backup                 # backup now (automatic backups also run every day)
sudo afeypos restore FILE.ndjson.gz
afeypos reset-password owner@myshop.co.ke 'NewPassw0rd!'
sudo afeypos config            # edit server/.env and restart
sudo afeypos uninstall         # keeps data; add --remove-data to delete everything
```

## Windows server

Windows 10/11 or Windows Server, 64-bit. In **PowerShell → Run as administrator**:

```powershell
irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1 | iex
```

With options:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1))) -Mode standalone -Port 4000
```

Options: `-Mode`, `-Port`, `-PublicUrl`, `-HqUrl -SyncToken -BranchCode` (branch servers), `-Root C:\AfeyPOS`, `-Ref`, `-SkipFirewall`.

It installs Node.js and MongoDB silently when they are missing, downloads Afey POS to `C:\AfeyPOS\app`, then runs `installer\windows\install.ps1`. That script:
- creates the `AfeyMongoDB` service;
- writes the configuration;
- builds Afey POS;
- registers the `AfeyPOS` startup task;
- schedules the daily backup;
- opens the firewall for the shop network.

Day-to-day use, backups and recovery are covered in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).

## Already have the code?

From the `AfeyPOS` folder, with Node.js 22.9+ and a MongoDB replica set available:

```bash
npm run setup -- --mode standalone --port 4000   # configure, install, build, initialise the database
npm start
```

`npm run setup` is what both installers run, and it is safe to repeat. Use `--print-env` to see the resulting configuration with secrets masked. For development, use `npm run local` instead (see the README).

## After installing

1. Open the address the installer printed and create the owner account (choose minimart or supermarket).
2. **Back up `server/.env`** somewhere safe. Its `ENCRYPTION_KEY` is needed to read saved M-Pesa, SMS, email and KRA credentials, 2FA secrets and fingerprint templates after a reinstall.
3. On each till, open `http://<server address>:<port>` in the browser.

## Verification status

The Linux installer was tested end to end on Ubuntu 24.04 (x86_64) without system services (`--no-service`):
- fresh install;
- re-run as an upgrade, with secrets, data and settings kept;
- Node.js download and checksum;
- building, replica set initialisation, health check, business registration and sign-in;
- backup.

Not tested here:
- the MongoDB download (its servers were not reachable from the test machine; a local `mongod` was used with `--mongod`);
- the systemd services and the Caddy HTTPS setup;
- the Windows scripts, because no PowerShell was available. They follow the existing Windows installer, which now uses the same `npm run setup`.

Try them on a test machine before your first shop.
