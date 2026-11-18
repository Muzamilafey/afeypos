# KRA ETR device on the Afey POS computer

Use this when a **KRA ETR device** (a TIMS control unit or fiscal device, e.g. Tremol, Datecs, Daisy) is plugged
into the computer that runs Afey POS, and it should sign every receipt.

Afey POS supports three kinds of KRA signing, chosen under **Administration → Integrations → KRA eTIMS**:

| Choice | What signs the receipt |
|---|---|
| OSCU (online, KRA servers) | KRA's eTIMS over the internet |
| VSCU (KRA software on your network) | KRA's VSCU software in the shop |
| **ETR device on the Afey POS computer** | **The ETR device plugged into the shop computer** (this guide) |

---

## 1. How it works

Every ETR brand talks to its device in its own way, so Afey POS does not talk to the device directly. It talks to
**the program that came with the device** (the ETR supplier installs it on the computer, e.g. "ZFPLab server",
"Fiscal service", "ESD/TIMS middleware"). That program speaks to the device over USB, serial or the network, and
answers Afey POS with the signature.

Afey POS can reach that program in one of two ways. Ask the ETR supplier which one theirs uses:

| Connection | How it works | What you need |
|---|---|---|
| **Its program listens on this computer** (web address) | Afey POS sends each invoice to the program's address, e.g. `http://127.0.0.1:4444/invoice`, and reads the answer. | The program's address and port (and a key, if it asks for one) |
| **Folder exchange** | Afey POS saves each invoice as a file in the program's **inbox** folder; the program signs it and saves its answer in the **outbox** folder. | The two folders, e.g. `C:\ETR\in` and `C:\ETR\out` |
| **Tremol control unit (ZFP Lab Server)** | For Tremol devices such as the **G03** (sold in Kenya by Total Solutions). Afey POS drives the control unit through Tremol's **ZFP Lab Server** running on this computer: it opens a receipt, adds each line and closes it, then reads the control-unit invoice number, signature and QR. | The ZFP Lab Server address (default `http://127.0.0.1:4444`), the operator number/password, and the CU serial number |

How the ETR is plugged in (USB, serial cable or network) does not matter to Afey POS: the program handles it.

> The ETR must be on the **shop computer** (a standalone or branch server), because that is the computer the device
> is plugged into. The online head office (VPS) cannot reach a device in a shop. Sales made at the shop are signed
> by the shop server, then synced to head office with their CU invoice numbers.

---

## 2. Before you start

1. The ETR supplier has installed the device and its program on the Afey POS computer, and a test receipt from their
   program works.
2. Note from the device or its sticker: the **CU serial number** (e.g. `KRAMW004201234567`).
3. Ask the supplier: *"Does your program take invoices on a local web address (which port?), or through folders
   (which inbox and outbox)? What does it answer?"* Show them [section 6](#6-for-the-etr-supplier-the-exact-format).

To find out yourself what is running on the computer:

- **Windows:** in PowerShell, `Get-NetTCPConnection -State Listen | Where-Object LocalAddress -in '127.0.0.1','0.0.0.0' | Sort-Object LocalPort | Select-Object LocalPort, OwningProcess, @{n='Program';e={(Get-Process -Id $_.OwningProcess).ProcessName}}`
  lists programs listening for connections. Look for the ETR program's name.
- **The device's port:** *Device Manager → Ports (COM & LPT)* shows a USB/serial ETR as a COM port. That is for the
  supplier's program, not for Afey POS.

---

## 3. Set it up in Afey POS

On the **shop computer's** Afey POS (e.g. `http://localhost:9999`):

1. **Administration → Settings → Modules**: turn on **KRA eTIMS** and save.
2. **Administration → Integrations**: in the **KRA eTIMS** section choose **ETR device on the Afey POS computer**.
3. Press **Find ETR** at the top of the form. Afey POS looks on this computer for:
   - ETR programs that are installed or running (Tremol / ZFPLab, Datecs, Daisy, "fiscal", ETR, TIMS, ESD…), and
     the local address each one listens on, marked **answers** when it replied just now;
   - ETR inbox / outbox folders (e.g. `C:\ETR\IN` and `C:\ETR\OUT`);
   - the device itself among the USB / COM-port devices (shown so you know Windows sees it).

   Press **Use this** next to the program address (or the folders): it fills in the connection for you. If nothing
   is found, start the ETR program, or ask the supplier how it takes invoices, then press **Look again**.
