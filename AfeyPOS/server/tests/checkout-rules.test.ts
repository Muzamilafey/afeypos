import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx, Client } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let cashier: Client;

const approve = async (permission: string) => (await cashier.post('/auth/override', { email: 'rita@rules.test', pin: '9876', permission, tillId: till })).body.overrideToken as string;
const setRules = (rules: object, cardTerminals?: object[]) => t.client.put('/settings/checkout-rules', { rules, cardTerminals });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'rulesco', 'minimart');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await t.client.post('/settings/users', { name: 'Carl Cashier', email: 'carl@rules.test', password: 'Carl12345', roles: ['cashier'], pin: '1234' });
  await t.client.post('/settings/users', { name: 'Rita Manager', email: 'rita@rules.test', password: 'Rita12345', roles: ['branch_manager'], pin: '9876' });
  cashier = new Client(ctx.api, 'rulesco');
  await cashier.login('carl@rules.test', 'Carl12345');
});
afterAll(teardown);

describe('checkout rules', () => {
  it('only the owner changes them, and cashiers get them with their session', async () => {
    expect((await cashier.put('/settings/checkout-rules', { rules: {} })).status).toBe(403);
    const r = await setRules({ items: { removeNeedsApproval: true, clearNeedsApproval: true }, discounts: { lineLimitBp: 500, saleLimitBp: 1000, maxAmountCents: 5000 }, shifts: { minOpeningFloatCents: 100000, blindClose: true, closeNeedsApproval: true }, cashierPages: ['sales', 'shifts'] },
      [{ name: 'Equity PDQ 1', bank: 'Equity', terminalId: 'T001' }]);
    expect(r.status).toBe(200);
    expect(r.body.data.rules).toMatchObject({ items: { removeNeedsApproval: true, holdAllowed: true }, discounts: { lineLimitBp: 500 }, shifts: { blindClose: true, required: true } });
    expect(r.body.data.cardTerminals).toHaveLength(1);
    const me = (await cashier.get('/auth/me')).body;
    expect(me.tenant.checkoutRules.items.removeNeedsApproval).toBe(true);
    // Page access: the cashier's menu keeps Checkout and the allowed pages only.
    const keys = me.navigation.map((n: any) => n.key);
    expect(keys).toEqual(expect.arrayContaining(['pos', 'sales', 'shifts']));
    expect(keys).not.toContain('returns');
    expect(keys).not.toContain('customers');
    expect(me.blockedPaths).toEqual(expect.arrayContaining(['/', '/returns', '/customers']));
    // The owner is not limited by the cashier page list.
    expect((await t.client.get('/auth/me')).body.blockedPaths).toEqual([]);
  });

  it('enforces the opening float and blind shift close with supervisor approval', async () => {
    const low = await cashier.post('/shifts', { tillId: till, openingFloatCents: 50000 });
    expect(low.body.error.code).toBe('FLOAT_TOO_LOW');
    const shift = await openShift(cashier, till, 100000);
    const summary = await cashier.get(`/shifts/${shift._id}/summary`);
    expect(summary.body.data.blind).toBe(true);
    expect(summary.body.data.expectedCashCents).toBeUndefined();
    expect((await t.client.get(`/shifts/${shift._id}/summary`)).body.data.expectedCashCents).toBe(100000);
    const noApproval = await cashier.post(`/shifts/${shift._id}/close`, { countedCashCents: 100000 });
    expect(noApproval.body.error.code).toBe('OVERRIDE_REQUIRED');
    const closed = await cashier.post(`/shifts/${shift._id}/close`, { countedCashCents: 99000, overrideToken: await approve('shifts.manage') });
    expect(closed.status).toBe(200);
    expect(closed.body.data.shift.varianceCents).toBeUndefined();
    await openShift(cashier, till, 100000);
  });

  it('removing scanned items needs a supervisor and is always recorded', async () => {
    const line = { productId: t.locations.tills[0]._id, name: 'Milk', qty: 1, amountCents: 6500 };
    const r = await cashier.post('/pos/item-removals', { tillId: till, kind: 'remove', lines: [line] });
    expect(r.body.error.code).toBe('OVERRIDE_REQUIRED');
    expect(r.body.error.details.permission).toBe('sales.items.remove');
    const ok = await cashier.post('/pos/item-removals', { tillId: till, kind: 'remove', lines: [line], overrideToken: await approve('sales.items.remove') });
    expect(ok.status).toBe(201);
    expect(ok.body.data.approved).toBe(true);
    // Lowering a quantity is free under these rules, but still logged.
    expect((await cashier.post('/pos/item-removals', { tillId: till, kind: 'reduce', lines: [line] })).status).toBe(201);
    const log = (await t.client.get('/audit?action=pos.item_removed')).body.data;
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('limits the discounts a cashier can give', async () => {
    const p = await createProduct(t.client, { prices: { retail: 20000 }, openingStock: [{ warehouseId: wh, qty: 20 }] });
    const sell = (discountCents: number, overrideToken?: string) => cashier.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, discountCents }], payments: [{ method: 'cash', amountCents: 20000 - discountCents }], overrideToken });
    expect((await sell(1000)).status).toBe(201); // 5% on the item: allowed
    const tooMuch = await sell(1500); // 7.5% on one item
    expect(tooMuch.body.error.code).toBe('OVERRIDE_REQUIRED');
    expect(tooMuch.body.error.message).toMatch(/above 5%/);
    expect((await sell(1500, await approve('sales.discount.override'))).status).toBe(201);
    await setRules({ discounts: { allowed: false } });
    expect((await sell(500)).body.error.code).toBe('OVERRIDE_REQUIRED');
    await setRules({ discounts: { allowed: true } });
  });

  it('closes a shift with a note-and-coin count that must add up, and prints the Z report', async () => {
    const current = (await cashier.get(`/shifts/current?tillId=${till}`)).body.data;
    const bad = await cashier.post(`/shifts/${current._id}/close`, { countedCashCents: 150000, denominations: { 'note-1000': 1, 'note-200': 1 }, overrideToken: await approve('shifts.manage') });
    expect(bad.body.error.code).toBe('COUNT_MISMATCH');
    expect((await cashier.post(`/shifts/${current._id}/close`, { countedCashCents: 1000, denominations: { 'note-3': 1 } })).body.error.code).toBe('BAD_COUNT');
    const ok = await cashier.post(`/shifts/${current._id}/close`, { countedCashCents: 125050, denominations: { 'note-1000': 1, 'note-200': 1, 'coin-20': 2, 'coin-10': 1, 'coin-0.5': 1 }, overrideToken: await approve('shifts.manage') });
    expect(ok.status).toBe(200);
    const report = await t.client.get(`/shifts/${current._id}/report`);
    expect(report.text).toContain('Z REPORT');
    expect(report.text).toContain('Closing cash count');
    expect(report.text).toMatch(/Coin Ksh.*0\.50/);
  });
});
