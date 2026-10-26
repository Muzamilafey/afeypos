import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, type Ctx } from './helpers.js';
import { AuditLog, PaymentTerminal, TerminalTransaction } from '../src/models/index.js';
import { runInTenant } from '../src/lib/context.js';
import { signSimulatedNotification } from '../src/modules/terminals/simulator.js';
import { openTerminalSecrets } from '../src/modules/terminals/service.js';

/**
 * Bank card terminals, end to end against the simulated terminal (test-only; never real money).
 * Real providers need certification with real hardware: see docs/CARD-TERMINALS.md.
 */
let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let A: { branch: string; wh: string; till: string };
let B: { branch: string; till: string };
let cashier: Client;
let manager: Client;
let product: any;
let terminalId: string;

async function user(email: string, data: Record<string, unknown>) {
  const r = await t.client.post('/settings/users', { name: email.split('@')[0], email, password: 'Passw0rd!x', ...data });
  if (r.status !== 201) throw new Error(`user ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  const c = new Client(ctx.api, 'cards');
  await c.login(email, 'Passw0rd!x');
  return c;
}

const T = (path = '') => `/payment-terminals${path}`;
const start = (amountCents: number, c: Client = cashier, extra: Record<string, unknown> = {}) => c.post(T('/transactions'), { terminalId, tillId: A.till, amountCents, clientRequestId: rid(), ...extra });
const refresh = (id: string, c: Client = cashier) => c.get(T(`/transactions/${id}?refresh=1`));
const sim = (flags: Record<string, boolean>) => t.client.post(T(`/${terminalId}/simulator`), flags);
const sell = (amountCents: number, payments: unknown[]) => cashier.post('/sales', { clientRequestId: rid(), tillId: A.till, lines: [{ productId: product._id, qty: 1, unitPriceCents: undefined }], payments, ...(amountCents ? {} : {}) });

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'cards', 'supermarket');
  A = { branch: t.locations.branches[0]._id, wh: t.locations.warehouses[0]._id, till: t.locations.tills[0]._id };
  const b = (await t.client.post('/settings/branches', { name: 'Westlands', code: 'WL' })).body.data;
  const till = (await t.client.post('/settings/tills', { branchId: b.branch._id, warehouseId: b.warehouse._id, name: 'WL till', code: 'WL1' })).body.data;
  B = { branch: b.branch._id, till: till._id };
  product = await createProduct(t.client, { name: 'Rice 2kg', sku: 'RICE2', prices: { retail: 25000 }, costCents: 18000, openingStock: [{ warehouseId: A.wh, qty: 100 }] });
  cashier = await user('cathy@cards.test', { roles: ['cashier'] });
  manager = await user('manny@cards.test', { roles: ['branch_manager'] });
  await openShift(cashier, A.till);
});
afterAll(teardown);

describe('onboarding a terminal (Settings → Payments → Bank card terminals)', () => {
  it('lists providers honestly: Equity needs provider access, nexo is not supported, the simulator is sandbox only', async () => {
    const r = await t.client.get(T('/providers'));
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.map((p: any) => [p.key, p]));
    expect(by.equity.availability).toBe('provider_access_required');
    expect(by.equity.connections).toEqual([]);
    expect(by.equity.accessSteps.length).toBeGreaterThan(2);
    expect(by.nexo.availability).toBe('not_supported');
    expect(by.simulator.availability).toBe('sandbox');
    expect(by.simulator.connections).toEqual(['cloud']);
    expect((await cashier.get(T('/providers'))).status).toBe(403);
  });

  it('refuses providers and connection methods that do not work', async () => {
    const eq = await t.client.post(T(), { name: 'Equity PDQ', provider: 'equity', connection: 'lan', branchId: A.branch });
    expect(eq.status).toBe(422);
    expect(eq.body.error.code).toBe('TERMINAL_PROVIDER_ACCESS_REQUIRED');
    const lan = await t.client.post(T(), { name: 'Sim', provider: 'simulator', connection: 'lan', branchId: A.branch });
    expect(lan.body.error.code).toBe('TERMINAL_CONNECTION_NOT_SUPPORTED');
    expect((await cashier.post(T(), { name: 'Sim', provider: 'simulator', connection: 'cloud', branchId: A.branch })).status).toBe(403);
  });

  it('walks discovery, pairing, connectivity, tills and a test payment before it can be enabled', async () => {
    const c = await t.client.post(T(), { name: 'Till 1 terminal', provider: 'simulator', connection: 'cloud', branchId: A.branch });
    expect(c.status).toBe(201);
    terminalId = c.body.data.id;
    const early = await t.client.post(T(`/${terminalId}/enable`));
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('TERMINAL_CHECKS_INCOMPLETE');

    const found = await t.client.get(T(`/${terminalId}/discover`));
    expect(found.body.data).toHaveLength(1);
    const reg = await t.client.post(T(`/${terminalId}/register`), { deviceId: found.body.data[0].deviceId });
    expect(reg.status).toBe(200);
    const code = /PAIRING CODE\n(\d{6})/.exec(reg.body.simulatedScreen)![1];

    const wrong = await t.client.post(T(`/${terminalId}/pair`), { pairingCode: code === '111111' ? '222222' : '111111' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('TERMINAL_PAIRING_REJECTED');
    const pair = await t.client.post(T(`/${terminalId}/pair`), { pairingCode: code });
    expect(pair.status).toBe(200);
    expect(pair.body.data.status).toBe('paired');

    const check = await t.client.post(T(`/${terminalId}/check`));
    expect(check.body.data.checks.connectivity.ok).toBe(true);
    expect((await t.client.put(T(`/${terminalId}/tills`), { tillIds: [B.till] })).status).toBe(400); // another branch's till
    expect((await t.client.put(T(`/${terminalId}/tills`), { tillIds: [A.till] })).body.data.checks.tills.ok).toBe(true);

    const test = await t.client.post(T(`/${terminalId}/test`), { clientRequestId: rid() });
    expect(test.status).toBe(201);
    expect(test.body.data).toMatchObject({ kind: 'test', status: 'approved', verified: true, sandbox: true });
    const enable = await t.client.post(T(`/${terminalId}/enable`));
    expect(enable.status).toBe(200);
    expect(enable.body.data.status).toBe('enabled');
    expect(enable.body.data.mode).toBe('sandbox');

    // Credentials stay on the server, encrypted.
    const view = JSON.stringify((await t.client.get(T(`/${terminalId}`))).body);
    expect(view).not.toMatch(/secret|pairingKey/i);
    const stored = await runInTenant(t.tenant.id, () => PaymentTerminal.findById(terminalId).select('+secretsEnc').lean());
    expect(stored!.secretsEnc).toBeTruthy();
    expect(stored!.secretsEnc).not.toContain(openTerminalSecrets(stored as any).pairingKey);
  });

  it('the till sees only its enabled terminals', async () => {
    expect((await cashier.get(T(`/for-till/${A.till}`))).body.data.map((x: any) => x.id)).toEqual([terminalId]);
    expect((await t.client.get(T(`/for-till/${B.till}`))).body.data).toEqual([]);
  });
});

describe('card payments at checkout', () => {
  it('successful payment: approved by the terminal status check, then linked to exactly one sale', async () => {
    const s = await start(25000);
    expect(s.status).toBe(201);
    expect(s.body.data).toMatchObject({ status: 'approved', verified: true, sandbox: true, last4: '1111', cardScheme: 'Visa', removeCard: true });
    expect(s.body.data.events.map((e: any) => e.source)).toContain('query'); // approval came from the status query
    const sale = await sell(25000, [{ method: 'card', amountCents: 25000, terminalTransactionId: s.body.data.id }]);
    expect(sale.status).toBe(201);
    expect(sale.body.data.payments[0]).toMatchObject({ method: 'card', sandbox: true, provider: 'simulator' });
    expect(sale.body.data.payments[0].reference).toMatch(/^SIMULATED – NOT A REAL PAYMENT · Visa · \*\*\*\*1111 · AUTH /);
    const again = await sell(25000, [{ method: 'card', amountCents: 25000, terminalTransactionId: s.body.data.id }]);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('CARD_PAYMENT_NOT_AVAILABLE');
    const linked = (await refresh(s.body.data.id)).body.data;
    expect(linked.saleNumber).toBe(sale.body.data.number);
  });

  it('declined and cancelled payments cannot pay a sale and free the terminal', async () => {
    const d = await start(25051);
    expect(d.body.data.status).toBe('declined');
    expect((await sell(0, [{ method: 'card', amountCents: 25051, terminalTransactionId: d.body.data.id }])).status).toBe(422);
    const c = await start(25052);
    expect(c.body.data.status).toBe('cancelled');
    expect((await start(25000)).body.data.status).toBe('approved'); // terminal free again
  });

  it('a duplicate payment request returns the same transaction (no second charge)', async () => {
    const id = rid();
    const a = await start(25000, cashier, { clientRequestId: id });
    const b = await start(25000, cashier, { clientRequestId: id });
    expect(b.status).toBe(200);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect((await start(9900, cashier, { clientRequestId: id })).status).toBe(409);
    const n = await runInTenant(t.tenant.id, () => TerminalTransaction.countDocuments({ clientRequestId: id }));
    expect(n).toBe(1);
  });

  it('a duplicate response or notification changes nothing', async () => {
    const a = (await start(25000)).body.data;
    const events = a.events.length;
    const again = (await refresh(a.id)).body.data;
    expect(again.status).toBe('approved');
    expect(again.events.length).toBe(events);
    const stored = await runInTenant(t.tenant.id, () => PaymentTerminal.findById(terminalId).select('+secretsEnc').lean());
    const body = JSON.stringify({ reference: a.reference, status: 'declined' });
    const hook = await ctx.api.post(`/api/v1/hooks/terminal/${t.tenant.id}/${terminalId}`).set('content-type', 'application/json').set('x-afey-sim-signature', signSimulatedNotification(openTerminalSecrets(stored as any).pairingKey, body)).send(body);
    expect(hook.status).toBe(200);
    expect((await refresh(a.id)).body.data.status).toBe('approved'); // the body's "declined" is never trusted
  });

  it('delayed approval: the terminal stays locked until it answers; the sale waits for the approval', async () => {
    const w = (await start(25054)).body.data;
    expect(w.status).toBe('processing');
    expect(w.open).toBe(true);
    const second = await start(25000);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('TERMINAL_HAS_OPEN_PAYMENT');
    expect((await sell(0, [{ method: 'card', amountCents: 25054, terminalTransactionId: w.id }])).status).toBe(422);
    const done = await cashier.post(T(`/transactions/${w.id}/simulate`), { outcome: 'approved' });
    expect(done.body.data).toMatchObject({ status: 'approved', verified: true });
  });

  it('the cashier can cancel an unfinished payment; cancelled only when the terminal confirms', async () => {
    const w = (await start(25054)).body.data;
    const c = await cashier.post(T(`/transactions/${w.id}/cancel`));
    expect(c.status).toBe(200);
    expect(c.body.data.status).toBe('cancelled');
    const other = await user('carl@cards.test', { roles: ['cashier'] });
    const w2 = (await start(25054)).body.data;
    expect((await other.post(T(`/transactions/${w2.id}/cancel`))).status).toBe(403); // another cashier's payment
    expect((await manager.post(T(`/transactions/${w2.id}/cancel`))).body.data.status).toBe('cancelled');
  });

  it('lost connection while reading the result: unknown, re-checked, then approved', async () => {
    const s = (await start(25053)).body.data;
    expect(s.status).toBe('unknown');
    expect(s.connectionLost).toBe(true);
    expect((await start(25000)).status).toBe(409); // never a new charge while unknown
    const r2 = (await refresh(s.id)).body.data;
    expect(r2.status).toBe('unknown');
    const r3 = (await refresh(s.id)).body.data;
    expect(r3).toMatchObject({ status: 'approved', verified: true, connectionLost: false });
  });

  it('terminal disconnected during checkout: unknown until it is back; only a reconciler can close it, and only as not charged', async () => {
    const s = (await start(25054)).body.data;
    await sim({ disconnected: true });
    const r = (await refresh(s.id)).body.data;
    expect(r).toMatchObject({ status: 'unknown', connectionLost: true });
    const health = (await t.client.get(T(`/${terminalId}`))).body.data.health;
    expect(health.lastError.code).toBe('UNREACHABLE');
    expect((await cashier.post(T(`/transactions/${s.id}/resolve`), { outcome: 'not_charged', note: 'checked terminal report' })).status).toBe(403);
    expect((await manager.post(T(`/transactions/${s.id}/resolve`), { outcome: 'approved', note: 'trust me please' })).status).toBe(400);
    const res = await manager.post(T(`/transactions/${s.id}/resolve`), { outcome: 'not_charged', note: 'Terminal report shows no such transaction' });
    expect(res.body.data).toMatchObject({ status: 'failed', resolution: 'not_charged', open: false });
    // Back on the network, the terminal is still holding that payment: it is busy, so nothing new starts.
    await sim({ disconnected: false });
    expect((await start(25000)).body.data.message).toMatch(/busy/);
    // If it later approves after all, the late approval is caught and kept for reconciliation (charged, no sale yet).
    const late = await manager.post(T(`/transactions/${s.id}/simulate`), { outcome: 'approved' });
    expect(late.body.data).toMatchObject({ status: 'approved', verified: true });
    expect(late.body.data.saleId).toBeUndefined();
    expect(late.body.data.message).toMatch(/Late approval/);
    expect((await start(25000)).body.data.status).toBe('approved');
  });

  it('powered off, expired credentials and a busy terminal: payment not started, terminal free, error recorded', async () => {
    await sim({ poweredOff: true });
    const off = (await start(25000)).body.data;
    expect(off).toMatchObject({ status: 'failed', open: false });
    expect(off.message).toMatch(/switched off/);
    await sim({ poweredOff: false, credentialsExpired: true });
    expect((await start(25000)).body.data.message).toMatch(/expired/);
    await sim({ credentialsExpired: false, busy: true });
    expect((await start(25000)).body.data.message).toMatch(/busy/);
    await sim({ busy: false });
    expect((await start(25000)).body.data.status).toBe('approved');
  });

  it('application restart during payment: the till finds the open payment, then uses its approval once', async () => {
    const s = (await start(25054)).body.data;
    // A new session (the till restarted) asks what is open on its terminals.
    const again = new Client(ctx.api, 'cards');
    await again.login('cathy@cards.test', 'Passw0rd!x');
    const open = (await again.get(T(`/transactions/open-for-till/${A.till}`))).body.data;
    expect(open.map((x: any) => x.id)).toContain(s.id);
    await again.post(T(`/transactions/${s.id}/simulate`), { outcome: 'approved' });
    const after = (await again.get(T(`/transactions/open-for-till/${A.till}`))).body.data.find((x: any) => x.id === s.id);
    expect(after.status).toBe('approved');
    expect(after.saleId).toBeUndefined();
    // The amount must match the approved payment exactly.
    expect((await sell(0, [{ method: 'card', amountCents: 25000, terminalTransactionId: s.id }])).status).toBe(422);
    const item = await createProduct(t.client, { name: 'Oil 1L', sku: 'OIL1', prices: { retail: 25054 }, costCents: 20000, openingStock: [{ warehouseId: A.wh, qty: 10 }] });
    const pay = [{ method: 'card', amountCents: 25054, terminalTransactionId: s.id }];
    const sale = await again.post('/sales', { clientRequestId: rid(), tillId: A.till, lines: [{ productId: item._id, qty: 1 }], payments: pay });
    expect(sale.status).toBe(201);
    expect((await again.post('/sales', { clientRequestId: rid(), tillId: A.till, lines: [{ productId: item._id, qty: 1 }], payments: pay })).status).toBe(422);
  });

  it('a terminal not assigned to the till cannot be used there', async () => {
    const r = await t.client.post(T('/transactions'), { terminalId, tillId: B.till, amountCents: 1000, clientRequestId: rid() });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('TERMINAL_NOT_ASSIGNED');
  });
});

describe('refunds, reconciliation and isolation', () => {
  it('refunds need the refund permission and cannot exceed the payment', async () => {
    const p = (await start(25000)).body.data;
    expect((await cashier.post(T(`/transactions/${p.id}/refund`), { amountCents: 1000, clientRequestId: rid(), reason: 'Damaged' })).status).toBe(403);
    const tooMuch = await manager.post(T(`/transactions/${p.id}/refund`), { amountCents: 30000, clientRequestId: rid(), reason: 'Damaged' });
    expect(tooMuch.body.error.code).toBe('TERMINAL_REFUND_TOO_MUCH');
    const ok = await manager.post(T(`/transactions/${p.id}/refund`), { amountCents: 10000, clientRequestId: rid(), reason: 'Damaged item' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ kind: 'refund', status: 'approved', verified: true });
    expect((await refresh(p.id, manager)).body.data.refundedCents).toBe(10000);
    const audits = await runInTenant(t.tenant.id, () => AuditLog.find({ action: 'terminal.refund_started' }).lean());
    expect(audits).toHaveLength(1);
  });

  it('the dashboard lists what needs attention; cashiers cannot see it', async () => {
    const list = await manager.get('/payment-terminals-transactions?needsAttention=true');
    expect(list.status).toBe(200);
    expect(list.body.data.every((x: any) => x.open || (x.status === 'approved' && !x.saleId))).toBe(true);
    expect((await cashier.get('/payment-terminals-transactions')).status).toBe(403);
    expect((await cashier.get(T())).status).toBe(403);
  });

  it('another branch’s staff cannot see or use this terminal', async () => {
    const wl = await user('wl@cards.test', { roles: ['branch_manager'], branchIds: [B.branch] });
    expect((await wl.get(T(`/${terminalId}`))).status).toBe(404);
    expect((await wl.get(T())).body.data).toEqual([]);
    const someTxn = await runInTenant(t.tenant.id, () => TerminalTransaction.findOne({ terminalId }).lean());
    expect((await wl.get(T(`/transactions/${someTxn!._id}`))).status).toBe(404);
    expect((await wl.post(T('/transactions'), { terminalId, tillId: A.till, amountCents: 1000, clientRequestId: rid() })).status).toBe(404);
  });

  it('another business cannot reach these terminals or payments', async () => {
    const otherTenant = new Types.ObjectId();
    const seen = await runInTenant(otherTenant, async () => ({ t: await PaymentTerminal.countDocuments(), x: await TerminalTransaction.countDocuments() }));
    expect(seen).toEqual({ t: 0, x: 0 });
    const s = (await start(25054)).body.data;
    // A notification addressed to another business, or badly signed, does nothing.
    expect((await ctx.api.post(`/api/v1/hooks/terminal/${otherTenant}/${terminalId}`).send({ reference: s.reference })).status).toBe(200);
    await ctx.api.post(`/api/v1/hooks/terminal/${t.tenant.id}/${terminalId}`).set('x-afey-sim-signature', 'forged').send({ reference: s.reference });
    const rejected = await runInTenant(t.tenant.id, () => AuditLog.countDocuments({ action: 'terminal.notification_rejected' }));
    expect(rejected).toBe(1);
    await cashier.post(T(`/transactions/${s.id}/cancel`));
  });

  it('a terminal with an unfinished payment cannot be removed', async () => {
    const s = (await start(25054)).body.data;
    expect((await t.client.delete(T(`/${terminalId}`))).status).toBe(409);
    await cashier.post(T(`/transactions/${s.id}/cancel`));
    expect((await t.client.delete(T(`/${terminalId}`))).status).toBe(200);
    expect((await cashier.get(T(`/for-till/${A.till}`))).body.data).toEqual([]);
  });
});
