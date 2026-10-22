# Optional hybrid synchronisation (local → cloud)

Status: **partially implemented**. Sales sync from a local installation to a cloud tenant is implemented and tested at the ingest level; full bidirectional sync is not.

## Design

- The local server stays the authority for its own sales and stock; it never waits for the internet.
- In the same transaction as each sale, an **outbox** entry is written (`SyncOutbox`) with the sale payload, its stable ObjectId and an idempotency key (`sale:<clientRequestId>`).
- A job pushes pending entries every minute to `SYNC_CLOUD_URL/api/v1/sync/ingest` with `Authorization: Sync <token>` (issued by the cloud tenant owner at `POST /settings/sync/token`). Network failures leave entries pending; they retry later.
- The cloud records each key once (`SyncInbox` unique index): a repeated push returns `duplicate` and changes nothing; the sale keeps the same id; stock in the cloud is changed by applying the movement **delta** (`type: sync`), never by overwriting quantities.
- Anything that cannot be applied safely (e.g. products unknown to the cloud) is recorded as a `conflict` for review, not guessed. Status: `GET /settings/sync/status`.

## Setup

1. Seed the cloud tenant from the local data so ids match (restore a tenant backup of the local installation into the cloud).
2. Cloud: owner issues a sync token.
3. Local `.env`: `SYNC_ENABLED=true`, `SYNC_CLOUD_URL=https://<tenant>.afeypos.com`, `SYNC_TOKEN=<token>`.

## Not yet implemented

Customer payments, purchases, adjustments and master-data changes (products, prices) are not synchronised; there is no cloud → local direction; conflict resolution is manual.
