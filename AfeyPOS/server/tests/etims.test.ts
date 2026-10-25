import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { drainJobs } from '../src/jobs/queue.js';
import { Job } from '../src/models/index.js';
import { runAsPlatform } from '../src/lib/context.js';
import { MockEtimsGateway, etimsDate } from '../src/integrations/etims/client.js';
import { taxType } from '../src/modules/etims/service.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let till: string;
let wh: string;
let cfgId: string;

const runJobs = async () => {
  await runAsPlatform(() => Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }));
  await drainJobs();
};

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'kra', 'supermarket');
  till = t.locations.tills[0]._id;
  wh = t.locations.warehouses[0]._id;
  await openShift(t.client, till);
});
afterAll(teardown);

describe('eTIMS helpers', () => {
  it('maps VAT rates to KRA tax types and formats EAT dates', () => {
    expect(taxType(1600)).toBe('B');
    expect(taxType(800)).toBe('E');
    expect(taxType(0)).toBe('C');
    expect(taxType(0, 'A')).toBe('A');
    expect(etimsDate(new Date('2026-10-25T09:05:07Z'))).toBe('20261025120507');
    expect(etimsDate(new Date('2026-10-25T22:00:00Z'), false)).toBe('20261026');
  });
});

describe('eTIMS device setup', () => {
  it('validates the configuration and initialises the device', async () => {
    expect((await t.client.post('/settings/integrations', { kind: 'etims', provider: 'mock', name: 'eTIMS', settings: { tin: 'bad', bhfId: '00' } })).status).toBe(400);
    expect((await t.client.post('/settings/integrations', { kind: 'etims', provider: 'vscu', name: 'VSCU', settings: { tin: 'P051234567X', bhfId: '00' } })).status).toBe(400);
    const c = await t.client.post('/settings/integrations', { kind: 'etims', provider: 'mock', name: 'eTIMS (simulator)', settings: { tin: 'p051234567x', bhfId: '00', dvcSrlNo: 'DVC-001' } });
    expect(c.status).toBe(201);
    cfgId = c.body.data.id;
    expect((await t.client.post(`/settings/integrations/${cfgId}/test`, {})).body.data.ok).toBe(false);
    const init = await t.client.post(`/settings/integrations/${cfgId}/etims/initialize`, {});
    expect(init.body.data).toMatchObject({ sdcId: 'KRACU0100000001', mrcNo: 'WIS00000001' });
    expect((await t.client.post(`/settings/integrations/${cfgId}/test`, {})).body.data.ok).toBe(true);
    const list = await t.client.get('/settings/integrations');
    expect(list.body.data.find((x: any) => x.id === cfgId).secretsSet).toContain('cmcKey');
  });
});

