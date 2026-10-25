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
  'sales.return',
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
  'expenses.manage',
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
    'products.read', 'products.manage', 'prices.manage',
    'inventory.read', 'inventory.adjust', 'inventory.adjust.approve', 'inventory.transfer', 'inventory.stocktake', 'inventory.receive',
    'customers.read', 'customers.manage', 'suppliers.read', 'credit.approve', 'customers.payments',
    'purchasing.read',
    'sales.create', 'sales.read', 'sales.read.all', 'sales.discount', 'sales.discount.override', 'sales.price.override', 'sales.void', 'sales.return', 'sales.credit',
    'quotations.manage', 'shifts.open', 'shifts.manage', 'cash.movement', 'payments.reconcile', 'expenses.manage',
    'reports.read', 'commissions.read', 'biometrics.enroll', 'hardware.manage',
  ],
  inventory_manager: [
    'products.read', 'products.manage', 'inventory.read', 'inventory.adjust', 'inventory.adjust.approve', 'inventory.transfer',
    'inventory.stocktake', 'inventory.receive', 'suppliers.read', 'purchasing.read', 'reports.read',
  ],
  procurement_officer: [
    'products.read', 'inventory.read', 'inventory.receive', 'suppliers.read', 'suppliers.manage', 'purchasing.read', 'purchasing.manage', 'reports.read',
  ],
  cashier: ['products.read', 'inventory.read', 'customers.read', 'sales.create', 'sales.read', 'sales.discount', 'shifts.open', 'cash.movement', 'customers.payments'],
  accountant: [
    'products.read', 'inventory.read', 'customers.read', 'suppliers.read', 'suppliers.pay', 'purchasing.read', 'sales.read', 'sales.read.all',
    'payments.reconcile', 'payouts.request', 'expenses.manage', 'customers.payments', 'reports.read', 'reports.financial', 'commissions.read', 'audit.read',
  ],
  auditor: [
    'products.read', 'inventory.read', 'customers.read', 'suppliers.read', 'purchasing.read', 'sales.read', 'sales.read.all',
    'reports.read', 'reports.financial', 'audit.read', 'commissions.read',
  ],
  salesperson: ['products.read', 'inventory.read', 'customers.read', 'customers.manage', 'sales.create', 'sales.read', 'quotations.manage', 'sales.discount', 'commissions.read'],
  warehouse_operator: ['products.read', 'inventory.read', 'inventory.receive', 'inventory.transfer', 'inventory.stocktake', 'purchasing.read'],
};

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const set = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) set.add(p);
  return set;
}

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
