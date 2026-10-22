import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp, teardown, registerTenant, createProduct, rid, type Ctx } from './helpers.js';

let ctx: Ctx;
let t: Awaited<ReturnType<typeof registerTenant>>;
let wh: string;
let supplierId: string;

beforeAll(async () => {
  ctx = await setupApp();
  t = await registerTenant(ctx.api, 'stockco', 'wholesale');
  // Enable everything inventory-related for this tenant.
  await t.client.put('/settings/modules', { enabled: ['serialNumbers', 'stockTransfers', 'batchExpiry', 'fractionalQuantities'] });
  wh = t.locations.warehouses[0]._id;
  supplierId = (await t.client.post('/suppliers', { name: 'Bidco Distributors' })).body.data._id;
});
afterAll(teardown);

const level = async (productId: string, warehouseId = wh) => {
  const r = await t.client.get(`/inventory/levels?productId=${productId}&warehouseId=${warehouseId}`);
  return r.body.data[0] ?? { qty: 0, avgCostCents: 0 };
};

describe('products and units', () => {
  it('creates a product with carton/pack conversions and barcodes per unit', async () => {
    const p = await createProduct(t.client, {
      name: 'Soda 500ml', sku: 'SODA500', baseUnit: 'pc', costCents: 4000, prices: { retail: 6000, wholesale: 5000 },
      units: [{ code: 'pc', name: 'Piece', factor: 1 }, { code: 'ctn', name: 'Carton (24)', factor: 24, prices: { wholesale: 115000 } }],
      barcodes: [{ code: '6001234567890', unitCode: 'pc' }, { code: '16001234567897', unitCode: 'ctn' }],
      openingStock: [{ warehouseId: wh, qty: 48, unitCostCents: 4000 }],
    });
    expect(p.units).toHaveLength(2);
    const lookup = await t.client.get(`/products/lookup?code=16001234567897&warehouseId=${wh}`);
    expect(lookup.body.data.unitCode).toBe('ctn');
    expect(lookup.body.data.stock.qty).toBe(48);
    const q = await t.client.post(`/products/${p._id}/quote`, { unitCode: 'ctn', qty: 2, priceList: 'wholesale' });
    expect(q.body.data.unitPriceCents).toBe(115000);
    const q2 = await t.client.post(`/products/${p._id}/quote`, { unitCode: 'pc', qty: 1, priceList: 'retail' });
    expect(q2.body.data.unitPriceCents).toBe(6000);
    const mv = await t.client.get(`/inventory/movements?productId=${p._id}`);
    expect(mv.body.data[0].type).toBe('opening');
    expect(mv.body.data[0].userId.name).toBe('Owner Person');
  });

  it('rejects duplicate barcodes across products and invalid unit definitions', async () => {
    await createProduct(t.client, { sku: 'BC1', barcodes: [{ code: '999000111', unitCode: 'pc' }] });
    const dup = await t.client.post('/products', { name: 'x', sku: 'BC2', barcodes: [{ code: '999000111', unitCode: 'pc' }] });
    expect(dup.status).toBe(409);
    const bad = await t.client.post('/products', { name: 'x', sku: 'BC3', units: [{ code: 'pc', name: 'pc', factor: 2 }] });
    expect(bad.status).toBe(400);
    const badBarcode = await t.client.post('/products', { name: 'x', sku: 'BC4', barcodes: [{ code: '1234567', unitCode: 'ctn' }] });
    expect(badBarcode.status).toBe(400);
  });

  it('imports products from CSV with a dry run first', async () => {
    const csv = 'sku,name,category,baseUnit,barcode,cost,retail,wholesale\nIMP1,Maize flour 2kg,Cereals & flour,pc,700000001,150,180,170\nIMP2,"Sugar, 1kg",Cereals & flour,pc,,120,145,\n';
    const dry = await t.client.post('/products-import', { csv });
    expect(dry.body.data.committed).toBe(false);
    expect(dry.body.data.results.map((r: any) => r.action)).toEqual(['create', 'create']);
    const real = await t.client.post('/products-import', { csv, commit: true });
    expect(real.body.data.committed).toBe(true);
    const list = await t.client.get('/products?q=Sugar');
    expect(list.body.data[0].prices.retail).toBe(14500);
    const bad = await t.client.post('/products-import', { csv: 'sku,name,retail\n,NoSku,1\nX,Y,abc\n', commit: true });
    expect(bad.body.data.committed).toBe(false);
    expect(bad.body.data.errors).toBe(2);
    const exp = await t.client.get('/products-export.csv');
    expect(exp.text).toContain('IMP1');
  });
});

