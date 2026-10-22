# Backups, restore and recovery

## What a backup contains

An Afey POS backup is a gzip file of MongoDB Extended JSON (lossless types), one document per line, plus a `.sha256` checksum file. Sessions, one-time tokens and idempotency records are excluded (users sign in again after a restore).

- **Full backup** (local installations, platform): every collection.
- **Tenant backup** (cloud export): the tenant record and every document with its `tenantId`.

Also back up `server/.env`: the `ENCRYPTION_KEY` in it is needed to read stored secrets.

## Making backups

| How | Command |
|---|---|
| Automatic (local) | every `BACKUP_INTERVAL_HOURS` (default 24) by the server, keeping `BACKUP_RETENTION` (14) files, plus the Windows daily task at 22:30 |
| Owner in the app | Settings → Backups & support → *Back up now* (local: full; cloud: tenant export) and *Download* |
| Command line | `npm run backup -w @afeypos/server` or `-- --tenant <tenantId>` / `-- --dir <path>` |
| Windows | `installer\windows\backup.ps1 -CopyTo E:\` |
| Cloud DR | MongoDB Atlas continuous backup / snapshots (recommended in addition) |

Keep copies **off the server** (USB drive rotated weekly, or cloud storage).

## Restoring

```bash
# Full restore (stop the server first). Refuses to overwrite a non-empty database unless --drop-existing.
npm run restore -w @afeypos/server -- /path/afeypos-full-....ndjson.gz --drop-existing
# Tenant restore. Refuses if the tenant exists unless --replace-tenant.
npm run restore -w @afeypos/server -- /path/afeypos-tenant-<id>-....ndjson.gz
```

The checksum is verified before anything is written; a modified or truncated file is rejected. On Windows use `installer\windows\restore.ps1 -BackupFile <file>` (takes a safety backup first).

## Tested procedures

Automated tests (`server/tests/backup-sync.test.ts`) create sales and stock, back up a tenant, delete its data, restore and compare product, sale and stock counts exactly; they also verify tampered files are refused. The CLI scripts were run end to end (seed → backup → refused restore → restore with `--drop-existing`).

## Recovery from interrupted work

- Checkout, returns, receiving, transfers and payments are transactional: a crash mid-sale leaves no partial stock or ledger change.
- The POS keeps the same request id for a payment attempt; retrying after a network failure replays the completed sale instead of creating a second one.
- Pending M-Pesa requests are re-checked by background jobs (and a 15-minute sweep) after restarts.
- Jobs locked by a crashed worker are picked up again after their 60 s lock expires.

## Disaster checklist (local)

1. Server PC dead: install Afey POS on another PC (INSTALL-WINDOWS.md), copy the old `server\.env` back, restore the latest backup.
2. Lost `.env`: restore still works, but re-enter M-Pesa/SMS/SMTP credentials and users must set up 2FA again.
