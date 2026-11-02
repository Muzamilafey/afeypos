import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  INTERNAL_BARCODE_PREFIX, SCALE_FORMAT_PRESETS, effectiveScaleFormats, internalEan13, nextFreePlu, skuPrefix, validateScaleFormats,
  type ScaleBarcodeFormat, type VariableWeightConfig,
} from '@afeypos/shared';
import { Category, Counter, Product, StockLevel, Tenant } from '../../models/index.js';
import { escapeRegex, objectId, parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { runAsPlatform } from '../../lib/context.js';
import { env } from '../../config/env.js';

/** Scale label formats in force for this business (configured list, else the older single layout). */
export function scaleFormatsFor(req: Request): ScaleBarcodeFormat[] {
  const s = req.tenant!.settings ?? {};
  const configured = (s as { scaleBarcodeFormats?: ScaleBarcodeFormat[] }).scaleBarcodeFormats;
  // The older layout only applied with the weighed-items module; a configured list is an explicit choice.
  if (configured?.length) return configured;
  if (!req.capabilities!.modules.includes('weighedItems')) return [];
  return effectiveScaleFormats(null, s.variableWeight as unknown as VariableWeightConfig);
}

const formatSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean(),
  prefix: z.string().regex(/^\d{1,3}$/),
  length: z.union([z.literal(12), z.literal(13)]),
  itemStart: z.number().int().min(0).max(12),
  itemLength: z.number().int().min(1).max(8),
  valueStart: z.number().int().min(0).max(12),
  valueLength: z.number().int().min(1).max(8),
  valueType: z.enum(['weight', 'price']),
  valueDecimals: z.number().int().min(0).max(3),
  verifyCheckDigit: z.boolean(),
});

const router = Router();

router.get('/settings/scale-barcodes', requirePermission('products.read'), async (req, res) => {
  const s = (req.tenant!.settings ?? {}) as { scaleBarcodeFormats?: ScaleBarcodeFormat[]; internalBarcodePrefix?: string };
  res.json({ data: {
    formats: scaleFormatsFor(req),
    configured: Boolean(s.scaleBarcodeFormats?.length),
    presets: SCALE_FORMAT_PRESETS,
    internalPrefix: s.internalBarcodePrefix ?? INTERNAL_BARCODE_PREFIX,
  } });
});

router.put('/settings/scale-barcodes', requirePermission('settings.manage'), async (req, res) => {
  const body = parse(z.object({ formats: z.array(formatSchema).max(20), internalPrefix: z.string().regex(/^(02|04|2\d)$/, 'Use a GS1 restricted-circulation prefix: 02, 04 or 20-29').optional() }), req.body);
  if (new Set(body.formats.map((f) => f.id)).size !== body.formats.length) throw badRequest('Each format needs its own id');
  const problems = validateScaleFormats(body.formats);
  if (problems.length) throw new AppError(422, 'INVALID_SCALE_FORMAT', problems.join('; '));
  const prefix = body.internalPrefix ?? (req.tenant!.settings as { internalBarcodePrefix?: string })?.internalBarcodePrefix ?? INTERNAL_BARCODE_PREFIX;
  const clash = body.formats.find((f) => f.enabled && (f.prefix.startsWith(prefix) || prefix.startsWith(f.prefix)));
  if (clash) throw new AppError(422, 'INVALID_SCALE_FORMAT', `${clash.name} reads codes starting ${clash.prefix}, which internal barcodes (${prefix}) also use: pick another prefix`);
  await runAsPlatform(() => Tenant.updateOne({ _id: req.tenant!._id }, { $set: { 'settings.scaleBarcodeFormats': body.formats, 'settings.internalBarcodePrefix': prefix } }));
  await audit(req, { action: 'settings.scale_barcodes_updated', entity: 'Tenant', entityId: req.tenant!._id, details: { formats: body.formats.map((f) => `${f.name} (${f.prefix})`), internalPrefix: prefix } });
  res.json({ data: { formats: body.formats, configured: body.formats.length > 0, presets: SCALE_FORMAT_PRESETS, internalPrefix: prefix } });
});

/** Codes already on a product (or another spelling of them). */
async function barcodeTaken(code: string) {
  return Boolean(await Product.exists({ $or: [{ 'barcodes.code': code }, { sku: code }] }));
}

