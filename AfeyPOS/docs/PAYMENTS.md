# Payment gateways

Afey POS accepts electronic payments through two kinds of integration:

- **M-Pesa (Safaricom Daraja)**: STK Push and Paybill/Till C2B, configured as integration kind `mpesa`. See [MPESA.md](MPESA.md).
- **Payment gateways**, integration kind `payment`: Paystack, Flutterwave, pawaPay, Airtel Money, Kopo Kopo, Hubtel, iPay, ZenoPay and Africa's Talking, plus an offline **payment simulator** for training and tests.

JulyPay and Chipper are listed as **coming soon**: neither publishes merchant API documentation or sandbox access we could build and test against, so they show a "SOON" badge in Settings → Integrations and cannot be configured yet.

## Supported providers

| Provider | Markets | Till flows | How the webhook is authenticated | How the payment is confirmed |
|---|---|---|---|---|
| Paystack | NG, GH, KE, ZA, CI | Phone prompt (M-Pesa, MTN, AirtelTigo, Telecel), payment link / QR (cards, bank, mobile money) | `x-paystack-signature` = HMAC-SHA512 of the raw body with the secret key | `GET /transaction/verify/:reference` |
| Flutterwave | NG, KE, GH, UG, TZ, RW, ZM, ZA, francophone | Phone prompt (`/charges?type=mpesa`, `mobile_money_*`), payment link / QR | `verif-hash` header equals the secret hash set in the dashboard | `GET /transactions/verify_by_reference?tx_ref=` |
| pawaPay | 15+ markets (M-Pesa, MTN, Airtel, Vodacom, Orange…) | Phone prompt; cashier picks the network (correspondent) | Per-tenant callback token in the URL | `GET /deposits/{depositId}` |
| Airtel Money (Open API) | KE, UG, TZ, RW, ZM, MW, CD, NG… | Phone prompt (USSD push) | Per-tenant callback token in the URL | `GET /standard/v1/payments/{id}` (TS = success) |
| Kopo Kopo | KE | M-Pesa STK push to a K-till | `X-KopoKopo-Signature` = HMAC-SHA256 of the raw body with the API key | `GET` the payment `Location` URL (only on the Kopo Kopo host) |
| Hubtel | GH | Phone prompt (MTN, Telecel, AirtelTigo) | Per-tenant callback token in the URL | Transaction status API (`api-txnstatus.hubtel.com`; Hubtel requires the server IP to be whitelisted) |
| iPay | KE | M-Pesa STK push | Per-tenant callback token in the URL | `POST /transaction/search` (HMAC-SHA256 signed) |
| Pesapal (API 3.0) | KE, UG, TZ, RW, MW, ZM, ZW | Payment page / QR (Visa, Mastercard, Amex, M-Pesa, Airtel Money, bank) | Per-tenant callback token in the URL; the notification (IPN) URL is registered with Pesapal automatically | `GET /api/Transactions/GetTransactionStatus?orderTrackingId=` (status_code 1 = completed) |
| ZenoPay | TZ | Phone prompt (M-Pesa, Mixx by Yas, Airtel, Halopesa) | `x-api-key` header equals the API key | `GET /order-status?order_id=` |
| Africa's Talking | KE, UG, TZ, RW, MW, ZM | Mobile checkout (phone prompt) | Per-tenant callback token in the URL | `GET /query/transaction/find` |
| Payment simulator | — | Phone prompt and payment link | Callback token | Outcome set via `POST /payments/gateways/simulate/:id` (disabled in production) |

## Trust model (same as M-Pesa)

1. Starting a charge creates a **pending** `PaymentIntent` with our own reference (`reference`), the provider's id (`providerRef`) and, for links, the hosted checkout URL.
2. A webhook is only a hint. It must pass the per-tenant callback token in the URL **and** the provider's own authentication (signature or shared secret, where the provider offers one). Rejected webhooks are logged with outcome `bad_signature` and otherwise ignored.
3. The intent becomes **succeeded** only after an authenticated server-to-provider status call confirms it, with the expected **amount and currency**. A mismatch marks it **failed**. Webhook bodies are never trusted for status or amount.
4. If no webhook arrives, background jobs poll the provider (after 30 s and 90 s) and expire the intent after the timeout (`stkPendingTimeoutSeconds`, default 180 s, for phone prompts; `linkTimeoutMinutes`, default 15, for payment links).
5. A sale consumes a succeeded intent through the same atomic claim as M-Pesa (`paidAmountCents - allocatedCents >= amount`), so a payment can never be used twice. A gateway intent cannot be passed off as an M-Pesa payment and vice versa.
6. A confirmation that arrives after the cashier cancelled, or after expiry, is recorded as a **late confirmation** on the Online payments page for manual reconciliation; it is never applied automatically.

Mobile money charges must be whole units (no cents). Card / link payments may include cents.

## Setting up a gateway

1. **Settings → Integrations → Payment methods**: pick a provider chip. The form lists the provider's required fields; secrets are encrypted at rest (AES-256-GCM) and never returned by the API.
2. Choose **Sandbox** while testing and **Production** for live money. Optionally restrict the configuration to branches.
3. Save, then press **Test**: it makes an authenticated call that does not move money (token request, balance or status lookup).
4. Open the integration again to copy its **webhook URL** (`/api/v1/hooks/pay/<tenant>/<token>/gw/<configId>`). Charges started from the till send it automatically where the provider supports per-request callbacks (Paystack and Flutterwave use the dashboard webhook setting: paste the URL there). The URL must be public HTTPS in production.

At the till, **Pay → Mobile money & cards** lists the gateways enabled for that branch. The cashier picks the provider, the network where needed, and either sends a **phone prompt** or creates a **payment link** shown as a **QR code** for the customer to scan. The sale can be completed only once the payment is confirmed.

## API

- `GET /payments/gateways?tillId=` — gateways for the till (no secrets).
- `POST /payments/gateways/:configId/charge` — `{ clientRequestId, amountCents, flow: 'push'|'link', phone?, channel?, email?, customerName?, tillId? }`. Idempotent on `clientRequestId`.
- `GET /payments/intents?provider=gateway|<provider>` · `GET /payments/intents/:id` · `POST /payments/intents/:id/query|cancel` — shared with M-Pesa.
- `GET /payments/online/reconciliation` · `GET /payments/online/events`.
- `POST /payments/gateways/simulate/:id` — simulator only, non-production.
- Sales: `payments: [{ method: 'gateway', amountCents, paymentIntentId }]`. The receipt shows the provider name and its receipt / transaction id.

## Card machines (bank POS / PDQ)

Bank card machines are not connected to Afey POS. The **Card** tile on the till records a payment taken on a machine:
1. the cashier keys the amount into the machine;
2. the customer taps or inserts the card;
3. the cashier enters the **approval code** from the slip, plus the card type and, optionally, the last four digits.

The sale stores the machine, card and approval code, for reconciliation with the bank statement. List your machines (name, bank, terminal ID) under **Settings → Checkout rules**. For cards without a machine, configure **Pesapal** under Integrations: the till shows a QR code for its payment page.

## Verification status

All adapters are covered by automated tests against **stubbed HTTP** (request shapes, signatures, status mapping, amount checks) and the full till flow is tested end to end with the simulator. **None has been exercised against the real provider sandbox or production APIs** from this environment (no accounts and no outbound access), so request/response details should be confirmed in each provider's sandbox before going live. Points to check in particular: pawaPay's API host (configurable via *API base URL*), iPay's v2 search response, Hubtel IP whitelisting, and whether Paystack mobile money needs an OTP step for some Ghana networks (that step is not supported at the till; such charges stay pending and expire).
