import type { RequestHandler } from 'express';
import { Tenant } from '../models/index.js';
import { AppError } from '../lib/errors.js';
import { runWithContext } from '../lib/context.js';
import { capabilitiesFor } from '../modules/tenants/capabilities.js';

/**
 * Single-business installation: every request belongs to the one business created at setup.
 * (Records still carry a tenantId so data stays scoped and backups/sync stay self-describing.)
 */
export async function findTenantForRequest(_req?: Parameters<RequestHandler>[0]) {
  return Tenant.findOne().sort({ createdAt: 1 });
}

/** Resolves the business, rejects requests before setup and enters its data context for the rest of the request. */
export const requireTenant: RequestHandler = async (req, _res, next) => {
  const tenant = await findTenantForRequest(req);
  if (!tenant) throw new AppError(404, 'SETUP_REQUIRED', 'This installation has not been set up yet');
  if (tenant.status === 'suspended') throw new AppError(403, 'BUSINESS_SUSPENDED', 'This installation is suspended. Contact the system administrator.');
  req.tenant = tenant;
  req.capabilities = capabilitiesFor(tenant);
  runWithContext({ tenantId: tenant._id, requestId: req.id }, () => next());
};
