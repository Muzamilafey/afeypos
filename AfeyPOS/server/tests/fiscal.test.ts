import http from 'node:http';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { drainJobs, enqueue, runNextJob } from '../src/jobs/queue.js';
import { AuditLog, FiscalTransaction, IntegrationConfig, Job } from '../src/models/index.js';
import { runAsPlatform, runInTenant } from '../src/lib/context.js';
import { MockEtimsGateway } from '../src/integrations/etims/client.js';
import { classifyTransportError, FiscalDisconnectedError, FiscalUncertainError, FiscalUnsupportedError, sanitizeForLog, statusForError } from '../src/integrations/fiscal/adapter.js';
import { fiscalAdapter, fiscalCapabilities } from '../src/modules/etims/adapters.js';
import { checkFiscalDevices } from '../src/modules/etims/health.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let product: any;
let mockId: string;

const runJobs = async () => {
  await runAsPlatform(() => Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }));
  await drainJobs();
};
const tenantId = () => new Types.ObjectId(String(t.tenant.id ?? t.tenant._id));
const sell = (etimsConfigId: string) =>
  t.client.post('/sales', { clientRequestId: rid(), tillId: till, etimsConfigId, lines: [{ productId: product._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 11600 }] }).then((r) => r.body.data);
const etimsOf = async (id: string) => (await t.client.get(`/sales/${id}`)).body.data.etims;

/** An ETR maker's program on this computer, scripted per request. */
function program(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close() })));
}
const answer = (res: http.ServerResponse, seq: number) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ cuInvoiceNumber: `0040555550${String(seq).padStart(9, '0')}`, cuSerialNumber: 'KRAMW004055555' }));
};

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'fiscalshop', 'supermarket', {}, ['etims']);
  till = t.locations.tills[0]._id;
  await openShift(t.client, till);
  product = await createProduct(t.client, { name: 'Rice 1kg', sku: 'RICE1', prices: { retail: 11600 }, taxRateBp: 1600, openingStock: [{ warehouseId: t.locations.warehouses[0]._id, qty: 200 }] });
  const c = await t.client.post('/settings/integrations', { kind: 'etims', provider: 'mock', name: 'Simulated eTIMS', settings: { tin: 'P051234567X', bhfId: '00', dvcSrlNo: 'DVC-9' } });
  mockId = c.body.data.id;
  await t.client.post(`/settings/integrations/${mockId}/etims/initialize`, {});
  await runJobs();
});
afterAll(teardown);

describe('fiscal adapter layer', () => {
  it('sorts transport errors into "not sent" and "maybe sent", and states each device\'s real capabilities', () => {
    expect(classifyTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'ETR')).toBeInstanceOf(FiscalDisconnectedError);
    expect(classifyTransportError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'ETR')).toBeInstanceOf(FiscalUncertainError);
    expect(classifyTransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }), 'ETR')).toBeInstanceOf(FiscalUncertainError);
    expect(statusForError(new FiscalUncertainError('x'))).toEqual({ status: 'awaiting_confirmation', retry: true });
    expect(statusForError(new FiscalDisconnectedError('x'))).toEqual({ status: 'device_disconnected', retry: true });

    // Status query for an ETR program only when its documented status address is set.
    expect(fiscalCapabilities({ provider: 'etr', settings: { connection: 'http' } })).toMatchObject({ transactionStatus: false, safeResend: false, localOnly: true, submitDebitNote: false });
    expect(fiscalCapabilities({ provider: 'etr', settings: { connection: 'http', statusPath: '/status/{invoiceNumber}' } }).transactionStatus).toBe(true);
    expect(fiscalCapabilities({ provider: 'etr', settings: { connection: 'folder' } })).toMatchObject({ transactionStatus: true, safeResend: true });
    expect(fiscalCapabilities({ provider: 'oscu' })).toMatchObject({ submitInvoice: true, submitCreditNote: true, transactionStatus: false, cancelTransaction: false, localOnly: false });
    expect(sanitizeForLog({ a: 1, cmcKey: 'k', nested: { authHeader: 'X: y' } })).toEqual({ a: 1, cmcKey: '[hidden]', nested: { authHeader: '[hidden]' } });
  });

  it('unsupported operations say so instead of pretending', async () => {
    const cfg = await runInTenant(tenantId(), () => IntegrationConfig.findById(mockId));
    const a = fiscalAdapter(cfg!);
    await expect(a.submitDebitNote({} as any)).rejects.toBeInstanceOf(FiscalUnsupportedError);
    await expect(a.cancelTransaction({} as any)).rejects.toThrow(/credit note instead/);
    expect(a.validateConfiguration()).toEqual([]);
  });
});