4. Check or fill in the rest:

   | Field | What to enter |
   |---|---|
   | Name | e.g. `Counter 1 ETR` |
   | KRA PIN of the business | e.g. `P051234567X` |
   | KRA branch id | `00` for head office |
   | CU serial number | from the device, e.g. `KRAMW004201234567` |
   | How Afey POS reaches the ETR program | **Its program listens on this computer**, **Folder exchange**, or **Simulator** |
   | Program address *(web address)* | e.g. `http://127.0.0.1:4444` |
   | Path invoices are sent to *(web address)* | e.g. `/invoice` (ask the supplier; the default is `/invoice`) |
   | Inbox / Outbox folder *(folder exchange)* | e.g. `C:\ETR\in` and `C:\ETR\out` |
   | Seconds to wait for the device | `30` (raise it if the device is slow) |
   | Answer fields | leave empty; fill in only if the test says the CU invoice number was not found |
   | Key header | only if the program asks for one, e.g. `X-Api-Key: abc123` |

5. **Used by**: the whole business, chosen branches, or chosen tills (for example, one ETR per counter).
6. **Live** for real receipts (**Test mode** while trying).
7. **Save**, then press **Test** on the device's card. You should see *"ETR program answers at…"* (web address) or
   *"Folders ready"* (folder exchange).
8. Make a small sale. The *Sale complete* window shows **"Signed by the KRA ETR · CU invoice 0040…"**, and the
   receipt prints:

   ```
   KRA TIMS · ETR
   CU Serial No.: KRAMW004201234567
   CU Invoice No.: 0040123450000012345
   Date                 01/11/2026, 14:32:10
   [QR code]
   ```

**Try it first with the Simulator**: it signs with made-up numbers and sends nothing to KRA, so you can check the
receipt layout before the supplier sets the device up.

---

## 3b. Tremol G03 (ZFP Lab Server)

The **Tremol G03** control unit (Type B / Type C, sold in Kenya by Total Solutions) is driven through Tremol's
**ZFP Lab Server**, a small program the supplier installs on the shop computer that listens on `http://127.0.0.1:4444`
by default.

1. In the ETR form, set **How Afey POS reaches the ETR program → Tremol control unit (ZFP Lab Server)**.
2. Fill in:

   | Field | What to enter |
   |---|---|
   | Program address | the ZFP Lab Server address, usually `http://127.0.0.1:4444` |
   | CU serial number | the G03's serial, e.g. `KRAMW011202207061496` |
   | Tremol operator / cashier number | usually `1` |
   | Tremol operator password | usually `0000` (stored as a secret) |

3. **Save**, then press **Test**: Afey POS asks the ZFP Lab Server for the device version — you should see
   *"Tremol ZFP Lab Server answers at…"*. If not, start the ZFP Lab Server and check the port.
4. For each sale Afey POS runs the device's own command sequence — **open the receipt, add every line with its VAT
   class, close the receipt** — then reads the control-unit invoice number, signature and QR from the device and
   prints them, exactly like any other ETR.

> **Confirm one real receipt before going live.** The exact command arguments the G03 expects can differ by firmware
> version. Afey POS uses Tremol's documented order, and if the device rejects a command it is reported as a failed
> fiscalisation (never a fake signature) — nothing is ever marked signed unless the device returned a real
> control-unit number. Make one test sale, then check that invoice on the **KRA portal** to confirm it was recorded.
> If your firmware uses a different argument order, the ETR supplier can give you the exact `OpenReceipt` /
> `SellPLUwithSpecifiedVAT` / `CloseReceipt` signatures from the device's ZFP manual, and they can be set on the
> device (advanced command templates) without changing Afey POS.

---

## 4. Every day

- **Each sale is signed by itself.** Checkout never waits for the device: if it is slow, busy or switched off, the
  sale is completed and signed when the device answers again (Afey POS keeps trying).
- **A receipt printed before the signature** shows *"KRA ETR: awaiting signature"*. Reprint it from **Sales history**
  once it is signed.
- **Returns** are signed as credit notes, naming the original sale's CU invoice number.
- **Several devices** (e.g. one per counter): the cashier picks the device on the payment screen, or each till uses
  its own (see *Used by*).
- **What failed and why:** the **KRA eTIMS** page lists sales waiting or refused, with **Retry**.

---

## 5. If something goes wrong