describe('signing sales, credit notes and voids', () => {
  let product: any;
  let saleId: string;

  it('registers products as eTIMS items', async () => {
    product = await createProduct(t.client, { name: 'Sugar 1kg', sku: 'SUGAR1', prices: { retail: 23200 }, taxRateBp: 1600, barcodes: [{ code: '6161100100042', unitCode: 'pc' }], etims: { itemClsCd: '50161800' }, openingStock: [{ warehouseId: wh, qty: 20 }] });
    await runJobs();
    const item = MockEtimsGateway.items.find((i) => i.itemNm === 'Sugar 1kg')!;
    expect(item).toMatchObject({ itemClsCd: '50161800', taxTyCd: 'B', qtyUnitCd: 'U', bcd: '6161100100042', dftPrc: 232 });
    expect(item.itemCd).toMatch(/^KE2NTU\d{7}$/);
    const p = (await t.client.get(`/products/${product._id}`)).body.data;
    expect(p.etims.registeredAt).toBeTruthy();
    // Editing the product keeps the registered item code.
    const { _id: _i, tenantId: _t, createdAt: _c, updatedAt: _u, __v: _v, levels: _l, variants: _vs, ...body } = p;
    await t.client.put(`/products/${product._id}`, { ...body, name: 'Sugar 1kg (white)' });
    await runJobs();
    expect((await t.client.get(`/products/${product._id}`)).body.data.etims.itemCd).toBe(item.itemCd);
  });

  it('signs a sale after checkout and prints the KRA details', async () => {
    const r = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: product._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 46400, tenderedCents: 50000 }] });
    expect(r.status).toBe(201);
    saleId = r.body.data._id;
    let s = (await t.client.get(`/sales/${saleId}`)).body.data;
    expect(s.etims).toMatchObject({ status: 'pending', invcNo: 1 });
    await runJobs();
    s = (await t.client.get(`/sales/${saleId}`)).body.data;
    expect(s.etims).toMatchObject({ status: 'signed', rcptSign: 'SIMSIGN000000001', sdcId: 'KRACU0100000001' });
    expect(s.etims.qrUrl).toContain('Data=P051234567X00SIMSIGN000000001');
    const sent = MockEtimsGateway.sales.at(-1)!;
    expect(sent).toMatchObject({ rcptTyCd: 'S', invcNo: 1, orgInvcNo: 0, pmtTyCd: '01', trdInvcNo: s.number, taxblAmtB: 464, taxRtB: 16, taxAmtB: 64, totAmt: 464, totItemCnt: 1 });
    expect(sent.itemList[0]).toMatchObject({ qty: 2, prc: 232, splyAmt: 464, taxTyCd: 'B', taxblAmt: 464, taxAmt: 64 });
    const text = await t.client.get(`/sales/${saleId}/receipt?format=text`);
    expect(text.text).toContain('CU Invoice No.');
    expect(text.text).toContain('SIMSIGN000000001');
    const html = await t.client.get(`/sales/${saleId}/receipt?format=html`);
    expect(html.text).toContain('<svg');
  });

  it('sends returns as credit notes against the original invoice, and voids as full credit notes', async () => {
    const sale = (await t.client.get(`/sales/${saleId}`)).body.data;
    const ret = await t.client.post(`/sales/${saleId}/returns`, { clientRequestId: rid(), tillId: till, lines: [{ lineId: sale.lines[0]._id, qty: 1 }], refundMethod: 'cash', reason: 'Damaged pack' });
    expect(ret.status).toBe(201);
    await runJobs();
    const note = MockEtimsGateway.sales.at(-1)!;
    expect(note).toMatchObject({ rcptTyCd: 'R', invcNo: 2, orgInvcNo: 1, totAmt: 232, taxAmtB: 32 });

    const s2 = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: product._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 23200 }] });
    await runJobs();
    const v = await t.client.post(`/sales/${s2.body.data._id}/void`, { clientRequestId: rid(), reason: 'Wrong item scanned' });
    expect(v.status).toBe(200);
    await runJobs();
    expect(MockEtimsGateway.sales.at(-1)).toMatchObject({ rcptTyCd: 'R', orgInvcNo: 3, totAmt: 232, rfdRsnCd: '11' });
  });

  it('keeps selling while KRA is unreachable and signs once it is back', async () => {
    MockEtimsGateway.failNext = 2;
    const r = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: product._id, qty: 1 }], payments: [{ method: 'cash', amountCents: 23200 }] });
    expect(r.status).toBe(201);
    await runJobs();
    let s = (await t.client.get(`/sales/${r.body.data._id}`)).body.data;
    expect(s.etims.status).toBe('pending');
    expect(s.etims.error).toMatch(/Network error/);
    expect((await t.client.get(`/sales/${r.body.data._id}/receipt?format=text`)).text).toContain('awaiting signature');
    await runJobs();
    await runJobs();
    s = (await t.client.get(`/sales/${r.body.data._id}`)).body.data;
    expect(s.etims.status).toBe('signed');
    const status = await t.client.get('/etims/status');
    expect(status.body.data.sales.signed).toBeGreaterThanOrEqual(3);
    expect(status.body.data.failed).toHaveLength(0);
  });
});
