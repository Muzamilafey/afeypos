import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { BackupRecord } from '../../models/index.js';
import { idParam } from '../../http/validate.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { createBackup } from './service.js';
import { runAsPlatform } from '../../lib/context.js';

/** Tenant-facing: owners can back up (local: whole installation) or export their own data (cloud). */
const router = Router();

function ownerOnly(req: any) {
  if (!req.auth?.roles.includes('tenant_owner') && !req.auth?.roles.includes('business_admin')) throw forbidden('Only owners and administrators can manage backups');
}

router.get('/backups', async (req, res) => {
  ownerOnly(req);
  res.json({ data: await runAsPlatform(() => BackupRecord.find({}).sort({ startedAt: -1 }).limit(50).lean()) });
});

router.post('/backups', async (req, res) => {
  ownerOnly(req);
  const scope = 'full';
  const r = await runAsPlatform(() => createBackup({ scope }));
  await audit(req, { action: 'backup.created', details: { scope, documents: r.documents, sha256: r.sha256 } });
  res.status(201).json({ data: { id: r.id, file: path.basename(r.file), sha256: r.sha256, documents: r.documents, sizeBytes: r.sizeBytes } });
});

router.get('/backups/:id/download', async (req, res) => {
  ownerOnly(req);
  const rec = await runAsPlatform(() => BackupRecord.findById(idParam(req.params.id)).lean());
  if (!rec || rec.status !== 'completed' || !rec.file) throw notFound('Backup');
  if (!fs.existsSync(rec.file)) throw notFound('Backup file');
  await audit(req, { action: 'backup.downloaded', details: { id: String(rec._id) } });
  res.download(rec.file, path.basename(rec.file));
});

export const backupRoutes = router;
