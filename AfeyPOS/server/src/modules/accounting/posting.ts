/**
 * Automatic posting: turns business documents into balanced double-entry journals.
 *
 *  Sale            Dr cash / M-Pesa / card / bank / gateway / receivable (per payment)   Cr Sales (net), VAT output
 *                  Dr COGS  Cr Inventory (weighted-average cost)
 *  Void            reverses the sale journal
 *  Sale return     Dr Sales returns (net), VAT output   Cr refund account (cash, M-Pesa, card, receivable, store credit)
 *                  Dr Inventory  Cr COGS (cost of restocked items)
 *  Goods received  Dr Inventory (net), VAT input   Cr Accounts payable
 *  Supplier return Dr Accounts payable   Cr Inventory
 *  Supplier paid   Dr Accounts payable   Cr cash / M-Pesa / bank
 *  Customer paid   Dr cash / M-Pesa / bank   Cr Accounts receivable
 *  Expense         Dr expense category (net), VAT input   Cr cash / M-Pesa / bank
 *  Stock count, damage, expiry, adjustments: Dr Stock losses / Cr Inventory (or Dr Inventory / Cr Stock gains)
 *  Opening stock and balances: against Opening balances equity
 *  Payroll         Dr Salaries, employer NSSF, levy, NITA   Cr PAYE, NSSF, SHIF, levy, NITA, deductions, advances, net salaries payable
 *  Salary paid     Dr Net salaries payable   Cr M-Pesa / bank / cash;  advances: Dr Staff advances  Cr cash / M-Pesa / bank
 *  Till cash in / out: against Cash in safe / in transit
 *
 * Each journal has a unique source key, and each source document is flagged once posted (a field written
 * without touching updatedAt, so branch sync is unaffected), so posting can run any number of times.
 * Accounting runs on head office (which receives every branch's documents) or a standalone shop.
 */
import { Account, CashMovement, Voucher, Expense, GoodsReceipt, JournalEntry, LedgerEntry, PayrollRun, Payout, SalaryAdvance, Sale, SaleReturn, StockMovement, SupplierReturn, Warehouse } from '../../models/index.js';
import { requireTenantId } from '../../lib/context.js';
import { nextNumber } from '../../lib/numbering.js';
import { badRequest } from '../../lib/errors.js';
import { DEFAULT_CHART, EXPENSE_CODE_END, EXPENSE_CODE_START } from './chart.js';

export interface Line { accountCode: string; debitCents?: number; creditCents?: number; branchId?: unknown; partyType?: string; partyId?: unknown; memo?: string }

const FLAG = '_acct';
const METHOD_KEY: Record<string, string> = { cash: 'cash', mpesa: 'mpesa', card: 'card', bank: 'bank', cheque: 'bank', gateway: 'gateway', credit: 'ar', loyalty: 'loyalty', voucher: 'vouchers', other: 'cash', account: 'ar', credit_note: 'store_credit' };

export async function ensureChart() {
  const existing = new Set((await Account.find({}, { code: 1 }).lean()).map((a) => a.code));
  const missing = DEFAULT_CHART.filter((a) => !existing.has(a.code));
  if (missing.length) await Account.insertMany(missing, { ordered: false }).catch((e) => { if (e?.code !== 11000 && !e?.writeErrors) throw e; });
}

export class Codes {
  private map = new Map<string, string>();
  async load() {
    for (const a of await Account.find({ key: { $type: 'string' } }, { key: 1, code: 1 }).lean()) this.map.set(a.key!, a.code);
    return this;
  }
  of(key: string) {
    const c = this.map.get(key);
    if (!c) throw new Error(`Account for ${key} is missing; restore the chart of accounts`);
    return c;
  }
  method(m: string | null | undefined) {
    return this.of(METHOD_KEY[m ?? 'cash'] ?? 'cash');
  }
  async expense(category: string) {
    const key = `expense:${category.trim().toLowerCase()}`;
    const found = this.map.get(key);
    if (found) return found;
    const used = new Set((await Account.find({}, { code: 1 }).lean()).map((a) => Number(a.code)));
    let code = EXPENSE_CODE_START;
    while (used.has(code) && code < EXPENSE_CODE_END) code += 1;
    const a = await Account.findOneAndUpdate({ key }, { $setOnInsert: { code: String(code), name: category.trim(), type: 'expense', subtype: 'operating_expense', key } }, { upsert: true, new: true });
    this.map.set(key, a!.code);
    return a!.code;
  }
}

