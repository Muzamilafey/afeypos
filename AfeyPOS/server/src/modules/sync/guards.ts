import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

/**
 * On a branch server, head-office data is read-only for the staff who work there: it arrives by sync.
 * Owners and administrators are not held back — they run the business and may add products, staff and the
 * rest on the shop's own server; those changes sync up to head office like a sale does.
 */
const HQ_OWNED: [RegExp, string][] = [
  [/^\/(products|products-import|categories|brands|promotions|customer-prices)(\/|$)/, 'products, prices and promotions'],
  [/^\/settings\/(business|modules|users|branches|warehouses|tills|integrations|notifications)(\/|$)/, 'settings, staff, branches and integrations'],
  [/^\/suppliers(\/[a-f0-9]{24})?$/, 'suppliers'],
  [/^\/auth\/(password\/change|pin|2fa)(\/|$)/, 'staff passwords and PINs'],
  [/^\/(hr|accounting)(\/|$)/, 'HR, payroll and accounts'],
];

const ADMIN_ROLES = ['tenant_owner', 'business_admin'];

export const branchReadOnly: RequestHandler = (req, _res, next) => {
  if (env().DEPLOYMENT_MODE !== 'branch' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.auth?.roles.some((r) => ADMIN_ROLES.includes(r))) return next();
  const path = req.path;
  // Product price quotes are reads that use POST.
  if (/^\/products\/[a-f0-9]{24}\/quote$/.test(path)) return next();
  const hit = HQ_OWNED.find(([re]) => re.test(path));
  if (hit) throw new AppError(409, 'MANAGED_AT_HQ', `On a branch server, ${hit[1]} are managed at head office and arrive here by sync. An owner or administrator can change them here.`);
  next();
};
