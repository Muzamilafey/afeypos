import { Router } from 'express';
import { z } from 'zod';
import { BUSINESS_PROFILES, BUSINESS_TYPES, MODULE_INFO } from '@afeypos/shared';
import { env } from '../../config/env.js';
import { Tenant } from '../../models/index.js';
import { parse } from '../../http/validate.js';
import { platformAudit } from '../../lib/audit.js';
import { findTenantForRequest } from '../../http/tenant.js';
import { authLimiter, tenantAppUrl } from '../auth/routes.js';
import { isSubdomainAvailable, provisionTenant, registrationSchema } from '../tenants/provisioning.js';
import { getPlan } from '../tenants/plans.js';
import { Plan } from '../../models/index.js';
import { mimeFor, tenantFilePath } from '../files/routes.js';

const router = Router();

router.get('/config', async (req, res) => {
  const e = env();
  const tenant = await findTenantForRequest(req);
  res.json({
    deploymentMode: e.DEPLOYMENT_MODE,
    baseDomain: e.BASE_DOMAIN,
    setupRequired: e.DEPLOYMENT_MODE === 'local' ? !(await Tenant.exists({})) : false,
    tenant: tenant
      ? { name: tenant.name, slug: tenant.slug, businessType: tenant.businessType, status: tenant.status, tagline: tenant.settings?.tagline ?? null, logoUrl: tenant.settings?.logoFileId ? `/api/v1/public/logo?v=${tenant.settings.logoFileId.slice(0, 8)}` : null }
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

router.get('/plans', async (_req, res) => {
  const plans = await Plan.find({ active: true }).sort({ priceMonthlyCents: 1 }).lean();
  res.json({ data: plans.map((p) => ({ code: p.code, name: p.name, priceMonthlyCents: p.priceMonthlyCents, currency: p.currency, trialDays: p.trialDays, limits: p.limits })) });
});

router.get('/subdomain-check', async (req, res) => {
  const { slug } = parse(z.object({ slug: z.string().max(64) }), req.query);
  res.json(await isSubdomainAvailable(slug));
});

/** Cloud: self-service tenant registration. Local: one-time installation setup. */
router.post('/register', authLimiter, async (req, res) => {
  const input = parse(registrationSchema, req.body);
  if (env().DEPLOYMENT_MODE === 'cloud' && !(await getPlan(input.planCode))) input.planCode = 'starter';
  const { tenant, owner } = await provisionTenant(input);
  await platformAudit(req, 'tenant.registered', { slug: tenant.slug, businessType: tenant.businessType, owner: owner.email }, tenant._id);
  res.status(201).json({
    tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug, businessType: tenant.businessType, status: tenant.status, trialEndsAt: tenant.trialEndsAt },
    url: tenantAppUrl(tenant.slug),
  });
});

export const publicRoutes = router;
