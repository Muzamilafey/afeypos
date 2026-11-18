# KRA eTIMS (OSCU and VSCU)

Afey POS sends every sale, return and void to the Kenya Revenue Authority's electronic Tax Invoice Management System (eTIMS). The receipt then carries the KRA signature and a QR code that customers can scan to check the invoice on the KRA site.

| Mode | When to use it |
|---|---|
| **OSCU** (Online Sales Control Unit) | Afey POS talks straight to KRA's online API (`https://etims-api.kra.go.ke/etims-api`, sandbox `https://etims-api-sbx.kra.go.ke/etims-api`). Needs internet at signing time. Sales made offline are queued and signed when the connection returns. |
| **VSCU** (Virtual Sales Control Unit) | KRA's signing software runs on a PC in the shop network and exposes the same API locally (e.g. `http://192.168.1.5:8088`). Best for busy supermarkets. |
| **Simulator** (`mock`, non-production only) | Signs locally with fake signatures for training and tests. It never contacts KRA. |

## Set up

1. Register the business on the KRA eTIMS portal and apply for OSCU or VSCU. KRA issues a **device serial number** for each branch (`bhfId`: `00` is head office, then `01`, `02`...).
2. In *Settings → Integrations → Add KRA eTIMS*, enter:
   - the KRA PIN (`P051234567X`),
   - the branch id,
   - the device serial number,
   - for VSCU, the VSCU address,
   - sandbox or production.

   On a multi-branch business, add one device per branch and select the branch it covers.
3. Press **Initialise device**. KRA returns the SCU id, the MRC number and the communication key (`cmcKey`). The key is stored encrypted and is never sent to the browser. **Test** checks that the configured HTTP service responds; it does not initialize the device or submit an invoice.
4. Give products a KRA **item classification code** and, if needed, a tax type under *Products → KRA eTIMS*. The tax type defaults from the VAT rate:

   | VAT rate | Tax type |
   |---|---|
   | 16 % | B |
   | 8 % | E |
   | 0 % | C (zero-rated) |

   Choose **A** (exempt) or **D** (non-VAT) explicitly where they apply. Products are registered with KRA automatically when saved. For an existing catalogue, use **Register all products** on the *KRA eTIMS* page. Item codes follow KRA's format `KE2{packaging}{unit}{serial}` and are kept when the product is edited.

## How signing works

- At checkout the sale is completed first. The till never waits for KRA. Afey POS reserves the next eTIMS invoice number for that device in the same step, so numbers are gap-free and never reused.
- A background job sends the invoice (`/saveTrnsSalesOsdc`). The receipt shows these details, plus a QR code linking to `.../indexEtimsReceiptData`:
  - the CU invoice number,
  - SCU id and MRC,
  - internal data,
  - receipt signature.

  The POS waits a few seconds for the signature before printing. If KRA is slow, the receipt prints with "awaiting signature" and can be reprinted from *Sales* once signed.
- **Offline**: network errors are retried with back-off for up to 60 attempts. Waiting invoices are listed on the *KRA eTIMS* page.
- **Rejections**: KRA validation errors, such as a wrong classification code, are not retried. The sale is marked *rejected*, the reason is shown, and after fixing the cause a manager presses **Retry**.
- **Returns** are sent as credit notes (`rcptTyCd R`) that reference the original invoice number. **Voids** of a sale already given an eTIMS number create a full credit note (refund reason 11) so KRA's books balance.
- Payment types map to KRA codes:

  | Payment | KRA code |
  |---|---|
  | Cash | 01 |
  | Credit | 02 |
  | Bank | 04 |
  | Card | 05 |
  | M-Pesa / mobile money | 06 |
  | Other | 07 |

## Local ETR discovery and device support

The **Search this computer** action runs through the paired Afey device bridge on Windows. It lists matching fiscal programs, their TCP listeners, and USB/COM devices. When it detects Tremol ZFPLabServer, it asks that server to find a device and shows its response. Discovery does not initialize, register, fiscalize, or submit a receipt.

Afey only fills a VSCU URL when one listener belongs to software explicitly identified as KRA VSCU/eTIMS and the address is unambiguous. A device scan cannot safely infer the KRA PIN, branch registration, KRA-issued device serial, or communication key. The business PIN and head-office branch id are prefilled from business settings; check them before saving. Enter the KRA-issued serial yourself, then initialize only after confirming the selected service is the right KRA device.

The listed model name or COM port alone does not make a printer a supported signing provider. The current signing gateway speaks the KRA OSCU/VSCU HTTP API. It does not contain model-specific direct receipt adapters for Tremol G03, S25, M23, FP24, or Datecs WP25 and FP700. Type A devices need their supplier program and registration flow; Type B/C hardware needs its compatible fiscal API/driver. Those flows must not be guessed from a USB port or a process name. Tremol's ZFPLabServer can discover and operate compatible Tremol devices, but its receipt command library is separate from the KRA OSCU/VSCU API.

## API

| Area | Endpoints |
|---|---|
| Device | `POST /settings/integrations/:id/etims/initialize` |
| Status | `GET /etims/status` (counts, waiting, rejected, unregistered products) |
| Retry | `POST /etims/retry` `{ kind: 'sale' \| 'return', id }` |
| Items | `POST /etims/items/register-all` |

## Verification status

The client follows KRA's published OSCU/VSCU specification:

- the `tin`/`bhfId`/`cmcKey` headers,
- the `selectInitOsdcInfo`, `saveItem` and `saveTrnsSalesOsdc` endpoints,
- tax types A to E,
- the invoice and credit-note fields.

Automated tests cover item registration, signing, credit notes, voids, offline retry and receipts using the simulator.

Automated tests cover the KRA API payload builder and signing queue with the simulator. The local discovery action has not been verified with attached Tremol or Datecs hardware in this environment. The KRA client has not been certified against the KRA sandbox, local VSCU software, or production. Before going live, complete KRA's sandbox certification with your device serial number. Points to confirm there:

- the receipt QR link format,
- the refund reason codes,
- the classification codes used for your catalogue.
- the selected local VSCU's KRA API compatibility and how it returns signed invoice data.
- the relevant vendor's integration package and receipt/credit-note workflow for each direct fiscal device model.
