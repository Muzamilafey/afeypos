import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { normalizeIsbn, PRICE_LISTS, parseVariableWeightBarcode, PRODUCT_FIELDS, type VariableWeightConfig } from '@afeypos/shared';
import { Brand, Category, CustomerPrice, Product, Promotion, StockLevel, Warehouse } from '../../models/index.js';
import { escapeRegex, idParam, objectId, pagination, parse, positiveCents } from '../../http/validate.js';
import { requireModule, requirePermission } from '../../http/auth.js';
import { withTransaction } from '../../db/connection.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { applyMovement } from '../inventory/stock.js';
import { quotePrice } from './pricing.js';
import { parseCsv, toCsv } from '../../lib/csv.js';
import { recordTombstone } from '../sync/hq.js';

const router = Router();

const priceMap = z.object({ retail: positiveCents.nullish(), wholesale: positiveCents.nullish(), contractor: positiveCents.nullish() }).partial();

const unitSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(40),
  factor: z.number().positive().max(1e6),
  prices: priceMap.default({}),
  isDefaultSale: z.boolean().optional(),
  isDefaultPurchase: z.boolean().optional(),
});

const productSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(64),
  type: z.enum(['stock', 'service', 'non_stock']).default('stock'),
  categoryId: objectId.nullish(),
  brandId: objectId.nullish(),
  description: z.string().max(2000).optional(),
  images: z.array(z.string().url().or(z.string().regex(/^\/api\/v1\/files\/[a-f0-9]{32}\.(png|jpg|webp)$/))).max(10).optional(),
  baseUnit: z.string().trim().min(1).max(20).default('pc'),
  units: z.array(unitSchema).max(20).default([]),
  barcodes: z.array(z.object({ code: z.string().trim().min(3).max(64), unitCode: z.string().trim().min(1).max(20) })).max(50).default([]),
  costCents: positiveCents.default(0),
  prices: priceMap.default({}),
  priceTiers: z.array(z.object({ priceList: z.enum(PRICE_LISTS), minQty: z.number().positive(), priceCents: positiveCents })).max(20).default([]),
  minOrderQty: z.number().nonnegative().default(0),
  taxRateBp: z.number().int().min(0).max(10000).nullish(),
  trackStock: z.boolean().default(true),
  trackBatches: z.boolean().default(false),
  trackSerials: z.boolean().default(false),
  allowFractional: z.boolean().default(false),
  reorderLevel: z.number().nonnegative().default(0),
  reorderQty: z.number().nonnegative().default(0),
  attributes: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
  warrantyMonths: z.number().int().min(0).max(240).default(0),
  requiresPrescription: z.boolean().default(false),
  ageRestricted: z.boolean().default(false),
  minAge: z.number().int().min(0).max(30).default(18),
  soldByWeight: z.boolean().default(false),
  plu: z.string().trim().regex(/^\d{1,6}$/).nullish(),
  parentId: objectId.nullish(),
  variantAttributes: z.record(z.string(), z.string().max(60)).optional(),
  active: z.boolean().default(true),
});

const createSchema = productSchema.extend({
  openingStock: z.array(z.object({ warehouseId: objectId, qty: z.number().positive(), unitCostCents: positiveCents.optional(), batchNo: z.string().optional(), expiryDate: z.coerce.date().optional(), serials: z.array(z.string()).optional() })).max(50).optional(),
});

type ProductInput = z.infer<typeof productSchema>;

