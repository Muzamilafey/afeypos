# Installing Afey POS on Windows (local shop server)

This guide is for shop owners and the technician setting up the shop. One computer is the **server** (it keeps the database); every till is a browser pointing at it.

> **Quickest way:** in PowerShell *Run as administrator* run
> `irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1 | iex`
> It downloads and installs Node.js, MongoDB and Afey POS and does everything below. See [INSTALL.md](INSTALL.md). The rest of this page covers the manual route and day-to-day operation.

## What you need

- A Windows 10/11 (64-bit) or Windows Server PC that stays on while the shop is open. 8 GB RAM and an SSD are recommended.
- A wired or Wi-Fi network connecting the tills to the server (internet is only needed for M-Pesa, SMS, email and cloud sync).
- Administrator access on the server PC.
- Installers (download on any computer with internet):
  1. **Node.js 22 LTS** (64-bit `.msi`) from https://nodejs.org
  2. **MongoDB Community Server 7 or 8** (`.msi`) from https://www.mongodb.com/try/download/community. In the installer choose *Complete* and **untick "Install MongoD as a Service"** (the Afey installer creates its own service). Also install **mongosh** (MongoDB Shell).
  3. The Afey POS release folder (or `git clone`).

## Install

1. Copy the `AfeyPOS` folder to `C:\AfeyPOS\app`.
2. Right-click **Start → Windows PowerShell (Admin)** and run:
   ```powershell
   cd C:\AfeyPOS\app
   powershell -ExecutionPolicy Bypass -File installer\windows\install.ps1
   ```
   Options: `-Port 9999` (default), `-DataDir C:\AfeyPOS\data`, `-MongoDataDir C:\AfeyPOS\mongodb`, `-SkipFirewall`.
3. The script:
   - checks Node.js and MongoDB,
   - creates the **AfeyMongoDB** Windows service as a single-node replica set (database only listens on 127.0.0.1),
   - writes `server\.env` with new random secrets (readable only by Administrators/SYSTEM),
   - installs and builds Afey POS,
   - registers the **AfeyPOS** scheduled task that starts at boot as SYSTEM and restarts automatically if it stops,
   - schedules a daily backup at 22:30,
   - opens the port in Windows Firewall for Private/Domain networks.
4. Open `http://localhost:9999` on the server, choose your business type and create the owner account.
5. On each till open `http://<server-ip>:9999` (the script prints the address). Pin it to the taskbar or create a desktop shortcut. On first use choose which till the computer is (Checkout asks).

> **Back up `server\.env` somewhere safe.** It contains `ENCRYPTION_KEY`; without it, saved M-Pesa/SMS credentials, 2FA secrets and fingerprint templates cannot be decrypted after a reinstall.

## Daily use

- Tills keep working when the internet is down. Cash, card and on-account sales work offline; M-Pesa STK, SMS and email resume when the connection returns (queued messages are retried).
- If the **server PC** is off, tills cannot sell. Keep it on a UPS.

## Security on the shop network

- Use a private network (Windows "Private" profile). The firewall rule is not applied to Public networks.
- MongoDB is bound to 127.0.0.1 and is never exposed to the network.
- Give each cashier their own account and PIN; never share the owner account.
- For HTTPS on the LAN, put a reverse proxy (e.g. Caddy with an internal certificate) in front of port 9999 and set `COOKIE_SECURE=true`.

## Upgrade

```powershell
powershell -ExecutionPolicy Bypass -File installer\windows\upgrade.ps1 -NewReleaseZip C:\Downloads\AfeyPOS-x.y.z.zip
```
It backs up first, keeps `server\.env`, rebuilds and restarts. Indexes are updated automatically.

## Service recovery

```powershell
powershell -File installer\windows\status.ps1         # health, service and task state
Start-Service AfeyMongoDB                             # database
Start-ScheduledTask -TaskName AfeyPOS                 # application
```
Logs: MongoDB in `C:\AfeyPOS\mongodb\log\mongod.log`. The application logs to its console; for persistent logs change the task action to `cmd /c node --env-file=.env dist\server.js >> C:\AfeyPOS\data\afeypos.log 2>&1`.

## Backups and restore

See [BACKUP.md](BACKUP.md). Quick reference:
```powershell
powershell -File installer\windows\backup.ps1 -CopyTo E:\            # backup now and copy to a USB drive
powershell -File installer\windows\restore.ps1 -BackupFile E:\afeypos-full-....ndjson.gz
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File installer\windows\uninstall.ps1             # keeps data
powershell -ExecutionPolicy Bypass -File installer\windows\uninstall.ps1 -RemoveData # deletes everything (asks to confirm)
```

## Verification status

The PowerShell scripts were written for Windows 10/11 and PowerShell 5.1+ but **have not been executed on a Windows machine in this build environment** (Linux CI). The equivalent steps (replica set, build, serving the web app, backup and restore scripts) were tested on Linux. Run through this guide once on a test PC before installing at a customer.
