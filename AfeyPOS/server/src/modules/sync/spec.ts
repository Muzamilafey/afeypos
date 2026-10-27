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
  AttendanceRecord, AuditLog, CustomRole, CustomerActivity, OnlineOrder, BiometricTemplate, Branch, Brand, CashMovement, Category, Customer, CustomerPrice, Expense, GoodsReceipt,
  IntegrationConfig, LedgerEntry, MpesaEvent, NotificationTemplate, PaymentIntent, Product, Promotion, PurchaseOrder, Sale, SaleReturn,
  SalesDocument, SerialItem, Shift, StockAdjustment, StockBatch, StockLevel, StockMovement, Stocktake, StockTransfer, Supplier,
  SupplierQuotation, SupplierReturn, Tenant, Till, UnitOfMeasure, User, Voucher, LoyaltyTransaction, Warehouse, PaymentTerminal, TerminalTransaction,
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
  /** Raised when downFilter starts sending older records too: branches then download this collection again from the start. */
  cursorVersion?: number;
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
  // Custom roles give users their permissions on branch servers too.
  { model: CustomRole, dir: 'down', field: 'updatedAt' },
  { model: Category, dir: 'down', field: 'updatedAt' },
  { model: Brand, dir: 'down', field: 'updatedAt' },
  { model: UnitOfMeasure, dir: 'down', field: 'updatedAt' },
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
  { model: SupplierQuotation, dir: 'both', field: 'updatedAt', owner: inWarehouses, downFilter: (b) => ({ warehouseId: { $in: ids(b.warehouseIds) } }) },
  { model: BiometricTemplate, dir: 'both', field: 'updatedAt' },
  { model: CustomerActivity, dir: 'both', field: 'updatedAt' },
  // Vouchers can be sold at one branch and spent at another. Offline branches cannot see a balance spent
  // elsewhere until they sync, so a voucher spent twice offline shows up at head office (newest wins).
  { model: Voucher, dir: 'both', field: 'updatedAt' },
  // Online orders are taken at HQ; the branch that fulfils them receives and completes them.
  { model: OnlineOrder, dir: 'both', field: 'updatedAt', owner: inBranch, downFilter: (b) => ({ branchId: new Types.ObjectId(b.branchId) }) },

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
  // With one M-Pesa for all branches, a payment no till was waiting for has no branch yet: every branch gets a
  // copy to see it, and the branch whose cashier uses it claims it at HQ first (/sync/mpesa-claim), so it is used once.
  {
    model: PaymentIntent, dir: 'both', field: 'updatedAt', owner: inBranch, cursorVersion: 2,
    downFilter: (b) => ({ $or: [{ branchId: new Types.ObjectId(b.branchId) }, { branchId: null, provider: 'mpesa', source: 'c2b', status: 'succeeded' }] }),
  },
  { model: MpesaEvent, dir: 'up', field: 'at' },
  // Card terminals connect to the server their tills use, so a branch server owns its terminals and their payments.
  { model: PaymentTerminal, dir: 'up', field: 'updatedAt', owner: inBranch },
  { model: TerminalTransaction, dir: 'up', field: 'updatedAt', owner: inBranch },
  { model: LedgerEntry, dir: 'up', field: 'updatedAt' },
  { model: AttendanceRecord, dir: 'up', field: 'at' },
  { model: LoyaltyTransaction, dir: 'up', field: 'at' },
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
