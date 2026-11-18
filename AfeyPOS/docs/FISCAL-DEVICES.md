# Fiscal devices: KRA eTIMS, TIMS ETR devices and reconciliation

This document covers how Afey POS sends sales and credit notes to KRA, either through KRA eTIMS (OSCU / VSCU) or
through a TIMS ETR device. It covers the device layer, how an invoice is fiscalized exactly once, monitoring,
reconciliation, reports, installation, a compatibility matrix, and a checklist for KRA certification.

The work extends the existing eTIMS module (`server/src/modules/etims`). Nothing was replaced:

- sales, payments and the database stay as they were;
- records saved before this change keep working;
- the existing pages keep working: **KRA eTIMS**, and the ETR finder under **Integrations**.

Related documents:

- [ETIMS.md](ETIMS.md): eTIMS OSCU / VSCU setup.
- [KRA-ETR-DEVICE.md](KRA-ETR-DEVICE.md): ETR program setup and the exact invoice and answer format.

## 1. What is implemented and how it was tested

| Status | Meaning | What it covers |
|---|---|---|
| **Implemented and tested** (server tests, browser test) | Runs in CI against the simulators and a local test program | See the list below |
| **Mock-tested only** | Proven with the simulator / a scripted local HTTP program, never with a real device or KRA | All device communication below |
| **Hardware-tested** | Tested with a physical device | **None yet.** No ETR model has been tested on site by us |
| **Awaiting manufacturer documentation** | Needs the maker's published protocol before it can be built | See the list below |
| **Awaiting KRA sandbox / certification** | Needs KRA sandbox credentials and KRA's own test process | See the list below |

**Implemented and tested:**

- the adapter layer and the fiscal states;
- exactly-once submission, the device lease and claim;
- status checks before any resend;
- reconciliation;
- the transaction log and device health;
- the monitor job;
- reports;
- the dashboard page;
- tenant isolation.

**Mock-tested only:**

- the OSCU / VSCU calls, against the eTIMS simulator;
- the ETR web-address and folder exchanges, against a test program and test folders.

**Awaiting manufacturer documentation:**