| What you see | What to do |
|---|---|
| Test: *"The ETR program does not answer at http://127.0.0.1:…"* | The program is not running, or listens on another port. Start it (or ask the supplier for the port) and test again. |
| Test: *"Afey POS cannot use the folder…"* | Create the folders, or give the computer's Afey POS service access to them. |
| Sales stay *"awaiting signature"* | Folder exchange: is the program watching the inbox? Files waiting in the inbox mean the program is not taking them. |
| *"the answer has no CU invoice number"* | The program answers with other field names. Open one answer (in the outbox `done` folder, or ask the supplier) and enter the field name under **Answer field with the CU invoice number**, e.g. `result.invoiceNo`. |
| *"ETR program refused the invoice (400): …"* | The device refused it (e.g. a missing tax rate or PIN). The reason is shown on the KRA eTIMS page; fix it, then **Retry**. |
| Paper out / device error | Fix the device; Afey POS retries by itself. |
| *Requires reconciliation* | The invoice was sent but the answer was lost, and the program has no status address, so Afey POS does not send it again on its own. Check the device journal, then open the sale under **Settings → Tax & fiscal devices → Fiscal transactions** and either record the CU invoice number it shows or confirm it is not there (it is then sent again). See [FISCAL-DEVICES.md](FISCAL-DEVICES.md). |

**Status address.** If the maker's program documents an address that answers "was this invoice signed?" (for
example `GET /invoice/{invoiceNumber}` returning the same answer as the invoice, or 404 when it does not have it),
enter it as the status address. A lost answer is then looked up automatically instead of going to reconciliation.
Only use an address the maker documents.

---

## 6. For the ETR supplier: the exact format

### Invoice sent by Afey POS

**Web address:** `POST <program address><path>` with `Content-Type: application/json`, plus the key header if one is
set. **Folder exchange:** a file `<invoiceNumber>.json` in the inbox. It is written under a temporary name and
renamed, so it is always complete. Each invoice is handed over **once**; Afey POS then waits for the answer.

```json
{
  "type": "sale",
  "invoiceNumber": "RCP-000123",
  "sequence": 123,
  "dateTime": "2026-11-01T14:32:10+03:00",
  "seller": { "pin": "P051234567X", "name": "WALALAHA SUPERMARKET" },
  "buyer": { "pin": null, "name": null, "phone": null },
  "cashier": "Amina",
  "payment": "cash",
  "items": [
    { "name": "Sugar 1kg", "code": "KE2NTU0000001", "barcode": "6161100000012", "quantity": 2, "unit": "U",
      "unitPrice": 116.0, "discount": 0, "total": 232.0, "taxCode": "B", "taxRate": 16, "taxAmount": 32.0 }
  ],
  "totals": { "taxable": 232.0, "tax": 32.0, "total": 232.0,
              "byTax": [ { "code": "B", "rate": 16, "taxable": 232.0, "tax": 32.0 } ] }
}
```

- Amounts are in shillings, **tax-inclusive**; `taxAmount` is the VAT inside `total`.
- `taxCode`: `A` exempt, `B` 16 % VAT, `C` zero-rated, `D` non-VAT, `E` 8 %.
- `payment`: `cash`, `card`, `mobile_money`, `credit`, `bank` or `other`.
- A credit note has `"type": "credit_note"`, `"relevantInvoiceNumber"` (the original sale's CU invoice number) and
  `"originalReceipt"` (the original receipt number).

### Answer Afey POS expects

JSON (for the web address, or a `.json` file in the outbox), or plain `key=value` / `key: value` lines (a `.txt`
file). The answer file has the same name as the invoice: `RCP-000123.json` or `RCP-000123.txt`.

```json
{ "cuInvoiceNumber": "0040123450000012345", "cuSerialNumber": "KRAMW004201234567",
  "qrCode": "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?...", "dateTime": "2026-11-01T14:32:11+03:00" }
```

Field names are matched without regard to case, at the top level or inside `data` / `result` / `response`:

| Value | Names recognised | Required |
|---|---|---|
| CU invoice number | `cuInvoiceNumber`, `cuInvoiceNo`, `controlUnitInvoiceNumber`, `CUIN`, `invoiceNumberCU`, `MiddlewareInvoiceNumber`, `InvoiceNumber` | **yes** |
| CU serial number | `cuSerialNumber`, `cuSerialNo`, `controlUnitSerialNumber`, `CUSN`, `serialNumber` (else the one set in Afey POS) | no |
| QR / verification link | `qrCode`, `qrUrl`, `verificationUrl`, `verifyUrl`, `QRCode`, `link` | no (printed as a QR code) |
| Date and time | `dateTime`, `cuDateTime`, `signedAt`, `date` | no |
| Error | `error`, `errorMessage` | when it could not sign |

Other names can be set in Afey POS (dotted paths such as `result.invoice.no`). An HTTP error status (4xx) means
the invoice was refused and is not retried; 5xx and no answer are retried.

When your program uses a different invoice format, tell us the program's name and model and we can add a direct
connector for it.
