/**
 * Checkout rules set by the owner (Settings > Checkout rules): what cashiers may do alone and what needs a
 * supervisor's approval on the till (staff card + PIN, fingerprint or email + PIN).
 */

export interface CheckoutRules {
  items: {
    /** Deleting a scanned item needs approval (permission sales.items.remove). */
    removeNeedsApproval: boolean;
    /** Lowering the quantity of a scanned item counts as removing. */
    reduceQtyNeedsApproval: boolean;
    /** Clearing the whole sale needs approval. */
    clearNeedsApproval: boolean;
    /** Cashiers may hold (park) sales and resume them. */
    holdAllowed: boolean;
  };
  discounts: {
    /** Cashiers may give discounts at all (without it every discount needs approval). */
    allowed: boolean;
    /** Largest discount on one item, in basis points of its price (1000 = 10%). */
    lineLimitBp: number;
    /** Largest discount on a whole sale, in basis points. */
    saleLimitBp: number;
    /** Largest discount amount on one sale; 0 means no amount cap. */
    maxAmountCents: number;
  };
  shifts: {
    /** Sales need an open shift on the till. */
    required: boolean;
    /** Smallest opening float a cashier may start with. */
    minOpeningFloatCents: number;
    /** Cashiers count the drawer without seeing the expected amount. */
    blindClose: boolean;
    /** Closing a shift needs a supervisor. */
    closeNeedsApproval: boolean;
    /** The till warns to hand over cash (pickup) above this much cash in the drawer; 0 = never. */
    maxCashInDrawerCents: number;
    /** A cashier may only have one open shift at a time. */
    oneOpenShiftPerCashier: boolean;
  };
  /** Pages a user whose only role is Cashier can open (navigation keys). Checkout is always allowed. */
  cashierPages: string[];
}

/** Pages an owner can allow or hide for cashiers (their permissions already exclude everything else). */
export const CASHIER_PAGE_OPTIONS: { key: string; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'sales', label: 'Sales history' },
  { key: 'returns', label: 'Returns' },
  { key: 'shifts', label: 'Shifts & cash' },
  { key: 'products', label: 'Products (view)' },
  { key: 'stock', label: 'Stock levels (view)' },
  { key: 'customers', label: 'Customers (view)' },
  { key: 'onlineOrders', label: 'Online orders' },
  { key: 'support', label: 'Support' },
];

export const CHECKOUT_RULE_DEFAULTS: CheckoutRules = {
  items: { removeNeedsApproval: false, reduceQtyNeedsApproval: false, clearNeedsApproval: false, holdAllowed: true },
  discounts: { allowed: true, lineLimitBp: 1000, saleLimitBp: 1000, maxAmountCents: 0 },
  shifts: { required: true, minOpeningFloatCents: 0, blindClose: false, closeNeedsApproval: false, maxCashInDrawerCents: 0, oneOpenShiftPerCashier: true },
  cashierPages: CASHIER_PAGE_OPTIONS.map((p) => p.key),
};

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : d);

/** Saved rules over the defaults. Older settings (requireOpenShift, cashierDiscountLimitBp) fill in when unset. */
export function mergeCheckoutRules(saved: unknown, legacy: { requireOpenShift?: boolean | null; cashierDiscountLimitBp?: number | null } = {}): CheckoutRules {
  const s = (saved && typeof saved === 'object' ? saved : {}) as any;
  const d = CHECKOUT_RULE_DEFAULTS;
  const legacyLimit = typeof legacy.cashierDiscountLimitBp === 'number' ? legacy.cashierDiscountLimitBp : d.discounts.saleLimitBp;
  return {
    items: {
      removeNeedsApproval: bool(s.items?.removeNeedsApproval, d.items.removeNeedsApproval),
      reduceQtyNeedsApproval: bool(s.items?.reduceQtyNeedsApproval, d.items.reduceQtyNeedsApproval),
      clearNeedsApproval: bool(s.items?.clearNeedsApproval, d.items.clearNeedsApproval),
      holdAllowed: bool(s.items?.holdAllowed, d.items.holdAllowed),
    },
    discounts: {
      allowed: bool(s.discounts?.allowed, d.discounts.allowed),
      lineLimitBp: int(s.discounts?.lineLimitBp, legacyLimit, 10000),
      saleLimitBp: int(s.discounts?.saleLimitBp, legacyLimit, 10000),
      maxAmountCents: int(s.discounts?.maxAmountCents, d.discounts.maxAmountCents),
    },
    shifts: {
      required: bool(s.shifts?.required, typeof legacy.requireOpenShift === 'boolean' ? legacy.requireOpenShift : d.shifts.required),
      minOpeningFloatCents: int(s.shifts?.minOpeningFloatCents, d.shifts.minOpeningFloatCents),
      blindClose: bool(s.shifts?.blindClose, d.shifts.blindClose),
      closeNeedsApproval: bool(s.shifts?.closeNeedsApproval, d.shifts.closeNeedsApproval),
      maxCashInDrawerCents: int(s.shifts?.maxCashInDrawerCents, d.shifts.maxCashInDrawerCents),
      oneOpenShiftPerCashier: bool(s.shifts?.oneOpenShiftPerCashier, d.shifts.oneOpenShiftPerCashier),
    },
    cashierPages: Array.isArray(s.cashierPages) ? s.cashierPages.filter((k: unknown) => CASHIER_PAGE_OPTIONS.some((p) => p.key === k)) : d.cashierPages,
  };
}

/** True for a user whose only built-in role is Cashier (the page list applies to them). */
export function isPlainCashier(roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every((r) => r === 'cashier');
}