describe('goods receiving and weighted average cost', () => {
  it('updates stock, average cost and supplier balance', async () => {
    const p = await createProduct(t.client, { sku: 'OIL1L', name: 'Cooking oil 1L', costCents: 0, units: [{ code: 'pc', name: 'pc', factor: 1 }, { code: 'ctn', name: 'Carton 12', factor: 12, isDefaultPurchase: true }] });
    const g1 = await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, supplierInvoiceNo: 'INV-1', lines: [{ productId: p._id, unitCode: 'ctn', qty: 1, unitCostCents: 120000 }] });
    expect(g1.status).toBe(201);
    expect(g1.body.data.totalCents).toBe(120000);
    let l = await level(p._id);
    expect(l.qty).toBe(12);
    expect(l.avgCostCents).toBe(10000);
    await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, lines: [{ productId: p._id, unitCode: 'pc', qty: 12, unitCostCents: 12000 }] });
    l = await level(p._id);
    expect(l.qty).toBe(24);
    expect(l.avgCostCents).toBe(11000);
    const s = await t.client.get(`/suppliers/${supplierId}`);
    expect(s.body.data.balanceCents).toBe(120000 + 144000);
    const pay = await t.client.post(`/suppliers/${supplierId}/payments`, { clientRequestId: rid(), amountCents: 100000, method: 'bank', reference: 'EFT1' });
    expect(pay.body.data.balanceCents).toBe(164000);
    const g = await t.client.get(`/goods-receipts/${g1.body.data._id}`);
    expect(g.body.data.paidCents).toBe(100000);
    const ret = await t.client.post('/supplier-returns', { supplierId, warehouseId: wh, reason: 'Leaking', lines: [{ productId: p._id, qty: 2 }] });
    expect(ret.status).toBe(201);
    expect((await level(p._id)).qty).toBe(22);
    expect((await t.client.get(`/suppliers/${supplierId}`)).body.data.balanceCents).toBe(164000 - 22000);
  });

  it('receives against a purchase order and tracks partial receipt', async () => {
    const p = await createProduct(t.client, { sku: 'RICE' });
    const po = await t.client.post('/purchase-orders', { supplierId, warehouseId: wh, lines: [{ productId: p._id, qty: 10, unitCostCents: 5000 }] });
    expect(po.body.data.totalCents).toBe(50000);
    await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, purchaseOrderId: po.body.data._id, lines: [{ productId: p._id, qty: 4, unitCostCents: 5000 }] });
    expect((await t.client.get(`/purchase-orders/${po.body.data._id}`)).body.data.status).toBe('partially_received');
    await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, purchaseOrderId: po.body.data._id, lines: [{ productId: p._id, qty: 6, unitCostCents: 5000 }] });
    expect((await t.client.get(`/purchase-orders/${po.body.data._id}`)).body.data.status).toBe('received');
  });
});

describe('adjustments, transfers and stocktake', () => {
  it('requires approval by another user and records the movement', async () => {
    const p = await createProduct(t.client, { sku: 'ADJ1', openingStock: [{ warehouseId: wh, qty: 10 }] });
    await t.client.post('/settings/users', { name: 'Store Keeper', email: 'keeper@stockco.test', password: 'Keeper123', roles: ['warehouse_operator'] });
    await t.client.post('/settings/users', { name: 'Inv Manager', email: 'inv@stockco.test', password: 'Invent123', roles: ['inventory_manager'] });
    const keeper = t.client.as('');
    await keeper.login('keeper@stockco.test', 'Keeper123');
    expect((await keeper.post('/inventory/adjustments', { warehouseId: wh, reason: 'damage', lines: [{ productId: p._id, qty: -2 }] })).status).toBe(403);
    const mgr = t.client.as('');
    await mgr.login('inv@stockco.test', 'Invent123');
    const adj = await mgr.post('/inventory/adjustments', { warehouseId: wh, reason: 'damage', notes: 'Dropped', lines: [{ productId: p._id, qty: -2 }] });
    expect(adj.body.data.status).toBe('pending');
    expect((await level(p._id)).qty).toBe(10);
    expect((await mgr.post(`/inventory/adjustments/${adj.body.data._id}/approve`)).status).toBe(403);
    expect((await t.client.post(`/inventory/adjustments/${adj.body.data._id}/approve`)).status).toBe(200);
    expect((await level(p._id)).qty).toBe(8);
    const mv = await t.client.get(`/inventory/movements?productId=${p._id}&type=damage`);
    expect(mv.body.data[0].ref.number).toBe(adj.body.data.number);
    expect(mv.body.data[0].reason).toBe('Dropped');
    const tooMuch = await t.client.post('/inventory/adjustments', { warehouseId: wh, reason: 'theft', approveNow: true, lines: [{ productId: p._id, qty: -100 }] });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await level(p._id)).qty).toBe(8);
  });

  it('transfers stock between warehouses via in-transit', async () => {
    const w2 = await t.client.post('/settings/warehouses', { branchId: t.locations.branches[0]._id, name: 'Back store', code: 'BACK' });
    const p = await createProduct(t.client, { sku: 'TRF1', openingStock: [{ warehouseId: wh, qty: 20, unitCostCents: 7000 }] });
    const tr = await t.client.post('/inventory/transfers', { fromWarehouseId: wh, toWarehouseId: w2.body.data._id, lines: [{ productId: p._id, qty: 5 }], dispatchNow: true });
    expect(tr.body.data.status).toBe('in_transit');
    expect((await level(p._id)).qty).toBe(15);
    expect((await level(p._id, w2.body.data._id)).inTransit).toBe(5);
    await t.client.post(`/inventory/transfers/${tr.body.data._id}/receive`, { lines: [{ productId: p._id, receivedQty: 4 }] });
    const dest = await level(p._id, w2.body.data._id);
    expect(dest.qty).toBe(4);
    expect(dest.inTransit).toBe(0);
    expect(dest.avgCostCents).toBe(7000);
  });

  it('posts stocktake variances against the snapshot', async () => {
    const p = await createProduct(t.client, { sku: 'CNT1', openingStock: [{ warehouseId: wh, qty: 30 }] });
    const st = await t.client.post('/inventory/stocktakes', { warehouseId: wh });
    expect(st.status).toBe(201);
    expect((await t.client.post('/inventory/stocktakes', { warehouseId: wh })).status).toBe(409);
    await t.client.patch(`/inventory/stocktakes/${st.body.data._id}/counts`, { counts: [{ productId: p._id, countedQty: 27 }] });
    const posted = await t.client.post(`/inventory/stocktakes/${st.body.data._id}/post`);
    expect(posted.status).toBe(200);
    expect(posted.body.data.variances.find((v: any) => v.productId === p._id).diff).toBe(-3);
    expect((await level(p._id)).qty).toBe(27);
  });
});