- a per-maker status query for ETR programs (Afey POS uses it only when the installer enters the address from the
  maker's documentation, see `statusPath`);
- direct USB / serial device protocols, which Afey POS does not speak (§4).

**Awaiting KRA sandbox / certification:**

- an OSCU / VSCU invoice status query: KRA's endpoint for looking up one invoice has not been confirmed from
  official documentation, so it is not called;
- confirmation of which result codes KRA returns for a re-sent invoice number;
- production approval.

Afey POS has **not** been certified or approved by KRA. Do not describe it as approved until KRA's process has
been completed (§11).

## 2. Architecture

```
Till (browser) ──► Afey POS server ──► etims.submit job ──► FiscalAdapter ──► device / KRA
   checkout never waits                │ claim + device lease     ├─ OSCU  (KRA eTIMS online API)
   for the device                      │ status query first       ├─ VSCU  (KRA signing software on the shop network)
                                       │ log + health             ├─ ETR program: web address on this computer
                                       ▼                          ├─ ETR program: inbox / outbox folders
                              Sale.etims / SaleReturn.etims       ├─ ETR simulator
                              FiscalTransaction, FiscalDeviceState└─ eTIMS simulator
```

The flow, step by step:

1. **Checkout never waits for KRA.** Inside the sale's database transaction, Afey POS reserves the next invoice number
   for the chosen device and queues a durable job (the outbox pattern). A sale is saved once, whatever happens with
   fiscalization later, so sales are never duplicated.
2. **The `etims.submit` job** builds the eTIMS invoice (tax types A–E, items and totals) and hands it to the
   device's adapter.
3. **The adapter layer** is `server/src/integrations/fiscal/adapter.ts` (interface, errors, states) and
   `server/src/modules/etims/adapters.ts` (one adapter per kind of device).

### Adapter interface

| Method | Purpose |
|---|---|
| `connect()` / `disconnect()` | Kept for session-based SDKs. A no-op for the HTTP and folder devices, which are reached per request |
| `getCapabilities()` | What this device can really do (table below) |
| `validateConfiguration()` | Problems in the setup, in plain words |
| `getDeviceInfo()` | Serial, SCU id, MRC number, where it is reached. Never a key |
| `getStatus()` | A cheap check used by the monitor. It never sends a fiscal command |
| `testConnection()` | A check a person asks for (the **Test connection** button) |
| `submitInvoice(sale)` | Sends a sale |
| `submitCreditNote(note)` | Sends a credit note (receipt type `R`, referencing the original invoice) |
| `submitDebitNote()` | Throws `FiscalUnsupportedError` (see capabilities) |
| `getTransactionStatus(sale)` | Whether the device or KRA already recorded this invoice, where documented |
| `getLastFiscalReceipt()` | Simulator only |
| `cancelTransaction()` | Throws `FiscalUnsupportedError`. A fiscal invoice is reversed with a credit note |

An operation a device does not support throws `FiscalUnsupportedError`; it is never faked.

### Capabilities

| Device kind | Invoice | Credit note | Debit note | Cancel | Status query | Safe resend | Shop computer only |
|---|---|---|---|---|---|---|---|
| OSCU (KRA online) | ✓ | ✓ | ✗ | ✗ | ✗ (awaiting KRA docs) | ✓ (same invoice number every attempt) | ✗ |
| VSCU (shop network) | ✓ | ✓ | ✗ | ✗ | ✗ (awaiting KRA docs) | ✓ | ✓ |
| ETR program, web address | ✓ | ✓ | ✗ | ✗ | Only with `statusPath` from the maker's docs | ✗ | ✓ |
| ETR program, folders | ✓ | ✓ | ✗ | ✗ | ✓ (the answer file) | ✓ (written once) | ✓ |
| ETR simulator | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ |
| eTIMS simulator | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ |

Debit notes are not offered because Afey POS has no debit note document. An eTIMS debit note will be added once
the document exists and is confirmed in the KRA sandbox.

## 3. Fiscal states

| State (stored value) | Shown as | Meaning | Colour |
|---|---|---|---|
| `pending` | Pending | Queued, not sent yet | yellow |
| `processing` | Processing | A worker is sending it right now | yellow |
| `signed` | **Fiscalized** | The device or KRA answered with its signature / CU invoice number. The only state printed as fiscal | green |
| `awaiting_confirmation` | Awaiting confirmation | Sent, but no answer came back. It may have been recorded | yellow |
| `device_disconnected` | Device disconnected | The device, its program or KRA could not be reached. Nothing was sent | yellow (red device) |
| `rejected` | Rejected | Refused by KRA or the device (for example, an invalid item classification). Fix it, then retry | red |
| `failed` | Failed | Could not be sent (device removed, invoice could not be built), or a person marked it not fiscalized | red |
| `requires_reconciliation` | Requires reconciliation | Nobody can tell whether it was recorded. A person checks (§6) | red |

Older records keep their old values (`pending` / `signed` / `failed`), which are all still valid.

How a receipt reads in each state:

- **Signed:** the receipt carries the signature, the CU numbers and the QR link, all exactly as received.
- **Still on its way:** the receipt says *"awaiting signature / NOT YET A FISCAL RECEIPT"*.
- **Refused, or needs a person:** the receipt says *"not fiscalized / NOT A FISCAL RECEIPT"*.

Afey POS never prints an invoice number, signature or QR code of its own invention. An offline sale is never shown
as fiscalized.

## 4. Exactly once, also with one device for many tills

1. **Same number every attempt.** An invoice number is reserved once per device (`Counter etims:invoice:<configId>`)
   and reused on every retry.
2. **Claim.** Before sending, the job atomically moves the document to `processing`, with a lease (`etims.claimUntil`).
   A second worker (a duplicate job, a manual retry, another process) finds it claimed and leaves it alone.
3. **Device lease.** Each device has one lease per server (`FiscalDeviceState.lockUntil`).
   - A central device shared by many tills handles one invoice at a time.
   - The others wait their turn, up to 15 s; after that their job retries shortly.
   - The lease expires on its own if a process dies holding it.
4. **Uncertain sends are checked first.**
   - **When it applies:** an earlier send got no answer (timeout, or the connection dropped after sending), or a
     worker died while sending. The state is then `awaiting_confirmation`, or a stale `processing`.
   - **Device can be asked:** if the device supports a status query, it is asked first.
     - Found: the document is stored as Fiscalized (`via: status_query`) without sending it again.
     - Not recorded: it is sent.
   - **Device cannot be asked, resend is safe:** if a resend cannot duplicate (OSCU / VSCU reuse the same number,
     and folder exchange writes the file only once), it is resent.
   - **Otherwise:** it goes to **Requires reconciliation**, and is never sent twice by guesswork.
5. **"Already recorded" without a signature** (for example, an eTIMS answer that the invoice exists) goes to
   reconciliation.
6. **Errors are sorted** (`classifyTransportError`):
   - *Could not connect* (ECONNREFUSED, host unreachable, folder not writable) gives `device_disconnected`. Nothing
     was sent, so it is safe to retry.
   - *Sent, no answer* (timeout, connection dropped) gives `awaiting_confirmation`.
7. **Retries.** The job queue retries with growing delays.
   - **Monitor job:** `fiscal.health` runs every 5 minutes for each business, and does three things:
     - checks the devices this server reaches;
     - sends waiting invoices at once when a device comes back;
     - queues again any invoice whose job was lost or gave up, for example after days offline.

**USB and serial devices.** Afey POS never sends commands to a USB or serial device. The device is driven by its
maker's program. Afey POS talks only to that program, over its documented web address or folders. *Find a device*
only lists USB and COM devices so the installer can see the device is connected.

## 5. Monitoring

**Settings → Tax & fiscal devices**, at `/settings/fiscal`. The menu entry is *Tax & fiscal devices* under Settings.

**Devices.** One card per device, showing:

- a status dot: green (working), yellow (invoices waiting), red (offline, or invoices need attention), grey (off or
  not known);
- kind, environment, serial and SCU, and where the device is reached;
- last success, last problem, and the waiting and needs-attention counts;
- capabilities, and setup warnings.

**Test connection** checks the device without sending an invoice.

**Fiscal transactions.** Every sale and credit note with a fiscal state.

- **Filter and search.** Filter by state (including *on the way* and *needs attention*). Search by receipt, invoice
  number, CU invoice number or signature.
- **Detail.** Opening one shows its fiscal fields and full history: each attempt, status query and reconciliation,
  with the request sent and the response received, both without keys.

**Reports.** For a period:

- fiscalized sales and net after credit notes;
- invoices on the way and invoices needing attention;
- sales made without a fiscal device;
- VAT on fiscalized sales by KRA tax type;
- per device: attempts, success rate, average time and downtime;
- sales against fiscalized amounts by day (the gap is what is not fiscalized);
- invoice numbers used twice for one device.

**Find a device.** Fiscal programs, their local addresses and folders, and USB / COM devices on this computer
(Windows and Linux).

The older **KRA eTIMS** page (`/etims`) still shows the totals, retry and product registration. It links to the
pages above.

## 6. Reconciliation

Reconciling is open to people with *Manage integrations*. Every action is written to the signed audit trail
(`fiscal.reconcile_*`) and to the fiscal log, with the person's note.

| Action | When | Effect |
|---|---|---|
| **Ask the device again** | The device has a status query | Back to *Awaiting confirmation*, and the device is asked |
| **Not on the device: send again** | You checked the device journal / KRA portal and the invoice is **not** there | Sent again with the same invoice number |
| **Found on the device / KRA: record it** | You found the signed invoice | Stores the CU invoice number / signature exactly as shown (`via: manual`) |
| **Mark as not fiscalized** | For example, a test sale | *Failed*. It stays listed as not fiscalized |

Reconciliation has these safeguards:

- A plain **Retry** is refused for *Requires reconciliation*; the invoice must be reconciled.
- An invoice that is already fiscalized cannot be reconciled.
- An invoice being sent at that moment cannot be touched.

## 7. Security

- **Keys stay on the server.** KRA communication keys (`cmcKey`) and an ETR program's auth header are sealed
  (AES-256-GCM, `secretsEnc`). They are never returned by the API and never stored in the fiscal log: key-like
  fields are masked by `sanitizeForLog`, and a test checks that the ETR key never reaches the log.
- **ETR programs must be local.** Their addresses must be on this computer or the shop network; anything else is
  refused (`assertLocal`).
- **Roles.**
  - Viewing fiscal data needs *Financial reports*.
  - Testing devices and reconciling need *Manage integrations*.
- **Isolation.**
  - Every model is tenant-scoped.
  - Sales and credit notes are also branch-scoped, so a user limited to some branches sees only theirs.
  - The fiscal log is filtered by the user's branches.
- **Audit and log.** Every reconciliation and every device test is audited. The fiscal log records each operation
  with its time, server, device, document and outcome.

## 8. Data design

All changes are backward compatible: new optional fields, new values and new collections only. There is no
migration script and no change to the existing database.

**`Sale.etims` / `SaleReturn.etims`: new fields**

- `claimUntil`, `lastAttemptAt`, `statusChangedAt`;
- `via` (`device` | `status_query` | `manual`);
- `resendConfirmedBy`, `reconciledBy`, `reconciledAt`, `reconcileNote`.

**`Sale.etims` / `SaleReturn.etims`: new status values**

`processing`, `rejected`, `awaiting_confirmation`, `device_disconnected`, `requires_reconciliation`.

**New indexes**

- `{tenantId, etims.status, completedAt}` on sales;
- `{tenantId, etims.status, createdAt}` on returns;
- `{tenantId, etims.configId, etims.invcNo}` on sales.

Each index is partial: only documents with a fiscal state are indexed.

**`FiscalTransaction` (new collection)**

Fields:

- the device: `configId`, `deviceName`, `deviceKind`, `branchId`, `origin` (which server);
- the operation and its document: `operation`, `docKind`, `docId`, `docNumber`, `invcNo`, `attempt`;
- the result: `outcome`, `ok`, `error`, `request`, `response`, `durationMs`;
- who and when: `userId`, `note`, `at`.

Indexes: by time, by device and time, and by document.

**`FiscalDeviceState` (new collection)**

One record per device per server (`{tenantId, configId, origin}`, unique). It holds:

- `state`, `message`, `lastCheckAt`;
- `lastSuccessAt`, `lastFailureAt`, `lastError`, `consecutiveFailures`;
- `downSince`, and `outages` (up to the last 100);
- the lease: `lockUntil`, `lockHolder`.

**Sync.** `FiscalTransaction` and `FiscalDeviceState` sync up from branch servers to head office, so HQ can monitor
devices plugged into shop computers.

**Invoice-number uniqueness.** The number is unique per device on one server: one counter, reserved in the sale's
transaction. A unique index across servers is deliberately not used. A device shared by two servers would make
syncing fail; instead, the dashboard and the report flag it (§12).

## 9. API

| Method | Path | Permission |
|---|---|---|
| GET | `/fiscal/devices` | reports.financial |
| POST | `/fiscal/devices/:id/test` | integrations.manage |
| GET | `/fiscal/transactions?status&kind&configId&q&from&to&branchId&limit` | reports.financial |
| GET | `/fiscal/transactions/:kind/:id` | reports.financial |
| POST | `/fiscal/transactions/:kind/:id/reconcile` `{action: check / resend / record / mark_failed, note, …}` | integrations.manage |
| GET | `/fiscal/log?configId&operation&ok&limit` | reports.financial |
| GET | `/fiscal/reports?from&to&branchId` | reports.financial |

Existing routes, unchanged:

- `/settings/integrations` (and `:id/test`, `:id/etims/initialize`);
- `/etims/status`, `/etims/retry`, `/etims/devices`, `/etims/etr/detect`, `/etims/items/register-all`.

`/etims/retry` now also accepts *rejected*, *device disconnected* and *awaiting confirmation*. It refuses
*requires reconciliation*.

## 10. Installation

There is no Docker and there are no new dependencies. The device layer uses Node's built-in `fetch` and `fs`.

### Windows shop computer (local server or branch server)

1. Install the ETR maker's program and drivers as the supplier instructs. Confirm on the program's own screen that
   it sees the device.
2. In Afey POS on **that computer**, open **Settings → Integrations → Add KRA eTIMS → ETR device**.
   - Press **Find ETR** to list the programs, the addresses they answer on and their inbox / outbox folders.
   - Pick one.
   - If the maker documents a "get invoice status" address, enter it as **Status address** (for example,
     `/invoice/{invoiceNumber}`).
3. Save, then press **Test** (or **Test connection** on **Tax & fiscal devices**).
4. Make a small test sale **in the sandbox / training mode first**.
   - Check the printed CU invoice number against the device's own journal.
   - Open the sale under **Fiscal transactions** and look at the request and response.

### Linux server

The same steps apply. *Find a device* uses `ss`, `ps` and `/dev/serial/by-id`. The account running Afey POS needs
read / write access to the ETR program's folders.

### OSCU / VSCU

1. Register the branch on the KRA eTIMS portal and get the device serial.
2. Add **KRA eTIMS → OSCU** (online) or **VSCU** (enter the VSCU address on the shop network).
3. Press **Initialise device**. KRA returns the SCU id, the MRC number and the communication key; the key is kept
   sealed.
4. Register products with **KRA eTIMS → Register all products**, then make a sandbox test sale.

### Head office (online server)

An ETR device or a VSCU is reached by the shop computer, not by the online head office. Set it up on the branch
server. HQ shows its state through sync. The online HQ can use OSCU directly.

## 11. Manufacturer compatibility

Afey POS reaches ETR devices through the maker's own program, so any device whose program offers one of these works
without device-specific code:

- **a local web address** that takes the invoice as JSON and answers with the CU invoice number;
- **inbox / outbox folders** with the same exchange.

The field names in the answer are configurable. The exact formats are in [KRA-ETR-DEVICE.md](KRA-ETR-DEVICE.md).

| Maker / product | How it connects to Afey POS | Status |
|---|---|---|
| Any ETR whose program has a local web address | `etr` + web address | Mock-tested (test program). **Not hardware-tested** |
| Any ETR whose program uses inbox / outbox folders | `etr` + folders | Mock-tested (test folders). **Not hardware-tested** |
| Tremol, Datecs, Daisy, Eltrade, Incotex (seen by *Find a device*) | Through their PC program, if it offers one of the two exchanges above | Detection only. **Awaiting manufacturer documentation** for each program's exchange and status query |
| Direct USB / serial fiscal protocol of any maker | Not supported. Afey POS does not send device commands | Not implemented by design |
| KRA eTIMS OSCU | `oscu` | Mock-tested. **Awaiting KRA sandbox testing** |
| KRA eTIMS VSCU | `vscu` | Mock-tested. **Awaiting KRA sandbox testing** |

A maker's protocol is added only from its published or supplied documentation, never by guessing commands.

## 12. Known limitations

- **No status query for OSCU / VSCU yet.** An uncertain OSCU / VSCU send is resent with the same invoice number. A
  "duplicate" answer goes to reconciliation. Which result codes KRA uses for this is to be confirmed in the sandbox.
- **ETR programs without a documented status address.** A lost answer goes to reconciliation; Afey POS cannot ask
  the device.
- **One device configuration used by two servers.** Two branch servers using one business-wide eTIMS configuration
  each number invoices from 1, and the numbers would clash at KRA. The dashboard warns about this, and the report
  lists duplicate numbers. Give each branch server its own configuration (its own KRA branch id or device).
- **Health checks.** OSCU is not polled: its state comes from the invoices actually sent. Health checks of local
  devices only check that the program or folders answer.
- **Not offered:** debit notes, cancellation, and reading the last receipt from a real device.

## 13. KRA certification checklist

Afey POS is **not** KRA-certified. Before going live, the business or its integrator should complete each item.

- [ ] **Sandbox credentials.** KRA eTIMS sandbox credentials obtained; OSCU / VSCU initialised in the sandbox.
- [ ] **Item registration.** Item registration accepted in the sandbox, including item classification codes for
      each product.
- [ ] **Each tax type.** A sale with each tax type (A, B, C, D, E) is accepted, and the totals match the receipt.
- [ ] **Credit notes.**
  - [ ] Full and partial credit notes are accepted.
  - [ ] Each references the original invoice number.
  - [ ] The refund reason codes are correct.
- [ ] **Re-sent invoice number.** Re-sending the same invoice number gives KRA's duplicate answer, and Afey POS
      shows it under reconciliation, not as a second invoice.
- [ ] **Offline period.** Sales during an offline period are queued, then signed in order when the connection is
      back, and none is lost or duplicated.
- [ ] **Receipt layout and QR code.** The receipt layout and QR code are checked against KRA's current receipt
      requirements; only KRA's returned values are printed.
- [ ] **ETR devices.**
  - [ ] Tested on the actual device with the maker's program, in training mode.
  - [ ] The CU invoice number is checked against the device journal.
  - [ ] Credit notes are tested.
  - [ ] Disconnection and reconnection are tested.
  - [ ] A lost answer is tested, ending in reconciliation or a status query.
- [ ] **Staff training.** Staff are trained on reconciliation and on what an unsigned receipt means.
- [ ] **KRA approval.** KRA's approval or certification process is completed for the device and integration mode
      used. Until then, nothing may say that Afey POS is KRA approved.

## 14. Tests

**Server: `server/tests/fiscal.test.ts`**

- transport errors sorted into "not sent" and "maybe sent";
- capabilities, and unsupported operations refused;
- a lost answer found by a status query, recorded once;
- two workers on one invoice: only one sends it;
- a duplicate answer goes to reconciliation, then a person records it (with audit);
- rejected, then retried and signed;
- device disconnected, the job gives up, and the monitor requeues it;
- an ETR program without a status query: a dropped connection goes to reconciliation, a person confirms, and it is
  resent once;
- an ETR program with a status address: a lost answer is looked up;
- three tills on one central device: one invoice at a time;
- the key never reaches the log;
- reports, including VAT by tax type and success rate;
- tenant isolation.

**Server: `etims.test.ts` and `etr.test.ts`** were updated for the new states.

**Browser: `web/e2e/zzz-till.spec.ts`** tests the Tax & fiscal devices pages.
