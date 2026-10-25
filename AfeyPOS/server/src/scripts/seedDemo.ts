// Sets up a demo business with grocery products, a supplier and a credit customer.
// Usage: npm run seed:demo -w @afeypos/server -- [minimart|supermarket]   (only on an empty database)
import { withDb } from './cli.js';
import { provisionTenant } from '../modules/tenants/provisioning.js';
import { runInTenant } from '../lib/context.js';
import { Customer, Product, Supplier, Warehouse } from '../models/index.js';
import { applyMovement } from '../modules/inventory/stock.js';
import { withTransaction } from '../db/connection.js';
import { BUSINESS_TYPES, type BusinessType } from '@afeypos/shared';

const type = (process.argv[2] ?? 'supermarket') as BusinessType;
if (!BUSINESS_TYPES.includes(type)) throw new Error(`Unknown business type ${type}; use minimart or supermarket`);

const ITEMS = [
  { name: 'Milk 500ml', sku: 'MILK500', baseUnit: 'pc', prices: { retail: 6500 }, costCents: 4800, qty: 120, barcode: '6161100100011', department: 'Dairy' },
  { name: 'Bread 400g', sku: 'BREAD400', baseUnit: 'pc', prices: { retail: 6500 }, costCents: 5200, qty: 60, barcode: '6161100100028', department: 'Bakery' },
  { name: 'Sugar 1kg', sku: 'SUGAR1', baseUnit: 'pc', prices: { retail: 18000, wholesale: 17000 }, costCents: 15500, qty: 80, department: 'Groceries', units: [{ code: 'pc', name: 'Piece', factor: 1 }, { code: 'bale', name: 'Bale (12)', factor: 12 }] },
  { name: 'Maize flour 2kg', sku: 'UNGA2', baseUnit: 'pc', prices: { retail: 17500, wholesale: 16500 }, costCents: 14800, qty: 100, barcode: '6161100100035', department: 'Groceries' },
  { name: 'Cooking oil 1L', sku: 'OIL1', baseUnit: 'pc', prices: { retail: 32000 }, costCents: 27000, qty: 48, department: 'Groceries' },
  { name: 'Soda 500ml', sku: 'SODA500', baseUnit: 'pc', prices: { retail: 7000 }, costCents: 4500, qty: 96, department: 'Beverages', units: [{ code: 'pc', name: 'Piece', factor: 1 }, { code: 'crate', name: 'Crate (24)', factor: 24 }] },
  { name: 'Tomatoes (per kg)', sku: 'TOM-KG', baseUnit: 'kg', allowFractional: true, soldByWeight: true, plu: '101', prices: { retail: 12000 }, costCents: 8000, qty: 40, department: 'Fresh produce' },
];

await withDb(async () => {
  const { tenant, owner } = await provisionTenant({ businessName: `Demo ${type}`, businessType: type, ownerName: 'Demo Owner', email: 'owner@demo.shop', password: 'DemoPass123', country: 'KE', currency: 'KES', timezone: 'Africa/Nairobi' });
  await runInTenant(tenant._id, async () => {
    const wh = (await Warehouse.findOne({ isDefault: true }))!;
    for (const it of ITEMS) {
      await withTransaction(async () => {
        const { qty, barcode, department, ...rest } = it as any;
        const [p] = await Product.create([{ ...rest, attributes: { department }, units: rest.units ?? [{ code: rest.baseUnit, name: rest.baseUnit, factor: 1 }], barcodes: barcode ? [{ code: barcode, unitCode: rest.baseUnit }] : [], reorderLevel: 10 }]);
        await applyMovement({ product: p, productId: p._id, warehouseId: wh._id, qty, type: 'opening', unitCostCents: rest.costCents, reason: 'Demo opening stock', userId: owner._id });
      });
    }
    await Supplier.create({ code: 'S00001', name: 'Demo Distributors Ltd', phone: '0700000001' });
    await Customer.create({ code: 'C00001', name: 'Demo Credit Customer', phone: '0700000002', creditLimitCents: 5_000_000, kind: 'wholesale', priceList: 'wholesale' });
  });
  console.log('Demo business created. Sign in as owner@demo.shop / DemoPass123');
});
