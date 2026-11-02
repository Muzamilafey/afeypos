/**
 * KRA eTIMS: sales and credit notes are signed by KRA (OSCU) or the local VSCU.
 *
 * Checkout never waits for KRA: inside the sale's transaction we reserve the next eTIMS invoice number for
 * the branch's device and queue a durable job. The job submits the invoice and stores the receipt
 * signature; connectivity failures retry with backoff (for days if needed), KRA validation errors stop
 * and are listed for the owner to fix. Receipts print the signature and the KRA QR code once signed.
 */
import { Types } from 'mongoose';
import { Counter, Customer, IntegrationConfig, Job, Product, Sale, SaleReturn, Tenant, User } from '../../models/index.js';
import { runAsPlatform } from '../../lib/context.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { IntegrationError } from '../../integrations/http.js';
import { etimsDate, type EtimsSale, type EtimsSaleLine } from '../../integrations/etims/client.js';
import type { EtrSignature } from '../../integrations/etims/etr.js';
import { FISCAL_OPEN, statusForError, type FiscalSignature, type FiscalStatus } from '../../integrations/fiscal/adapter.js';
import { configsForTill, findActiveConfig } from '../integrations/configs.js';
import { etimsGateway, fiscalAdapter } from './adapters.js';
import { logFiscal, recordHealth, withDeviceLock } from './fiscal.js';

type Cfg = InstanceType<typeof IntegrationConfig>;

export { etimsGateway } from './adapters.js';

/** KRA tax type from the line's VAT rate unless the product overrides it. */
export function taxType(rateBp: number | null | undefined, override?: string | null): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (override && 'ABCDE'.includes(override)) return override as 'A';
  if (rateBp === 1600) return 'B';
  if (rateBp === 800) return 'E';
  return 'C';
}

export const TAX_RATES = { A: 0, B: 16, C: 0, D: 0, E: 8 } as const;

