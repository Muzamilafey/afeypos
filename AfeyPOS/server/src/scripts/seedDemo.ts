// Creates a demo tenant with products, a supplier and a customer. Usage: npm run seed:demo -w @afeypos/server -- [businessType] [subdomain]
import { withDb } from './cli.js';
import { provisionTenant } from '../modules/tenants/provisioning.js';
import { runInTenant } from '../lib/context.js';
import { Customer, Product, Supplier, Warehouse } from '../models/index.js';
import { applyMovement } from '../modules/inventory/stock.js';
import { withTransaction } from '../db/connection.js';
import { BUSINESS_TYPES, type BusinessType } from '@afeypos/shared';

const type = (process.argv[2] ?? 'minimart') as BusinessType;
if (!BUSINESS_TYPES.includes(type)) throw new Error(`Unknown business type ${type}`);
const slug = process.argv[3] ?? `demo-${type}`;

await withDb(async () => {
  const { tenant, owner } = await provisionTenant({ businessName: `Demo ${type}`, businessType: type, subdomain: slug, ownerName: 'Demo Owner', email: `owner@${slug}.demo`, password: 'DemoPass123', country: 'KE', currency: 'KES', timezone: 'Africa/Nairobi', planCode: 'business' });
  await runInTenant(tenant._id, async () => {
    const wh = (await Warehouse.findOne({ isDefault: true }))!;
    const items = type === 'hardware'
      ? [
          { name: 'Cement 50kg (Bamburi)', sku: 'CEM50', baseUnit: 'bag', prices: { retail: 85000, contractor: 80000, wholesale: 78000 }, costCents: 72000, qty: 200 },
          { name: 'Iron sheet 3m gauge 30', sku: 'IS30-3', baseUnit: 'sheet', prices: { retail: 95000, contractor: 90000 }, costCents: 78000, qty: 120 },
          { name: 'PVC pipe 1/2"', sku: 'PVC12', baseUnit: 'm', allowFractional: true, units: [{ code: 'm', name: 'Metre', factor: 1 }, { code: 'ft', name: 'Foot', factor: 0.3048 }, { code: 'len', name: 'Length (6 m)', factor: 6 }], prices: { retail: 12000 }, costCents: 7000, qty: 600 },
        ]
      : [
          { name: 'Milk 500ml', sku: 'MILK500', baseUnit: 'pc', prices: { retail: 6500 }, costCents: 4800, qty: 120, barcode: '6161100100011' },
          { name: 'Bread 400g', sku: 'BREAD400', baseUnit: 'pc', prices: { retail: 6500 }, costCents: 5200, qty: 60, barcode: '6161100100028' },
          { name: 'Sugar 1kg', sku: 'SUGAR1', baseUnit: 'pc', prices: { retail: 18000, wholesale: 17000 }, costCents: 15500, qty: 80, units: [{ code: 'pc', name: 'Piece', factor: 1 }, { code: 'bale', name: 'Bale (12)', factor: 12 }] },
          { name: 'Soda 500ml', sku: 'SODA500', baseUnit: 'pc', prices: { retail: 7000 }, costCents: 4500, qty: 96, units: [{ code: 'pc', name: 'Piece', factor: 1 }, { code: 'crate', name: 'Crate (24)', factor: 24 }] },
        ];
    for (const it of items) {
      await withTransaction(async () => {
        const { qty, barcode, ...rest } = it as any;
        const [p] = await Product.create([{ ...rest, units: rest.units ?? [{ code: rest.baseUnit, name: rest.baseUnit, factor: 1 }], barcodes: barcode ? [{ code: barcode, unitCode: rest.baseUnit }] : [], reorderLevel: 10 }]);
        await applyMovement({ product: p, productId: p._id, warehouseId: wh._id, qty, type: 'opening', unitCostCents: rest.costCents, reason: 'Demo opening stock', userId: owner._id });
      });
    }
    await Supplier.create({ code: 'S00001', name: 'Demo Distributors Ltd', phone: '0700000001' });
    await Customer.create({ code: 'C00001', name: 'Demo Credit Customer', phone: '0700000002', creditLimitCents: 5_000_000, kind: 'wholesale', priceList: 'wholesale' });
  });
  console.log(`Demo tenant "${slug}" created. Sign in as owner@${slug}.demo / DemoPass123`);
});
