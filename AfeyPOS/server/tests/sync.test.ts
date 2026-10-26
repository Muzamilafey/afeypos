/**
 * Head office <-> branch sync, end to end: HQ runs in this process, the branch is a real second server
 * process with its own database that talks to HQ over HTTP.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import supertest from 'supertest';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, Client, OWNER_PASSWORD, type Ctx } from './helpers.js';

process.env.SYNC_SETTLE_MS = '0';

let ctx: Ctx;
let hq: Awaited<ReturnType<typeof registerTenant>>;
let hqServer: Server;
const procs: ChildProcess[] = [];
let branch: Client;
let branch2: Client;
let hqUrl: string;
let b1: { id: string; warehouseId: string; tillId: string };
let b2: { id: string; warehouseId: string; tillId: string };
let mainWh: string;
let milk: any;

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Starts a real branch server process with its own database, configured from HQ's sync-token answer. */
async function startBranch(syncEnv: Record<string, string>): Promise<Client> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const base = inject('mongoUri');
  const dbName = `branch_${crypto.randomBytes(5).toString('hex')}`;
  const uri = base.includes('/?') ? base.replace('/?', `/${dbName}?`) : `${base.replace(/\/$/, '')}/${dbName}`;
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, ...syncEnv, SYNC_HQ_URL: hqUrl,
      NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', MONGODB_URI: uri, JOBS_ENABLED: 'false', LOG_LEVEL: process.env.BRANCH_LOG_LEVEL ?? 'error',
      SYNC_INTERVAL_SECONDS: '3600', SYNC_SETTLE_MS: '0', API_PUBLIC_URL: url, CORS_ORIGINS: url,
      BACKUP_DIR: `/tmp/afeypos-test-backups/${dbName}`, UPLOAD_DIR: `/tmp/afeypos-test-uploads/${dbName}`,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  procs.push(proc);
  const api = supertest(url);
  // The first automatic run (2 s after start) downloads the business, staff and products.
  await waitFor(async () => (await api.get('/api/v1/public/config')).body.setupRequired === false);
  const c = new Client(api, 'branch');
  await waitFor(async () => {
    await c.login('owner@chain.test', OWNER_PASSWORD);
    return true;
  });
  return c;
}

const runSync = async (on: Client = branch) => {
  const r = await on.post('/settings/sync/run', {});
  expect(r.status).toBe(200);
  expect(r.body.data.error).toBeUndefined();
  expect(r.body.data.ok).toBe(true);
  return r.body.data;
};

beforeAll(async () => {
  ctx = await setupApp({ DEPLOYMENT_MODE: 'hq', SYNC_SETTLE_MS: '0' });
  hqServer = ctx.app.listen(0, '127.0.0.1');
  await new Promise((r) => hqServer.once('listening', r));
  hqUrl = `http://127.0.0.1:${(hqServer.address() as AddressInfo).port}`;
  hq = await registerTenant(ctx.api, 'chain', 'supermarket');
  mainWh = hq.locations.warehouses[0]._id;

  // A second branch, stocked from head office before it gets its own server.
  const br = await hq.client.post('/settings/branches', { name: 'Mombasa Road', code: 'MSA01' });
  expect(br.status).toBe(201);
  const till = await hq.client.post('/settings/tills', { branchId: br.body.data.branch._id, warehouseId: br.body.data.warehouse._id, name: 'MSA till 1', code: 'MSA1' });
  b1 = { id: br.body.data.branch._id, warehouseId: br.body.data.warehouse._id, tillId: till.body.data._id };
  milk = await createProduct(hq.client, { name: 'Milk 500ml', sku: 'MILK500', prices: { retail: 6500 }, costCents: 4800, barcodes: [{ code: '6161100100011', unitCode: 'pc' }], openingStock: [{ warehouseId: b1.warehouseId, qty: 50 }, { warehouseId: mainWh, qty: 100 }] });

  const br2 = await hq.client.post('/settings/branches', { name: 'Thika Road', code: 'THK01' });
  const till2 = await hq.client.post('/settings/tills', { branchId: br2.body.data.branch._id, warehouseId: br2.body.data.warehouse._id, name: 'THK till 1', code: 'THK1' });
  b2 = { id: br2.body.data.branch._id, warehouseId: br2.body.data.warehouse._id, tillId: till2.body.data._id };

  const tok = await hq.client.post(`/settings/branches/${b1.id}/sync-token`, {});
  expect(tok.status).toBe(200);
  expect(tok.body.data.env).toMatchObject({ DEPLOYMENT_MODE: 'branch', BRANCH_CODE: 'MSA01', SYNC_ENABLED: 'true' });
  const tok2 = await hq.client.post(`/settings/branches/${b2.id}/sync-token`, {});
  [branch, branch2] = await Promise.all([startBranch(tok.body.data.env), startBranch(tok2.body.data.env)]);
}, 90_000);

afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  hqServer?.close();
  await teardown();
});

describe('branch server bootstrap', () => {
  it('downloads the business, staff, products and its own opening stock from HQ', async () => {
    await runSync();
    const me = await branch.get('/auth/me');
    expect(me.body.deploymentMode).toBe('branch');
    expect(me.body.tenant.id).toBe(hq.tenant.id);
    const lookup = await branch.get(`/products/lookup?code=6161100100011&warehouseId=${b1.warehouseId}`);
    expect(lookup.body.data.product.name).toBe('Milk 500ml');
    expect(lookup.body.data.stock.qty).toBe(50);
  });

  it('refuses to edit head-office data on the branch', async () => {
    const r = await branch.post('/products', { name: 'Local item', sku: 'LOC1', prices: { retail: 100 } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MANAGED_AT_HQ');
    expect((await branch.post('/settings/users', { name: 'X', email: 'x@y.z', roles: ['cashier'] })).body.error.code).toBe('MANAGED_AT_HQ');
  });
});

describe('branch server tills', () => {
  it('cannot be set up as a new business, and sells only from its own branch tills', async () => {
    const reg = await branch.api.post('/api/v1/public/register').send({ businessName: 'Other', businessType: 'supermarket', ownerName: 'X Y', email: 'x@other.test', password: OWNER_PASSWORD });
    expect(reg.status).toBe(409);
    expect(reg.body.error.code).toBe('BRANCH_SERVER');
    // Head office's own till (and another branch's) arrive by sync but cannot sell here.
    const other = await branch.post('/shifts', { tillId: hq.locations.tills[0]._id, openingFloatCents: 0 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('STOCK_OWNED_ELSEWHERE');
    expect(other.body.error.message).toMatch(/This till belongs to .* but this server runs branch MSA01/);
  });
});

describe('selling at the branch', () => {
  it('sells offline-first at the branch; HQ receives the sale and the branch stock after sync', async () => {
    await openShift(branch, b1.tillId, 100000);
    const sale = await branch.post('/sales', { clientRequestId: rid(), tillId: b1.tillId, lines: [{ productId: milk._id, qty: 3 }], payments: [{ method: 'cash', amountCents: 19500, tenderedCents: 20000 }] });
    expect(sale.status).toBe(201);
    expect(sale.body.data.number).toMatch(/^RCP-MSA01-\d+$/);
    await runSync();
    const hqSales = await hq.client.get(`/sales?branchId=${b1.id}`);
    expect(hqSales.body.data.map((s: any) => s.number)).toContain(sale.body.data.number);
    const levels = await hq.client.get(`/inventory/levels?productId=${milk._id}&warehouseId=${b1.warehouseId}`);
    expect(levels.body.data[0].qty).toBe(47);
    // Syncing again does not duplicate anything.
    await runSync();
    expect((await hq.client.get(`/sales?branchId=${b1.id}`)).body.data.filter((s: any) => s.number === sale.body.data.number)).toHaveLength(1);
  });

  it('HQ cannot change stock in a warehouse that belongs to a branch server', async () => {
    const r = await hq.client.post('/inventory/adjustments', { warehouseId: b1.warehouseId, reason: 'correction', lines: [{ productId: milk._id, qty: -1 }], approveNow: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STOCK_OWNED_ELSEWHERE');
  });
});

describe('head-office changes reach the branch', () => {
  it('price changes and new products arrive at the next sync', async () => {
    const full = (await hq.client.get(`/products/${milk._id}`)).body.data;
    const { _id: _i, tenantId: _t, createdAt: _c, updatedAt: _u, __v: _v, levels: _l, variants: _vs, ...body } = full;
    expect((await hq.client.put(`/products/${milk._id}`, { ...body, prices: { retail: 7000 } })).status).toBe(200);
    await createProduct(hq.client, { name: 'Bread 400g', sku: 'BREAD400', prices: { retail: 6500 } });
    await runSync();
    const p = (await branch.get(`/products/${milk._id}`)).body.data;
    expect(p.prices.retail).toBe(7000);
    expect((await branch.get('/products?q=Bread')).body.data).toHaveLength(1);
  });
});

describe('customers across branches', () => {
  it('a customer added at the branch reaches HQ, and credit sales update the HQ balance', async () => {
    await hq.client.put('/settings/modules', { enabled: ['customerCredit'] });
    await runSync();
    const c = await branch.post('/customers', { name: 'Mama Mboga', phone: '0711222333', creditLimitCents: 1_000_000 });
    expect(c.status).toBe(201);
    expect(c.body.data.code).toMatch(/MSA01/);
    const sale = await branch.post('/sales', { clientRequestId: rid(), tillId: b1.tillId, customerId: c.body.data._id, lines: [{ productId: milk._id, qty: 2 }], payments: [{ method: 'credit', amountCents: 14000 }] });
    expect(sale.status).toBe(201);
    await runSync();
    const atHq = await hq.client.get(`/customers/${c.body.data._id}`);
    expect(atHq.status).toBe(200);
    expect(atHq.body.data.balanceCents ?? atHq.body.data.customer?.balanceCents).toBe(14000);
  });
});

describe('transfers between head office and the branch', () => {
  it('dispatched at HQ, in transit at the branch, received at the branch, closed at HQ', async () => {
    const tr = await hq.client.post('/inventory/transfers', { fromWarehouseId: mainWh, toWarehouseId: b1.warehouseId, lines: [{ productId: milk._id, qty: 10 }], dispatchNow: true });
    expect(tr.status).toBe(201);
    await runSync();
    const atBranch = await branch.get(`/inventory/levels?productId=${milk._id}&warehouseId=${b1.warehouseId}`);
    expect(atBranch.body.data[0].inTransit).toBe(10);
    const rec = await branch.post(`/inventory/transfers/${tr.body.data._id}/receive`, {});
    expect(rec.status).toBe(200);
    await runSync();
    const atHq = (await hq.client.get('/inventory/transfers')).body.data.find((t: any) => t._id === tr.body.data._id);
    expect(atHq.status).toBe('received');
    const level = (await hq.client.get(`/inventory/levels?productId=${milk._id}&warehouseId=${b1.warehouseId}`)).body.data[0];
    expect(level.qty).toBe(55); // 50 - 3 - 2 + 10
    expect(level.inTransit).toBe(0);
  });
});

describe('transfers between two branch servers', () => {
  it('MSA01 dispatches, THK01 sees it in transit and receives it; both and HQ agree', async () => {
    const tr = await branch.post('/inventory/transfers', { fromWarehouseId: b1.warehouseId, toWarehouseId: b2.warehouseId, lines: [{ productId: milk._id, qty: 5 }], dispatchNow: true });
    expect(tr.status).toBe(201);
    expect(tr.body.data.number).toMatch(/^TRF-MSA01-/);
    await runSync(branch);
    await runSync(branch2);
    const incoming = await branch2.get(`/inventory/levels?productId=${milk._id}&warehouseId=${b2.warehouseId}`);
    expect(incoming.body.data[0].inTransit).toBe(5);
    // The sender cannot receive into a warehouse it does not own.
    expect((await branch.post(`/inventory/transfers/${tr.body.data._id}/receive`, {})).body.error.code).toBe('STOCK_OWNED_ELSEWHERE');
    expect((await branch2.post(`/inventory/transfers/${tr.body.data._id}/receive`, { lines: [{ productId: milk._id, receivedQty: 4 }] })).status).toBe(200);
    await runSync(branch2);
    await runSync(branch);
    const atSender = (await branch.get('/inventory/transfers')).body.data.find((t: any) => t._id === tr.body.data._id);
    expect(atSender.status).toBe('received');
    expect(atSender.lines[0].receivedQty).toBe(4);
    const hqLevels = async (wh: string) => (await hq.client.get(`/inventory/levels?productId=${milk._id}&warehouseId=${wh}`)).body.data[0];
    expect((await hqLevels(b1.warehouseId)).qty).toBe(50);
    expect(await hqLevels(b2.warehouseId)).toMatchObject({ qty: 4, inTransit: 0 });
    // Each branch also sees the other's stock (read-only).
    expect((await branch.get(`/inventory/levels?productId=${milk._id}&warehouseId=${b2.warehouseId}`)).body.data[0].qty).toBe(4);
  });
});

describe('head-office dashboard', () => {
  it('shows the branch server online with nothing pending', async () => {
    const s = await hq.client.get('/settings/sync/status');
    const row = s.body.data.branches.find((b: any) => b.code === 'MSA01');
    expect(row).toMatchObject({ hasServer: true, online: true });
    expect(row.sync.pendingUp).toBe(0);
  });
});
