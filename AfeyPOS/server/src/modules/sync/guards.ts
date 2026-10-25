import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

/**
 * On a branch server, head-office data is read-only: it arrives by sync and local edits would be
 * overwritten. Branches still sell, receive and move stock, take payments, and add or edit customers.
 */
const HQ_OWNED: [RegExp, string][] = [
  [/^\/(products|products-import|categories|brands|promotions|customer-prices)(\/|$)/, 'products, prices and promotions'],
  [/^\/settings\/(business|modules|users|branches|warehouses|tills|integrations|notifications)(\/|$)/, 'settings, staff, branches and integrations'],
  [/^\/suppliers(\/[a-f0-9]{24})?$/, 'suppliers'],
  [/^\/auth\/(password\/change|pin|2fa)(\/|$)/, 'staff passwords and PINs'],
  [/^\/(hr|accounting)(\/|$)/, 'HR, payroll and accounts'],
];

export const branchReadOnly: RequestHandler = (req, _res, next) => {
  if (env().DEPLOYMENT_MODE !== 'branch' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const path = req.path;
  // Product price quotes are reads that use POST.
  if (/^\/products\/[a-f0-9]{24}\/quote$/.test(path)) return next();
  const hit = HQ_OWNED.find(([re]) => re.test(path));
  if (hit) throw new AppError(409, 'MANAGED_AT_HQ', `On a branch server, ${hit[1]} are managed at head office and arrive here by sync`);
  next();
};
