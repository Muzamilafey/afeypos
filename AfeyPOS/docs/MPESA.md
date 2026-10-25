# M-Pesa (Safaricom Daraja)

Afey POS integrates **M-Pesa Express (STK Push)**, **STK status query**, **C2B** (customers paying the Paybill/Till directly), **Transaction Status** (checking a code a customer shows) and **B2C** (salary and refund payouts). It works with both **Paybill** and **Buy Goods (Till)** accounts. Credentials are stored server-side, encrypted (AES-256-GCM), and never sent to the browser.

## Three ways to take M-Pesa at the till

1. **Send prompt (STK Push)**: the customer gets a PIN prompt on their phone. Paybill uses `CustomerPayBillOnline`; Buy Goods uses `CustomerBuyGoodsOnline` with the store (head-office) number and the till as `PartyB`.
2. **Customer pays Paybill/Till** (offline payment): the till shows what to pay.
   - *Paybill*: the Paybill number and a short **account number** for this sale (till code + 4 digits, e.g. `T14821`). When the C2B confirmation arrives with that account number, the sale completes by itself.
   - *Buy Goods*: the till number and amount. The payment is matched by amount when exactly **one** till is waiting for that amount in the last 30 minutes; otherwise it stays in the "received, not yet used" list for the cashier to pick.
   - Waiting payments that never arrive expire after 10 minutes (or `stkPendingTimeoutSeconds` if longer).
3. **Enter M-Pesa code**: the cashier types the code from the customer's SMS (e.g. `SJK3AB12CD`).
   - Already received by C2B and unused: applied immediately. Already used: refused, naming the sale it paid.
   - Not received yet (C2B URLs not registered, or a lost callback): if an **initiator** is configured, Afey POS asks Safaricom with the Transaction Status API; the payment is confirmed only when Safaricom says it *Completed*, with the amount Safaricom reports.

Payments received to the Paybill/Till that no sale claimed are listed at the till and on *Payments → M-Pesa* for reconciliation.

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
- Voiding a sale releases its M-Pesa payment so it can be applied to the corrected sale.

## Payouts (B2C), optional

Salaries (and refunds) can be paid to phones with M-Pesa B2C (`/mpesa/b2c/v3/paymentrequest`, `SalaryPayment` / `BusinessPayment`):

- Payouts are created as **drafts** (by payroll or `POST /payments/payouts`), **approved by a different person** with the `payouts.approve` permission, then **sent**. Each payout is claimed atomically, so it is never sent twice.
- A payout is **succeeded** only when Safaricom's result callback confirms it (receipt and receiver name recorded); failures and timeouts are recorded.
- Needs a B2C short code (bulk disbursement account), an initiator name and its security credential.

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
| Account type | **Paybill** (customers enter an account number) or **Buy Goods / Till** |
| Paybill number / store number | Paybill number, or for Buy Goods the **store (head office) number** used with the passkey |
| Till number | Buy Goods only: the till receiving funds (`PartyB`) |
| Consumer key / secret | From your Daraja app |
| Passkey | Lipa na M-Pesa Online passkey |
| Initiator name + security credential | Optional: API operator created on the M-Pesa org portal; the credential is the initiator password encrypted with Safaricom's certificate (Daraja portal generates it). Needed for code checks and payouts. |
| B2C short code | Optional: bulk disbursement short code for payouts |

Use **Test** to verify OAuth credentials. Branches can have their own configuration (select branches). For C2B press **Register C2B** to register the confirmation/validation URLs shown on the page.

**Sandbox**: create an app at https://developer.safaricom.co.ke, use the test short code `174379` with the sandbox passkey shown on the Daraja simulator page, and a sandbox test MSISDN. Callback URLs must be public HTTPS (use a tunnel such as `cloudflared` for local testing).

**Simulator**: provider `mock` (non-production only) never contacts Safaricom. Prompts are confirmed with `POST /payments/mpesa/simulate/:id`, Paybill/Till payments with `POST /payments/mpesa/simulate-c2b`, code checks with `POST /payments/mpesa/simulate-status/:id`, payouts with `POST /payments/payouts/:id/simulate`. Used by automated tests and for training.

## Branch servers

Safaricom can only call public addresses, so a branch server's callback URLs point at **head office** (`SYNC_HQ_URL`). HQ keeps results it does not recognise, and the branch collects and applies them during sync; the branch also confirms its prompts with the STK status query whenever it is online. Paybill/Till payments land at HQ and sync to the branch that owns the M-Pesa configuration. See SYNC.md.

## Going live (production approval)

1. Business registered with a PayBill or Till (M-Pesa for Business) and the **Business Administrator** / M-Pesa portal access.
2. On the Daraja portal, *Go Live*: select your short code, verify with the OTP sent to the administrator, and request **Lipa Na M-Pesa Online (STK Push)** and **C2B**, plus **Transaction Status** and **B2C** if you use code checks or payouts.
3. Safaricom issues production consumer key/secret and the **production passkey** (by email).
4. Public HTTPS callback URLs (no IP addresses, no "mpesa"/"safaricom" in the URL).
5. Set `API_PUBLIC_URL` on the server to that HTTPS host.

## Verification status

The Daraja client follows the published API (OAuth, `stkpush/v1/processrequest`, `stkpushquery/v1/query`, `c2b/v2/registerurl`, `transactionstatus/v1/query`, `b2c/v3/paymentrequest`, callback and result payloads). Points to confirm in sandbox: the Transaction Status `IdentifierType`/`PartyA` used for Buy Goods (Afey uses the till number with type 2) and the B2C v3 endpoint for your account. Automated tests cover the full lifecycle with the simulator and recorded payload shapes. **It has not been run against the live Daraja sandbox or production from this build environment**, which has no internet access to Safaricom. Test end-to-end in sandbox before going live.
