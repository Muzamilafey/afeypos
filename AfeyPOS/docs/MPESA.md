# M-Pesa (Safaricom Daraja)

Afey POS integrates **M-Pesa Express (STK Push)**, **STK status query**, and **C2B** (customers paying the PayBill/Till directly). Credentials are stored server-side, encrypted (AES-256-GCM), and never sent to the browser.

## Payment states and guarantees

| State | Meaning |
|---|---|
| `pending` | STK request sent; customer has not confirmed. **Cannot pay for a sale.** |
| `succeeded` | Confirmed by Safaricom: STK callback with matching amount and a receipt number, an authenticated STK status query, or a C2B confirmation. |
| `failed` | Rejected, insufficient funds, amount mismatch, or duplicate receipt. |
| `cancelled` | Customer cancelled (ResultCode 1032) or cashier abandoned it. |
| `expired` | No confirmation within the timeout (default 180 s, configurable). |

- A sale can only use a `succeeded` intent, and only for its unused amount; the claim is atomic inside the checkout transaction, so one payment can never pay two sales.
- Callbacks are idempotent: duplicates are logged and ignored; a receipt number can only be recorded once per business.
- Late callbacks after a cashier cancelled are recorded and shown under *M-Pesa → reconciliation* for follow-up (refund or apply).
- If a callback is lost, background jobs query Daraja at ~45 s and at the timeout; the cashier can also press *Check status*.
- Voiding a sale releases its M-Pesa payment so it can be applied to the corrected sale. Refunds to customers (B2C/reversal) are **not** initiated by Afey POS; do them in M-Pesa and record the refund method as M-Pesa.

## Callback security

Daraja callbacks are not signed. Afey POS defends them by:
1. a per-business secret token in the callback URL path (`/api/v1/hooks/pay/<tenantId>/<token>/...`),
2. matching the `CheckoutRequestID` to an intent created by this business,
3. checking the amount equals the requested amount,
4. unique receipt numbers,
5. optional IP allow-list (`MPESA_ALLOWED_IPS`, Safaricom publishes its callback IPs),
6. optional "Double-check every callback with an STK status query" setting.

The path deliberately avoids words like "mpesa" because Safaricom rejects C2B URLs containing them.

## Configure

*Settings → Integrations → Add mpesa*, provider **daraja**:

| Field | Value |
|---|---|
| Environment | `sandbox` for testing, `production` for live money |
| Business short code | PayBill number, or for Buy Goods the **Head Office/Store number** used with the passkey |
| Type | `paybill` (CustomerPayBillOnline) or `till` (CustomerBuyGoodsOnline) |
| Till number | Buy Goods till receiving funds (PartyB) |
| Consumer key / secret | From your Daraja app |
| Passkey | Lipa na M-Pesa Online passkey |

Use **Test** to verify OAuth credentials. Branches can have their own configuration (select branches). For C2B press **Register C2B** to register the confirmation/validation URLs shown on the page.

**Sandbox**: create an app at https://developer.safaricom.co.ke, use the test short code `174379` with the sandbox passkey shown on the Daraja simulator page, and a sandbox test MSISDN. Callback URLs must be public HTTPS (use a tunnel such as `cloudflared` for local testing).

**Simulator**: provider `mock` (non-production only) never contacts Safaricom; payments are confirmed with `POST /api/v1/payments/mpesa/simulate/:id`. Used by automated tests.

## Going live (production approval)

1. Business registered with a PayBill or Till (M-Pesa for Business) and the **Business Administrator** / M-Pesa portal access.
2. On the Daraja portal, *Go Live*: select your short code, verify with the OTP sent to the administrator, and request **Lipa Na M-Pesa Online (STK Push)** and **C2B** products.
3. Safaricom issues production consumer key/secret and the **production passkey** (by email).
4. Public HTTPS callback URLs (no IP addresses, no "mpesa"/"safaricom" in the URL).
5. Set `API_PUBLIC_URL` on the server to that HTTPS host.

## Verification status

The Daraja client follows the published API (OAuth, `stkpush/v1/processrequest`, `stkpushquery/v1/query`, `c2b/v2/registerurl`, callback payloads). Automated tests cover the full lifecycle with the simulator and recorded payload shapes. **It has not been run against the live Daraja sandbox or production from this build environment**, which has no internet access to Safaricom. Test end-to-end in sandbox before going live.