/** KRA item code: origin KE + item type 2 (finished goods) + package unit + quantity unit + 7-digit sequence. */
async function itemCodeFor(product: any, pkg: string, qtyUnit: string) {
  if (product.etims?.itemCd) return product.etims.itemCd as string;
  const c = await Counter.findOneAndUpdate({ key: 'etims:item' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const code = `KE2${pkg}${qtyUnit}${String(c!.seq).padStart(7, '0')}`;
  await Product.updateOne({ _id: product._id }, { $set: { 'etims.itemCd': code } });
  return code;
}

/** KRA unit codes for common base units (U = piece, KG, LTR...). */
const QTY_UNIT: Record<string, string> = { pc: 'U', kg: 'KG', g: 'GRM', l: 'LTR', ml: 'MLT', m: 'MTR', pack: 'PA', ctn: 'CT', case: 'CA', box: 'BX', dozen: 'DZ' };

const r2 = (cents: number) => Math.round(cents) / 100;
const PAYMENT_CODE: Record<string, string> = { cash: '01', credit: '02', bank: '04', card: '05', mpesa: '06', gateway: '06', loyalty: '07', voucher: '07', other: '07' };

export async function etimsConfigForBranch(branchId?: Types.ObjectId | null, tillId?: Types.ObjectId | null) {
  return findActiveConfig('etims', branchId, tillId);
}

/** The ETR devices a till may sign with: its own, then its branch's, then the ones for the whole business. */
export async function etimsDevicesForTill(branchId?: Types.ObjectId | null, tillId?: Types.ObjectId | null) {
  return configsForTill('etims', branchId, tillId);
}

async function nextInvoiceNo(configId: Types.ObjectId) {
  const c = await Counter.findOneAndUpdate({ key: `etims:invoice:${configId}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return c!.seq;
}

/** Called inside the checkout transaction: reserve the eTIMS invoice number and queue the submission. */
export async function queueSaleForEtims(saleId: Types.ObjectId, branchId: Types.ObjectId, caps: { modules: readonly string[] }, opts: { tillId?: Types.ObjectId | null; configId?: Types.ObjectId | null } = {}) {
  if (!caps.modules.includes('etims')) return;
  // The device the till chose, if it may use it; otherwise the till's own, its branch's, or the business's.
  const allowed = await etimsDevicesForTill(branchId, opts.tillId);
  const cfg = (opts.configId && allowed.find((c) => String(c._id) === String(opts.configId))) ?? allowed[0] ?? null;
  if (!cfg) return;
  const invcNo = await nextInvoiceNo(cfg._id);
  await Sale.updateOne({ _id: saleId }, { $set: { etims: { status: 'pending', configId: cfg._id, invcNo, orgInvcNo: 0, attempts: 0, statusChangedAt: new Date() } } });
  await enqueue('etims.submit', { kind: 'sale', id: String(saleId) }, { maxAttempts: 60, dedupeKey: `etims:sale:${saleId}` });
}

/** Called inside the return transaction: a credit note referencing the original invoice. */
export async function queueReturnForEtims(returnId: Types.ObjectId, sale: { _id: Types.ObjectId; branchId: Types.ObjectId; etims?: { invcNo?: number | null; configId?: Types.ObjectId | null } | null }, caps: { modules: readonly string[] }) {
  if (!caps.modules.includes('etims') || !sale.etims?.invcNo) return;
  const cfg = sale.etims.configId ? await IntegrationConfig.findById(sale.etims.configId) : await etimsConfigForBranch(sale.branchId);
  if (!cfg) return;
  const invcNo = await nextInvoiceNo(cfg._id);
  await SaleReturn.updateOne({ _id: returnId }, { $set: { etims: { status: 'pending', configId: cfg._id, invcNo, orgInvcNo: sale.etims.invcNo, attempts: 0, statusChangedAt: new Date() } } });
  await enqueue('etims.submit', { kind: 'return', id: String(returnId) }, { maxAttempts: 60, dedupeKey: `etims:return:${returnId}` });
}

export function etimsQrUrl(cfg: Cfg, rcptSign: string) {
  const host = cfg.environment === 'production' ? 'https://etims.kra.go.ke' : 'https://etims-sbx.kra.go.ke';
  return `${host}/common/link/etims/receipt/indexEtimsReceiptData?Data=${cfg.settings?.tin ?? ''}${cfg.settings?.bhfId ?? '00'}${rcptSign}`;
}

interface LineIn { productId: Types.ObjectId; name?: string | null; qty?: number | null; unitPriceCents?: number | null; discountCents?: number | null; cartDiscountCents?: number | null; totalCents?: number | null; taxCents?: number | null; taxRateBp?: number | null }

async function buildLines(lines: LineIn[]) {
  const products = new Map((await Product.find({ _id: { $in: lines.map((l) => l.productId) } }).lean()).map((p) => [String(p._id), p]));
  const items: EtimsSaleLine[] = [];
  for (const [i, l] of lines.entries()) {
    const p: any = products.get(String(l.productId));
    const qtyUnit = p?.etims?.qtyUnitCd || QTY_UNIT[p?.baseUnit ?? 'pc'] || 'U';
    const pkg = p?.etims?.pkgUnitCd || 'NT';
    const qty = Math.abs(l.qty ?? 0);
    const total = Math.abs(l.totalCents ?? 0);
    const discount = Math.abs((l.discountCents ?? 0) + (l.cartDiscountCents ?? 0));
    const supply = total + discount;
    items.push({
      itemSeq: i + 1, itemCd: p ? await itemCodeFor(p, pkg, qtyUnit) : `KE2NTU${String(i + 1).padStart(7, '0')}`, itemClsCd: p?.etims?.itemClsCd || '99000000',
      itemNm: (l.name ?? p?.name ?? 'Item').slice(0, 200), bcd: p?.barcodes?.[0]?.code ?? null, pkgUnitCd: pkg, pkg: qty, qtyUnitCd: qtyUnit, qty,
      prc: r2(qty ? supply / qty : supply), splyAmt: r2(supply), dcRt: supply ? Math.round((discount / supply) * 10000) / 100 : 0, dcAmt: r2(discount),
      taxTyCd: taxType(l.taxRateBp, p?.etims?.taxTyCd), taxblAmt: r2(total), taxAmt: r2(Math.abs(l.taxCents ?? 0)), totAmt: r2(total),
    });
  }
  return items;
}

function totals(items: EtimsSaleLine[]) {
  const by = { A: [0, 0], B: [0, 0], C: [0, 0], D: [0, 0], E: [0, 0] } as Record<string, [number, number]>;
  for (const it of items) {
    by[it.taxTyCd][0] += it.taxblAmt;
    by[it.taxTyCd][1] += it.taxAmt;
  }
  const f = (n: number) => Math.round(n * 100) / 100;
  const t: Record<string, number> = {};
  for (const k of ['A', 'B', 'C', 'D', 'E']) {
    t[`taxblAmt${k}`] = f(by[k][0]);
    t[`taxAmt${k}`] = f(by[k][1]);
    t[`taxRt${k}`] = TAX_RATES[k as keyof typeof TAX_RATES];
  }
  return { ...t, totTaxblAmt: f(items.reduce((a, i) => a + i.taxblAmt, 0)), totTaxAmt: f(items.reduce((a, i) => a + i.taxAmt, 0)), totAmt: f(items.reduce((a, i) => a + i.totAmt, 0)) } as any;
}

async function header(cashierId: unknown, customerId: unknown) {
  const [cashier, customer, tenant] = await Promise.all([
    cashierId ? User.findById(cashierId, { name: 1 }).lean() : null,
    customerId ? Customer.findById(customerId, { name: 1, kind: 1, phone: 1, taxPin: 1 }).lean() : null,
    runAsPlatform(() => Tenant.findOne({}, { name: 1, contact: 1, settings: 1 }).lean()),
  ]);
  const walkIn = !customer || customer.kind === 'walk_in';
  const custTin = walkIn ? null : ((customer as any).taxPin ?? null);
  return {
    user: { regrId: String(cashierId ?? 'system').slice(0, 20), regrNm: cashier?.name ?? 'POS', modrId: String(cashierId ?? 'system').slice(0, 20), modrNm: cashier?.name ?? 'POS' },
    customer: { custTin, custNm: walkIn ? null : customer!.name },
    receipt: { custTin, custMblNo: walkIn ? null : (customer!.phone ?? null), trdeNm: tenant?.name, adrs: tenant?.contact?.address ?? undefined, topMsg: tenant?.settings?.receiptHeader ?? undefined, btmMsg: tenant?.settings?.receiptFooter ?? undefined, prchrAcptcYn: 'N' as const },
  };
}

async function buildSale(sale: any): Promise<EtimsSale> {
  const items = await buildLines(sale.lines);
  const h = await header(sale.cashierId, sale.customerId);
  const main = [...sale.payments].sort((a: any, b: any) => b.amountCents - a.amountCents)[0];
  const at = sale.completedAt ?? sale.createdAt ?? new Date();
  return {
    invcNo: sale.etims.invcNo, orgInvcNo: 0, trdInvcNo: sale.number, ...h.customer, salesTyCd: 'N', rcptTyCd: 'S', pmtTyCd: PAYMENT_CODE[main?.method] ?? '07', salesSttsCd: '02',
    cfmDt: etimsDate(at), salesDt: etimsDate(at, false), totItemCnt: items.length, ...totals(items), prchrAcptcYn: 'N', remark: null, ...h.user,
    receipt: { ...h.receipt, rptNo: sale.etims.invcNo }, itemList: items,
  };
}

async function buildCreditNote(ret: any): Promise<EtimsSale> {
  const sale = await Sale.findById(ret.saleId).lean();
  const byLine = new Map((sale?.lines ?? []).map((l: any) => [String(l._id), l]));
  const lines = ret.lines.map((l: any) => {
    const orig: any = byLine.get(String(l.lineId)) ?? {};
    return { productId: l.productId, name: l.name, qty: l.qty, totalCents: l.refundCents, taxCents: l.taxCents, taxRateBp: orig.taxRateBp, discountCents: 0, cartDiscountCents: 0 };
  });
  const items = await buildLines(lines);
  const h = await header(ret.processedBy, ret.customerId);
  const at = ret.createdAt ?? new Date();
  return {
    invcNo: ret.etims.invcNo, orgInvcNo: ret.etims.orgInvcNo, trdInvcNo: ret.number, ...h.customer, salesTyCd: 'N', rcptTyCd: 'R',
    pmtTyCd: ret.refundMethod === 'mpesa' ? '06' : ret.refundMethod === 'card' ? '05' : ret.refundMethod === 'account' ? '02' : '01', salesSttsCd: '02',
    cfmDt: etimsDate(at), salesDt: etimsDate(at, false), rfdDt: etimsDate(at), rfdRsnCd: ret.isVoid ? '11' : '05', totItemCnt: items.length, ...totals(items),
    prchrAcptcYn: 'N', remark: (ret.reason ?? '').slice(0, 400) || null, ...h.user, receipt: { ...h.receipt, rptNo: ret.etims.invcNo }, itemList: items,
    // ETR devices refer to the original sale by its receipt and CU invoice numbers.
    ...({ orgTrdInvcNo: sale?.number, orgCuInvoiceNo: sale?.etims?.cuInvoiceNo ?? undefined } as object),
  };
}

/** The fields stored when the device or KRA signed (or a status query found the signature). */
export function signedFields(cfg: Cfg, sig: FiscalSignature, via: 'device' | 'status_query' | 'manual') {
  const etr = cfg.provider === 'etr' ? (sig as EtrSignature) : null;
  return {
    'etims.status': 'signed', 'etims.rcptNo': sig.curRcptNo, 'etims.totRcptNo': sig.totRcptNo, 'etims.intrlData': sig.intrlData, 'etims.rcptSign': sig.rcptSign,
    'etims.sdcId': sig.sdcId ?? cfg.settings?.sdcId, 'etims.mrcNo': sig.mrcNo ?? cfg.settings?.mrcNo, 'etims.sdcDateTime': sig.sdcDateTime, 'etims.signedAt': new Date(),
    'etims.via': via, 'etims.statusChangedAt': new Date(),
    // The ETR device gives its own CU invoice number and QR link; eTIMS receipts link to KRA's eTIMS page.
    ...(etr ? { 'etims.device': 'etr', 'etims.cuInvoiceNo': etr.cuInvoiceNo, 'etims.cuSerial': etr.cuSerial, 'etims.qrUrl': etr.qrUrl ?? '' } : { 'etims.qrUrl': etimsQrUrl(cfg, sig.rcptSign) }),
  };
}

/** Claimable by a worker: on its way, and not being sent by another worker right now. */
const CLAIMABLE: FiscalStatus[] = ['pending', 'awaiting_confirmation', 'device_disconnected', 'processing'];
const LEASE_MS = 150_000;

export function fiscalModel(kind: 'sale' | 'return') {
  return (kind === 'sale' ? Sale : SaleReturn) as unknown as typeof Sale;
}

export async function buildFiscalPayload(kind: 'sale' | 'return', doc: any) {
  return kind === 'sale' ? buildSale(doc) : buildCreditNote(doc);
}

/**
 * Sends one sale or credit note to its fiscal device, exactly once:
 *  1. the document is claimed (status "processing"), so no other worker sends it at the same time;
 *  2. the device's lease is taken, so one shared device handles one invoice at a time;
 *  3. if an earlier send may have reached the device (no answer, or a worker died while sending), the device is
 *     asked first; where it cannot be asked and a resend could duplicate, it goes to reconciliation instead;
 *  4. the outcome is stored on the document and in the fiscal transaction log.
 * The same invoice number is used on every attempt.
 */
registerJob('etims.submit', async ({ kind, id }: { kind: 'sale' | 'return'; id: string }) => {
  const model = fiscalModel(kind);
  const doc: any = await model.findById(id).lean();
  if (!doc?.etims || !FISCAL_OPEN.includes(doc.etims.status)) return;
  const cfg = await IntegrationConfig.findById(doc.etims.configId);
  const ref = { kind, id: doc._id, number: doc.number, invcNo: doc.etims.invcNo, branchId: doc.branchId, attempt: (doc.etims.attempts ?? 0) + 1 };
  if (!cfg) {
    await model.updateOne({ _id: id }, { $set: { 'etims.status': 'failed', 'etims.error': 'eTIMS configuration removed', 'etims.statusChangedAt': new Date() } });
    return;
  }
  const now = new Date();
  const before: any = await model.findOneAndUpdate(
    { _id: id, 'etims.status': { $in: CLAIMABLE }, $or: [{ 'etims.claimUntil': null }, { 'etims.claimUntil': { $lt: now } }] },
    { $set: { 'etims.status': 'processing', 'etims.claimUntil': new Date(now.getTime() + LEASE_MS), 'etims.lastAttemptAt': now } },
    { new: false, projection: { etims: 1 } },
  ).lean();
  // Another worker is sending it right now; its outcome stands (the sweep picks it up if that worker died).
  if (!before) return;
  const prev = before.etims.status as FiscalStatus;
  const adapter = fiscalAdapter(cfg);
  const caps = adapter.getCapabilities();
  const operation = kind === 'sale' ? 'invoice' : 'credit_note';
  const settle = (set: Record<string, unknown>, inc = true) => model.updateOne({ _id: id }, { $set: { 'etims.statusChangedAt': new Date(), ...set }, $unset: { 'etims.claimUntil': 1 }, ...(inc ? { $inc: { 'etims.attempts': 1 } } : {}) });

  let payload: EtimsSale;
  try {
    payload = await buildFiscalPayload(kind, doc);
  } catch (err: any) {
    await settle({ 'etims.status': 'failed', 'etims.error': `Could not prepare the invoice: ${String(err?.message ?? err).slice(0, 250)}` }, false);
    return;
  }

  let entered = false;
  try {
    await withDeviceLock(cfg._id, LEASE_MS, async () => {
      entered = true;
      // Maybe sent before: ask the device first, never send blindly.
      const maybeSent = (prev === 'awaiting_confirmation' || prev === 'processing') && !doc.etims.resendConfirmedBy;
      if (maybeSent) {
        if (caps.transactionStatus) {
          const t0 = Date.now();
          try {
            const answer = await adapter.getTransactionStatus(payload);
            if (answer.found) {
              await settle({ ...signedFields(cfg, answer.signature, 'status_query') }, true);
              await model.updateOne({ _id: id }, { $unset: { 'etims.error': 1 } });
              await logFiscal({ cfg, operation: 'status_query', doc: ref, outcome: 'signed', ok: true, request: { invcNo: payload.invcNo, trdInvcNo: payload.trdInvcNo }, response: answer.signature, durationMs: Date.now() - t0 });
              await recordHealth(cfg._id, true, 'Answered a status query');
              return;
            }
            await logFiscal({ cfg, operation: 'status_query', doc: ref, outcome: 'not_recorded', ok: true, request: { invcNo: payload.invcNo, trdInvcNo: payload.trdInvcNo }, response: answer.raw ?? { found: false }, durationMs: Date.now() - t0 });
          } catch (err: any) {
            const { status } = statusForError(err);
            const next = status === 'rejected' || status === 'pending' ? 'awaiting_confirmation' : status;
            await settle({ 'etims.status': next, 'etims.error': String(err?.message ?? err).slice(0, 300) });
            await logFiscal({ cfg, operation: 'status_query', doc: ref, outcome: next, ok: false, error: String(err?.message ?? err), durationMs: Date.now() - t0 });
            if (next === 'requires_reconciliation') return;
            throw err;
          }
        } else if (!caps.safeResend) {
          // Cannot ask, and sending again could create a second fiscal record: a person decides.
          await settle({ 'etims.status': 'requires_reconciliation', 'etims.error': 'The device may have signed this invoice but its answer was lost, and it cannot be asked. Check the device journal, then record the signature or confirm it was not signed.' }, false);
          await logFiscal({ cfg, operation: 'reconcile', doc: ref, outcome: 'requires_reconciliation', ok: false, error: 'Uncertain send; device has no status query' });
          return;
        }
      }
      const t0 = Date.now();
      try {
        const sig = kind === 'sale' ? await adapter.submitInvoice(payload) : await adapter.submitCreditNote(payload);
        await model.updateOne({ _id: id }, { $set: signedFields(cfg, sig, 'device'), $inc: { 'etims.attempts': 1 }, $unset: { 'etims.error': 1, 'etims.claimUntil': 1, 'etims.resendConfirmedBy': 1 } });
        await logFiscal({ cfg, operation, doc: ref, outcome: 'signed', ok: true, request: payload, response: sig, durationMs: Date.now() - t0 });
        await recordHealth(cfg._id, true, 'Signed an invoice');
      } catch (err: any) {
        const { status, retry } = statusForError(err);
        const message = String(err?.message ?? err).slice(0, 300);
        await settle({ 'etims.status': status, 'etims.error': message });
        await logFiscal({ cfg, operation, doc: ref, outcome: status, ok: false, error: message, request: payload, response: err?.body, durationMs: Date.now() - t0 });
        if (status === 'device_disconnected') await recordHealth(cfg._id, false, message);
        if (retry) throw err; // retried by the job queue with backoff
      }
    });
  } catch (err: any) {
    // Lease not obtained (device busy): give the document back as it was and try again shortly. Anything that
    // went wrong after the lease was taken may have happened after sending, so it is checked before any resend.
    const back = entered || prev === 'processing' ? 'awaiting_confirmation' : prev;
    await model.updateOne({ _id: id, 'etims.status': 'processing' }, { $set: { 'etims.status': back, 'etims.error': String(err?.message ?? err).slice(0, 300) }, $unset: { 'etims.claimUntil': 1 } });
    throw err;
  }
});

/**
 * Safety net, run by the scheduler: invoices whose job was lost or gave up (a device off for days), or whose
 * worker died mid-send, are queued again. The submit job's status check keeps this from sending anything twice.
 */
export async function sweepFiscalQueue(now = new Date()) {
  let queued = 0;
  const bucket = Math.floor(now.getTime() / (10 * 60_000));
  for (const kind of ['sale', 'return'] as const) {
    const model = fiscalModel(kind);
    const open: any[] = await model.find({ 'etims.status': { $in: FISCAL_OPEN }, $or: [{ 'etims.claimUntil': null }, { 'etims.claimUntil': { $lt: now } }] }, { _id: 1, etims: 1 }).limit(500).lean();
    for (const d of open) {
      const active = await Job.exists({ type: 'etims.submit', 'payload.id': String(d._id), status: { $in: ['queued', 'running'] } });
      if (active) continue;
      await enqueue('etims.submit', { kind, id: String(d._id) }, { maxAttempts: 60, dedupeKey: `etims:${kind}:${d._id}:sweep:${bucket}` });
      queued++;
    }
  }
  return queued;
}

/** A device just came back: send what is waiting for it now instead of at the next backoff. */
export async function hurryFiscalQueue() {
  await Job.updateMany({ type: 'etims.submit', status: 'queued' }, { $set: { runAt: new Date() } });
}

/** Registers (or updates) a product as an eTIMS item on every configured device. */
export async function queueItemRegistration(productId: Types.ObjectId, caps: { modules: readonly string[] }) {
  if (!caps.modules.includes('etims')) return;
  if (!(await IntegrationConfig.exists({ kind: 'etims', enabled: true }))) return;
  await enqueue('etims.item', { productId: String(productId) }, { maxAttempts: 30, dedupeKey: `etims:item:${productId}:${Date.now() >> 16}` });
}

registerJob('etims.item', async ({ productId }: { productId: string }) => {
  const p: any = await Product.findById(productId).lean();
  if (!p) return;
  const qtyUnit = p.etims?.qtyUnitCd || QTY_UNIT[p.baseUnit] || 'U';
  const pkg = p.etims?.pkgUnitCd || 'NT';
  const itemCd = await itemCodeFor(p, pkg, qtyUnit);
  // ETR (TIMS) devices do not keep an item list.
  const configs = await IntegrationConfig.find({ kind: 'etims', enabled: true, provider: { $ne: 'etr' } });
  try {
    for (const cfg of configs) {
      await etimsGateway(cfg).saveItem({
        itemCd, itemClsCd: p.etims?.itemClsCd || '99000000', itemTyCd: '2', itemNm: p.name.slice(0, 200), orgnNatCd: 'KE', pkgUnitCd: pkg, qtyUnitCd: qtyUnit,
        taxTyCd: taxType(p.taxRateBp ?? 1600, p.etims?.taxTyCd), bcd: p.barcodes?.[0]?.code ?? null, dftPrc: (p.prices?.retail ?? 0) / 100, isrcAplcbYn: 'N', useYn: p.active ? 'Y' : 'N',
        regrId: 'afeypos', regrNm: 'Afey POS', modrId: 'afeypos', modrNm: 'Afey POS',
      });
    }
    await Product.updateOne({ _id: p._id }, { $set: { 'etims.registeredAt': new Date() }, $unset: { 'etims.error': 1 } });
  } catch (err: any) {
    await Product.updateOne({ _id: p._id }, { $set: { 'etims.error': String(err?.message ?? err).slice(0, 300) } });
    if (!(err instanceof IntegrationError) || err.retryable) throw err;
  }
});
