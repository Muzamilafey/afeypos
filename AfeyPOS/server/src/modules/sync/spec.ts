/**
 * What replicates between head office (HQ) and branch servers, in which direction, and who may send it.
 *
 *  up   = branch -> HQ: the branch is the authority (its sales, shifts, cash and the stock of its own warehouses).
 *  down = HQ -> branch: HQ is the authority (settings, branches, staff, products, prices, promotions, suppliers).
 *  both = either side may edit; the most recent edit wins (customers, transfers, purchase orders, fingerprints).
 *
 * Records are copied whole, ordered by a change timestamp (`updatedAt`, or `at` for append-only records),
 * and applied with "newest wins", so repeats and retries are harmless. Customer and supplier balances are
 * recomputed at HQ from their ledgers rather than copied, because several branches change them.
 */
import { Types, type Model } from 'mongoose';
import {
  AttendanceRecord, AuditLog, BiometricTemplate, Branch, Brand, CashMovement, Category, Customer, CustomerPrice, Expense, GoodsReceipt,
  IntegrationConfig, LedgerEntry, MpesaEvent, NotificationTemplate, PaymentIntent, Product, Promotion, PurchaseOrder, Sale, SaleReturn,
  SalesDocument, SerialItem, Shift, StockAdjustment, StockBatch, StockLevel, StockMovement, Stocktake, StockTransfer, Supplier,
  SupplierReturn, Tenant, Till, User, Warehouse,
} from '../../models/index.js';

export interface BranchScope {
  branchId: string;
  code: string;
  warehouseIds: Set<string>;
  tillIds: Set<string>;
}

export interface SyncSpec {
  model: Model<any>;
  dir: 'up' | 'down' | 'both';
  /** Change timestamp used for ordering and newest-wins. */
  field: 'updatedAt' | 'at';
  /** HQ accepts a record from a branch only when this returns true (default: any record of the business). */
  owner?: (doc: any, b: BranchScope) => boolean;
  /** HQ sends a branch only records matching this filter. */
  downFilter?: (b: BranchScope) => Record<string, unknown>;
}

const inBranch = (doc: any, b: BranchScope) => String(doc.branchId) === b.branchId;
const inWarehouses = (doc: any, b: BranchScope) => b.warehouseIds.has(String(doc.warehouseId));
const inTills = (doc: any, b: BranchScope) => b.tillIds.has(String(doc.tillId));
const ids = (s: Set<string>) => [...s].map((x) => new Types.ObjectId(x));

export const SYNC_SPECS: SyncSpec[] = [
  // ---- HQ -> branch ----
  { model: Tenant, dir: 'down', field: 'updatedAt' },
  { model: Branch, dir: 'down', field: 'updatedAt' },
  { model: Warehouse, dir: 'down', field: 'updatedAt' },
  { model: Till, dir: 'down', field: 'updatedAt' },
  { model: User, dir: 'down', field: 'updatedAt' },
  { model: Category, dir: 'down', field: 'updatedAt' },
  { model: Brand, dir: 'down', field: 'updatedAt' },
  { model: Product, dir: 'down', field: 'updatedAt' },
  { model: CustomerPrice, dir: 'down', field: 'updatedAt' },
  { model: Promotion, dir: 'down', field: 'updatedAt' },
  { model: Supplier, dir: 'down', field: 'updatedAt' },
  { model: NotificationTemplate, dir: 'down', field: 'updatedAt' },
  { model: IntegrationConfig, dir: 'down', field: 'updatedAt', downFilter: (b) => ({ $or: [{ branchIds: { $size: 0 } }, { branchIds: { $in: ids(new Set([b.branchId])) } }] }) },

  // ---- edited on both sides ----
  { model: Customer, dir: 'both', field: 'updatedAt' },
  {
    model: StockTransfer, dir: 'both', field: 'updatedAt',
    owner: (d, b) => b.warehouseIds.has(String(d.fromWarehouseId)) || b.warehouseIds.has(String(d.toWarehouseId)),
    downFilter: (b) => ({ $or: [{ fromWarehouseId: { $in: ids(b.warehouseIds) } }, { toWarehouseId: { $in: ids(b.warehouseIds) } }] }),
  },
  { model: PurchaseOrder, dir: 'both', field: 'updatedAt', owner: inWarehouses, downFilter: (b) => ({ warehouseId: { $in: ids(b.warehouseIds) } }) },
  { model: BiometricTemplate, dir: 'both', field: 'updatedAt' },

  // ---- branch -> HQ ----
  { model: Shift, dir: 'up', field: 'updatedAt', owner: inBranch },
  { model: Sale, dir: 'up', field: 'updatedAt', owner: inBranch },
  { model: SaleReturn, dir: 'up', field: 'updatedAt', owner: inBranch },
  { model: SalesDocument, dir: 'up', field: 'updatedAt', owner: inBranch },
  { model: CashMovement, dir: 'up', field: 'at', owner: inTills },
  { model: StockLevel, dir: 'up', field: 'updatedAt', owner: inWarehouses },
  { model: StockMovement, dir: 'up', field: 'at', owner: inWarehouses },
  { model: StockBatch, dir: 'up', field: 'updatedAt', owner: inWarehouses },
  { model: SerialItem, dir: 'up', field: 'updatedAt', owner: inWarehouses },
  { model: StockAdjustment, dir: 'up', field: 'updatedAt', owner: inWarehouses },
  { model: Stocktake, dir: 'up', field: 'updatedAt', owner: inWarehouses },
  { model: GoodsReceipt, dir: 'up', field: 'updatedAt', owner: inWarehouses },
  { model: SupplierReturn, dir: 'up', field: 'updatedAt', owner: inWarehouses },
  { model: Expense, dir: 'up', field: 'updatedAt', owner: inBranch },
  // Paybill/Till payments reach HQ (public callbacks) and belong to the branch that owns the M-Pesa config.
  { model: PaymentIntent, dir: 'both', field: 'updatedAt', owner: inBranch, downFilter: (b) => ({ branchId: new Types.ObjectId(b.branchId) }) },
  { model: MpesaEvent, dir: 'up', field: 'at' },
  { model: LedgerEntry, dir: 'up', field: 'updatedAt' },
  { model: AttendanceRecord, dir: 'up', field: 'at' },
  { model: AuditLog, dir: 'up', field: 'at' },
];

/**
 * Stock of other branches is sent down read-only (so staff can see what is available elsewhere).
 * A branch's own stock is sent down only once, when it first connects (seeding its database).
 */
export const STOCK_REPLICA_MODELS = [StockLevel, StockBatch, SerialItem];

export function specFor(collection: string): SyncSpec | undefined {
  return SYNC_SPECS.find((s) => s.model.collection.collectionName === collection);
}

export const upSpecs = () => SYNC_SPECS.filter((s) => s.dir !== 'down');
export const downSpecs = () => SYNC_SPECS.filter((s) => s.dir !== 'up');