/** Creates a balanced journal once per source key. Zero lines are dropped; a sub-shilling difference goes to rounding. */
export async function postJournal(codes: Codes | null, j: { key?: string; date: Date; memo: string; source?: { type: string; id?: unknown; number?: string }; branchId?: unknown; lines: Line[]; manual?: boolean; createdBy?: unknown; reversalOf?: unknown }) {
  const lines = j.lines
    .map((l) => ({ ...l, debitCents: Math.round(l.debitCents ?? 0), creditCents: Math.round(l.creditCents ?? 0) }))
    .map((l) => (l.debitCents < 0 || l.creditCents < 0 ? { ...l, debitCents: Math.max(0, l.debitCents) + Math.max(0, -l.creditCents), creditCents: Math.max(0, l.creditCents) + Math.max(0, -l.debitCents) } : l))
    .filter((l) => l.debitCents > 0 || l.creditCents > 0);
  if (!lines.length) return null;
  const dr = lines.reduce((s, l) => s + l.debitCents, 0);
  const cr = lines.reduce((s, l) => s + l.creditCents, 0);
  if (dr !== cr) {
    if (!codes || j.manual) throw badRequest(`Journal does not balance (debits ${dr / 100}, credits ${cr / 100})`);
    lines.push({ accountCode: codes.of('rounding'), debitCents: cr > dr ? cr - dr : 0, creditCents: dr > cr ? dr - cr : 0, memo: 'Difference' } as any);
  }
  if (j.key && (await JournalEntry.exists({ sourceKey: j.key }))) return null;
  try {
    const [e] = await JournalEntry.create([{ number: await nextNumber('journal', 'JE'), date: j.date, memo: j.memo, source: j.source, sourceKey: j.key, branchId: j.branchId, lines, totalCents: Math.max(dr, cr), manual: Boolean(j.manual), createdBy: j.createdBy, reversalOf: j.reversalOf }]);
    return e;
  } catch (err: any) {
    if (err?.code === 11000 && err?.keyPattern?.sourceKey) return null;
    throw err;
  }
}

// ---------- per-document rules ----------

function saleLines(c: Codes, s: any): Line[] {
  const b = s.branchId;
  const lines: Line[] = (s.payments ?? []).map((p: any) => ({ accountCode: c.method(p.method), debitCents: p.amountCents, branchId: b, ...(p.method === 'credit' && s.customerId ? { partyType: 'customer', partyId: s.customerId } : {}) }));
  if (s.creditCents && !(s.payments ?? []).some((p: any) => p.method === 'credit')) lines.push({ accountCode: c.of('ar'), debitCents: s.creditCents, branchId: b, partyType: 'customer', partyId: s.customerId });
  lines.push({ accountCode: c.of('sales'), creditCents: s.netCents ?? (s.totalCents - (s.taxCents ?? 0)), branchId: b });
  lines.push({ accountCode: c.of('vat_output'), creditCents: s.taxCents ?? 0, branchId: b });
  lines.push({ accountCode: c.of('cogs'), debitCents: s.costCents ?? 0, branchId: b });
  lines.push({ accountCode: c.of('inventory'), creditCents: s.costCents ?? 0, branchId: b });
  return lines;
}

async function postSale(c: Codes, s: any) {
  await postJournal(c, { key: `sale:${s._id}`, date: s.completedAt ?? s.createdAt, memo: `Sale ${s.number}`, source: { type: 'Sale', id: s._id, number: s.number }, branchId: s.branchId, lines: saleLines(c, s) });
  if (s.status === 'voided') {
    const reversed = saleLines(c, s).map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents }));
    await postJournal(c, { key: `sale-void:${s._id}`, date: s.voidedAt ?? new Date(), memo: `Void of sale ${s.number}`, source: { type: 'Sale', id: s._id, number: s.number }, branchId: s.branchId, lines: reversed });
  }
}