/** Normalises units (base unit always present with factor 1) and checks barcode unit references. */
function normalizeProduct(p: ProductInput, caps: { productFields: readonly string[]; modules: readonly string[] }) {
  const units = p.units.filter((u) => u.code !== p.baseUnit);
  const base = p.units.find((u) => u.code === p.baseUnit);
  if (base && base.factor !== 1) throw badRequest('The base unit must have a conversion factor of 1');
  units.unshift({ code: p.baseUnit, name: base?.name ?? p.baseUnit, factor: 1, prices: base?.prices ?? {}, isDefaultSale: base?.isDefaultSale, isDefaultPurchase: base?.isDefaultPurchase });
  const codes = new Set(units.map((u) => u.code));
  if (codes.size !== units.length) throw badRequest('Unit codes must be unique');
  for (const b of p.barcodes) if (!codes.has(b.unitCode)) throw badRequest(`Barcode ${b.code} references unknown unit ${b.unitCode}`);
  if (new Set(p.barcodes.map((b) => b.code)).size !== p.barcodes.length) throw badRequest('Duplicate barcodes');
  if (p.trackSerials && p.allowFractional) throw badRequest('Serialised products cannot use fractional quantities');
  if (p.trackSerials && !caps.modules.includes('serialNumbers')) throw badRequest('Enable the serial numbers module first');
  if (p.trackBatches && !caps.modules.includes('batchExpiry')) throw badRequest('Enable the batches & expiry module first');
  const attributes = Object.fromEntries(Object.entries(p.attributes).filter(([k]) => (PRODUCT_FIELDS as readonly string[]).includes(k) || k.startsWith('custom_')));
  const trackStock = p.type === 'stock' ? p.trackStock : false;
  return { ...p, units, attributes, trackStock };
}


// ---- categories & brands ----
router.get('/categories', requirePermission('products.read'), async (_req, res) => {
  res.json({ data: await Category.find({}).sort({ sortOrder: 1, name: 1 }).lean() });
});
router.post('/categories', requirePermission('products.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(80), parentId: objectId.nullish(), color: z.string().max(20).optional(), sortOrder: z.number().int().default(0) }), req.body);
  res.status(201).json({ data: await Category.create(body) });
});
router.patch('/categories/:id', requirePermission('products.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(80), parentId: objectId.nullish(), color: z.string().max(20), sortOrder: z.number().int(), active: z.boolean() }).partial(), req.body);
  const c = await Category.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: body }, { new: true });
  if (!c) throw notFound('Category');
  res.json({ data: c });
});
router.get('/brands', requirePermission('products.read'), async (_req, res) => {
  res.json({ data: await Brand.find({}).sort({ name: 1 }).lean() });
});
router.post('/brands', requirePermission('products.manage'), async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
  res.status(201).json({ data: await Brand.create(body) });
});

// ---- products ----
router.get('/products', requirePermission('products.read'), async (req, res) => {
  const q = parse(pagination.extend({ categoryId: objectId.optional(), active: z.enum(['true', 'false']).optional(), type: z.string().optional(), lowStock: z.enum(['true']).optional(), warehouseId: objectId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.categoryId) filter.categoryId = q.categoryId;
  if (q.active) filter.active = q.active === 'true';
  if (q.type) filter.type = q.type;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const isbn = normalizeIsbn(q.q);
    filter.$or = [{ name: rx }, { sku: rx }, { 'barcodes.code': q.q }, { plu: q.q }, { 'attributes.department': rx }, ...(isbn ? [{ 'barcodes.code': isbn }] : [])];
  }
  const [rows, total] = await Promise.all([
    Product.find(filter).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Product.countDocuments(filter),
  ]);
  const levels = await StockLevel.find({ productId: { $in: rows.map((r) => r._id) }, ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}) }).lean();
  const byProduct = new Map<string, { qty: number; reserved: number }>();
  for (const l of levels) {
    const cur = byProduct.get(String(l.productId)) ?? { qty: 0, reserved: 0 };
    cur.qty += l.qty;
    cur.reserved += l.reserved ?? 0;
    byProduct.set(String(l.productId), cur);
  }
  const data = rows.map((r) => ({ ...r, stock: byProduct.get(String(r._id)) ?? { qty: 0, reserved: 0 } }));
  res.json({ data: q.lowStock ? data.filter((d) => d.trackStock && d.stock.qty <= d.reorderLevel) : data, total, page: q.page, limit: q.limit });
});

/**
 * Checkout lookup: exact barcode (including variable-weight scale barcodes), PLU or SKU.
 * Returns the product, the matched unit and, for scale barcodes, the embedded quantity/price.
 */
