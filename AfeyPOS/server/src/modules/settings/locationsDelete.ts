/**
 * Deleting a till, a store (warehouse) or a branch. Only an owner or administrator, who confirms on the spot
 * (fingerprint, staff card, or username / email with PIN or password: a single-use approval in X-Approval).
 *
 * Deleting never erases history: the record is retired (active: false, deletedAt) so past sales, stock movements
 * and reports still show where they happened, and it disappears from every list and choice. It is refused while
 * it would break something: an open shift, stock still on hand, a branch server still connected.
 */
import { Router } from 'express';
import { Branch, IntegrationConfig, PaymentTerminal, Shift, StockLevel, Till, Warehouse } from '../../models/index.js';
import { idParam } from '../../http/validate.js';
import { assertBranchAccess, requirePermission } from '../../http/auth.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { adminApproval } from '../sync/routes.js';
import { invalidateOwnership } from '../sync/ownership.js';

export const locationDeleteRoutes = Router();

const live = { deletedAt: { $exists: false } };

async function confirmAdmin(req: any) {
  if (!req.auth!.roles.includes('tenant_owner') && !req.auth!.roles.includes('business_admin')) throw forbidden('Only owners and administrators can delete tills, stores and branches');
  return adminApproval(req);
}

/** Tills and terminals no longer offer what was deleted. */
async function detachTills(ids: unknown[]) {
  if (!ids.length) return;
  await PaymentTerminal.updateMany({ tillIds: { $in: ids } }, { $pull: { tillIds: { $in: ids } } });
  await IntegrationConfig.updateMany({ tillIds: { $in: ids } }, { $pull: { tillIds: { $in: ids } } });
}

async function assertNoOpenShift(filter: Record<string, unknown>, what: string) {
  const open = await Shift.findOne({ ...filter, status: 'open' }, { number: 1 }).lean();
  if (open) throw conflict(`${what} has an open shift${(open as any).number ? ` (${(open as any).number})` : ''}. End the shift first.`, 'LOCATION_HAS_OPEN_SHIFT');
}

async function assertNoStock(warehouseIds: unknown[], what: string) {
  const stock = await StockLevel.findOne({ warehouseId: { $in: warehouseIds }, $or: [{ qty: { $ne: 0 } }, { inTransit: { $gt: 0 } }] }, { _id: 1 }).lean();
  if (stock) throw conflict(`${what} still holds stock. Transfer it to another store, or adjust it to zero, first.`, 'LOCATION_HAS_STOCK');
}

locationDeleteRoutes.delete('/settings/tills/:id', requirePermission('branches.manage'), async (req, res) => {
  const t = await Till.findOne({ _id: idParam(req.params.id), ...live });
  if (!t) throw notFound('Till');
  assertBranchAccess(req, t.branchId);
  const admin = await confirmAdmin(req);
  await assertNoOpenShift({ tillId: t._id }, `Till ${t.name}`);
  await Till.updateOne({ _id: t._id }, { $set: { active: false, deletedAt: new Date(), deletedBy: req.auth!.userId } });
  await detachTills([t._id]);
  await audit(req, { action: 'till.deleted', entity: 'Till', entityId: t._id, details: { name: t.name, code: t.code, confirmedBy: admin.name } });
  res.json({ data: { id: t._id, deleted: true } });
});

locationDeleteRoutes.delete('/settings/warehouses/:id', requirePermission('branches.manage'), async (req, res) => {
  const w = await Warehouse.findOne({ _id: idParam(req.params.id), ...live });
  if (!w) throw notFound('Store');
  assertBranchAccess(req, w.branchId);
  const admin = await confirmAdmin(req);
  const sellers = await Till.find({ warehouseId: w._id, ...live }, { name: 1 }).lean();
  if (sellers.length) throw conflict(`Tills sell from ${w.name}: ${sellers.map((x) => x.name).join(', ')}. Delete them, or let them sell from another store, first.`, 'STORE_HAS_TILLS');
  const others = await Warehouse.find({ branchId: w.branchId, _id: { $ne: w._id }, ...live }, { _id: 1 }).lean();
  if (!others.length) throw conflict(`${w.name} is the only store of its branch. Delete the branch instead.`, 'LAST_STORE');
  await assertNoStock([w._id], w.name);
  await Warehouse.updateOne({ _id: w._id }, { $set: { active: false, isDefault: false, deletedAt: new Date(), deletedBy: req.auth!.userId } });
  // The branch keeps a default store.
  if (w.isDefault) await Warehouse.updateOne({ _id: others[0]!._id }, { $set: { isDefault: true } });
  invalidateOwnership();
  await audit(req, { action: 'warehouse.deleted', entity: 'Warehouse', entityId: w._id, details: { name: w.name, code: w.code, confirmedBy: admin.name } });
  res.json({ data: { id: w._id, deleted: true } });
});

locationDeleteRoutes.delete('/settings/branches/:id', requirePermission('branches.manage'), async (req, res) => {
  const b = await Branch.findOne({ _id: idParam(req.params.id), ...live });
  if (!b) throw notFound('Branch');
  assertBranchAccess(req, b._id);
  const admin = await confirmAdmin(req);
  if (!(await Branch.exists({ _id: { $ne: b._id }, ...live }))) throw conflict('This is the only branch: a business needs at least one.', 'LAST_BRANCH');
  if (b.hasServer) throw conflict(`${b.name} has its own server. Stop its branch server (Branch sync) first.`, 'BRANCH_HAS_SERVER');
  await assertNoOpenShift({ branchId: b._id }, b.name);
  const stores = await Warehouse.find({ branchId: b._id, ...live }, { _id: 1 }).lean();
  await assertNoStock(stores.map((w) => w._id), b.name);
  const tills = await Till.find({ branchId: b._id, ...live }, { _id: 1 }).lean();
  const stamp = { active: false, deletedAt: new Date(), deletedBy: req.auth!.userId };
  await Till.updateMany({ branchId: b._id, ...live }, { $set: stamp });
  await Warehouse.updateMany({ branchId: b._id, ...live }, { $set: { ...stamp, isDefault: false } });
  await Branch.updateOne({ _id: b._id }, { $set: stamp });
  await detachTills(tills.map((t) => t._id));
  invalidateOwnership();
  await audit(req, { action: 'branch.deleted', entity: 'Branch', entityId: b._id, details: { name: b.name, code: b.code, tills: tills.length, stores: stores.length, confirmedBy: admin.name } });
  res.json({ data: { id: b._id, deleted: true } });
});