async function postReturn(c: Codes, r: any) {
  if (r.isVoid) return; // the void reverses the whole sale
  const b = r.branchId;
  const net = (r.lines ?? []).reduce((a: number, l: any) => a + (l.netCents ?? 0), 0);
  const tax = (r.lines ?? []).reduce((a: number, l: any) => a + (l.taxCents ?? 0), 0);
  const cost = (r.lines ?? []).reduce((a: number, l: any) => a + (l.costCents ?? 0), 0);
  await postJournal(c, {
    key: `return:${r._id}`, date: r.createdAt, memo: `Return ${r.number}`, source: { type: 'SaleReturn', id: r._id, number: r.number }, branchId: b,
    lines: [
      { accountCode: c.of('returns'), debitCents: net, branchId: b },
      { accountCode: c.of('vat_output'), debitCents: tax, branchId: b },
      { accountCode: c.method(r.refundMethod), creditCents: r.refundCents, branchId: b, ...(r.refundMethod === 'account' ? { partyType: 'customer', partyId: r.customerId } : {}) },
      { accountCode: c.of('inventory'), debitCents: cost, branchId: b },
      { accountCode: c.of('cogs'), creditCents: cost, branchId: b },
    ],
  });
}

const branchOfWarehouse = new Map<string, unknown>();
async function warehouseBranch(id: unknown) {
  const k = String(id);
  if (!branchOfWarehouse.has(k)) branchOfWarehouse.set(k, (await Warehouse.findById(id, { branchId: 1 }).lean())?.branchId);
  return branchOfWarehouse.get(k);
}

async function postGrn(c: Codes, g: any) {
  const b = await warehouseBranch(g.warehouseId);
  const total = g.totalCents ?? 0;
  const tax = g.taxCents ?? 0;
  await postJournal(c, {
    key: `grn:${g._id}`, date: g.invoiceDate ?? g.createdAt, memo: `Goods received ${g.number}${g.supplierInvoiceNo ? ` (invoice ${g.supplierInvoiceNo})` : ''}`, source: { type: 'GoodsReceipt', id: g._id, number: g.number }, branchId: b,
    lines: [
      { accountCode: c.of('inventory'), debitCents: total - tax, branchId: b },
      { accountCode: c.of('vat_input'), debitCents: tax, branchId: b },
      { accountCode: c.of('ap'), creditCents: total, branchId: b, partyType: 'supplier', partyId: g.supplierId },
    ],
  });
}

async function postSupplierReturn(c: Codes, r: any) {
  const b = await warehouseBranch(r.warehouseId);
  await postJournal(c, {
    key: `supplier-return:${r._id}`, date: r.createdAt, memo: `Return to supplier ${r.number}`, source: { type: 'SupplierReturn', id: r._id, number: r.number }, branchId: b,
    lines: [{ accountCode: c.of('ap'), debitCents: r.totalCents, partyType: 'supplier', partyId: r.supplierId, branchId: b }, { accountCode: c.of('inventory'), creditCents: r.totalCents, branchId: b }],
  });
}

