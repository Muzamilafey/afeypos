import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { Types } from 'mongoose';
import { setupApp, teardown, registerTenant, createProduct, openShift, rid, type Ctx } from './helpers.js';
import { createBackup, restoreBackup, verifyBackupFile } from '../src/modules/backups/service.js';
import { runAsPlatform, runInTenant } from '../src/lib/context.js';
import { Product, Sale, StockLevel, Tenant } from '../src/models/index.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'backupco', 'minimart');
});
afterAll(teardown);

describe('backup and restore', () => {
  it('backs up a tenant, survives data loss and restores exactly', async () => {
    const wh = t.locations.warehouses[0]._id;
    const p = await createProduct(t.client, { sku: 'KEEP-1', openingStock: [{ warehouseId: wh, qty: 12, unitCostCents: 3333 }] });
    await openShift(t.client, t.locations.tills[0]._id);
    await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, lines: [{ productId: p._id, qty: 2 }], payments: [{ method: 'cash', amountCents: 20000 }] });
    const tenantId = new Types.ObjectId(t.tenant.id);
    const before = await runInTenant(tenantId, async () => ({ products: await Product.countDocuments(), sales: await Sale.countDocuments(), qty: (await StockLevel.findOne({ productId: p._id }).lean())!.qty }));

    const b = await runAsPlatform(() => createBackup({ scope: 'tenant', tenantId }));
    expect(b.documents).toBeGreaterThan(10);
    expect(verifyBackupFile(b.file)).toBe(true);

    // Restoring over an existing tenant is refused unless explicitly requested.
    await expect(restoreBackup(b.file)).rejects.toThrow(/already exists/);

    // Simulate data loss.
    await runInTenant(tenantId, async () => {
      await Product.deleteMany({});
      await Sale.deleteMany({});
    });
    await runAsPlatform(() => Tenant.deleteOne({ _id: tenantId }));
    expect((await t.client.get('/products')).status).toBe(404);

    const r = await runAsPlatform(() => restoreBackup(b.file));
    expect(r.scope).toBe('tenant');
    const after = await runInTenant(tenantId, async () => ({ products: await Product.countDocuments(), sales: await Sale.countDocuments(), qty: (await StockLevel.findOne({ productId: p._id }).lean())!.qty }));
    expect(after).toEqual(before);
    // The app keeps working after restore (sessions are not part of backups, so log in again).
    await t.client.login('owner@backupco.test', 'OwnerPass123');
    expect((await t.client.get(`/products/${p._id}`)).body.data.sku).toBe('KEEP-1');
  });

  it('detects tampered backups', async () => {
    const b = await runAsPlatform(() => createBackup({ scope: 'full' }));
    fs.appendFileSync(b.file, 'garbage');
    expect(verifyBackupFile(b.file)).toBe(false);
    await expect(restoreBackup(b.file, { dropExisting: true })).rejects.toThrow(/checksum/);
  });
});
