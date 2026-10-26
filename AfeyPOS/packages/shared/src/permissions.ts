/** Central permission catalogue and role definitions. Enforced on the server; the UI only uses it for display. */

export const PERMISSIONS = [
  // administration
  'settings.manage',
  'users.manage',
  'branches.manage',
  'integrations.manage',
  'hardware.manage',
  'biometrics.enroll',
  // catalogue
  'products.read',
  'products.manage',
  'prices.manage',
  'products.cost',
  // inventory
  'inventory.read',
  'inventory.adjust',
  'inventory.adjust.approve',
  'inventory.transfer',
  'inventory.stocktake',
  'inventory.receive',
  // parties
  'customers.read',
  'customers.manage',
  'suppliers.read',
  'suppliers.manage',
  'suppliers.pay',
  'credit.approve',
  // purchasing
  'purchasing.read',
  'purchasing.manage',
  // sales
  'sales.create',
  'sales.read',
  'sales.read.all',
  'sales.discount',
  'sales.discount.override',
  'sales.price.override',
  'sales.void',
  'sales.items.remove',
  'vouchers.manage',
  'loyalty.manage',
  'sales.return',
  'returns.approve',
  'sales.credit',
  'quotations.manage',
  'customers.payments',
  // till / cash
  'shifts.open',
  'shifts.manage',
  'cash.movement',
  'payments.reconcile',
  'payouts.request',
  'payouts.approve',
  'terminals.manage',
  'terminals.refund',
  'terminals.reconcile',
  'expenses.manage',
  // HR, accounting, CRM, online orders
  'hr.manage',
  'payroll.manage',
  'payroll.approve',
  'accounting.read',
  'accounting.manage',
  'crm.manage',
  'orders.manage',
  // reporting
  'reports.read',
  'reports.financial',
  'audit.read',
  'commissions.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'tenant_owner',
  'business_admin',
  'branch_manager',
  'inventory_manager',
  'procurement_officer',
  'cashier',
  'accountant',
  'auditor',
  'salesperson',
  'warehouse_operator',
] as const;

export type Role = (typeof ROLES)[number];

/** Roles assignable to staff (all of them; kept under this name for existing imports). */
export const TENANT_ROLES: Role[] = [...ROLES];

const tenantAll = [...PERMISSIONS] as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  tenant_owner: tenantAll,
  business_admin: tenantAll,
  branch_manager: [
    'products.read', 'products.manage', 'prices.manage', 'products.cost',
    'inventory.read', 'inventory.adjust', 'inventory.adjust.approve', 'inventory.transfer', 'inventory.stocktake', 'inventory.receive',
    'customers.read', 'customers.manage', 'suppliers.read', 'credit.approve', 'customers.payments',
    'purchasing.read',
    'sales.create', 'sales.read', 'sales.read.all', 'sales.discount', 'sales.discount.override', 'sales.price.override', 'sales.void', 'sales.items.remove', 'vouchers.manage', 'loyalty.manage', 'sales.return', 'returns.approve', 'sales.credit',
    'quotations.manage', 'shifts.open', 'shifts.manage', 'cash.movement', 'payments.reconcile', 'terminals.refund', 'terminals.reconcile', 'expenses.manage',
    'reports.read', 'commissions.read', 'biometrics.enroll', 'hardware.manage', 'hr.manage', 'crm.manage', 'orders.manage',
  ],
  inventory_manager: [
    'products.read', 'products.manage', 'products.cost', 'inventory.read', 'inventory.adjust', 'inventory.adjust.approve', 'inventory.transfer',
    'inventory.stocktake', 'inventory.receive', 'suppliers.read', 'purchasing.read', 'reports.read',
  ],
  procurement_officer: [
    'products.read', 'products.cost', 'inventory.read', 'inventory.receive', 'suppliers.read', 'suppliers.manage', 'purchasing.read', 'purchasing.manage', 'reports.read',
  ],
  cashier: ['products.read', 'inventory.read', 'customers.read', 'sales.create', 'sales.read', 'sales.discount', 'shifts.open', 'cash.movement', 'customers.payments', 'orders.manage'],
  accountant: [
    'products.read', 'products.cost', 'inventory.read', 'customers.read', 'suppliers.read', 'suppliers.pay', 'purchasing.read', 'sales.read', 'sales.read.all',
    'payments.reconcile', 'terminals.reconcile', 'payouts.request', 'expenses.manage', 'customers.payments', 'reports.read', 'reports.financial', 'commissions.read', 'audit.read',
    'payroll.manage', 'accounting.read', 'accounting.manage',
  ],
  auditor: [
    'products.read', 'products.cost', 'inventory.read', 'customers.read', 'suppliers.read', 'purchasing.read', 'sales.read', 'sales.read.all',
    'reports.read', 'reports.financial', 'audit.read', 'commissions.read', 'accounting.read',
  ],
  salesperson: ['products.read', 'inventory.read', 'customers.read', 'customers.manage', 'sales.create', 'sales.read', 'quotations.manage', 'sales.discount', 'commissions.read', 'crm.manage'],
  warehouse_operator: ['products.read', 'inventory.read', 'inventory.receive', 'inventory.transfer', 'inventory.stocktake', 'purchasing.read'],
};

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const set = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r as Role] ?? []) set.add(p);
  return set;
}

