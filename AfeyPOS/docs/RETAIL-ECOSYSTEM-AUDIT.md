# Afey POS: retail ecosystem audit and implementation plan

This is the Phase 1 inspection for the "advanced intelligent retail management ecosystem" brief.

It maps every requirement to what Afey POS already has, then lists what this round adds. Payment
reconciliation (M-Pesa, cards, Pesapal, gateways) is **out of scope** and is not modified.

## Architecture (unchanged)

| Layer | What it is |
|---|---|
| Monorepo | `packages/shared` (types, money, barcode, pricing, rules), `server`, `web`, `bridge` (device connector on till PCs), `shop` (online shop), `installer` |
| Server | Node 20, Express 5, MongoDB/Mongoose. Every tenant-owned model goes through `tenantModel()` (tenant plugin plus optional branch-scope plugin), so every query is tenant-scoped. Zod validation, durable job queue (`jobs/queue.ts`), audit log (`lib/audit.ts`) |
| Auth | Sessions; roles plus custom roles; permission checks (`requirePermission`); supervisor approval tokens (`/auth/override`, single use); staff card / PIN / fingerprint sign-in |
| Deployment | `standalone`, `hq` (online head office) and `branch` (local server with its own database, syncing to HQ through `modules/sync`). Stock is owned by one server per warehouse |
| Web | React 18, Vite, Tailwind, React Query, PWA |

## Requirement map

Key: **E** exists, **E+** exists and extended this round, **N** new this round, **L** known limitation.

### Phase 2: Inventory

| Requirement | Status | Where |
|---|---|---|
| Real-time stock, branch levels, movements, valuation | E | `inventory/stock.ts` (weighted average cost per warehouse), `/inventory/levels`, `/inventory/movements`, `/reports/inventory-valuation` |
| Low / out of stock alerts, reorder level | E | `/inventory/alerts`, Stock alerts page, sidebar badge |
| Minimum / maximum, overstock | E | `reorderLevel`, `maxStock` (product wizard), `/reports/stock-analysis?tab=overstock` |
| Adjustment approvals, transfers | E | `/inventory/adjustments/:id/approve`, transfers with in-transit stock |
| Forecasting, depletion dates, reorder quantities | E+ | `/reports/stock-analysis` (days/months), `/reports/reorder`. Now states its data period, method and limits |
| Expiry, batches, FEFO, expiry report | E | `StockBatch` with FEFO allocation in `applyMovement`, `/reports/expiry` |
| Dead stock | E+ | `/reports/dead-stock`. Now with suggested actions |
| Inventory dashboard | E | Products dashboard tiles, Stock analysis, Dashboard widgets |

### Phase 3: Purchasing and suppliers

| Requirement | Status | Where |
|---|---|---|
| Supplier profiles, terms, balances, history | E+ | `Supplier` (now plus lead time), payables ledger, purchase history report |
| Suggested purchase orders, reviewed before sending | N | `POST /purchase-orders/suggest`. Drafts are created only on request; sending stays a separate approval |
| Supplier price comparison | E+ | RFQ comparison `/supplier-quotations/compare/:groupId`; new per product `GET /products/:id/supplier-prices` (price, lead time, reliability) |
| Goods receiving, partial / multiple deliveries, batches | E+ | `/goods-receipts` against PO lines (`partially_received`). Now records damaged and short quantities |
| Supplier performance | N | `GET /reports/supplier-performance`: on-time rate, lead time, fill rate, damaged, price changes, balance |

### Phase 4: Cashier security

| Requirement | Status | Where |
|---|---|---|
| Accounts, PIN, card, fingerprint, roles, tills | E | `modules/auth`, `staff`, `biometrics` |
| Automatic session lock at the till | N | Checkout rule `security.lockAfterMinutes`; the till locks and unlocks with the cashier's PIN, card or password |
| Sensitive actions need approval (configurable) | E | Checkout rules: item removal, discounts, price changes, minimum price, wholesale, shift close, returns approval |
| Audit trail with before/after, approver | E+ | `AuditLog`. Entries are now hash-chained so editing or deleting one is detectable (`GET /audit/verify`) |
| Shifts, declarations, expected cash, variance, review | E | `sales/shifts.ts`, drawer report |

