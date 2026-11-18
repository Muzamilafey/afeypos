import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { JournalEntry, Account } from '../src/models/index.js';
import { runInTenant } from '../src/lib/context.js';
import { Types } from 'mongoose';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let product: any;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'roundco', 'supermarket');
  till = t.locations.tills[0]._id;
  await openShift(t.client, till, 100000);
  // 0.90 each, VAT inclusive 16 %.
  product = await createProduct(t.client, { name: 'Sweet', sku: 'SWT', prices: { retail: 90 }, taxRateBp: 1600, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 100 }] });
});
afterAll(teardown);

const sell = (qty: number, amountCents: number) => t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: product._id, qty }], payments: [{ method: 'cash', amountCents, tenderedCents: amountCents }] });

describe('rounding to the nearest whole shilling', () => {
  it('is off by default: the exact cents are charged', async () => {
    const r = await sell(1, 90);
    expect(r.status).toBe(201);
    expect(r.body.data.totalCents).toBe(90);
    expect(r.body.data.roundingCents ?? 0).toBe(0);
  });

  it('when on, rounds the payable and records the difference, and the books still balance', async () => {
    await t.client.put('/settings/checkout-rules', { rules: { pricing: { roundToWholeShilling: true } } });
    // One sweet at 0.90 rounds up to 1.00 (rounding +0.10).
    const up = await sell(1, 100);
    expect(up.body.data).toMatchObject({ totalCents: 100, roundingCents: 10, netCents: expect.any(Number) });
    // Net + tax stay the un-rounded 0.90.
    expect(up.body.data.netCents + up.body.data.taxCents).toBe(90);
    // Paying the un-rounded amount is now rejected.
    expect((await sell(1, 90)).status).toBe(422);
    // Three sweets = 2.70 rounds down to 3.00? 2.70 -> 3.00 is +0.30; 2.70 nearest whole is 3.00.
    const many = await sell(3, 300);
    expect(many.body.data).toMatchObject({ totalCents: 300, roundingCents: 30 });
    // 5 sweets = 4.50 -> rounds to 5.00 (+0.50, round half up via Math.round).
    const half = await sell(5, 500);
    expect(half.body.data.totalCents).toBe(500);

    // The ledger balances and the rounding account carries the difference.
    await t.client.post('/accounting/post', {});
    await drainJobs();
    const tenantId = new Types.ObjectId(String(t.tenant.id ?? t.tenant._id));
    const roundingCode = (await runInTenant(tenantId, () => Account.findOne({ key: 'rounding' }).lean()))!.code;
    const { balanced, roundingTotal } = await runInTenant(tenantId, async () => {
      const entries = await JournalEntry.find({}).lean();
      let dr = 0; let cr = 0; let rounding = 0;
      for (const e of entries) for (const l of e.lines) { dr += l.debitCents ?? 0; cr += l.creditCents ?? 0; if (l.accountCode === roundingCode) rounding += (l.creditCents ?? 0) - (l.debitCents ?? 0); }
      return { balanced: dr === cr, roundingTotal: rounding };
    });
    expect(balanced).toBe(true);
    // Rounding was credited (extra money kept): +0.10 +0.30 +0.50 = 0.90.
    expect(roundingTotal).toBe(90);
  });
});
