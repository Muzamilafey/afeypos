# API overview

Base path `/api/v1`. JSON in/out, money in integer cents, quantities in the chosen unit. Errors: `{ "error": { "code", "message", "details", "requestId" } }`. Tenant endpoints are resolved by host (`<slug>.<BASE_DOMAIN>`, custom domain, or the single tenant in local mode) and need `Authorization: Bearer <accessToken>` except where noted. Mutating checkout/payment endpoints accept `Idempotency-Key`.

| Area | Endpoints |
|---|---|
| Health | `GET /health` |
| Public | `GET /public/config`, `GET /public/business-types`, `GET /public/plans`, `GET /public/subdomain-check?slug=`, `POST /public/register` |
| Auth (no token) | `POST /auth/login`, `/auth/mfa`, `/auth/pin-login`, `/auth/biometric-login`, `/auth/refresh`, `/auth/logout`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/email/verify` |
| Auth | `POST /auth/override`, `GET /auth/me`, `GET/DELETE /auth/sessions[/:id]`, `POST /auth/logout-all`, `/auth/password/change`, `/auth/pin`, `/auth/2fa/setup|enable|disable`, `/auth/email/resend` |
| Catalog | `GET/POST /categories`, `PATCH /categories/:id`, `GET/POST /brands`, `GET/POST /products`, `GET /products/lookup?code=`, `GET/PUT/DELETE /products/:id`, `POST /products/:id/quote`, `GET/PUT/DELETE /customer-prices`, `GET/POST/PATCH /promotions`, `GET /products-export.csv`, `POST /products-import`, `POST /files`, `GET /files/:id` |
| Inventory | `GET /inventory/levels`, `/inventory/movements`, `/inventory/batches`, `/inventory/serials/:serial`; `GET/POST /inventory/adjustments`, `POST .../:id/approve|reject`; `GET/POST /inventory/transfers`, `POST .../:id/dispatch|receive`; `GET/POST /inventory/stocktakes`, `GET .../:id`, `PATCH .../:id/counts`, `POST .../:id/post` |
| Sales | `POST/GET /sales`, `GET /sales/:id`, `POST /sales/:id/returns`, `/void`, `/send-receipt`, `/print`; `GET /sales/:id/receipt?format=html|text|escpos`, `/invoice` |
| Shifts | `GET/POST /shifts`, `GET /shifts/current?tillId=`, `GET /shifts/:id/summary`, `POST /shifts/:id/cash`, `/close` |
| Documents | `GET/POST /documents`, `GET /documents/:id`, `/print`, `POST /documents/:id/status`, `/reserve`, `POST /delivery-notes`, `/delivery-notes/:id/delivered` |
| Parties | `GET/POST /customers`, `GET/PATCH /customers/:id`, `GET /customers/:id/statement`, `POST .../statement/send`, `/payments`, `/adjustments`; `GET /receivables/ageing`; `GET/POST /suppliers`, `GET/PATCH /suppliers/:id`, `POST /suppliers/:id/payments`; `GET /payables/ageing` |
| Purchasing | `GET/POST /purchase-orders`, `GET /purchase-orders/:id`, `POST .../send|cancel`, `GET/POST /goods-receipts`, `GET /goods-receipts/:id`, `GET/POST /supplier-returns` |
| Payment gateways | `GET /payments/gateways`, `POST /payments/gateways/:id/charge`, `GET /payments/online/reconciliation|events`, `POST /payments/gateways/simulate/:id` (non-production); webhooks `/hooks/pay/:tenantId/:token/gw/:configId` (see [PAYMENTS.md](PAYMENTS.md)) |
| M-Pesa | `POST /payments/mpesa/stk`, `GET /payments/intents[/:id]`, `POST /payments/intents/:id/query|cancel`, `GET /payments/mpesa/reconciliation`, `/events`, `POST /payments/mpesa/simulate/:id` (non-production) |
| Callbacks (no token) | `POST /hooks/pay/:tenantId/:token/stk`, `/c2b/validation`, `/c2b/confirmation` |
| Reports | `GET /reports/dashboard|sales|profit|inventory-valuation|stock-movements|losses|low-stock|expiry|exceptions|shifts|mpesa|receivables|payables|purchases|expenses|tax|branches|activity` (`from`, `to`, `branchId`, `groupBy`, `format=csv`) |
| Settings | `GET/PATCH /settings/business`, `PUT /settings/modules`, `GET/POST/PATCH /settings/users`, `GET /settings/locations`, `POST /settings/branches|warehouses|tills`, `PATCH /settings/branches/:id|tills/:id`, integrations CRUD + `/test` + `/register-c2b`, notification templates and logs, support access approvals, `GET /audit`, expenses, repairs, sync token/status |
| Hardware / biometrics | `/hardware/devices` CRUD + `/test`, `POST /hardware/labels`; `/biometrics/devices`, `/biometrics/enroll`, `/biometrics/templates/:userId`, `/biometrics/challenge` and `/biometrics/verify` (bridge HMAC), `GET /attendance` |
| Backups | `GET/POST /backups`, `GET /backups/:id/download` |
| Sync (cloud) | `POST /sync/ingest` (`Authorization: Sync <token>`) |
| Platform | `/platform/auth/login|refresh|logout`, `GET /platform/me`, `GET/POST /platform/tenants`, `GET/PATCH /platform/tenants/:id`, `GET/POST /platform/plans`, `PATCH /platform/plans/:code`, `/platform/support/grants` (+ `/emergency-approve`, `/session`), `GET /platform/health|jobs|notifications|audit|backups`, `POST /platform/jobs/:id/retry`, `POST /platform/backups`, `GET/POST /platform/users` |

Realtime (Socket.IO, path `/socket.io`, `auth: { token }`): `sale.created`, `sale.returned`, `sale.voided`, `shift.closed`, `payment.updated`, `inventory.low_stock`.