/** Custom roles are stored per business with keys like "custom:shelf-filler". */
export const CUSTOM_ROLE_PREFIX = 'custom:';
export const isCustomRole = (r: string) => r.startsWith(CUSTOM_ROLE_PREFIX);
export const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);

/**
 * What a user may actually do: built-in roles + custom roles + permissions granted to them, minus the ones
 * denied to them. Owners always have everything (a deny cannot lock the business out).
 */
export function effectivePermissions(input: {
  roles: readonly string[];
  customRoles?: readonly { key: string; permissions: readonly string[] }[];
  extraPermissions?: readonly string[];
  deniedPermissions?: readonly string[];
}): Set<Permission> {
  const builtIn = input.roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  const set = permissionsForRoles(builtIn);
  if (builtIn.includes('tenant_owner')) return set;
  for (const c of input.customRoles ?? []) if (input.roles.includes(c.key)) for (const p of c.permissions) if (isPermission(p)) set.add(p);
  for (const p of input.extraPermissions ?? []) if (isPermission(p)) set.add(p);
  for (const p of input.deniedPermissions ?? []) set.delete(p as Permission);
  return set;
}

export const PERMISSION_GROUPS = ['Administration', 'Products', 'Stock', 'Customers & suppliers', 'Purchasing', 'Selling', 'Till & cash', 'Payments', 'People', 'Accounts', 'Reports'] as const;