router.get('/products/lookup', requirePermission('products.read'), async (req, res) => {
  const { code, warehouseId } = parse(z.object({ code: z.string().trim().min(1).max(64), warehouseId: objectId.optional() }), req.query);
  let product = await Product.findOne({ 'barcodes.code': code, active: true }).lean();
  let unitCode = product?.barcodes.find((b) => b.code === code)?.unitCode;
  let weighed: { qty?: number; priceCents?: number } | undefined;
  if (!product && req.capabilities!.modules.includes('weighedItems')) {
    const parsed = parseVariableWeightBarcode(code, req.tenant!.settings!.variableWeight as unknown as VariableWeightConfig);
    if (parsed) {
      product = await Product.findOne({ plu: String(Number(parsed.itemCode)), active: true }).lean() ?? await Product.findOne({ plu: parsed.itemCode, active: true }).lean();
      if (product) {
        unitCode = product.baseUnit;
        weighed = parsed.weight !== undefined ? { qty: parsed.weight } : { priceCents: parsed.priceCents };
      }
    }
  }
  if (!product) {
    // ISBN typed with hyphens or as ISBN-10 (older books print ISBN-10 only).
    const isbn = normalizeIsbn(code);
    if (isbn && isbn !== code) {
      product = await Product.findOne({ 'barcodes.code': isbn, active: true }).lean();
      unitCode = product?.barcodes.find((b) => b.code === isbn)?.unitCode;
    }
  }
  if (!product) product = await Product.findOne({ $or: [{ sku: code }, { plu: code }], active: true }).lean();
  if (!product) throw notFound('Product');
  const stock = warehouseId ? await StockLevel.findOne({ productId: product._id, warehouseId }).lean() : null;
  res.json({ data: { product, unitCode: unitCode ?? product.baseUnit, weighed, stock: stock ? { qty: stock.qty, reserved: stock.reserved } : null } });
});

router.get('/products/:id', requirePermission('products.read'), async (req, res) => {
  const p = await Product.findById(idParam(req.params.id)).lean();
  if (!p) throw notFound('Product');
  const levels = await StockLevel.find({ productId: p._id }).lean();
  const variants = await Product.find({ parentId: p._id }, { name: 1, sku: 1, variantAttributes: 1 }).lean();
  res.json({ data: { ...p, levels, variants } });
});

router.post('/products/:id/quote', requirePermission('products.read'), async (req, res) => {
  const body = parse(z.object({ unitCode: z.string().optional(), qty: z.number().positive(), priceList: z.enum(PRICE_LISTS).default('retail'), customerId: objectId.optional(), branchId: objectId.optional(), couponCode: z.string().optional() }), req.body);
  const product = await Product.findById(idParam(req.params.id));
  if (!product) throw notFound('Product');
  res.json({ data: await quotePrice({ product, ...body }) });
});

router.post('/products', requirePermission('products.manage'), async (req, res) => {
  const input = parse(createSchema, req.body);
  const { openingStock, ...rest } = input;
  const data = normalizeProduct(rest, req.capabilities!);
  const product = await withTransaction(async () => {
    const [p] = await Product.create([data]);
    for (const os of openingStock ?? []) {
      if (!(await Warehouse.exists({ _id: os.warehouseId }))) throw notFound('Warehouse');
      await applyMovement({ product: p, productId: p._id, warehouseId: os.warehouseId, qty: os.qty, type: 'opening', unitCostCents: os.unitCostCents ?? p.costCents, reason: 'Opening stock', ref: { type: 'Product', id: p._id, number: p.sku }, userId: req.auth!.userId, batchNo: os.batchNo, expiryDate: os.expiryDate, serials: os.serials });
    }
    await audit(req, { action: 'product.created', entity: 'Product', entityId: p._id, details: { sku: p.sku } });
    return p;
  });
  res.status(201).json({ data: product });
});

