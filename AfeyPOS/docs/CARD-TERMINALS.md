# Bank card terminals

Afey POS can send a card payment to a connected bank card terminal: the cashier chooses **Card → Charge on the
terminal**, Afey POS sends the amount and a unique reference, the customer taps or inserts the card and enters
the PIN **on the terminal**, and Afey POS records the payment only when the terminal's own transaction status
confirms the approval.

Afey POS never reads cards or PINs and never stores card numbers, CVV, PIN or track data. It keeps only what a
receipt and reconciliation need: card scheme, last four digits, approval code and the terminal's reference.

## What is implemented, and what is not

| Provider | Status | Terminal models | Connections | Tested |
|---|---|---|---|---|
| **Afey terminal simulator** | Implemented, **test only** | Afey Simulated Terminal | Cloud (runs inside Afey POS) | Automated tests (server and browser) |
| **Equity Bank Kenya** | **Provider access required** | Not published | Not published | No: no specification, credentials or test terminal |
| KCB Bank Kenya | Provider access required | Not published | Not published | No |
| Co-operative Bank of Kenya | Provider access required | Not published | Not published | No |
| NCBA Bank Kenya | Provider access required | Not published | Not published | No |
| Absa Bank Kenya | Provider access required | Not published | Not published | No |
| nexo Retailer (ISO 20022 CASP) terminals | Not yet supported | Depends on the acquirer | Depends on the acquirer | No |

- **No real bank terminal is supported yet.** None of the Kenyan banks above publishes an ECR or semi-integrated
  POS specification that an adapter could be built from. Nothing has been guessed: no endpoint, protocol or field
  of any bank is implemented.
- The **simulator** behaves like a paired network terminal: discovery, a pairing code on its screen, an
  authenticated pairing key, status queries, cancel, refunds, signed notifications, and faults you can trigger
  (switched off, disconnected, busy, expired pairing). Its payments are always marked
  **SIMULATED – NOT A REAL PAYMENT** on the sale and receipt.
- Card machines that are **not** connected to Afey POS keep working as before: the cashier enters the approval
  code from the slip (Card → "Card machine not connected to Afey POS"). Those payments are recorded as entered,
  not verified by a terminal.

A provider can be offered for real payments only after its adapter is built from the provider's official
documentation **and** certified with real hardware and verified transactions.

## How it works

```
Till (browser) ── start payment ──► Afey POS server ── adapter (provider's SDK/protocol) ──► terminal
     ▲                                     │
     └──── live status (socket + polling) ◄┘◄── status query (authoritative) ◄────────────────┘
```

- **Adapter interface** (`server/src/modules/terminals/adapter.ts`): discover, register, pair, status, start a
  sale, query, cancel, refund, verify notifications. Each adapter declares which of these its provider supports;
  Afey POS never offers an operation the adapter lacks.
- **Registry** (`server/src/modules/terminals/registry.ts`): the implemented adapters. Adding a bank means adding
  an adapter here and setting its catalogue entry (`packages/shared/src/terminals.ts`) to `available`.