async function postLedger(c: Codes, e: any) {
  const amt = Math.abs(e.amountCents);
  const src = { type: e.ref?.type ?? 'LedgerEntry', id: e.ref?.id ?? e._id, number: e.ref?.number };
  const party = { partyType: e.partyType, partyId: e.partyId };
  let lines: Line[] | null = null;
  let memo = '';
  if (e.partyType === 'customer') {
    if (e.kind === 'payment') {
      memo = `Customer payment ${src.number ?? ''}`;
      lines = [{ accountCode: c.method(e.method), debitCents: amt }, { accountCode: c.of('ar'), creditCents: amt, ...party }];
    } else if (e.kind === 'opening') {
      memo = 'Customer opening balance';
      lines = e.amountCents >= 0 ? [{ accountCode: c.of('ar'), debitCents: amt, ...party }, { accountCode: c.of('opening'), creditCents: amt }] : [{ accountCode: c.of('opening'), debitCents: amt }, { accountCode: c.of('ar'), creditCents: amt, ...party }];
    } else if (e.kind === 'adjustment' && e.ref?.type !== 'SaleVoid') {
      memo = `Customer balance adjustment${e.notes ? `: ${e.notes}` : ''}`;
      lines = e.amountCents >= 0 ? [{ accountCode: c.of('ar'), debitCents: amt, ...party }, { accountCode: c.of('other_income'), creditCents: amt }] : [{ accountCode: c.of('bad_debts'), debitCents: amt }, { accountCode: c.of('ar'), creditCents: amt, ...party }];
    }
  } else if (e.partyType === 'supplier') {
    if (e.kind === 'payment') {
      memo = `Supplier payment ${src.number ?? ''}`;
      lines = [{ accountCode: c.of('ap'), debitCents: amt, ...party }, { accountCode: c.method(e.method), creditCents: amt }];
    } else if (e.kind === 'opening') {
      memo = 'Supplier opening balance';
      lines = e.amountCents >= 0 ? [{ accountCode: c.of('opening'), debitCents: amt }, { accountCode: c.of('ap'), creditCents: amt, ...party }] : [{ accountCode: c.of('ap'), debitCents: amt, ...party }, { accountCode: c.of('opening'), creditCents: amt }];
    }
  }
  if (lines) await postJournal(c, { key: `ledger:${e._id}`, date: e.at ?? e.createdAt, memo: memo.trim(), source: src, lines });
}

async function postExpense(c: Codes, x: any) {
  const tax = x.taxCents ?? 0;
  await postJournal(c, {
    key: `expense:${x._id}`, date: x.date ?? x.createdAt, memo: `Expense ${x.number}: ${x.category}${x.payee ? ` (${x.payee})` : ''}`, source: { type: 'Expense', id: x._id, number: x.number }, branchId: x.branchId,
    lines: [
      { accountCode: await c.expense(x.category), debitCents: x.amountCents - tax, branchId: x.branchId },
      { accountCode: c.of('vat_input'), debitCents: tax, branchId: x.branchId },
      { accountCode: c.method(x.method), creditCents: x.amountCents, branchId: x.branchId },
    ],
  });
}

export const STOCK_TYPES = ['opening', 'adjustment', 'damage', 'wastage', 'expiry', 'stocktake'];
async function postStockMovement(c: Codes, m: any) {
  const value = Math.round((m.qty ?? 0) * (m.unitCostCents ?? 0));
  if (!value) return;
  const b = await warehouseBranch(m.warehouseId);
  const other = m.type === 'opening' ? c.of('opening') : value > 0 ? c.of('stock_gains') : c.of('stock_losses');
  const abs = Math.abs(value);
  await postJournal(c, {
    key: `stock:${m._id}`, date: m.at ?? m.createdAt, memo: `Stock ${m.type}${m.reason ? `: ${m.reason}` : ''}${m.ref?.number ? ` (${m.ref.number})` : ''}`, source: { type: 'StockMovement', id: m._id, number: m.ref?.number }, branchId: b,
    lines: value > 0 ? [{ accountCode: c.of('inventory'), debitCents: abs, branchId: b }, { accountCode: other, creditCents: abs, branchId: b }] : [{ accountCode: other, debitCents: abs, branchId: b }, { accountCode: c.of('inventory'), creditCents: abs, branchId: b }],
  });
}

async function postCashMovement(c: Codes, m: any) {
  if (m.type !== 'cash_in' && m.type !== 'cash_out') return;
  const amt = Math.abs(m.amountCents);
  const inn = m.type === 'cash_in';
  // Cash taken for a gift voucher is owed to the holder until the voucher is spent.
  const other = inn && m.ref?.type === 'Voucher' ? c.of('vouchers') : c.of('cash_transit');
  await postJournal(c, {
    key: `cash:${m._id}`, date: m.at ?? m.createdAt, memo: `Till ${inn ? 'cash in' : 'cash out'}${m.reason ? `: ${m.reason}` : ''}`, source: { type: 'CashMovement', id: m._id },
    lines: inn ? [{ accountCode: c.of('cash'), debitCents: amt }, { accountCode: other, creditCents: amt }] : [{ accountCode: c.of('cash_transit'), debitCents: amt }, { accountCode: c.of('cash'), creditCents: amt }],
  });
}