describe('never fiscalized twice', () => {
  it('a lost answer is checked with the device before any resend', async () => {
    MockEtimsGateway.script = ['timeout'];
    const before = MockEtimsGateway.sales.length;
    const sale = await sell(mockId);
    await runJobs();
    // The receipt is honest while it waits.
    const e1 = await etimsOf(sale._id);
    expect(e1.status).toBe('awaiting_confirmation');
    expect((await t.client.get(`/sales/${sale._id}/receipt?format=text`)).text).toContain('NOT YET A FISCAL RECEIPT');
    await runJobs();
    const e2 = await etimsOf(sale._id);
    expect(e2).toMatchObject({ status: 'signed', via: 'status_query', invcNo: e1.invcNo });
    // Recorded once at the device.
    expect(MockEtimsGateway.sales.length).toBe(before + 1);
    const detail = (await t.client.get(`/fiscal/transactions/sale/${sale._id}`)).body.data;
    expect(detail.log.map((l: any) => `${l.operation}:${l.outcome}`)).toEqual(['invoice:awaiting_confirmation', 'status_query:signed']);
    expect(detail.log[0].request).toMatchObject({ invcNo: e1.invcNo, trdInvcNo: sale.number });
  });

  it('two workers on the same invoice: only one sends it', async () => {
    const before = MockEtimsGateway.sales.length;
    const sale = await sell(mockId);
    // A duplicate job for the same sale (e.g. a manual retry while the first is queued).
    await runInTenant(tenantId(), () => enqueue('etims.submit', { kind: 'sale', id: String(sale._id) }, { dedupeKey: `dup:${sale._id}` }));
    await runAsPlatform(() => Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }));
    await Promise.all([runNextJob(), runNextJob(), runNextJob()]);
    await drainJobs();
    expect((await etimsOf(sale._id)).status).toBe('signed');
    expect(MockEtimsGateway.sales.length).toBe(before + 1);
  });

  it('"already recorded" without a signature goes to reconciliation; a person records what the device shows', async () => {
    MockEtimsGateway.script = ['duplicate'];
    const sale = await sell(mockId);
    await runJobs();
    expect((await etimsOf(sale._id)).status).toBe('requires_reconciliation');
    // A plain retry is refused: it must be reconciled.
    expect((await t.client.post('/etims/retry', { kind: 'sale', id: sale._id })).body.error.code).toBe('FISCAL_RECONCILE');
    expect((await t.client.post(`/fiscal/transactions/sale/${sale._id}/reconcile`, { action: 'record', note: 'x' })).status).toBe(400);
    const r = await t.client.post(`/fiscal/transactions/sale/${sale._id}/reconcile`, { action: 'record', note: 'Found on KRA eTIMS portal', rcptSign: 'PORTALSIGN0001', rcptNo: 77 });
    expect(r.body.data.status).toBe('signed');
    expect(await etimsOf(sale._id)).toMatchObject({ status: 'signed', via: 'manual', rcptSign: 'PORTALSIGN0001', reconcileNote: 'Found on KRA eTIMS portal' });
    const a = await runInTenant(tenantId(), () => AuditLog.findOne({ action: 'fiscal.reconcile_record' }).lean());
    expect(a?.details).toMatchObject({ from: 'requires_reconciliation', to: 'signed' });
    expect((await t.client.post(`/fiscal/transactions/sale/${sale._id}/reconcile`, { action: 'resend', note: 'try again' })).body.error.code).toBe('FISCAL_ALREADY_SIGNED');
  });

  it('a refusal is "rejected"; a device that cannot be reached is "device disconnected" and catches up on its own', async () => {
    MockEtimsGateway.script = ['reject'];
    const rej = await sell(mockId);
    await runJobs();
    expect(await etimsOf(rej._id)).toMatchObject({ status: 'rejected', error: expect.stringMatching(/910/) });
    expect((await t.client.post('/etims/retry', { kind: 'sale', id: rej._id })).body.data.queued).toBe(true);
    await runJobs();
    expect((await etimsOf(rej._id)).status).toBe('signed');

    MockEtimsGateway.script = ['disconnected', 'disconnected'];
    const off = await sell(mockId);
    await runJobs();
    expect((await etimsOf(off._id)).status).toBe('device_disconnected');
    // The job gave up (e.g. days offline): the monitor queues it again.
    await runAsPlatform(() => Job.updateMany({ type: 'etims.submit', status: 'queued' }, { $set: { status: 'dead' } }));
    const { requeued } = await runInTenant(tenantId(), () => checkFiscalDevices());
    expect(requeued).toBeGreaterThanOrEqual(1);
    await runJobs();
    await runJobs();
    expect((await etimsOf(off._id)).status).toBe('signed');
  });
});

