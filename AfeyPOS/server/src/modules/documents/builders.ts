/**
 * Builds the PDF of a business document from the database. Used by the download links and by emails
 * (the PDF is rebuilt when the email is sent, so the notification log only keeps a reference).
 */
import { formatMoney } from '@afeypos/shared';
import { Branch, Customer, GoodsReceipt, PurchaseOrder, Sale, SalesDocument, Supplier, SupplierQuotation, Tenant, Warehouse } from '../../models/index.js';
import { runAsPlatform } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { tenantFilePath } from '../files/routes.js';
import { renderPdf, type PdfDocSpec } from './pdf.js';

export const DOCUMENT_KINDS = ['supplier_quotation', 'purchase_order', 'goods_receipt', 'quotation', 'invoice'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface BuiltDocument {
  buffer: Buffer;
  filename: string;
  title: string;
  number: string;
  /** Who it normally goes to (supplier or customer). */
  recipient: { name: string; email?: string | null };
}

const day = (d?: Date | string | null) => (d ? new Date(d).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const qtyText = (q: number) => String(Math.round((q ?? 0) * 1000) / 1000);

export async function businessOf(tenantId: unknown) {
  const t = await runAsPlatform(() => Tenant.findById(tenantId).lean());
  if (!t) throw notFound('Business');
  const logoPath = t.settings?.logoFileId ? tenantFilePath(String(t._id), t.settings.logoFileId) : null;
  return {
    tenant: t,
    currency: t.settings?.currency ?? 'KES',
    business: { name: t.name, logoPath, lines: [t.contact?.address ?? '', [t.contact?.phone, t.contact?.email].filter(Boolean).join('  |  '), t.settings?.taxPin ? `KRA PIN ${t.settings.taxPin}` : ''] },
  };
}

async function deliverTo(warehouseId: unknown) {
  const w = warehouseId ? await Warehouse.findById(warehouseId).lean() : null;
  const b = w?.branchId ? await Branch.findById(w.branchId).lean() : null;
  return { heading: 'Deliver to', lines: [w?.name ?? '', b?.name && b.name !== w?.name ? b.name : '', (b as any)?.address ?? '', (b as any)?.phone ?? ''] };
}

const supplierLines = (s: any) => [s?.contactPerson ? `Attn: ${s.contactPerson}` : '', s?.address ?? '', [s?.phone, s?.email].filter(Boolean).join('  |  '), s?.taxPin ? `KRA PIN ${s.taxPin}` : ''];

/** What the document shows; rendered as PDF (download, email) or HTML (print). */
export async function buildDocumentSpec(tenantId: unknown, kind: DocumentKind, id: unknown): Promise<{ spec: PdfDocSpec; recipient: BuiltDocument['recipient'] }> {
  const { business, currency, tenant } = await businessOf(tenantId);
  const m = (c: number | null | undefined) => formatMoney(c ?? 0, currency);
  let spec: PdfDocSpec;
  let recipient: BuiltDocument['recipient'];

  if (kind === 'supplier_quotation') {
    const q = await SupplierQuotation.findById(id).lean();
    if (!q) throw notFound('Supplier quotation');
    const s = await Supplier.findById(q.supplierId).lean();
    const quoted = ['quoted', 'accepted', 'rejected'].includes(q.status);
    recipient = { name: s?.name ?? 'Supplier', email: s?.email };
    spec = {
      title: quoted ? 'Supplier quotation' : 'Request for quotation', number: q.number, business,
      meta: [['Date', day(q.sentAt ?? q.createdAt)], ...(q.respondBy ? [['Please reply by', day(q.respondBy)] as [string, string]] : []), ...(q.validUntil ? [['Valid until', day(q.validUntil)] as [string, string]] : []), ...(q.supplierRef ? [['Supplier ref', q.supplierRef] as [string, string]] : [])],
      party: { heading: 'Supplier', name: s?.name ?? '', lines: supplierLines(s) }, party2: await deliverTo(q.warehouseId),
      columns: [{ label: '#', width: 4 }, { label: 'Item', width: 40 }, { label: 'Quantity', width: 14, align: 'right' }, { label: 'Unit price', width: 16, align: 'right' }, { label: 'Amount', width: 16, align: 'right' }],
      rows: q.lines.map((l, i) => [String(i + 1), `${l.name}${l.available === false ? ' (not available)' : ''}${l.notes ? `\n${l.notes}` : ''}`, `${qtyText(l.qty)} ${l.unitCode}`, l.unitCostCents == null ? '' : m(l.unitCostCents), l.unitCostCents == null || l.available === false ? '' : m(Math.round(l.qty * l.unitCostCents))]),
      totals: quoted ? [{ label: 'Total quoted', value: m(q.totalCents), bold: true }, ...(q.deliveryDays != null ? [{ label: 'Delivery', value: `${q.deliveryDays} days` }] : [])] : [],
      notes: [
        q.notes ?? '',
        quoted ? q.supplierNotes ?? '' : `Please send us your best prices, availability and delivery time for the items above${q.respondBy ? ` by ${day(q.respondBy)}` : ''}, quoting our reference ${q.number}.`,
        'Prices should include VAT where it applies.',
      ],
    };
  } else if (kind === 'purchase_order') {
    const po = await PurchaseOrder.findById(id).lean();
    if (!po) throw notFound('Purchase order');
    const s = await Supplier.findById(po.supplierId).lean();
    recipient = { name: s?.name ?? 'Supplier', email: s?.email };
    spec = {
      title: 'Purchase order', number: po.number, business,
      meta: [['Date', day(po.sentAt ?? po.createdAt)], ...(po.expectedAt ? [['Deliver by', day(po.expectedAt)] as [string, string]] : []), ['Payment terms', `${s?.paymentTermsDays ?? 30} days`]],
      party: { heading: 'Supplier', name: s?.name ?? '', lines: supplierLines(s) }, party2: await deliverTo(po.warehouseId),
      columns: [{ label: '#', width: 4 }, { label: 'Item', width: 40 }, { label: 'Quantity', width: 14, align: 'right' }, { label: 'Unit cost', width: 16, align: 'right' }, { label: 'Amount', width: 16, align: 'right' }],
      rows: po.lines.map((l, i) => [String(i + 1), l.name ?? '', `${qtyText(l.qty)} ${l.unitCode}`, m(l.unitCostCents), m(Math.round(l.qty * l.unitCostCents))]),
      totals: [{ label: 'Total', value: m(po.totalCents), bold: true }],
      notes: [po.notes ?? '', `Please quote ${po.number} on your delivery note and invoice.`],
      signatures: ['Authorised by', 'Date'],
    };
  } else if (kind === 'goods_receipt') {
    const g = await GoodsReceipt.findById(id).lean();
    if (!g) throw notFound('Goods receipt');
    const s = g.supplierId ? await Supplier.findById(g.supplierId).lean() : null;
    const po = g.purchaseOrderId ? await PurchaseOrder.findById(g.purchaseOrderId, { number: 1 }).lean() : null;
    recipient = { name: s?.name ?? 'Supplier', email: s?.email };
    spec = {
      title: 'Goods received note', number: g.number, business,
      meta: [['Received', day(g.createdAt)], ...(g.supplierInvoiceNo ? [['Supplier invoice', g.supplierInvoiceNo] as [string, string]] : []), ...(g.invoiceDate ? [['Invoice date', day(g.invoiceDate)] as [string, string]] : []), ...(po ? [['Purchase order', po.number] as [string, string]] : []), ...(g.dueDate ? [['Payment due', day(g.dueDate)] as [string, string]] : [])],
      party: { heading: 'Supplier', name: s?.name ?? 'No supplier (stock received)', lines: s ? supplierLines(s) : [] }, party2: { ...(await deliverTo(g.warehouseId)), heading: 'Received into' },
      columns: [{ label: '#', width: 4 }, { label: 'Item', width: 34 }, { label: 'Batch / expiry', width: 16 }, { label: 'Quantity', width: 13, align: 'right' }, { label: 'Unit cost', width: 15, align: 'right' }, { label: 'Amount', width: 15, align: 'right' }],
      rows: g.lines.map((l, i) => [String(i + 1), `${l.name ?? ''}${l.serials?.length ? `\nS/N ${l.serials.join(', ')}` : ''}`, [l.batchNo, l.expiryDate ? `exp ${day(l.expiryDate)}` : ''].filter(Boolean).join(' '), `${qtyText(l.qty ?? 0)} ${l.unitCode ?? ''}`, m(l.unitCostCents), m(Math.round((l.qty ?? 0) * (l.unitCostCents ?? 0)))]),
      totals: [{ label: 'Subtotal', value: m(g.subtotalCents) }, { label: 'VAT', value: m(g.taxCents) }, { label: 'Total', value: m(g.totalCents), bold: true }],
      notes: [g.notes ?? ''],
      signatures: s ? ['Received by', 'Delivered by (supplier)'] : ['Received by', 'Checked by'],
    };
  } else if (kind === 'quotation') {
    const d = await SalesDocument.findById(id).lean();
    if (!d) throw notFound('Document');
    const c = d.customerId ? await Customer.findById(d.customerId).lean() : null;
    const title = { quotation: 'Quotation', sales_order: 'Sales order', delivery_note: 'Delivery note' }[d.type];
    const prices = d.type !== 'delivery_note';
    recipient = { name: c?.name ?? d.customerName ?? 'Customer', email: c?.email };
    spec = {
      title, number: d.number, business,
      meta: [['Date', day(d.createdAt)], ...(d.validUntil ? [['Valid until', day(d.validUntil)] as [string, string]] : [])],
      party: { heading: d.type === 'delivery_note' ? 'Deliver to' : 'Customer', name: c?.name ?? d.customerName ?? 'Customer', lines: [c?.address ?? d.deliveryAddress ?? '', [c?.phone, c?.email].filter(Boolean).join('  |  '), c?.taxPin ? `KRA PIN ${c.taxPin}` : ''] },
      columns: prices
        ? [{ label: '#', width: 4 }, { label: 'Item', width: 40 }, { label: 'Quantity', width: 14, align: 'right' }, { label: 'Unit price', width: 14, align: 'right' }, { label: 'Discount', width: 12, align: 'right' }, { label: 'Amount', width: 16, align: 'right' }]
        : [{ label: '#', width: 4 }, { label: 'Item', width: 60 }, { label: 'Quantity', width: 18, align: 'right' }, { label: 'Received', width: 18 }],
      rows: d.lines.map((l, i) => (prices
        ? [String(i + 1), `${l.name ?? ''}${l.sku ? `\n${l.sku}` : ''}`, `${qtyText(l.qty ?? 0)} ${l.unitCode ?? ''}`, m(l.unitPriceCents), l.discountCents ? m(l.discountCents) : '', m(l.totalCents)]
        : [String(i + 1), l.name ?? '', `${qtyText(l.qty ?? 0)} ${l.unitCode ?? ''}`, ''])),
      totals: prices ? [{ label: 'Total before VAT', value: m((d.totalCents ?? 0) - (d.taxCents ?? 0)) }, { label: 'VAT', value: m(d.taxCents) }, { label: 'Total', value: m(d.totalCents), bold: true }] : [],
      notes: [d.notes ?? '', d.type === 'quotation' ? `Prices are valid${d.validUntil ? ` until ${day(d.validUntil)}` : ' for 14 days'} and subject to stock availability.` : ''],
      signatures: d.type === 'delivery_note' ? ['Received by', 'Date'] : undefined,
    };
  } else {
    const sale = await Sale.findById(id).lean();
    if (!sale) throw notFound('Sale');
    const c = sale.customerId ? await Customer.findById(sale.customerId).lean() : null;
    const branch = await Branch.findById(sale.branchId).lean();
    const balance = Math.max(0, (sale.totalCents ?? 0) - (sale.paidCents ?? 0) - (sale.refundedCents ?? 0));
    recipient = { name: c?.name ?? 'Customer', email: c?.email };
    const signed = sale.etims?.status === 'signed';
    spec = {
      title: tenant.settings?.taxPin ? 'Tax invoice' : 'Invoice', number: sale.number, business,
      meta: [['Date', day(sale.completedAt)], ...(sale.dueDate ? [['Due date', day(sale.dueDate)] as [string, string]] : []), ...(branch ? [['Branch', branch.name] as [string, string]] : [])],
      party: { heading: 'Bill to', name: c?.name ?? 'Cash customer', lines: c ? [c.address ?? '', [c.phone, c.email].filter(Boolean).join('  |  '), c.taxPin ? `KRA PIN ${c.taxPin}` : ''] : [] },
      party2: signed ? { heading: 'KRA eTIMS', lines: [`Invoice no. ${sale.etims!.invcNo ?? ''}`, `CU ${sale.etims!.sdcId ?? ''}`, `Signature ${sale.etims!.rcptSign ?? ''}`, sale.etims!.sdcDateTime ? `Signed ${sale.etims!.sdcDateTime}` : ''] } : undefined,
      columns: [{ label: '#', width: 4 }, { label: 'Item', width: 38 }, { label: 'Quantity', width: 13, align: 'right' }, { label: 'Unit price', width: 14, align: 'right' }, { label: 'VAT', width: 13, align: 'right' }, { label: 'Amount', width: 18, align: 'right' }],
      rows: sale.lines.map((l, i) => [String(i + 1), `${l.name ?? ''}${l.serials?.length ? `\nS/N ${l.serials.join(', ')}` : ''}`, `${qtyText(l.qty ?? 0)} ${l.unitCode ?? ''}`, m(l.unitPriceCents), m(l.taxCents), m(l.totalCents)]),
      totals: [
        { label: 'Total before VAT', value: m(sale.netCents ?? (sale.totalCents - (sale.taxCents ?? 0))) },
        ...(sale.discountCents ? [{ label: 'Discount', value: m(sale.discountCents) }] : []),
        { label: 'VAT', value: m(sale.taxCents) },
        { label: 'Total', value: m(sale.totalCents), bold: true },
        { label: 'Paid', value: m(sale.paidCents) },
        ...(balance ? [{ label: 'Balance due', value: m(balance), bold: true }] : []),
      ],
      notes: [
        sale.payments?.length ? `Payments: ${sale.payments.filter((p) => p.method !== 'credit').map((p) => `${p.method.toUpperCase()} ${m(p.amountCents)}${p.reference ? ` (${p.reference})` : ''}`).join(', ')}` : '',
        sale.status === 'voided' ? 'This sale was VOIDED.' : '',
        sale.notes ?? '', tenant.settings?.receiptFooter ?? '',
      ],
    };
  }
  return { spec, recipient };
}

export async function buildDocument(tenantId: unknown, kind: DocumentKind, id: unknown): Promise<BuiltDocument> {
  const { spec, recipient } = await buildDocumentSpec(tenantId, kind, id);
  const safe = spec.number.replace(/[^A-Za-z0-9-]/g, '');
  return { buffer: await renderPdf(spec), filename: `${spec.title.replace(/\s+/g, '-')}-${safe}.pdf`, title: spec.title, number: spec.number, recipient };
}