/**
 * Issued gift vouchers become a liability. Sold for M-Pesa, card or bank: that account is debited (cash sales
 * are posted with their till cash movement). Given away as a promotion or goodwill: a marketing expense.
 */
async function postVoucher(c: Codes, v: any) {
  if (v.source === 'sold' && (!v.payment?.method || v.payment.method === 'cash')) return;
  const debit = v.source === 'sold' ? c.method(v.payment.method) : await c.expense('Promotional vouchers');
  await postJournal(c, {
    key: `voucher:${v._id}`, date: v.createdAt, memo: `Gift voucher ${v.code} (${v.source})`, source: { type: 'Voucher', id: v._id, number: v.code },
    lines: [{ accountCode: debit, debitCents: v.initialCents }, { accountCode: c.of('vouchers'), creditCents: v.initialCents }],
  });
}

async function postPayroll(c: Codes, r: any) {
  const t = r.totals ?? {};
  const pension = (r.lines ?? []).reduce((s: number, l: any) => s + (l.pensionCents ?? 0), 0);
  await postJournal(c, {
    key: `payroll:${r._id}`, date: r.periodEnd ?? r.approvedAt ?? r.createdAt, memo: `Payroll ${r.number} (${r.period})`, source: { type: 'PayrollRun', id: r._id, number: r.number }, branchId: r.branchId,
    lines: [
      { accountCode: c.of('salaries'), debitCents: t.grossCents },
      { accountCode: c.of('nssf_employer'), debitCents: t.nssfEmployerCents },
      { accountCode: c.of('ahl_employer'), debitCents: t.ahlEmployerCents },
      { accountCode: c.of('nita_expense'), debitCents: t.nitaCents },
      { accountCode: c.of('paye'), creditCents: t.payeCents },
      { accountCode: c.of('nssf'), creditCents: (t.nssfCents ?? 0) + (t.nssfEmployerCents ?? 0) },
      { accountCode: c.of('shif'), creditCents: t.shifCents },
      { accountCode: c.of('ahl'), creditCents: (t.ahlCents ?? 0) + (t.ahlEmployerCents ?? 0) },
      { accountCode: c.of('nita'), creditCents: t.nitaCents },
      { accountCode: c.of('pension'), creditCents: pension },
      { accountCode: c.of('payroll_deductions'), creditCents: t.deductionsCents },
      { accountCode: c.of('advances'), creditCents: t.advanceRecoveryCents },
      { accountCode: c.of('salaries_payable'), creditCents: t.netCents },
    ],
  });
}

async function postPayrollPayments(c: Codes, r: any) {
  const payouts = new Map((await Payout.find({ _id: { $in: (r.lines ?? []).map((l: any) => l.payoutId).filter(Boolean) } }, { amountCents: 1, completedAt: 1 }).lean()).map((p) => [String(p._id), p]));
  for (const l of r.lines ?? []) {
    if (!l.paid) continue;
    const p = l.payoutId ? payouts.get(String(l.payoutId)) : null;
    // M-Pesa pays whole shillings; cents stay owed in net salaries payable.
    const amt = p ? p.amountCents : l.netCents;
    await postJournal(c, {
      key: `salary:${r._id}:${l._id}`, date: p?.completedAt ?? r.paidAt ?? new Date(), memo: `Salary ${r.period}: ${l.name}`, source: { type: 'PayrollRun', id: r._id, number: r.number },
      lines: [{ accountCode: c.of('salaries_payable'), debitCents: amt }, { accountCode: c.method(l.payMethod), creditCents: amt }],
    });
  }
}