/**
 * Internal in-store barcodes for products without a manufacturer barcode. EAN-13 with a restricted-circulation
 * prefix on head office / single-server installs; on a branch server Code 128 carrying the branch code, so two
 * servers numbering on their own can never hand out the same code. Never a GS1-registered GTIN.
 */
router.post('/barcodes/generate', requirePermission('products.manage'), async (req, res) => {
  const { count } = parse(z.object({ count: z.number().int().min(1).max(200).default(1) }), req.body ?? {});
  const e = env();
  const branch = e.DEPLOYMENT_MODE === 'branch' && e.BRANCH_CODE ? e.BRANCH_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const prefix = (req.tenant!.settings as { internalBarcodePrefix?: string })?.internalBarcodePrefix ?? INTERNAL_BARCODE_PREFIX;
  const formats = scaleFormatsFor(req);
  const codes: string[] = [];
  for (let guard = 0; codes.length < count && guard < count + 1000; guard++) {
    const c = await Counter.findOneAndUpdate({ key: branch ? `internal-barcode-${branch}` : 'internal-barcode' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    let code: string;
    try {
      code = branch ? `AFY${branch}${String(c!.seq).padStart(6, '0')}` : internalEan13(c!.seq, prefix, formats);
    } catch (err) {
      throw new AppError(422, 'BARCODE_PREFIX', (err as Error).message);
    }
    if (!(await barcodeTaken(code))) codes.push(code);
  }
  res.json({ data: { codes, format: branch ? 'Code 128' : 'EAN-13', internal: true, note: 'In-store code: valid only inside this business, not a registered GTIN.' } });
});

/** Next SKU for a category (or product name): PREFIX-0001, one past the highest one in use. */
router.get('/catalog/next-sku', requirePermission('products.read'), async (req, res) => {
  const q = parse(z.object({ categoryId: objectId.optional(), name: z.string().max(200).optional() }), req.query);
  const cat = q.categoryId ? await Category.findById(q.categoryId, { name: 1 }).lean() : null;
  const prefix = skuPrefix(cat?.name ?? q.name);
  const rx = new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`);
  const used = await Product.find({ sku: { $regex: rx } }, { sku: 1 }).lean();
  const max = used.reduce((m, p) => Math.max(m, Number(rx.exec(p.sku)?.[1] ?? 0)), 0);
  let n = max + 1;
  while (await Product.exists({ sku: `${prefix}-${String(n).padStart(4, '0')}` })) n++;
  res.json({ data: { sku: `${prefix}-${String(n).padStart(4, '0')}`, prefix } });
});

/** Lowest free PLU (scale item number), and whether a given PLU is free. */
router.get('/catalog/next-plu', requirePermission('products.read'), async (req, res) => {
  const q = parse(z.object({ check: z.string().regex(/^\d{1,6}$/).optional(), max: z.coerce.number().int().min(9).max(999999).default(99999) }), req.query);
  const used = (await Product.distinct('plu', { plu: { $type: 'string' } })) as string[];
  const taken = q.check ? await Product.findOne({ plu: { $in: [q.check, String(Number(q.check))] } }, { name: 1, sku: 1 }).lean() : null;
  res.json({ data: { plu: nextFreePlu(used, q.max), check: q.check ? { plu: q.check, free: !taken, product: taken } : undefined } });
});

const STOP = new Set(['the', 'and', 'for', 'with', 'of', 'a', 'pc', 'pcs', 'kg', 'g', 'ml', 'l', 'ltr', 'pack']);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+(ml|g|kg|l)?$/.test(w));

/**
 * Possible duplicates while creating a product: same barcode or SKU (exact), or names sharing words.
 * Also suggests categories from the closest matches. Suggestions only: nothing is changed.
 */
router.get('/catalog/similar', requirePermission('products.read'), async (req, res) => {
  const q = parse(z.object({ name: z.string().trim().max(200).optional(), barcode: z.string().trim().max(64).optional(), sku: z.string().trim().max(64).optional(), excludeId: objectId.optional() }), req.query);
  const not = q.excludeId ? { _id: { $ne: q.excludeId } } : {};
  const exact = (q.barcode || q.sku)
    ? await Product.find({ ...not, $or: [...(q.barcode ? [{ 'barcodes.code': q.barcode }] : []), ...(q.sku ? [{ sku: q.sku }] : [])] }, { name: 1, sku: 1, barcodes: 1, categoryId: 1, active: 1 }).limit(5).lean()
    : [];
  const terms = words(q.name ?? '').slice(0, 6);
  const near = terms.length
    ? await Product.find({ ...not, $or: terms.map((t) => ({ name: new RegExp(`\\b${escapeRegex(t)}`, 'i') })) }, { name: 1, sku: 1, barcodes: 1, categoryId: 1, active: 1, prices: 1 }).limit(60).lean()
    : [];
  const scored = near
    .map((p) => {
      const pw = new Set(words(p.name));
      const hits = terms.filter((t) => [...pw].some((w) => w.startsWith(t))).length;
      return { p, score: hits / Math.max(terms.length, pw.size) };
    })
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const catCount = new Map<string, number>();
  for (const { p } of scored) if (p.categoryId) catCount.set(String(p.categoryId), (catCount.get(String(p.categoryId)) ?? 0) + 1);
  const cats = catCount.size ? await Category.find({ _id: { $in: [...catCount.keys()] } }, { name: 1 }).lean() : [];
  res.json({ data: {
    exact: exact.map((p) => ({ _id: p._id, name: p.name, sku: p.sku, active: p.active, matched: q.barcode && p.barcodes?.some((b) => b.code === q.barcode) ? 'barcode' : 'sku' })),
    similar: scored.map(({ p, score }) => ({ _id: p._id, name: p.name, sku: p.sku, active: p.active, retailCents: p.prices?.retail ?? null, score: Math.round(score * 100) })),
    categories: cats.map((c) => ({ _id: c._id, name: c.name, count: catCount.get(String(c._id)) ?? 0 })).sort((a, b) => b.count - a.count),
  } });
});

export const barcodeRoutes = router;

// ---- product management dashboard and bulk actions ----

/** Catalogue health: what needs attention (no barcode, no price, below cost, weighed without PLU, low stock...). */
router.get('/catalog/stats', requirePermission('products.read'), async (_req, res) => {
  const [total, active, noBarcode, noPrice, noCategory, weighedNoPlu, belowCost, internal, low] = await Promise.all([
    Product.countDocuments({}),
    Product.countDocuments({ active: true }),
    Product.countDocuments({ active: true, type: 'stock', $or: [{ barcodes: { $size: 0 } }, { barcodes: { $exists: false } }] }),
    Product.countDocuments({ active: true, $or: [{ 'prices.retail': null }, { 'prices.retail': { $exists: false } }, { 'prices.retail': 0 }] }),
    Product.countDocuments({ active: true, $or: [{ categoryId: null }, { categoryId: { $exists: false } }] }),
    Product.countDocuments({ active: true, soldByWeight: true, $or: [{ plu: null }, { plu: { $exists: false } }] }),
    Product.countDocuments({ active: true, costCents: { $gt: 0 }, $expr: { $gt: ['$costCents', { $ifNull: ['$prices.retail', 0] }] }, 'prices.retail': { $gt: 0 } }),
    Product.countDocuments({ 'barcodes.code': { $regex: /^(04\d{11}|AFY)/ } }),
    Product.aggregate([
      { $match: { active: true, trackStock: true, type: 'stock' } },
      { $lookup: { from: StockLevel.collection.collectionName, localField: '_id', foreignField: 'productId', as: 'levels' } },
      { $match: { $expr: { $lte: [{ $sum: '$levels.qty' }, '$reorderLevel'] } } },
      { $count: 'n' },
    ]),
  ]);
  res.json({ data: { total, active, archived: total - active, noBarcode, noPrice, noCategory, weighedNoPlu, belowCost, internalBarcodes: internal, lowStock: low[0]?.n ?? 0 } });
});

const bulkSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate-barcodes'), productIds: z.array(objectId).min(1).max(500) }),
  z.object({ action: z.literal('assign-plus'), productIds: z.array(objectId).min(1).max(500) }),
  z.object({ action: z.literal('update-prices'), productIds: z.array(objectId).min(1).max(500), mode: z.enum(['percent', 'amount']), value: z.number().int().min(-100000000).max(100000000), roundTo: z.number().int().min(1).max(10000).default(1), dryRun: z.boolean().default(true) }),
  z.object({ action: z.literal('set-category'), productIds: z.array(objectId).min(1).max(500), categoryId: objectId.nullable() }),
  z.object({ action: z.enum(['archive', 'activate']), productIds: z.array(objectId).min(1).max(500) }),
]);

/**
 * Bulk actions on selected products. Price changes are previewed first (dryRun) and only applied when asked,
 * never below cost or the minimum price; each change is audited.
 */
router.post('/catalog/bulk', requirePermission('products.manage'), async (req, res) => {
  const body = parse(bulkSchema, req.body);
  const ids = [...new Set(body.productIds.map(String))];
  const products = await Product.find({ _id: { $in: ids } });
  const out: { productId: string; name: string; result: string; before?: unknown; after?: unknown }[] = [];
  if (body.action === 'generate-barcodes') {
    const prefix = (req.tenant!.settings as { internalBarcodePrefix?: string })?.internalBarcodePrefix ?? INTERNAL_BARCODE_PREFIX;
    const formats = scaleFormatsFor(req);
    for (const p of products) {
      if (p.barcodes.length) { out.push({ productId: String(p._id), name: p.name, result: 'skipped: already has a barcode' }); continue; }
      let code = '';
      for (let i = 0; i < 1000 && !code; i++) {
        const c = await Counter.findOneAndUpdate({ key: 'internal-barcode' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
        const candidate = internalEan13(c!.seq, prefix, formats);
        if (!(await barcodeTaken(candidate))) code = candidate;
      }
      p.barcodes.push({ code, unitCode: p.baseUnit });
      await p.save();
      out.push({ productId: String(p._id), name: p.name, result: 'added', after: code });
    }
  } else if (body.action === 'assign-plus') {
    const used = new Set(((await Product.distinct('plu', { plu: { $type: 'string' } })) as string[]).map((x) => String(Number(x))));
    for (const p of products) {
      if (p.plu) { out.push({ productId: String(p._id), name: p.name, result: 'skipped: already has a PLU' }); continue; }
      const plu = nextFreePlu(used);
      if (!plu) throw new AppError(409, 'NO_FREE_PLU', 'No free PLU numbers left');
      used.add(plu);
      p.plu = plu;
      await p.save();
      out.push({ productId: String(p._id), name: p.name, result: 'assigned', after: plu });
    }
  } else if (body.action === 'update-prices') {
    if (!req.auth!.permissions.has('prices.manage')) throw new AppError(403, 'FORBIDDEN', 'You need the prices.manage permission to change prices');
    for (const p of products) {
      const before = p.prices?.retail ?? null;
      if (!before) { out.push({ productId: String(p._id), name: p.name, result: 'skipped: no price' }); continue; }
      const raw = body.mode === 'percent' ? before * (1 + body.value / 10000) : before + body.value;
      const after = Math.round(raw / body.roundTo) * body.roundTo;
      const floor = Math.max(p.costCents ?? 0, p.minPriceCents ?? 0);
      if (after <= 0 || (floor && after < floor)) { out.push({ productId: String(p._id), name: p.name, result: 'skipped: would go below cost or minimum', before, after }); continue; }
      if (!body.dryRun) {
        await Product.updateOne({ _id: p._id }, { $set: { 'prices.retail': after } });
        await audit(req, { action: 'product.updated', entity: 'Product', entityId: p._id, details: { bulk: true, pricesBefore: { retail: before }, pricesAfter: { retail: after } } });
      }
      out.push({ productId: String(p._id), name: p.name, result: body.dryRun ? 'preview' : 'changed', before, after });
    }
  } else if (body.action === 'set-category') {
    if (body.categoryId && !(await Category.exists({ _id: body.categoryId }))) throw badRequest('Unknown category');
    await Product.updateMany({ _id: { $in: ids } }, { $set: { categoryId: body.categoryId } });
    for (const p of products) out.push({ productId: String(p._id), name: p.name, result: 'changed' });
  } else {
    await Product.updateMany({ _id: { $in: ids } }, { $set: { active: body.action === 'activate' } });
    for (const p of products) out.push({ productId: String(p._id), name: p.name, result: body.action === 'activate' ? 'activated' : 'archived' });
  }
  if (!('dryRun' in body) || !body.dryRun) await audit(req, { action: `products.bulk_${body.action}`, entity: 'Product', details: { count: out.filter((o) => !o.result.startsWith('skipped')).length } });
  res.json({ data: out });
});
