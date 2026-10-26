/** Settings screens for branch sync: tokens and branch health at head office; status and "sync now" on a branch. */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Branch, SyncConflict, SyncCursor } from '../../models/index.js';
import { idParam, parse } from '../../http/validate.js';
import { requireAnyPermission, requirePermission } from '../../http/auth.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { invalidateOwnership } from './ownership.js';
import { keyFingerprint } from './hq.js';
import { resetCursors, syncOnce, syncState } from './branch.js';

export const syncSettingsRoutes = Router();

const ownerOnly = (req: any) => {
  if (!req.auth!.roles.includes('tenant_owner') && !req.auth!.roles.includes('business_admin')) throw forbidden('Only owners and administrators can manage branch servers');
};

/** HQ: give a branch its own server. The token is shown once. */
syncSettingsRoutes.post('/settings/branches/:id/sync-token', requirePermission('branches.manage'), async (req, res) => {
  ownerOnly(req);
  if (env().DEPLOYMENT_MODE !== 'hq') throw new AppError(409, 'NOT_HQ', 'Branch servers connect to a head-office server (DEPLOYMENT_MODE=hq)');
  const token = randomToken(32);
  const b = await Branch.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: { hasServer: true, syncTokenHash: sha256(token) } }, { new: true });
  if (!b) throw notFound('Branch');
  invalidateOwnership();
  await audit(req, { action: 'sync.branch_token_issued', entity: 'Branch', entityId: b._id, details: { code: b.code } });
  res.json({
    data: {
      token,
      env: { DEPLOYMENT_MODE: 'branch', BRANCH_CODE: b.code, SYNC_ENABLED: 'true', SYNC_HQ_URL: env().API_PUBLIC_URL.replace(/\/$/, ''), SYNC_TOKEN: token },
      keyFingerprint: keyFingerprint(),
      note: 'Copy these into the branch server .env together with the same ENCRYPTION_KEY as head office, then start it on an empty database.',
    },
  });
});

/** HQ: take the branch back to being run from head office (its server can no longer sync). */
syncSettingsRoutes.delete('/settings/branches/:id/sync-token', requirePermission('branches.manage'), async (req, res) => {
  ownerOnly(req);
  const b = await Branch.findOneAndUpdate({ _id: idParam(req.params.id) }, { $set: { hasServer: false }, $unset: { syncTokenHash: 1 } }, { new: true });
  if (!b) throw notFound('Branch');
  invalidateOwnership();
  await audit(req, { action: 'sync.branch_token_revoked', entity: 'Branch', entityId: b._id, details: { code: b.code } });
  res.json({ data: { id: b._id, hasServer: false } });
});

syncSettingsRoutes.get('/settings/sync/status', requirePermission('settings.manage'), async (_req, res) => {
  const e = env();
  const conflicts = await SyncConflict.find({ resolved: false }).sort({ at: -1 }).limit(50).lean();
  if (e.DEPLOYMENT_MODE === 'hq') {
    const branches = await Branch.find({}).sort({ code: 1 }).lean();
    const now = Date.now();
    res.json({
      data: {
        role: 'hq',
        keyFingerprint: keyFingerprint(),
        branches: branches.map((b) => ({
          id: b._id, code: b.code, name: b.name, hasServer: Boolean(b.hasServer), sync: b.sync ?? {},
          online: Boolean(b.sync?.lastSeenAt && now - new Date(b.sync.lastSeenAt).getTime() < 2 * 60_000),
        })),
        conflicts,
      },
    });
    return;
  }
  if (e.DEPLOYMENT_MODE === 'branch') {
    const cursors = await SyncCursor.find({}).sort({ key: 1 }).lean();
    res.json({ data: { role: 'branch', branchCode: e.BRANCH_CODE, hqUrl: e.SYNC_HQ_URL || e.SYNC_CLOUD_URL, enabled: e.SYNC_ENABLED, ...syncState(), cursors, conflicts } });
    return;
  }
  res.json({ data: { role: 'standalone' } });
});

/** Small status for the header on every till of a branch server: online or not, and when it last synced. */
syncSettingsRoutes.get('/sync/indicator', requireAnyPermission('sales.create', 'settings.manage', 'reports.read'), async (_req, res) => {
  const e = env();
  if (e.DEPLOYMENT_MODE !== 'branch') return void res.json({ data: { role: e.DEPLOYMENT_MODE } });
  const st = syncState();
  res.json({ data: { role: 'branch', enabled: e.SYNC_ENABLED, online: st.online, running: st.running, lastSuccessAt: st.lastSuccessAt ?? null, lastError: st.last && !st.last.ok ? st.last.error : null } });
});

/** Branch: sync now. */
syncSettingsRoutes.post('/settings/sync/run', requirePermission('settings.manage'), async (_req, res) => {
  if (env().DEPLOYMENT_MODE !== 'branch') throw new AppError(409, 'NOT_BRANCH', 'Only branch servers sync with head office');
  res.json({ data: await syncOnce() });
});

/** Branch: resend or re-download everything (safe: records are applied newest-wins). */
syncSettingsRoutes.post('/settings/sync/resync', requirePermission('settings.manage'), async (req, res) => {
  ownerOnly(req);
  const { scope } = parse(z.object({ scope: z.enum(['all', 'up', 'down']).default('all') }), req.body ?? {});
  await resetCursors(scope);
  await audit(req, { action: 'sync.resync', details: { scope } });
  res.json({ data: { ok: true } });
});

syncSettingsRoutes.post('/settings/sync/conflicts/:id/resolve', requirePermission('settings.manage'), async (req, res) => {
  await SyncConflict.updateOne({ _id: idParam(req.params.id) }, { $set: { resolved: true } });
  res.json({ data: { ok: true } });
});
