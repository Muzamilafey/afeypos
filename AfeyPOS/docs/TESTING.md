# Testing and actual results

## How tests run

- **Server integration tests** (`server/tests`, Vitest + Supertest) start a real **MongoDB 7 single-node replica set** with `mongodb-memory-server`, so transactions, unique indexes and write conflicts behave as in production. Each test file uses its own database.
  - In restricted networks, point it at an installed binary: `MONGOMS_SYSTEM_BINARY=/path/to/mongod`. (In this build environment MongoDB's download site was blocked, so MongoDB 7.0.34 from conda-forge was used.)
- **Shared, web and bridge unit tests**: Vitest.
- **End-to-end tests** (`web/e2e`, Playwright + Chromium): `scripts/e2e-server.mjs` starts an in-memory replica set and the **built** server in local mode serving the **built** web app; tests drive the real UI.

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e
```

## Results (2026-10-22, this build)

| Check | Result |
|---|---|
| `npm run typecheck` (shared, server, web, bridge) | pass |
| `npm run lint` (ESLint, whole monorepo) | pass, 0 problems |
| Shared unit tests | 16 passed |
| Server integration + unit tests | 101 passed in 16 files |
| Web unit tests | 4 passed |
| Bridge tests | 4 passed |
| `npm run build` (all packages) | pass |
| Playwright e2e (Chromium) | 4 passed (cash sale, bad login, M-Pesa simulator, payment-gateway simulator incl. QR link) |
| CLI scripts (seed demo, backup, refused restore, restore with `--drop-existing`) | run manually against a replica set: pass |

Server test files and coverage areas:

| File | Tests | Covers |
|---|---|---|
| auth | 8 | registration validation, reserved/duplicate subdomains, provisioning, generic login errors, lockout, refresh rotation and reuse, logout revocation, TOTP 2FA, password reset tokens, RBAC, owner protection |
| tenancy | 12 | subdomain and custom-domain resolution, header ignored, cross-tenant token rejection, IDOR on read/update/delete/sell, fail-closed queries, scoped aggregates and upserts, suspended tenants, module gating, enabling modules keeps data, plan entitlements, hardware profile |
| inventory | 10 | units and conversions, barcodes per unit, duplicate barcodes, CSV import/export dry run, weighted average cost, supplier balance/payment/return, PO partial receipt, adjustment approval by another user, transfers via in-transit, stocktake variances, FEFO batches skipping expired, serial/IMEI and warranty |
| checkout | 13 | shift required, VAT-inclusive totals and change, payment mismatch, split payments, idempotent duplicate submissions, **12 concurrent checkouts on 5 units (exactly 5 succeed)**, discount limits and single-use supervisor override, price lists/tiers/customer prices, price override protection, credit limits and payment allocation/statement/ageing, partial returns and restock, voids, quotation conversion once, delivery notes, shift reconciliation |
| mpesa | 9 | Daraja password/timestamp/callback parsing, validation, pending cannot pay, confirmed pays once, duplicate callbacks, receipt reuse, amount mismatch, cancellation code, wrong secret / other tenant ignored, expiry via job, confirmation via status query + late receipt, C2B once and allocation |
| bookshop | 2 | bookshop offered at setup with book fields/modules/price lists; ISBN-10 → ISBN-13 stored and auto-barcoded; lookup by ISBN-13, hyphenated and ISBN-10; search by author and class; second-hand copy with the same ISBN (no barcode clash, found by ISBN); invalid ISBN rejected; sale |
| gateways | 14 | Paystack/Flutterwave/pawaPay/Airtel/Kopo Kopo/Hubtel/iPay/ZenoPay/Africa's Talking request shapes, signatures (HMAC-SHA512/SHA256, shared secrets) and status mapping against stubbed HTTP; Kopo Kopo host pinning; config validation without secret leakage; simulator flow pending → confirmed → sale once; gateway vs M-Pesa intent separation; amount mismatch; idempotent charge; payment links; late confirmations; forged and wrong-token webhooks ignored; webhook confirmed only after the verify API agrees |
| notifications | 3 | phone normalisation, templates, no-provider skip, dedupe, delivery via provider, retry after transient failure |
| backup-sync | 4 | tenant backup → data loss → exact restore, tampered backup refused, sync ingest once as a stock delta, conflicts recorded, sync token required |
| platform | 5 | tenant list without secrets, platform/tenant token separation, suspend/reactivate, plans, full support-access flow (request, owner approval, read-only, tenant-bound, audited, revocable), health |
| reports | 2 | timezone conversion, revenue/tax/COGS/profit/returns/expenses/cash received/credit/valuation/shift expected cash |
| local-mode | 1 | one-time setup, LAN access by IP, no plan limits |
| hardware-biometrics | 3 | cloud SSRF block, ZPL generation, LAN printing over TCP, fingerprint enrolment/challenge/verify with HMAC, nonce single use, audit without template data |
| extras | 4 | tenant-scoped uploads and type checks, licensed sale hours, age verification, A4 invoice, daily report email, weekly credit reminders |
| unit | 7 | RFC 6238 vectors, scrypt, AES-GCM with AAD and tamper detection, env validation, CSV/formula injection, ESC/POS, receipt text |
| smoke | 2 | health with transactions, register + /me |

## Requires credentials, approval or hardware (not verified here)

- Safaricom Daraja sandbox/production (STK Push, query, C2B registration): needs a Daraja app, short code, passkey, public HTTPS callbacks and Safaricom go-live approval.
- Talk Sasa and Africa's Talking SMS, real SMTP servers: need accounts.
- Payment gateways (Paystack, Flutterwave, pawaPay, Airtel Money, Kopo Kopo, Hubtel, iPay, ZenoPay, Africa's Talking): tested only against stubbed HTTP and the simulator; need merchant/sandbox accounts and public HTTPS webhooks. See [PAYMENTS.md](PAYMENTS.md).
- Physical receipt/label printers, cash drawers, customer displays, scales, RFID readers.
- ZKTeco and SecuGen fingerprint readers (SDKs not integrated).
- Windows PowerShell installer scripts (written for Windows, not executed in this Linux environment).
- Cloud DNS/wildcard TLS and multi-instance deployment.
