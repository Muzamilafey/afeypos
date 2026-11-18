import { describe, expect, it } from 'vitest';
import { permissionsForRoles, type Role } from '@afeypos/shared';
import { dashboardKind } from '../pages/Dashboard';

const kindFor = (roles: Role[], modules = ['reports', 'accounting']) => {
  const perms = permissionsForRoles(roles);
  return dashboardKind(roles, (p) => perms.has(p), (m) => modules.includes(m));
};

describe('dashboard by role', () => {
  it('gives each role its own dashboard', () => {
    expect(kindFor(['tenant_owner'])).toBe('admin');
    expect(kindFor(['business_admin'])).toBe('admin');
    expect(kindFor(['accountant'])).toBe('finance');
    expect(kindFor(['auditor'])).toBe('finance');
    expect(kindFor(['branch_manager'])).toBe('manager');
    expect(kindFor(['cashier'])).toBe('sales');
    expect(kindFor(['salesperson'])).toBe('sales');
    expect(kindFor(['inventory_manager'])).toBe('stock');
    expect(kindFor(['procurement_officer'])).toBe('stock');
    expect(kindFor(['warehouse_operator'])).toBe('stock');
    // Without the accounting module an accountant sees the business view.
    expect(kindFor(['accountant'], ['reports'])).toBe('manager');
  });
});