### Phase 5: Checkout

| Requirement | Status | Where |
|---|---|---|
| EAN/UPC, internal codes, several barcodes, PLU, SKU, variable weight/price, configurable parsing | E | `barcodeEngine.ts`, `/products/lookup`, scale label layouts |
| Unknown barcode → register | E | Till offers search; product wizard pre-fills from the scanned code |
| Direct weighing, labels | E | Weigh window (bridge serial / keyboard); scale label decoding |
| Customer-facing display | N | `/customer-display` page on a second screen, updated live by the till |
| Suspend/resume, split payments, returns, reprint, permissions | E | Hold sales, multiple payments, Returns, reprint audit |
| Quantity limits | N | Checkout rule `items.maxQtyPerLine` (0 = no limit), enforced on the server |

### Phase 6: AI Business Assistant

N. `modules/assistant`: provider-independent (Anthropic, OpenAI, Gemini), keys sealed on the server,
read-only analytics tools that respect the user's permissions and branches, usage limits and request log.
It still answers the built-in questions without an AI provider.

### Phase 7: Loyalty and CRM

| Requirement | Status | Where |
|---|---|---|
| Profiles, categories, history, balances, preferences | E | `Customer`, CRM insights |
| Points, redemption, tiers, member pricing, birthday | E | `modules/loyalty`, customer prices, CRM birthday greeting |
| Points expiry | N | Loyalty setting `pointsExpireMonths`; expired points are written off by a daily job, with history |
| Campaigns through existing SMS, consent and opt-out | E | `/crm/campaigns`, `/crm/customers/:id/opt-out` |
| Credit limits, statements, ageing | E | Customer credit, `/reports/receivables` |

### Phase 8: Reports

| Requirement | Status | Where |
|---|---|---|
| Sales by period, branch, till, cashier, category, product, payment | E | Reports menu (30+ reports) |
| Revenue, COGS, gross vs net profit, expenses | E | `/reports/profit` (cost recorded on each sale line at the moving average), expenses, accounting P&L |
| PDF / print | E | ReportActions |
| CSV / Excel | N | ReportActions now adds CSV and Excel (.xlsx) for the report shown |

### Phase 9: Multi-branch

| Requirement | Status | Where |
|---|---|---|
| Central management, branch prices, stock, reorder, promotions | E | HQ mode, `branchPrices`, branch-scoped promotions |
| Transfer request → approval → dispatch → transit → receive → discrepancy | E+ | Transfers now need a manager approval before dispatch (rule `transfers.approvalRequired`); shortages recorded on receipt |
| Branch comparisons | E | `/reports/branches` |

### Phase 10: Hardware

| Requirement | Status | Where |
|---|---|---|
| Device registry, tests | E | Hardware page, scales, card terminals, fingerprint readers, bridge |
| Compatibility database with honest statuses, onboarding, health | N | Settings → Hardware → **Device compatibility** (`/settings/hardware/compatibility`), shared catalogue `packages/shared/src/hardwareCatalog.ts` |
| Local connector | E | `bridge/` (extended earlier: scales, labels) |

### Phase 12: Offline

E. Branch servers keep selling with no internet and sync with idempotent records (client request ids,
newest-wins replication, single owner per warehouse). The PWA keeps the shell. No change this round.

## Order of work this round

1. Purchasing intelligence: lead times, suggested POs, supplier prices, damaged/short receiving, supplier performance.
2. Transfer approval.
3. Cashier security: till auto-lock, quantity limit, tamper-evident audit chain.
4. Customer-facing display.
5. Loyalty points expiry.
6. Report CSV/Excel export, forecast assumptions.
7. Hardware Compatibility Centre.
8. AI Business Assistant.

Each step ships with server tests (and e2e where there is UI) and keeps the existing suites green.
