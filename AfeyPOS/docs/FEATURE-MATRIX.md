# Feature matrix

Legend: **Tested** = implemented with automated tests · **Implemented** = working code, exercised manually or indirectly, no dedicated test · **Partial** = some of the requirement · **Not verified** = code exists but needs credentials/hardware/OS not available here · **Not implemented**.

## Edition and deployment

| Feature | Status | Notes |
|---|---|---|
| Monorepo: React+Vite+TS web, Node+Express+TS API, MongoDB/Mongoose, Zod, REST /api/v1, Socket.IO | Tested | |
| Single-business installation (no SaaS tenants, sign-up, subdomains, plans or platform portal) | Tested | One-time setup page; refused once set up |
| Business types: minimart and supermarket, driving modules, nav, fields, checkout, dashboards | Tested | Installs set up with a retired type run as a supermarket |
| Owners enable/disable modules later without data loss | Tested | Pharmacy, liquor (age checks), serials etc. remain as optional modules |
| Deployment roles: standalone, hq (online head office), branch (local DB) | Tested | |
| Branch servers with their own database syncing to HQ (bootstrap, up/down/both directions, cursors, newest-wins, tombstones, health dashboard) | Tested | Two real branch processes in `sync.test.ts`; not tested over a real WAN |
| Separate stock per branch, owned by its server; HQ ↔ branch and branch ↔ branch transfers with in-transit | Tested | |
| Customer/supplier balances recomputed at HQ from ledgers; branch-prefixed document numbers | Tested | Concurrent offline credit at two branches can exceed a limit until sync |
| Selling during internet outages (standalone / branch) | Implemented | No internet dependency except integrations |
| Windows installer, upgrade, backup, restore, uninstall, status scripts | Not verified | Not executed on Windows |
| Fail-closed data scoping (requests, jobs, files, sockets, callbacks) | Tested | |
| HQ DNS/HTTPS | Not verified | Documented (DEPLOYMENT-HQ.md) |

## Inventory

| Feature | Status |
|---|---|
| Products, services, non-stock items, categories, brands | Tested (brands: implemented) |
| Variants | Partial: parent/variant fields in model; no variant generator UI |
| SKUs, multiple barcodes per product/unit, PLU | Tested |
| Product images / attachments (tenant-scoped uploads) | Tested |
| Units and conversion factors, fractional quantities | Tested |
| Cost, retail/wholesale/contractor price lists, customer-specific prices, quantity tiers, minimum order qty | Tested |
| Opening stock, multiple branches/warehouses | Tested |
| Purchase orders, goods received, supplier invoices on GRN, supplier payments, supplier returns | Tested |
| Customer returns with restock / damaged | Tested |
| Transfers with in-transit | Tested |
| Adjustments with approval | Tested |
| Stocktaking and reconciliation | Tested |
| Damage, wastage, expiry | Tested (adjustment reasons, losses report) |
| Batches, expiry, FEFO | Tested |
| Serial numbers / IMEI, warranty | Tested |
| Low-stock and reorder alerts (realtime + email) | Implemented |
| Weighted average costing, valuation | Tested |
| Negative stock control | Tested (blocked by default) |
| Movement history linked to user/reason/document | Tested |
| Reserved stock (sales orders), stock in transit | Implemented / Tested |
| CSV import/export | Tested (Excel: export CSV opens in Excel; .xlsx not implemented) |
| Barcode/label printing | Implemented (browser Code 128, ZPL/TSPL) |

## Checkout

| Feature | Status |
|---|---|
| Barcode scanning (keyboard wedge, queued scans), search, category shortcuts | Tested (e2e) |
| Quantity and unit selection, multiple/suspended carts | Implemented |
| Customer selection, price list selection | Implemented (pricing tested) |
| Discounts with permission and limits, manager override | Tested |
| Quotations → sale, sales orders, delivery notes, invoices (A4) | Tested |
| Cash, M-Pesa, payment gateways, card, bank, credit, loyalty; split and partial (credit) payments | Tested |
| Receipt printing/reprinting (browser, ESC/POS, network printer) | Implemented / Tested (TCP) |
| Email/SMS receipts | Tested |
| Returns, exchanges (return + new sale), refunds, voids | Tested |
| Returns page: scan receipt, partial/full returns, reasons, return window and approval amount, supervisor approval, M-Pesa B2C refunds, credit note slip | Tested (server and browser) |
| Supermarket reports: daily Z summary, baskets and peak hours, returns, discounts, ABC product performance, dead stock, reorder suggestions, sales by weekday/department/brand | Tested |
| Till opening/closing, shifts, cash in/out, expected vs actual | Tested |
| Sales history and search (receipt, M-Pesa ref, serial) | Implemented |
| Payment failure/timeout handling, duplicate-submission protection, safe stock deduction | Tested |
| Concurrent sales without overselling | Tested |
| Promotions and coupons, loyalty points | Implemented (promotion pricing path tested indirectly; loyalty implemented) |
| Pharmacy prescription references, controlled-substance flag | Implemented (no controlled-drugs register report) |
| Liquor age verification and licensed hours | Tested |
| Repairs (electronics) | Implemented |
| Sales reps and commissions | Partial: computed per sale and reported; no payout workflow |

