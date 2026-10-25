import { Router } from 'express';
import { BUSINESS_PROFILES, BUSINESS_TYPES, MODULE_INFO } from '@afeypos/shared';
import { env } from '../../config/env.js';
import { runInTenant } from '../../lib/context.js';
import { parse } from '../../http/validate.js';
import { audit } from '../../lib/audit.js';
import { findTenantForRequest } from '../../http/tenant.js';
import { authLimiter, appUrl } from '../auth/routes.js';
import { provisionTenant, registrationSchema } from '../tenants/provisioning.js';
import { effectiveBusinessType } from '../tenants/capabilities.js';
import { mimeFor, tenantFilePath } from '../files/routes.js';

const router = Router();

router.get('/config', async (req, res) => {
  const e = env();
  const tenant = await findTenantForRequest(req);
  res.json({
    deploymentMode: e.DEPLOYMENT_MODE,
    branchCode: e.DEPLOYMENT_MODE === 'branch' ? (e.BRANCH_CODE ?? null) : null,
    setupRequired: !tenant,
    tenant: tenant
      ? { name: tenant.name, slug: tenant.slug, businessType: effectiveBusinessType(tenant.businessType), status: tenant.status, tagline: tenant.settings?.tagline ?? null, logoUrl: tenant.settings?.logoFileId ? `/api/v1/public/logo?v=${tenant.settings.logoFileId.slice(0, 8)}` : null }
      : null,
  });
});

/** The business logo for the sign-in page (public on purpose: it is shown before anyone signs in). */
router.get('/logo', async (req, res) => {
  const tenant = await findTenantForRequest(req);
  const file = tenant?.settings?.logoFileId ? tenantFilePath(String(tenant._id), tenant.settings.logoFileId) : null;
  if (!file) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No logo' } });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(mimeFor(file)).sendFile(file);
});

router.get('/business-types', (_req, res) => {
  res.json({
    data: BUSINESS_TYPES.map((t) => ({ type: t, name: BUSINESS_PROFILES[t].name, description: BUSINESS_PROFILES[t].description, modules: BUSINESS_PROFILES[t].modules })),
    modules: MODULE_INFO,
  });
});

/** One-time installation setup: creates the business and its owner. Refused once set up. */
router.post('/register', authLimiter, async (req, res) => {
  const input = parse(registrationSchema, req.body);
  const { tenant, owner } = await provisionTenant(input);
  await runInTenant(tenant._id, () => audit(req, { action: 'business.setup', entity: 'Tenant', entityId: tenant._id, details: { businessType: tenant.businessType, owner: owner.email } }));
  res.status(201).json({
    tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug, businessType: tenant.businessType, status: tenant.status },
    url: appUrl(),
  });
});

/**
 * Landing page after a hosted checkout (Paystack, Flutterwave...). Purely informational: the till only
 * completes the sale once the server has verified the payment with the provider.
 */
router.get('/payment-return', (_req, res) => {
  res.type('html').set('Cache-Control', 'no-store').send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment submitted</title>' +
      '<style>body{font-family:system-ui,sans-serif;background:#f5f5f4;color:#191817;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;padding:32px;border-radius:16px;max-width:360px;text-align:center;box-shadow:0 4px 24px #0001}</style></head>' +
      '<body><main><h1>Thank you</h1><p>Your payment has been submitted. The cashier will confirm it at the till. You can close this page.</p></main></body></html>',
  );
});

export const publicRoutes = router;