async function postAdvance(c: Codes, a: any) {
  await postJournal(c, {
    key: `advance:${a._id}`, date: a.paidAt ?? a.updatedAt, memo: `Salary advance ${a.number}`, source: { type: 'SalaryAdvance', id: a._id, number: a.number },
    lines: [{ accountCode: c.of('advances'), debitCents: a.amountCents }, { accountCode: c.method(a.payMethod), creditCents: a.amountCents }],
  });
}

// ---------- the sweep ----------

interface SourceDef { model: { collection: any }; filter: () => Record<string, unknown>; post: (c: Codes, doc: any) => Promise<void>; flag?: (doc: any) => string }

const SOURCES: Record<string, SourceDef> = {
  sales: {
    model: Sale,
    filter: () => ({ $or: [{ [FLAG]: null }, { status: 'voided', [FLAG]: { $ne: 'void' } }] }),
    post: postSale,
    flag: (d) => (d.status === 'voided' ? 'void' : 'done'),
  },
  returns: { model: SaleReturn, filter: () => ({ [FLAG]: null }), post: postReturn },
  grns: { model: GoodsReceipt, filter: () => ({ [FLAG]: null }), post: postGrn },
  supplierReturns: { model: SupplierReturn, filter: () => ({ [FLAG]: null }), post: postSupplierReturn },
  ledger: { model: LedgerEntry, filter: () => ({ [FLAG]: null }), post: postLedger },
  expenses: { model: Expense, filter: () => ({ [FLAG]: null }), post: postExpense },
  stock: { model: StockMovement, filter: () => ({ [FLAG]: null, type: { $in: STOCK_TYPES } }), post: postStockMovement },
  vouchers: { model: Voucher, filter: () => ({ [FLAG]: null }), post: postVoucher },
  cash: { model: CashMovement, filter: () => ({ [FLAG]: null, type: { $in: ['cash_in', 'cash_out'] } }), post: postCashMovement },
  payroll: { model: PayrollRun, filter: () => ({ [FLAG]: null, status: { $in: ['approved', 'paid'] } }), post: postPayroll },
  advances: { model: SalaryAdvance, filter: () => ({ [FLAG]: null, status: { $in: ['paid', 'settled'] } }), post: postAdvance },
};

const indexed = new Set<string>();
let running: Promise<Record<string, number>> | null = null;

/** Posts everything not yet in the ledger. Safe to call often (reports call it first); concurrent calls share one run. */
export function postPending(): Promise<Record<string, number>> {
  if (running) return running;
  running = (async () => {
    const tenantId = requireTenantId();
    await ensureChart();
    const codes = await new Codes().load();
    const counts: Record<string, number> = {};
    for (const [name, s] of Object.entries(SOURCES)) {
      const coll = s.model.collection;
      if (!indexed.has(name)) {
        await coll.createIndex({ tenantId: 1, [FLAG]: 1 }).catch(() => undefined);
        indexed.add(name);
      }
      counts[name] = 0;
      for (let round = 0; round < 200; round++) {
        const docs = await coll.find({ tenantId, ...s.filter() }).sort({ _id: 1 }).limit(500).toArray();
        if (!docs.length) break;
        for (const d of docs) {
          await s.post(codes, d);
          await coll.updateOne({ _id: d._id }, { $set: { [FLAG]: s.flag ? s.flag(d) : 'done' } });
          counts[name] += 1;
        }
        if (docs.length < 500) break;
      }
    }
    // Salary payments: payslips are marked paid after approval.
    for (const r of await PayrollRun.find({ status: { $in: ['approved', 'paid'] }, 'lines.paid': true, updatedAt: { $gte: new Date(Date.now() - 400 * 86400_000) } }).lean()) await postPayrollPayments(codes, r);
    return counts;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Forgets what has been posted so everything is posted again (after restoring the chart, or for a fresh ledger). */
export async function resetPostingFlags() {
  const tenantId = requireTenantId();
  for (const s of Object.values(SOURCES)) await s.model.collection.updateMany({ tenantId, [FLAG]: { $exists: true } }, { $unset: { [FLAG]: 1 } });
}

