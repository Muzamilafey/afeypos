# Database

## MongoDB requirements

- MongoDB **7.0 or newer**, running as a **replica set**. A single-node replica set is enough for a shop.
- Why: checkout, returns, goods receiving, transfers, payments and ledger postings use multi-document **transactions** (`withTransaction`, with Mongoose's transaction AsyncLocalStorage). Standalone MongoDB cannot provide them.
- On start the server checks the topology. With `MONGODB_REQUIRE_REPLICA_SET=true` (default) it refuses to start on a standalone server. Setting it to `false` lets it start with a loud warning: stock decrements are still conditional atomic updates (no overselling), but a failure half-way through a sale is **not** rolled back. Do not run production that way.

### Single-node replica set

`mongod.cfg`:

```yaml
replication:
  replSetName: rs0
net:
  bindIp: 127.0.0.1
  port: 27017
```

Then once: `mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'`.

Connection string: `mongodb://127.0.0.1:27017/afeypos?replicaSet=rs0`. The Windows installer does all of this. For the cloud use MongoDB Atlas (replica set by default) or a self-managed 3-node replica set.

## Separate databases

- Local installation: its own database (`afeypos`) on the shop server.
- Cloud: one database shared by all tenants, isolated at the application layer by `tenantId` (see ARCHITECTURE.md). Very large tenants can be moved to their own cluster later by restoring a tenant backup into another deployment.
- Tests create a throwaway database per test file on an in-memory replica set.

## Indexes

Indexes are declared on the schemas and built at start (`Model.init()`). Highlights:

| Collection | Index |
|---|---|
| products | `tenantId+sku` unique, `tenantId+barcodes.code` unique (partial), `tenantId+plu` unique (partial), text on name/sku |
| stocklevels | `tenantId+productId+warehouseId` unique |
| stockmovements | `tenantId+productId+at`, `tenantId+ref.type+ref.id` |
| sales | `tenantId+number` unique, `tenantId+clientRequestId` unique, `tenantId+completedAt` |
| shifts | `tenantId+tillId` unique where `status=open` (one open shift per till) |
| paymentintents | `tenantId+checkoutRequestId`, `tenantId+receiptNumber`, `tenantId+clientRequestId` unique (partial) |
| serialitems | `tenantId+productId+serial` unique |
| idempotencyrecords | `tenantId+scope+key` unique, TTL 7 days |
| sessions | TTL after expiry |
| jobs | `dedupeKey` unique (partial), `status+runAt` |

## Migrations strategy

- Schema changes are additive with defaults so old documents stay valid; new indexes build on start.
- Data migrations go in `server/src/scripts/migrations/NNN-name.ts`, are idempotent, run with `withDb()` and record themselves in a `migrations` collection (convention; no migrations have been needed yet).
- Always take a backup before an upgrade (the Windows `upgrade.ps1` does this automatically).

## Health and startup validation

- `/health` and `/api/v1/health` report database connectivity, replica set and transaction support.
- Startup validates the environment (secrets length, 32-byte encryption key, production safety flags) and the database topology before accepting requests.