## Payments and notifications

| Feature | Status |
|---|---|
| Daraja STK Push, callbacks, status query, C2B confirmation/validation, C2B URL registration | Tested with simulator; Not verified against Safaricom |
| Paybill and Buy Goods (Till): STK for both; offline payments matched by account number (Paybill) or unique amount (Buy Goods) | Tested with simulator |
| Enter the M-Pesa code from the customer's SMS: applied if received, refused if used, verified via Transaction Status API otherwise | Tested with simulator; Not verified against Safaricom |
| M-Pesa B2C payouts (salaries/refunds) with two-person approval, send-once claim, result callbacks | Tested with simulator; Not verified against Safaricom |
| M-Pesa on branch servers (callbacks via HQ relayed during sync) | Implemented; relay path not covered by an automated test |
| Payment states, idempotent callbacks, duplicate receipts, amount verification, expiry, reconciliation | Tested |
| Per-branch M-Pesa configurations, sandbox/production | Implemented |
| Payment gateways: Paystack, Flutterwave, pawaPay, Airtel Money, Kopo Kopo, Hubtel, iPay, ZenoPay, Africa's Talking (phone prompt and payment link / QR) | Tested with stubbed provider APIs and the simulator; Not verified against the providers ([PAYMENTS.md](PAYMENTS.md)) |
| Gateway webhooks: signature / shared-secret / callback-token checks, re-verification via provider API, amount + currency checks, late confirmations | Tested |
| JulyPay, Chipper | Not implemented (listed as "coming soon": no public merchant API to build against) |
| SMS: Talk Sasa, Africa's Talking | Not verified (no accounts) |
| Email: SMTP | Not verified against a real server (nodemailer) |
| Templates, logs, retries, rate limits, dedupe, quotas, test connection | Tested |
| Scheduled reports, credit reminders, low-stock alerts, PO emails, statements | Tested / Implemented |

## Hardware and biometrics

| Feature | Status |
|---|---|
| Device configuration screens, tests, status | Implemented |
| ESC/POS receipts, cash drawer kick | Tested (bytes / TCP), Not verified on hardware |
| Device bridge (auth, printing, drawer, display, scale, fingerprint protocol) | Tested (4 tests); serial devices Not verified |
| Variable-weight scale barcodes | Tested |
| ZKTeco / SecuGen readers | Not implemented (adapter interface + simulator only) |
| Biometric enrolment, verification, overrides, attendance, audit, encryption | Tested with simulator |
| Fingerprint sign-in by touch (1:N identification), fingerprint approval and clocking, browser ↔ bridge ↔ server | Tested end to end with the simulated reader |
| ZKTeco reader helper (ZKFinger SDK) | Source only; not compiled or tested with hardware |
| Staff ID cards (Code 128), card + PIN sign-in, card approval, card clock in/out, reissue/revoke, lockout | Tested (server and browser) |

## HR and payroll

| Feature | Status |
|---|---|
| Employees (KRA PIN, NSSF, SHIF, pay type, allowances, deductions, M-Pesa/bank/cash) | Tested |
| Kenyan statutory: NSSF tiers, SHIF, Housing Levy, PAYE after deductions, personal relief, NITA | Tested against worked examples; confirm with KRA before filing (see HR.md) |
| Payroll runs: attendance-based daily/hourly pay, unpaid leave, overtime, one-off items, advance recovery with the one-third rule, separate approver | Tested |
| Payslips (A5), statutory schedule CSV (P10 figures), bank file | Tested |
| Salary payment by M-Pesa B2C (payouts approved and sent by a second person, payslips marked paid on Safaricom's result) | Tested with the simulator |
| Leave (accrual, balance, approval), salary advances (approval, payment, recovery), attendance from card/fingerprint clocking | Tested |

## Reports, security, reliability

| Feature | Status |
|---|---|
| Dashboard and all reports listed in REPORTS.md, CSV export, timezone-aware | Tested (profit, valuation, tax, dashboard, exceptions); others implemented |
| Roles and permissions, branch restrictions | Tested |
| scrypt, refresh rotation, session revocation, lockout, rate limiting, 2FA, password reset, email verification | Tested (email verification: implemented) |
| Platform-user 2FA | Partial: enforced at login if enabled; no self-service setup |
| Audit trails (tenant and platform) | Tested |
| Backups (full/tenant), checksums, restore, scheduled backups, retention | Tested |
| Health checks, startup validation | Tested |
| Idempotent operations, recovery from interrupted workflows | Tested |
| KRA eTIMS (OSCU/VSCU): item registration, sale signing, credit notes, voids, offline queue, receipt QR | Tested with simulator; not verified against KRA (see ETIMS.md) |
| Offline-capable browser (PWA/service worker) | Not implemented: tills need the local server |
| Dark mode, responsive/touch layouts, loading/empty/error states, confirmations | Implemented |
