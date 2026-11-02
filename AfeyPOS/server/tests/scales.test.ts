import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, type Ctx } from './helpers.js';
import { Job } from '../src/models/index.js';
import { drainJobs } from '../src/jobs/queue.js';
import { runAsPlatform } from '../src/lib/context.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
const branchId = () => t.locations.branches[0]._id;
/** Makes queued retries due now (the queue backs off between attempts). */
const runDue = async () => { await runAsPlatform(() => Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } })); return drainJobs(); };

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'scaleshop', 'supermarket');
});
afterAll(teardown);

describe('weighing scales (simulated adapters; no physical hardware in these tests)', () => {
  it('lists brands honestly and refuses impossible pairings', async () => {
    const cat = (await t.client.get('/scales/catalog')).body.data;
    expect(cat.brands.map((b: any) => b.key)).toEqual(expect.arrayContaining(['cas', 'digi', 'avery-berkel', 'bizerba', 'mettler-toledo', 'ishida', 'adam', 'ohaus']));
    expect(cat.adapters['file-export'].pluSync).toBe('file');
    const bad = await t.client.post('/scales', { name: 'Bench', brand: 'ohaus', adapter: 'file-export', branchId: branchId() });
    expect(bad.status).toBe(400);
    const label = await t.client.post('/scales', { name: 'Bench', brand: 'adam', adapter: 'bridge-serial', role: 'label', branchId: branchId() });
    expect(label.body.error.message).toMatch(/PLU list/);
  });

  it('verifies a counter scale only with a stable reading close to a known test weight', async () => {
    const s = (await t.client.post('/scales', { name: 'Till 1 scale', brand: 'cas', adapter: 'bridge-serial', branchId: branchId(), tillIds: [t.locations.tills[0]._id], settings: { port: 'COM3', baud: 9600 } })).body.data;
    expect(s.status).toBe('unverified');
    const unstable = await t.client.post(`/scales/${s._id}/verify`, { expectedKg: 1, reading: { grossKg: 1, netKg: 1, stable: false } });
    expect(unstable.status).toBe(422);
    const off = await t.client.post(`/scales/${s._id}/verify`, { expectedKg: 1, reading: { grossKg: 1.2, netKg: 1.2, stable: true } });
    expect(off.body.error.message).toMatch(/1.200 kg but the test weight is 1.000/);
    const ok = await t.client.post(`/scales/${s._id}/verify`, { expectedKg: 1, reading: { grossKg: 1.004, tareKg: 0, netKg: 1.004, stable: true, raw: 'ST,GS,+  1.004kg' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'verified', simulated: false });
    // Changing the port means testing again.
    const moved = (await t.client.patch(`/scales/${s._id}`, { settings: { port: 'COM4' } })).body.data;
    expect(moved.status).toBe('unverified');
    expect((await t.client.get(`/scales?tillId=${t.locations.tills[0]._id}`)).body.data).toHaveLength(1);
  });

  it('sends prices to a simulated label scale with retries and versions, confirmed by the device', async () => {
    await createProduct(t.client, { name: 'Beef', sku: 'BEEF', plu: '1', baseUnit: 'kg', allowFractional: true, soldByWeight: true, prices: { retail: 80000 } });
    await createProduct(t.client, { name: 'Tomatoes', sku: 'TOM', plu: '2', baseUnit: 'kg', allowFractional: true, soldByWeight: true, prices: { retail: 12000 } });
    const s = (await t.client.post('/scales', { name: 'Deli label scale', brand: 'simulator', adapter: 'simulator', role: 'label', branchId: branchId(), settings: { simulateFailures: 2 } })).body.data;
    expect(s.simulated).toBe(true);
    expect(s.pluStatus).toMatchObject({ applies: true, count: 2, upToDate: false });
    const job = (await t.client.post(`/scales/${s._id}/sync`, {})).body.data;
    expect(job).toMatchObject({ version: 1, status: 'queued' });
    await drainJobs();
    let jobs = (await t.client.get(`/scales/${s._id}/jobs`)).body.data;
    expect(jobs[0]).toMatchObject({ status: 'queued', error: expect.stringMatching(/Simulated send failure 1/) });
    await runDue();
    await runDue();
    jobs = (await t.client.get(`/scales/${s._id}/jobs`)).body.data;
    expect(jobs[0]).toMatchObject({ status: 'succeeded', confirmation: 'device' });
    const after = (await t.client.get('/scales')).body.data.find((x: any) => x._id === s._id);
    expect(after).toMatchObject({ status: 'verified', plu: { version: 1, count: 2 }, pluStatus: { upToDate: true } });

    // A price change makes the scale out of date until the next send.
    const beef = (await t.client.get('/products?q=BEEF')).body.data[0];
    const rest = Object.fromEntries(Object.entries(beef).filter(([k]) => !['_id', 'tenantId', 'createdAt', 'updatedAt', '__v', 'stock'].includes(k)));
    expect((await t.client.put(`/products/${beef._id}`, { ...rest, prices: { retail: 85000 } })).status).toBe(200);
    expect((await t.client.get('/scales')).body.data.find((x: any) => x._id === s._id).pluStatus.upToDate).toBe(false);
  });

  it('label scales without a direct link get a file and need a person to confirm the import', async () => {
    const s = (await t.client.post('/scales', { name: 'DIGI SM', brand: 'digi', adapter: 'file-export', role: 'label', branchId: branchId() })).body.data;
    const verify = await t.client.post(`/scales/${s._id}/verify`, { expectedKg: 1 });
    expect(verify.body.error.code).toBe('VERIFY_BY_IMPORT');
    const job = (await t.client.post(`/scales/${s._id}/sync`, {})).body.data;
    expect(job.status).toBe('awaiting_import');
    await drainJobs();
    expect((await t.client.get(`/scales/${s._id}/jobs`)).body.data[0].status).toBe('awaiting_import');
    const file = await t.client.get(`/scale-jobs/${job._id}/file`);
    expect(file.text.split('\r\n')[0]).toBe('PLU,Name,Unit price,Type');
    expect(file.text).toContain('1,Beef,850.00,Weighed');
    // A newer send supersedes the old one.
    const job2 = (await t.client.post(`/scales/${s._id}/sync`, {})).body.data;
    expect((await t.client.post(`/scale-jobs/${job._id}/confirm`, {})).body.error.code).toBe('NOT_AWAITING_IMPORT');
    const done = (await t.client.post(`/scale-jobs/${job2._id}/confirm`, {})).body.data;
    expect(done).toMatchObject({ status: 'succeeded', confirmation: 'manual', version: 2 });
    expect((await t.client.get('/scales')).body.data.find((x: any) => x._id === s._id)).toMatchObject({ status: 'verified', pluStatus: { upToDate: true } });
  });

  it('gives up after the maximum attempts and can be retried by hand', async () => {
    const s = (await t.client.post('/scales', { name: 'Flaky', brand: 'simulator', adapter: 'simulator', role: 'label', branchId: branchId(), settings: { simulateFailures: 9 } })).body.data;
    const job = (await t.client.post(`/scales/${s._id}/sync`, {})).body.data;
    for (let i = 0; i < 6; i++) await runDue();
    const failed = (await t.client.get(`/scales/${s._id}/jobs`)).body.data[0];
    expect(failed.status).toBe('failed');
    expect(failed.log.at(-1).message).toMatch(/giving up/);
    expect((await t.client.post(`/scale-jobs/${job._id}/retry`, {})).body.data.status).toBe('queued');
  });
});