describe('batches, expiry and serial numbers', () => {
  it('picks batches first-expiring-first-out and never sells expired batches', async () => {
    const p = await createProduct(t.client, { sku: 'MILK', trackBatches: true });
    const soon = new Date(Date.now() + 5 * 86400_000).toISOString();
    const later = new Date(Date.now() + 40 * 86400_000).toISOString();
    const expired = new Date(Date.now() - 86400_000).toISOString();
    await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, lines: [
      { productId: p._id, qty: 5, unitCostCents: 100, batchNo: 'LATE', expiryDate: later },
      { productId: p._id, qty: 3, unitCostCents: 100, batchNo: 'SOON', expiryDate: soon },
      { productId: p._id, qty: 4, unitCostCents: 100, batchNo: 'OLD', expiryDate: expired },
    ] });
    const noBatch = await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, lines: [{ productId: p._id, qty: 1, unitCostCents: 100 }] });
    expect(noBatch.status).toBe(400);
    await t.client.post('/shifts', { tillId: t.locations.tills[0]._id });
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, lines: [{ productId: p._id, qty: 4 }], payments: [{ method: 'cash', amountCents: 40000 }] });
    expect(sale.status).toBe(201);
    expect(sale.body.data.lines[0].batches).toEqual([expect.objectContaining({ batchNo: 'SOON', qty: 3 }), expect.objectContaining({ batchNo: 'LATE', qty: 1 })]);
    const tooMany = await t.client.post('/sales', { clientRequestId: rid(), tillId: t.locations.tills[0]._id, lines: [{ productId: p._id, qty: 5 }], payments: [{ method: 'cash', amountCents: 50000 }] });
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
    const exp = await t.client.get('/reports/expiry?days=10');
    expect(exp.body.data.map((b: any) => b.batchNo)).toEqual(expect.arrayContaining(['OLD']));
  });

  it('tracks serial numbers from receipt to sale and warranty lookup', async () => {
    const p = await createProduct(t.client, { sku: 'PHONE', name: 'Phone X', trackSerials: true, warrantyMonths: 12, prices: { retail: 2000000 } });
    const mismatch = await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, lines: [{ productId: p._id, qty: 2, unitCostCents: 1500000, serials: ['IMEI1'] }] });
    expect(mismatch.status).toBe(400);
    await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, lines: [{ productId: p._id, qty: 2, unitCostCents: 1500000, serials: ['IMEI1', 'IMEI2'] }] });
    const dup = await t.client.post('/goods-receipts', { supplierId, warehouseId: wh, lines: [{ productId: p._id, qty: 1, unitCostCents: 1500000, serials: ['IMEI1'] }] });
    expect(dup.status).toBe(409);
    const till = t.locations.tills[0]._id;
    const wrong = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, serials: ['NOPE'] }], payments: [{ method: 'cash', amountCents: 2000000 }] });
    expect(wrong.body.error.code).toBe('SERIAL_UNAVAILABLE');
    const sale = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, serials: ['IMEI2'] }], payments: [{ method: 'cash', amountCents: 2000000 }] });
    expect(sale.status).toBe(201);
    const again = await t.client.post('/sales', { clientRequestId: rid(), tillId: till, lines: [{ productId: p._id, qty: 1, serials: ['IMEI2'] }], payments: [{ method: 'cash', amountCents: 2000000 }] });
    expect(again.body.error.code).toBe('SERIAL_UNAVAILABLE');
    const lookup = await t.client.get('/inventory/serials/IMEI2');
    expect(lookup.body.data[0].status).toBe('sold');
    expect(lookup.body.data[0].warranty.active).toBe(true);
    expect(lookup.body.data[0].sale.number).toBe(sale.body.data.number);
  });
});