/** Labels for the roles screen. "sensitive" marks money, people and system access. */
export const PERMISSION_INFO: Record<Permission, { label: string; group: (typeof PERMISSION_GROUPS)[number]; sensitive?: boolean }> = {
  'settings.manage': { label: 'Change business settings', group: 'Administration', sensitive: true },
  'users.manage': { label: 'Manage users and roles', group: 'Administration', sensitive: true },
  'branches.manage': { label: 'Manage branches, warehouses and tills', group: 'Administration', sensitive: true },
  'integrations.manage': { label: 'Manage integrations (M-Pesa, KRA, SMS, email)', group: 'Administration', sensitive: true },
  'hardware.manage': { label: 'Set up printers and devices', group: 'Administration' },
  'biometrics.enroll': { label: 'Enrol fingerprints and issue staff cards', group: 'Administration', sensitive: true },
  'products.read': { label: 'See products', group: 'Products' },
  'products.manage': { label: 'Add and edit products', group: 'Products' },
  'prices.manage': { label: 'Change prices and promotions', group: 'Products', sensitive: true },
  'products.cost': { label: 'See cost prices and margins', group: 'Products', sensitive: true },
  'inventory.read': { label: 'See stock levels', group: 'Stock' },
  'inventory.adjust': { label: 'Adjust stock', group: 'Stock', sensitive: true },
  'inventory.adjust.approve': { label: 'Approve stock adjustments', group: 'Stock', sensitive: true },
  'inventory.transfer': { label: 'Transfer stock', group: 'Stock' },
  'inventory.stocktake': { label: 'Count stock (stocktake)', group: 'Stock' },
  'inventory.receive': { label: 'Receive goods', group: 'Stock' },
  'customers.read': { label: 'See customers', group: 'Customers & suppliers' },
  'customers.manage': { label: 'Add and edit customers', group: 'Customers & suppliers' },
  'suppliers.read': { label: 'See suppliers', group: 'Customers & suppliers' },
  'suppliers.manage': { label: 'Add and edit suppliers', group: 'Customers & suppliers' },
  'suppliers.pay': { label: 'Pay suppliers', group: 'Customers & suppliers', sensitive: true },
  'credit.approve': { label: 'Approve customer credit', group: 'Customers & suppliers', sensitive: true },
  'purchasing.read': { label: 'See quotations, orders and deliveries', group: 'Purchasing' },
  'purchasing.manage': { label: 'Request quotes and place purchase orders', group: 'Purchasing' },
  'sales.create': { label: 'Sell at the till', group: 'Selling' },
  'sales.read': { label: 'See own sales', group: 'Selling' },
  'sales.read.all': { label: 'See everyone’s sales', group: 'Selling' },
  'sales.discount': { label: 'Give discounts (within the limit)', group: 'Selling' },
  'sales.discount.override': { label: 'Approve discounts above the limit', group: 'Selling', sensitive: true },
  'sales.price.override': { label: 'Change prices at the till', group: 'Selling', sensitive: true },
  'sales.void': { label: 'Void sales', group: 'Selling', sensitive: true },
  'vouchers.manage': { label: 'Issue, sell and cancel gift vouchers', group: 'Selling', sensitive: true },
  'loyalty.manage': { label: 'Run the loyalty program: cards and point adjustments', group: 'Customers & suppliers', sensitive: true },
  'sales.items.remove': { label: 'Remove scanned items or clear a sale (when Checkout rules require approval)', group: 'Selling', sensitive: true },
  'sales.return': { label: 'Process returns and refunds', group: 'Selling', sensitive: true },
  'returns.approve': { label: 'Approve returns outside the policy', group: 'Selling', sensitive: true },
  'sales.credit': { label: 'Sell on credit', group: 'Selling', sensitive: true },
  'quotations.manage': { label: 'Make quotations and sales orders', group: 'Selling' },
  'customers.payments': { label: 'Receive customer account payments', group: 'Selling' },
  'orders.manage': { label: 'Handle online orders', group: 'Selling' },
  'shifts.open': { label: 'Open and close own shift', group: 'Till & cash' },
  'shifts.manage': { label: 'Manage all shifts and tills', group: 'Till & cash', sensitive: true },
  'cash.movement': { label: 'Cash in / cash out (drawer)', group: 'Till & cash', sensitive: true },
  'expenses.manage': { label: 'Record expenses', group: 'Till & cash', sensitive: true },
  'payments.reconcile': { label: 'Reconcile M-Pesa and online payments', group: 'Payments', sensitive: true },
  'payouts.request': { label: 'Request M-Pesa payouts', group: 'Payments', sensitive: true },
  'payouts.approve': { label: 'Approve and send M-Pesa payouts', group: 'Payments', sensitive: true },
  'terminals.manage': { label: 'Set up bank card terminals (pairing, tills, enabling)', group: 'Payments', sensitive: true },
  'terminals.refund': { label: 'Refund card payments on a card terminal', group: 'Payments', sensitive: true },
  'terminals.reconcile': { label: 'Reconcile card terminal payments and cancel others’ card payments', group: 'Payments', sensitive: true },
  'hr.manage': { label: 'Manage employees, leave and attendance', group: 'People', sensitive: true },
  'payroll.manage': { label: 'Prepare payroll', group: 'People', sensitive: true },
  'payroll.approve': { label: 'Approve and pay payroll', group: 'People', sensitive: true },
  'crm.manage': { label: 'Run CRM and campaigns', group: 'Customers & suppliers' },
  'accounting.read': { label: 'See the books', group: 'Accounts', sensitive: true },
  'accounting.manage': { label: 'Post journals and close periods', group: 'Accounts', sensitive: true },
  'reports.read': { label: 'See sales and stock reports', group: 'Reports' },
  'reports.financial': { label: 'See profit, tax and financial reports', group: 'Reports', sensitive: true },
  'audit.read': { label: 'See the audit trail', group: 'Reports', sensitive: true },
  'commissions.read': { label: 'See commissions', group: 'Reports' },
};

export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return permissionsForRoles(roles).has(permission);
}

export const ROLE_LABELS: Record<Role, string> = {
  tenant_owner: 'Owner',
  business_admin: 'Business administrator',
  branch_manager: 'Branch manager',
  inventory_manager: 'Inventory manager',
  procurement_officer: 'Procurement officer',
  cashier: 'Cashier',
  accountant: 'Accountant',
  auditor: 'Auditor',
  salesperson: 'Salesperson',
  warehouse_operator: 'Warehouse operator',
};