router.put('/products/:id', requirePermission('products.manage'), async (req, res) => {
  const id = idParam(req.params.id);
  const input = parse(productSchema, req.body);
  const before = await Product.findById(id).lean();
  if (!before) throw notFound('Product');
  if (JSON.stringify(before.prices) !== JSON.stringify(input.prices) && !req.auth!.permissions.has('prices.manage')) throw badRequest('You need the prices.manage permission to change prices');
  const data = normalizeProduct(input, req.capabilities!);
  if (before.trackSerials !== data.trackSerials || before.trackBatches !== data.trackBatches) {
    const hasStock = await StockLevel.exists({ productId: id, qty: { $ne: 0 } });
    if (hasStock) throw badRequest('Batch/serial tracking can only be changed when the product has no stock');
  }
  const p = await Product.findOneAndUpdate({ _id: id }, { $set: data }, { new: true, runValidators: true });
  await audit(req, { action: 'product.updated', entity: 'Product', entityId: id, details: { pricesBefore: before.prices, pricesAfter: data.prices, costBefore: before.costCents, costAfter: data.costCents } });
  res.json({ data: p });
});

router.delete('/products/:id', requirePermission('products.manage'), async (req, res) => {
  // Products are archived, never deleted, to preserve history.
  const p = await Product.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: { active: false } }, { new: true });
  if (!p) throw notFound('Product');
  await audit(req, { action: 'product.archived', entity: 'Product', entityId: p._id });
  res.json({ data: p });
});

// ---- customer-specific pricing ----
router.get('/customer-prices', requirePermission('products.read'), requireModule('customerPricing'), async (req, res) => {
  const { customerId, productId } = parse(z.object({ customerId: objectId.optional(), productId: objectId.optional() }), req.query);
  res.json({ data: await CustomerPrice.find({ ...(customerId ? { customerId } : {}), ...(productId ? { productId } : {}) }).lean() });
});
router.put('/customer-prices', requirePermission('prices.manage'), requireModule('customerPricing'), async (req, res) => {
  const body = parse(z.object({ customerId: objectId, productId: objectId, unitCode: z.string(), priceCents: positiveCents }), req.body);
  const r = await CustomerPrice.findOneAndUpdate({ customerId: body.customerId, productId: body.productId, unitCode: body.unitCode }, { $set: { priceCents: body.priceCents } }, { upsert: true, new: true });
  await audit(req, { action: 'price.customer_set', entity: 'CustomerPrice', entityId: r!._id, details: body });
  res.json({ data: r });
});
router.delete('/customer-prices/:id', requirePermission('prices.manage'), requireModule('customerPricing'), async (req, res) => {
  const id = idParam(req.params.id);
  await CustomerPrice.deleteOne({ _id: id });
  await recordTombstone(CustomerPrice.collection.collectionName, id);
  res.json({ ok: true });
});

// ---- promotions ----
const promoSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['percent', 'fixed_price']),
  value: z.number().int().positive(),
  productIds: z.array(objectId).default([]),
  categoryIds: z.array(objectId).default([]),
  branchIds: z.array(objectId).default([]),
  couponCode: z.string().trim().toUpperCase().max(40).nullish(),
  minQty: z.number().nonnegative().default(0),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  active: z.boolean().default(true),
  maxUses: z.number().int().positive().nullish(),
});
router.get('/promotions', requirePermission('products.read'), requireModule('promotions'), async (_req, res) => {
  res.json({ data: await Promotion.find({}).sort({ createdAt: -1 }).lean() });
});
router.post('/promotions', requirePermission('prices.manage'), requireModule('promotions'), async (req, res) => {
  const body = parse(promoSchema, req.body);
  if (body.kind === 'percent' && body.value > 10000) throw badRequest('Percent promotions are in basis points (max 10000)');
  const p = await Promotion.create(body);
  await audit(req, { action: 'promotion.created', entity: 'Promotion', entityId: p._id });
  res.status(201).json({ data: p });
});
router.patch('/promotions/:id', requirePermission('prices.manage'), requireModule('promotions'), async (req, res) => {
  const body = parse(promoSchema.partial(), req.body);
  const p = await Promotion.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: body }, { new: true });
  if (!p) throw notFound('Promotion');
  res.json({ data: p });
});

