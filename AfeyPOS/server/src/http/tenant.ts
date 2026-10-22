import type { RequestHandler } from 'express';
import { subdomainFromHost } from '@afeypos/shared';
import { env } from '../config/env.js';
import { Tenant } from '../models/index.js';
import { AppError } from '../lib/errors.js';
import { runWithContext } from '../lib/context.js';
import { capabilitiesFor } from '../modules/tenants/plans.js';

export function requestHost(req: Parameters<RequestHandler>[0]): string {
  return (req.hostname || req.get('host') || '').toLowerCase();
}

/** Determines which tenant a request belongs to. Never trusts client-supplied ids. */
export async function findTenantForRequest(req: Parameters<RequestHandler>[0]) {
  const e = env();
  if (e.DEPLOYMENT_MODE === 'local') return Tenant.findOne().sort({ createdAt: 1 });
  const host = requestHost(req);
  const sub = subdomainFromHost(host, e.BASE_DOMAIN);
  if (sub && sub !== e.PLATFORM_SUBDOMAIN) return Tenant.findOne({ slug: sub });
  if (!sub && host && host !== e.BASE_DOMAIN && !host.endsWith('.' + e.BASE_DOMAIN) && host !== 'localhost' && host !== '127.0.0.1') {
    const t = await Tenant.findOne({ customDomains: host });
    if (t) return t;
  }
  const header = req.get('x-tenant');
  if (e.ALLOW_TENANT_HEADER && header) return Tenant.findOne({ slug: header.toLowerCase() });
  return null;
}

const lastTouch = new Map<string, number>();
/** Usage tracking: records tenant activity at most every 5 minutes per process. */
function touchActivity(id: import('mongoose').Types.ObjectId) {
  const k = String(id);
  const now = Date.now();
  if ((lastTouch.get(k) ?? 0) > now - 300_000) return;
  lastTouch.set(k, now);
  Tenant.updateOne({ _id: id }, { $set: { 'usage.lastActivityAt': new Date(now) } }).catch(() => undefined);
}

/** Resolves the tenant, rejects unknown/suspended tenants and enters tenant context for the rest of the request. */
export const requireTenant: RequestHandler = async (req, _res, next) => {
  const tenant = await findTenantForRequest(req);
  if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', 'No business is registered at this address');
  if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
    throw new AppError(403, 'TENANT_SUSPENDED', tenant.status === 'suspended' ? 'This account is suspended. Please contact support.' : 'This account has been cancelled.');
  }
  req.tenant = tenant;
  req.capabilities = await capabilitiesFor(tenant);
  touchActivity(tenant._id);
  runWithContext({ tenantId: tenant._id, requestId: req.id }, () => next());
};
