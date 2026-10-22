# Architecture

## Overview

```
 Browser (POS / back office / platform portal)          Till PC
   │  HTTPS + WebSocket (same origin)                      │ http://127.0.0.1:9123
   ▼                                                       ▼
 Afey POS server (Express 5) ──────────────────────  Afey device bridge
   │  REST /api/v1, Socket.IO, job worker, scheduler       (printers, drawer, scale,
   ▼                                                        display, fingerprint SDK)
 MongoDB replica set (transactions)
   │
   └─ outbound: Safaricom Daraja, Talk Sasa / Africa's Talking, SMTP, (optional) cloud sync
```

One codebase serves both deployment models; `DEPLOYMENT_MODE=local|cloud` changes tenant resolution, plan entitlements and a few safety rules (e.g. server-side network printing is only allowed locally).

## Packages

- `packages/shared`: business profiles and module catalogue, navigation, permission catalogue and roles, integer-cents money helpers, tax and proportional allocation, EAN-13 and scale-barcode parsing, subdomain rules, default plans. Used by both server and web so totals computed in the browser match the server exactly.
- `server/src`
  - `config/env.ts`: Zod-validated environment; refuses weak secrets and the dev tenant header in production.
  - `db/`: connection with replica-set check, `withTransaction`, and the **tenant plugin**.
  - `http/`: tenant resolution, authentication, RBAC (`requirePermission`), module gates (`requireModule`), idempotency keys, error mapping.
  - `modules/*`: auth, tenants/provisioning, catalog, inventory, sales (checkout, returns, shifts, documents), parties (customers/suppliers/ledger), purchasing, payments (M-Pesa), notifications, reports, settings, hardware, biometrics, backups, files, sync, platform.
  - `jobs/`: MongoDB-backed durable job queue, scheduler, per-tenant daily tasks.
  - `integrations/`: Daraja client + simulator, SMS providers, SMTP.
  - `realtime/`: Socket.IO with tenant rooms.

## Business profiles and capabilities

Code never branches on the business type. `resolveCapabilities()` (shared) turns a tenant's business type, owner-enabled/disabled modules and plan entitlements into:

- `modules` (e.g. `quotations`, `unitConversions`, `batchExpiry`, `serialNumbers`, `ageVerification`),
- `productFields` shown on the product form,
- `priceLists`, default units, checkout options (touch mode, fractional quantities, unit/price-list selectors),
- dashboard widgets.

The server enforces modules (`requireModule` and path gates in `app.ts`); the web builds navigation from `navigationFor(capabilities, permissions)` returned by `/auth/me`. Disabling a module hides it and blocks its API; data is kept. `pos` and `inventory` cannot be disabled.

## Multi-tenancy and isolation

- Every tenant-owned collection is defined through `tenantModel()`, which installs `tenantPlugin`: an immutable required `tenantId`, injected into every query, update, upsert, aggregate and insert from an `AsyncLocalStorage` request context. A query without tenant context **throws** (`TenantContextError`) instead of returning other tenants' data. Asking for a different tenant's id inside a context also throws. `bulkWrite` is blocked on tenant models.
- Platform code must explicitly enter `runAsPlatform()`; background jobs run inside `runInTenant(job.tenantId)`.
- The tenant is resolved only from the host (`<slug>.<BASE_DOMAIN>` or a registered custom domain), never from client ids. Access tokens carry the tenant id and session id; a token from tenant A is rejected at tenant B, and the session is checked on every request so revocation is immediate.
- `$lookup` stages add an explicit `tenantId` match on the joined collection.
- Uploads live under `UPLOAD_DIR/<tenantId>/`; realtime sockets join only their tenant's rooms; M-Pesa callbacks carry the tenant id plus a per-tenant secret token in the path.
- Compound unique indexes are tenant-prefixed (`tenantId+sku`, `tenantId+number`, `tenantId+barcodes.code`, `tenantId+clientRequestId` ...).

Tests in `server/tests/tenancy.test.ts` cover cross-tenant tokens, IDOR by id, fail-closed queries, scoped aggregates and upserts.

## Money and quantities

All money is integer cents. Quantities are base units rounded to 3 decimals (2.5 m, 0.75 kg). Selling/purchase units carry a conversion factor to the base unit (carton = 24, foot = 0.3048 m). Tax per line uses basis points with inclusive or exclusive pricing; cart discounts are allocated with the largest-remainder method so parts always sum to the total.

## Inventory model and costing

- `StockLevel` per product per warehouse: `qty`, `reserved` (sales orders), `inTransit` (transfers), `avgCostCents`.
- **Costing method: weighted average cost per warehouse**, recalculated atomically (aggregation-pipeline update) on every inbound movement; outbound movements use the current average for COGS.
- `applyMovement()` is the only code that changes stock. Outbound updates are conditional (`qty >= requested`) so concurrent sales cannot oversell, unless the owner explicitly allows negative stock. Every change writes a `StockMovement` with user, time, reason, balance and originating document.
- Batches/expiry: FEFO picking that skips expired batches for sales. Serials/IMEI: each unit tracked through receipt, sale (with warranty end date), return and supplier return.

## Checkout

`POST /sales` runs in one transaction: idempotency check (`clientRequestId` unique + optional `Idempotency-Key`), shift check, pricing (customer price → quantity tier → unit/price list → promotion), discount authorisation (cashier limit, single-use supervisor override tokens), tax, payment validation (exact total; cash change; M-Pesa only from confirmed, unallocated intents claimed atomically; credit within limit or approved; loyalty points), stock deduction, customer ledger, loyalty, commission, cash movement, audit, sync outbox. Returns and voids reverse these consistently.

## Background work

Jobs (`Job` collection) are claimed with an atomic lock, retried with exponential backoff and marked `dead` after `maxAttempts`. Enqueuing inside a transaction commits the job with the business change (outbox pattern). Dedupe keys make the scheduler safe with several server processes. Notifications never block checkout.

## Frontend

Single React app with three areas: sign-in/onboarding, tenant app (`AppShell` with business-specific sidebar) and `/platform` portal. Access token in memory, refresh token in an httpOnly SameSite=Strict cookie with rotation. The POS keeps carts (including suspended sales) in localStorage per till, queues barcode scans so fast scanners never lose items, and keeps one stable `clientRequestId` per payment attempt so a retry after a network error can never double-sell.
