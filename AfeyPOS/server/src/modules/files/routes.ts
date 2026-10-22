/**
 * Tenant-scoped uploads (product images, attachments). Files are stored under UPLOAD_DIR/<tenantId>/,
 * named with random ids, type-checked by magic bytes, and only served to authenticated users of the
 * same tenant. Cloud deployments with several app servers should point UPLOAD_DIR at shared storage.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { parse } from '../../http/validate.js';
import { requirePermission } from '../../http/auth.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

const TYPES: { ext: string; mime: string; magic: number[] }[] = [
  { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
  { ext: 'pdf', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
];
const MAX_BYTES = 3 * 1024 * 1024;

const tenantDir = (tenantId: string) => path.resolve(env().UPLOAD_DIR, tenantId);

export const FILE_ID_RE = /^[a-f0-9]{32}\.(png|jpg|webp|pdf)$/;

/** Absolute path of a tenant file, or null when the id is invalid or the file is missing. */
export function tenantFilePath(tenantId: string, id: string): string | null {
  if (!FILE_ID_RE.test(id)) return null;
  const file = path.join(tenantDir(tenantId), id);
  return fs.existsSync(file) ? file : null;
}

export const mimeFor = (id: string) => TYPES.find((t) => id.endsWith(t.ext))?.mime ?? 'application/octet-stream';

const router = Router();

router.post('/files', requirePermission('products.manage'), async (req, res) => {
  const body = parse(z.object({ base64: z.string().min(8).max(Math.ceil((MAX_BYTES * 4) / 3) + 8), purpose: z.enum(['product_image', 'attachment']).default('product_image') }), req.body);
  const data = Buffer.from(body.base64, 'base64');
  if (data.length > MAX_BYTES) throw badRequest('File is larger than 3 MB');
  const type = TYPES.find((t) => t.magic.every((b, i) => data[i] === b));
  if (!type) throw badRequest('Only PNG, JPEG, WEBP images and PDF files are allowed');
  const id = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
  const dir = tenantDir(String(req.tenant!._id));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, id), data, { flag: 'wx' });
  await audit(req, { action: 'file.uploaded', details: { id, bytes: data.length, purpose: body.purpose } });
  res.status(201).json({ data: { id, url: `/api/v1/files/${id}`, mime: type.mime, bytes: data.length } });
});

router.get('/files/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{32}\.(png|jpg|webp|pdf)$/.test(id)) throw notFound('File');
  const file = path.join(tenantDir(String(req.tenant!._id)), id);
  if (!fs.existsSync(file)) throw notFound('File');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(TYPES.find((t) => id.endsWith(t.ext))!.mime).sendFile(file);
});

export const fileRoutes = router;
