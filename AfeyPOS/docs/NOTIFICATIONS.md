# SMS and email notifications

Notifications are queued (`NotificationLog` + durable job) and sent by the background worker, so a slow or failing provider never blocks checkout.

## Providers

| Channel | Provider | Settings | Secret |
|---|---|---|---|
| SMS | Talk Sasa | Sender ID, API base URL (optional, default `https://bulksms.talksasa.com/api/v3`) | API token |
| SMS | Africa's Talking | Username, Sender ID/short code | API key (`sandbox` environment uses the AT sandbox) |
| SMS / email | `console` | none | none: development only, records messages instead of sending |
| Email | SMTP | Host, port, username, from address | Password |

Platform-level email (password resets before a tenant has SMTP) uses the `SMTP_*` server variables. Add more providers by implementing `SmsProvider` / `EmailProvider` in `server/src/integrations`.

## Use cases and templates

`receipt`, `payment_confirmation`, `customer_statement`, `credit_reminder`, `low_stock`, `purchase_order`, `password_reset`, `email_verify`, `scheduled_report`, `test`. Templates use `{{variable}}` placeholders; tenants can override any template per channel (API `PUT /settings/notifications/templates`).

Scheduled: daily sales summary email at 21:00 local time (Settings → Sales & tax → *Daily sales summary emails*); overdue-balance SMS reminders at 09:00, at most once a week per customer.

## Reliability controls

- **Retries** with exponential backoff for network/5xx/429 errors (up to 6 attempts); permanent rejections are marked `failed` immediately.
- **Duplicate prevention**: dedupe keys (e.g. one receipt per sale per recipient, one reminder per customer per week).
- **Rate limiting**: per-tenant token bucket (60 messages/minute per process).
- **Usage limits**: in the cloud each SMS consumes the plan's monthly allowance; once exhausted messages are `skipped` with a reason.
- **Delivery logs**: Settings → Integrations shows test results; `GET /settings/notifications/logs` lists every message and status.
- **Test connection**: *Test* verifies SMTP and sends a test SMS/email to the address you enter.

## Verification status

Queueing, templates, retries, dedupe and quotas are covered by automated tests with the console providers. Talk Sasa and Africa's Talking HTTP calls follow their published APIs but **were not exercised against the live services** (requires accounts and internet). Confirm the Talk Sasa endpoint/payload with your account documentation before going live.