describe('ETR program without a status query', () => {
  it('connection dropped after sending: not resent automatically; resent after a person confirms', async () => {
    let posts = 0;
    let mode: 'drop' | 'ok' = 'drop';
    const p = await program((req, body, res) => {
      if (req.method !== 'POST') return res.writeHead(200).end('ETR');
      posts++;
      if (mode === 'drop') return req.socket.destroy();
      answer(res, JSON.parse(body).sequence);
    });
    try {
      const cfg = await t.client.post('/settings/integrations', { kind: 'etims', provider: 'etr', name: 'Counter ETR', settings: { tin: 'P051234567X', bhfId: '00', connection: 'http', url: p.url, timeoutSeconds: 5 }, secrets: { authHeader: 'X-Api-Key: very-secret-1' } });
      const sale = await sell(cfg.body.data.id);
      await runJobs();
      expect((await etimsOf(sale._id)).status).toBe('awaiting_confirmation');
      await runJobs();
      expect((await etimsOf(sale._id)).status).toBe('requires_reconciliation');
      expect(posts).toBe(1);
      // Asking the device is not possible for this program.
      expect((await t.client.post(`/fiscal/transactions/sale/${sale._id}/reconcile`, { action: 'check' })).body.error.code).toBe('FISCAL_NO_STATUS_QUERY');
      mode = 'ok';
      const r = await t.client.post(`/fiscal/transactions/sale/${sale._id}/reconcile`, { action: 'resend', note: 'Device journal has no such invoice' });
      expect(r.body.data.status).toBe('pending');
      await runJobs();
      expect(await etimsOf(sale._id)).toMatchObject({ status: 'signed', via: 'device', cuSerial: 'KRAMW004055555' });
      expect(posts).toBe(2);
      // The program's key never reaches the log.
      const log = (await t.client.get(`/fiscal/log?configId=${cfg.body.data.id}`)).body.data;
      expect(JSON.stringify(log)).not.toContain('very-secret-1');
    } finally {
      p.close();
    }
  }, 30_000);

  it('with the program\'s status address set, a lost answer is looked up instead', async () => {
    let posts = 0;
    const signed = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    const p = await program((req, body, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/status/')) {
        const no = decodeURIComponent(req.url.slice(8));
        if (!signed.has(no)) return res.writeHead(404).end();
        return answer(res, signed.get(no)!);
      }
      if (req.method !== 'POST') return res.writeHead(200).end('ETR');
      posts++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const inv = JSON.parse(body);
      signed.set(inv.invoiceNumber, inv.sequence);
      setTimeout(() => {
        inFlight--;
        if (posts === 1) return req.socket.destroy(); // first answer lost
        answer(res, inv.sequence);
      }, 50);
    });
    try {
      const cfg = await t.client.post('/settings/integrations', { kind: 'etims', provider: 'etr', name: 'Central ETR', settings: { tin: 'P051234567X', bhfId: '00', connection: 'http', url: p.url, statusPath: '/status/{invoiceNumber}', timeoutSeconds: 5 } });
      const id = cfg.body.data.id;
      const sale = await sell(id);
      await runJobs();
      await runJobs();
      expect(await etimsOf(sale._id)).toMatchObject({ status: 'signed', via: 'status_query' });
      expect(posts).toBe(1);

      // Several tills on one central device: one invoice at a time, each once.
      const many = await Promise.all([sell(id), sell(id), sell(id)]);
      await runAsPlatform(() => Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }));
      await Promise.all([runNextJob(), runNextJob(), runNextJob()]);
      await runJobs();
      for (const s of many) expect((await etimsOf(s._id)).status).toBe('signed');
      expect(posts).toBe(4);
      expect(maxInFlight).toBe(1);

      const dev = (await t.client.get('/fiscal/devices')).body.data.find((d: any) => d.id === id);
      expect(dev).toMatchObject({ kind: 'etr_http', capabilities: { transactionStatus: true }, health: { state: 'online' }, colour: 'green' });
      const test = (await t.client.post(`/fiscal/devices/${id}/test`, {})).body.data;
      expect(test.state).toBe('online');
    } finally {
      p.close();
    }
  }, 30_000);
});