- **Payments** (`server/src/modules/terminals/service.ts`):
  - one open payment per terminal (a database lock); a second charge cannot start while one is open or unknown;
  - starting is idempotent (`clientRequestId`): a retried request returns the same payment;
  - "approved" is set only from the terminal's **status query**, with the same reference, amount and currency.
    The answer to "start", a cashier's click, a timeout or a notification body never approves a payment;
  - no final answer in time → **unknown**: still locked, checked again every few seconds, then every 30 s;
  - checkout links an approved payment to **exactly one sale** (atomic claim; a second sale is refused);
  - a reconciler may close an unknown payment only as **not charged** (after checking the terminal's report);
    Afey POS keeps asking the terminal for a day, so a late approval is still caught and shown;
  - refunds go to the terminal with the refund permission, never above what is left to refund.
- **Notifications** `POST /api/v1/hooks/terminal/:businessId/:terminalId` are authenticated by the adapter and
  only trigger a status query; the body is never trusted.
- **Restart recovery**: open payments are re-checked by background jobs, and the till shows them again when it
  reopens (an approved payment that is not on a sale yet can be used once).

## Setting up a terminal (Settings → Payments → Bank card terminals)

1. **Provider**: choose the bank or provider. Providers that are not available show "Provider access required" or
   "Not yet supported" and what is needed.
2. **Terminal and connection**: compatible models and operating systems; only connection methods the integration
   supports can be chosen (LAN/Wi-Fi, USB, serial or an approved cloud connection).
3. **Install** the provider's official terminal application, driver or connector.
4. **Find the terminal** with the provider's discovery, or register it.
5. **Pair**: enter the code shown on the terminal. A device is trusted only after pairing, and it must prove
   its identity on every call, never just because it is on the network.
6. **Connection test**: connected, identity confirmed, ready.
7. **Tills**: which tills of the branch may use it.
8. **Test payment** (sandbox/simulator): a small payment that never pays a sale.
9. **Result**: every check is listed. **Enable for payments** works only when all have passed.

The dashboard shows for each terminal: provider and bank, model and serial, branch and tills, connection and
readiness, last successful connection, integration version, items needing attention and the last error, with
Reconnect, Disable and Remove. **Card payments** lists payments with their verified status, links to sales,
re-check, "not charged" and refunds. Reconcilers find it under **Finance → Card terminal payments**.

## Permissions

| Permission | Allows |
|---|---|
| `terminals.manage` | Set up, pair, assign tills, test, enable, disable and remove terminals (owners and administrators) |
| `sales.create` | Charge on a terminal at an assigned till; cancel one's own unfinished payment |
| `terminals.reconcile` | See all terminal payments, re-check, close unknown ones as "not charged", cancel others' (branch managers, accountants) |
| `terminals.refund` | Refund a card payment on the terminal (branch managers) |

Terminals and their payments belong to one business and one branch: staff limited to other branches cannot see or
use them.

## Settings (server/.env)

| Variable | Default | Meaning |
|---|---|---|
| `TERMINAL_SIMULATOR` | `false` | In production (`NODE_ENV=production`) the simulator is offered only when `true` (training installations). Always available otherwise. |
| `TERMINAL_SIM_STEP_MS` | `1500` | Length of each simulated step (connecting, card, PIN, processing). |
| `TERMINAL_PAYMENT_TIMEOUT_SECONDS` | `180` | After this long without a final answer, a payment is shown as "unknown" (it stays locked and keeps being checked). |

## Deployment

- **Single shop / head office**: terminals are configured on the server the tills use.
- **Branch servers**: a branch server owns its terminals and their payments (they sync up to head office for
  reporting). Set up a branch's terminals on that branch's server.
- **Local connectors**: a provider whose terminal must be reached on the shop LAN, over USB or serial would run
  its adapter next to the tills, in the Afey device bridge (`bridge/`), with authenticated, loopback-only commands
  and signed results. No such provider is supported yet, so no connector is shipped; it will be built with the
  first provider that needs it.

## Testing

```bash
npm -w server test -- terminals    # server: setup, payments, failures, isolation (simulated terminal)
npx playwright test e2e/z-card-terminals.spec.ts   # browser: wizard and checkout (run after the other specs)
```

The server tests cover: successful, declined and cancelled payments; lost connection; delayed approval;
duplicate responses and notifications; duplicate payment requests; unknown status and its resolution; restart
during a payment; terminal switched off, disconnected, busy or with expired pairing; refunds and their
permission; other branches and other businesses; a terminal with an unfinished payment cannot be removed.

The simulator's test amounts: cents **.51** declined, **.52** cancelled by the customer, **.53** connection drops
while the result is read, **.54** waits until finished from the simulator controls; anything else is approved.

## Onboarding a bank or terminal provider (certification checklist)

1. Get the provider's ECR / semi-integrated specification or SDK, its licence terms and the supported terminal
   models, firmware and connection methods.
2. Get sandbox or test credentials and a test terminal with test cards.
3. Build the adapter against `TerminalAdapter`, implementing only what the provider documents; record its
   integration version.
4. Map every provider status to Afey POS statuses, including timeouts, busy, declined, cancelled and "unknown".
5. Confirm how the provider authenticates status queries and notifications; never approve from an
   unauthenticated message.
6. Test with the provider's test cards: approval, decline, cancel, PIN entry, contactless, refund, timeout,
   network loss, terminal restart, duplicate request, wrong amount.
7. Complete the provider's certification. Only then set the provider to `available` in the catalogue.
8. Pilot at one till with real, small payments and compare the terminal report with Afey POS daily.

## Troubleshooting

| Problem | What to do |
|---|---|
| "The terminal is switched off" / "cannot be reached" | Switch it on; check its network cable or Wi-Fi; then Reconnect / check on the dashboard |
| "The terminal is busy with another transaction" | Finish or cancel it on the terminal, or check the unfinished payment under Card payments |
| "This terminal has a card payment that is not finished" | Open it at the till (it is shown automatically) or under Card payments; wait for the answer or press Check again |
| A payment shows **unknown** | Do not charge again. Press Check again; if the terminal's own report shows it was not charged, a reconciler marks it "Not charged…" |
| "Pairing has expired" | Set up the terminal again from the dashboard (find, pair, test) |
| "Approved, not on a sale" | The card was charged but the sale was not completed: use it at the till ("Use this payment") or refund it |
| A provider shows "Provider access required" | The provider has not supplied an integration; see the checklist above |
