import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  INTERNAL_BARCODE_PREFIX, SCALE_FORMAT_PRESETS, effectiveScaleFormats, internalEan13, nextFreePlu, skuPrefix, validateScaleFormats,
  type ScaleBarcodeFormat, type VariableWeightConfig,
} from '@afeypos/shared';
import { Category, Counter, Product, Tenant } from '../../models/index.js';
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