describe('monitoring, reports and isolation', () => {
  it('lists transactions by status, reports fiscal totals and VAT, and keeps businesses apart', async () => {
    const all = (await t.client.get('/fiscal/transactions')).body.data;
    expect(all.length).toBeGreaterThan(5);
    expect(all.every((r: any) => r.etims.status && r.deviceName)).toBe(true);
    const manual = all.find((r: any) => r.etims.via === 'manual');
    expect((await t.client.get(`/fiscal/transactions?q=${manual.number}`)).body.data).toHaveLength(1);
    expect((await t.client.get('/fiscal/transactions?status=attention')).body.data.every((r: any) => ['rejected', 'failed', 'requires_reconciliation'].includes(r.etims.status))).toBe(true);

    const rep = (await t.client.get('/fiscal/reports')).body.data;
    expect(rep.sales.fiscalized.n).toBeGreaterThanOrEqual(8);
    expect(rep.netFiscalizedCents).toBe(rep.sales.fiscalized.cents - rep.creditNotes.fiscalized.cents);
    expect(rep.vat).toEqual([expect.objectContaining({ taxType: 'B', rate: 16 })]);
    expect(rep.vat[0].taxCents).toBe(1600 * rep.sales.fiscalized.n);
    expect(rep.daily[0]).toMatchObject({ fiscalizedReceipts: rep.sales.fiscalized.n });
    const mock = rep.devices.find((d: any) => d.id === mockId);
    expect(mock.attempts).toBeGreaterThan(mock.succeeded);
    expect(mock.successRate).toBeLessThan(100);
    expect(rep.duplicateInvoiceNumbers).toEqual([]);

    // Another business sees none of it.
    const other = await registerTenant(ctx.api, 'otherfiscal', 'supermarket', {}, ['etims']);
    expect((await other.client.get('/fiscal/transactions')).body.data).toEqual([]);
    expect((await other.client.get(`/fiscal/transactions/sale/${manual.id}`)).status).toBe(404);
    expect((await other.client.post(`/fiscal/transactions/sale/${manual.id}/reconcile`, { action: 'mark_failed', note: 'not mine' })).status).toBe(404);
    expect((await other.client.get('/fiscal/devices')).body.data).toEqual([]);
    expect(await runInTenant(new Types.ObjectId(String(other.tenant.id ?? other.tenant._id)), () => FiscalTransaction.countDocuments({}))).toBe(0);
  });
});
