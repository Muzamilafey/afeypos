# Suppliers & purchasing

The *Suppliers & purchasing* menu covers buying stock from start to finish:

1. **Supplier quotations**: ask one or several suppliers for prices.
2. **Purchase orders**: order from the supplier you choose.
3. **Goods received**: receive the delivery into stock with the supplier's invoice.

Paying suppliers and their balances stay on each supplier's page (*Suppliers*), which also lists their quotations, orders and deliveries.

## Supplier quotations

*Request quotation*: pick one or more suppliers, the warehouse to deliver to, a reply-by date and the items with quantities. Tick *Email the request* to send each supplier a **request for quotation** as PDF straight away (their email address comes from the supplier record; suppliers without one can be printed or phoned).

Asking several suppliers creates one quotation per supplier (RFQ-000001, RFQ-000002...) linked as one request.

When a supplier replies (email, phone or their own quote), open their quotation and enter:
- the price per item, or untick *available* for items they cannot supply;
- their quote reference, delivery time in days, how long the quote is valid, and their terms.

**Compare suppliers** shows every item with each supplier's price side by side; the lowest price per item is marked green, and the cheapest complete quote is named.

**Accept and order** turns the quote into a purchase order at the quoted prices (only the available, priced items) and, if you confirm, emails it to the supplier with the PDF. The other suppliers' open quotes for the same request are closed as *rejected*. A request can also be rejected or cancelled.

## Purchase orders

Create one directly (*New purchase order*) or from an accepted quotation. Open an order to see what was ordered, received and is still outstanding, and to:
- download the **PDF**;
- **email it to the supplier** (PDF attached; you can change the address, add copies and a message), which also marks it *sent*;
- **receive goods** against it;
- cancel it while nothing has been received.

## Goods received (GRN)

*Receive goods* records a delivery, either against a purchase order (the outstanding quantities are filled in; change them to what actually arrived) or on its own. Enter the supplier invoice number and date, the VAT on the invoice, batch numbers and expiry dates for batch-tracked products, and serial numbers where needed.

Posting a goods received note:
- adds the stock to the warehouse (weighted average cost) and updates product costs;
- adds the invoice to what you owe the supplier, due after their payment terms;
- moves the purchase order to *partially received* or *received*.

Each GRN has a **PDF** (with signature lines for the person receiving and the driver) and can be emailed to the supplier.

## PDFs and email

These documents can be downloaded as A4 PDF and emailed with the PDF attached:

| Document | Where |
|---|---|
| Request for quotation / supplier quotation | Supplier quotations |
| Purchase order | Purchase orders |
| Goods received note | Goods received |
| Quotation, sales order, delivery note (to customers) | Sales → Quotations, Sales orders |
| Invoice / tax invoice for a sale | Sales history → a sale (*Invoice PDF*, *Email invoice*) |

The PDF carries your business name, logo (PNG or JPEG from *Settings*), address, phone, email and KRA PIN, the supplier's or customer's details, the items, totals and (for signed sales) the KRA eTIMS details.

Email needs the email module and an email account (*Settings → Integrations → Email (SMTP)*; see NOTIFICATIONS.md). Emails are queued and retried; the PDF is produced when the email is actually sent, so it always shows the document as it is then. Every email sent is recorded in the notification log and the audit trail.

## Permissions

| Action | Permission |
|---|---|
| See quotations, orders, GRNs and their PDFs | `purchasing.read` |
| Request, record, accept quotations; create, email, cancel orders | `purchasing.manage` |
| Receive goods | `inventory.receive` |
| Email customer quotations / invoices | `quotations.manage` / `sales.read` (cashiers only for their own sales) |

## API

```
GET  /supplier-quotations[?open=true&supplierId=&groupId=]
POST /supplier-quotations            { supplierIds[], warehouseId, lines[{productId, unitCode?, qty}], respondBy?, notes?, send?, message? }
PUT  /supplier-quotations/:id/quote  { lines[{lineId, unitCostCents|null, available, notes?}], validUntil?, supplierRef?, deliveryDays?, supplierNotes? }
GET  /supplier-quotations/compare/:groupId
POST /supplier-quotations/:id/send | accept | reject | cancel
POST /purchase-orders/:id/send       { to?, cc?, message? }   (emails the PDF)
GET  /pdf/:kind/:id                  kind = supplier_quotation | purchase_order | goods_receipt | quotation | invoice
POST /email/:kind/:id                { to?, cc?, message? }
```