// ---- CSV import / export ----
router.get('/products-export.csv', requirePermission('products.read'), async (_req, res) => {
  const products = await Product.find({}).sort({ sku: 1 }).lean();
  const cats = new Map((await Category.find({}).lean()).map((c) => [String(c._id), c.name]));
  const rows = products.map((p) => ({
    sku: p.sku, name: p.name, type: p.type, category: p.categoryId ? cats.get(String(p.categoryId)) ?? '' : '', baseUnit: p.baseUnit,
    barcode: p.barcodes.find((b) => b.unitCode === p.baseUnit)?.code ?? '', cost: (p.costCents ?? 0) / 100,
    retail: (p.prices?.retail ?? 0) / 100, wholesale: p.prices?.wholesale ? p.prices.wholesale / 100 : '', contractor: p.prices?.contractor ? p.prices.contractor / 100 : '',
    taxRatePercent: p.taxRateBp === null || p.taxRateBp === undefined ? '' : p.taxRateBp / 100, reorderLevel: p.reorderLevel, active: p.active,
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
  res.send(toCsv(rows));
});

/** Imports products from CSV (create or update by SKU). Dry-run by default; returns per-row results. */
router.post('/products-import', requirePermission('products.manage'), async (req, res) => {
  const body = parse(z.object({ csv: z.string().min(1).max(5_000_000), commit: z.boolean().default(false) }), req.body);
  const rows = parseCsv(body.csv);
  if (rows.length > 10000) throw badRequest('Import at most 10,000 rows at a time');
  const cats = new Map((await Category.find({}).lean()).map((c) => [c.name.toLowerCase(), c._id]));
  const results: { row: number; sku: string; action: 'create' | 'update' | 'error'; error?: string }[] = [];
  const toMoney = (v: string | undefined) => (v === undefined || v === '' ? undefined : Math.round(Number(v) * 100));
  const prepared: { sku: string; data: Record<string, unknown>; exists: boolean }[] = [];
  for (const [i, r] of rows.entries()) {
    const sku = (r.sku ?? '').trim();
    try {
      if (!sku || !r.name) throw new Error('sku and name are required');
      const nums = ['cost', 'retail', 'wholesale', 'contractor', 'taxRatePercent', 'reorderLevel'].filter((k) => r[k] && Number.isNaN(Number(r[k])));
      if (nums.length) throw new Error(`invalid number in ${nums.join(', ')}`);
      let categoryId: Types.ObjectId | undefined;
      if (r.category) {
        categoryId = cats.get(r.category.toLowerCase());
        if (!categoryId && body.commit) {
          const c = await Category.create({ name: r.category });
          categoryId = c._id;
          cats.set(r.category.toLowerCase(), c._id);
        }
      }
      const baseUnit = r.baseUnit || 'pc';
      const data: Record<string, unknown> = {
        name: r.name, type: ['stock', 'service', 'non_stock'].includes(r.type) ? r.type : 'stock', baseUnit, categoryId,
        costCents: toMoney(r.cost) ?? 0,
        prices: { retail: toMoney(r.retail) ?? 0, wholesale: toMoney(r.wholesale), contractor: toMoney(r.contractor) },
        taxRateBp: r.taxRatePercent === undefined || r.taxRatePercent === '' ? null : Math.round(Number(r.taxRatePercent) * 100),
        reorderLevel: Number(r.reorderLevel || 0),
        active: r.active === undefined || r.active === '' ? true : r.active.toLowerCase() !== 'false',
      };
      if (r.barcode) data.barcodes = [{ code: r.barcode, unitCode: baseUnit }];
      const exists = Boolean(await Product.exists({ sku }));
      prepared.push({ sku, data, exists });
      results.push({ row: i + 2, sku, action: exists ? 'update' : 'create' });
    } catch (e: any) {
      results.push({ row: i + 2, sku, action: 'error', error: e.message });
    }
  }
  const errors = results.filter((r) => r.action === 'error').length;
  if (body.commit && errors === 0) {
    await withTransaction(async () => {
      for (const p of prepared) {
        if (p.exists) await Product.updateOne({ sku: p.sku }, { $set: p.data });
        else await Product.create([{ sku: p.sku, units: [{ code: p.data.baseUnit, name: p.data.baseUnit, factor: 1 }], ...p.data }]);
      }
    });
    await audit(req, { action: 'product.imported', details: { rows: prepared.length } });
  }
  res.json({ data: { committed: body.commit && errors === 0, errors, results } });
});

export const catalogRoutes = router;
