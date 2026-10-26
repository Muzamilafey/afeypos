import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ModuleKey, Permission } from '@afeypos/shared';
import { useAuth } from './lib/auth';
import { AppShell } from './layouts/AppShell';
import { Loading, EmptyState } from './components/ui';
import { ForgotPasswordPage, LoginPage, SetupPage, ResetPasswordPage, VerifyEmailPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { POSPage } from './pages/POS';
import { SaleDetailPage, SalesPage, ShiftsPage } from './pages/sales/Sales';
import { ReturnsPage } from './pages/sales/Returns';
import { AttendancePage, EmployeeDetailPage, EmployeesPage, LeavePage, PayrollPage, PayrollRunPage } from './pages/hr/HR';
import { PayoutsPage } from './pages/Payouts';
import { SupportPage } from './pages/Support';
import { AccountingPage, LedgerPage } from './pages/accounting/Accounting';
import { CrmPage } from './pages/crm/CRM';
import { OnlineOrdersPage, StoreSettingsPage } from './pages/OnlineOrders';
import { StoreStudioPage } from './pages/StoreStudio';
import { RolesPage } from './pages/settings/Roles';
import { PurchasingPage } from './pages/sales/Purchasing';
import { DocumentsPage } from './pages/sales/Documents';
import { ProductEditPage, ProductsPage } from './pages/inventory/Products';
import { AdjustmentsPage, LabelsPage, MovementsPage, StockLevelsPage, StocktakesPage, TransfersPage } from './pages/inventory/Inventory';
import { PartiesPage, PartyDetailPage } from './pages/parties/Parties';
import { AuditPage, ExpensesPage, MpesaPage, OnlinePaymentsPage, PromotionsPage, ReportsPage, RepairsPage } from './pages/Finance';
import { AccountPage, BusinessSettingsPage, HardwarePage, IntegrationsPage, LocationsPage, UsersPage } from './pages/settings/Settings';
import { SyncPage } from './pages/settings/Sync';
import { EtimsPage } from './pages/Etims';

function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return <>{children}</>;
}

/** UI-level guard; the server enforces the same rules. */
function Gate({ perm, module, children }: { perm?: Permission; module?: ModuleKey; children: ReactNode }) {
  const { can, has } = useAuth();
  if ((perm && !can(perm)) || (module && !has(module))) return <EmptyState title="Not available" icon="shield">You do not have access to this page, or the module is not enabled.</EmptyState>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<Navigate to="/setup" replace />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route element={<Protected><AppShell /></Protected>}>
        <Route index element={<DashboardPage />} />
        <Route path="pos" element={<Gate perm="sales.create" module="pos"><POSPage /></Gate>} />
        <Route path="sales" element={<Gate perm="sales.read"><SalesPage /></Gate>} />
        <Route path="sales/:id" element={<Gate perm="sales.read"><SaleDetailPage /></Gate>} />
        <Route path="returns" element={<Gate perm="sales.read" module="pos"><ReturnsPage /></Gate>} />
        <Route path="shifts" element={<Gate perm="shifts.open"><ShiftsPage /></Gate>} />
        <Route path="documents/:type" element={<Gate perm="sales.read"><DocumentsPage /></Gate>} />
        <Route path="repairs" element={<Gate module="repairs"><RepairsPage /></Gate>} />
        <Route path="products" element={<Gate perm="products.read"><ProductsPage /></Gate>} />
        <Route path="products/:id" element={<Gate perm="products.read"><ProductEditPage /></Gate>} />
        <Route path="inventory" element={<Gate perm="inventory.read"><StockLevelsPage /></Gate>} />
        <Route path="inventory/movements" element={<Gate perm="inventory.read"><MovementsPage /></Gate>} />
        <Route path="inventory/adjustments" element={<Gate perm="inventory.adjust"><AdjustmentsPage /></Gate>} />
        <Route path="inventory/transfers" element={<Gate perm="inventory.transfer" module="stockTransfers"><TransfersPage /></Gate>} />
        <Route path="inventory/stocktakes" element={<Gate perm="inventory.stocktake" module="stocktake"><StocktakesPage /></Gate>} />
        <Route path="labels" element={<Gate perm="products.read"><LabelsPage /></Gate>} />
        <Route path="purchasing" element={<Gate perm="purchasing.read" module="purchasing"><PurchasingPage tab="orders" /></Gate>} />
        <Route path="purchasing/quotations" element={<Gate perm="purchasing.read" module="purchasing"><PurchasingPage tab="quotations" /></Gate>} />
        <Route path="purchasing/receiving" element={<Gate perm="purchasing.read" module="purchasing"><PurchasingPage tab="receiving" /></Gate>} />
        <Route path="customers" element={<Gate perm="customers.read"><PartiesPage kind="customer" /></Gate>} />
        <Route path="customers/:id" element={<Gate perm="customers.read"><PartyDetailPage kind="customer" /></Gate>} />
        <Route path="suppliers" element={<Gate perm="suppliers.read"><PartiesPage kind="supplier" /></Gate>} />
        <Route path="suppliers/:id" element={<Gate perm="suppliers.read"><PartyDetailPage kind="supplier" /></Gate>} />
        <Route path="promotions" element={<Gate perm="prices.manage" module="promotions"><PromotionsPage /></Gate>} />
        <Route path="reports" element={<Gate perm="reports.read"><ReportsPage /></Gate>} />
        <Route path="expenses" element={<Gate perm="expenses.manage"><ExpensesPage /></Gate>} />
        <Route path="payments/mpesa" element={<Gate perm="payments.reconcile" module="mpesa"><MpesaPage /></Gate>} />
        <Route path="payments/online" element={<Gate perm="payments.reconcile" module="payments"><OnlinePaymentsPage /></Gate>} />
        <Route path="online-orders" element={<Gate perm="orders.manage" module="onlineStore"><OnlineOrdersPage /></Gate>} />
        <Route path="settings/online-shop" element={<Gate perm="settings.manage" module="onlineStore"><StoreSettingsPage /></Gate>} />
        <Route path="settings/store-studio" element={<Gate perm="settings.manage" module="onlineStore"><StoreStudioPage /></Gate>} />
        <Route path="accounting" element={<Gate perm="accounting.read" module="accounting"><AccountingPage /></Gate>} />
        <Route path="accounting/ledger/:code" element={<Gate perm="accounting.read" module="accounting"><LedgerPage /></Gate>} />
        <Route path="crm" element={<Gate perm="customers.read" module="crm"><CrmPage /></Gate>} />
        <Route path="payments/payouts" element={<Gate perm="payouts.request" module="mpesa"><PayoutsPage /></Gate>} />
        <Route path="hr/employees" element={<Gate perm="hr.manage" module="hr"><EmployeesPage /></Gate>} />
        <Route path="hr/employees/:id" element={<Gate perm="hr.manage" module="hr"><EmployeeDetailPage /></Gate>} />
        <Route path="hr/payroll" element={<Gate perm="payroll.manage" module="hr"><PayrollPage /></Gate>} />
        <Route path="hr/payroll/:id" element={<Gate perm="payroll.manage" module="hr"><PayrollRunPage /></Gate>} />
        <Route path="hr/leave" element={<Gate perm="hr.manage" module="hr"><LeavePage /></Gate>} />
        <Route path="hr/attendance" element={<Gate perm="hr.manage" module="hr"><AttendancePage /></Gate>} />
        <Route path="etims" element={<Gate perm="reports.financial" module="etims"><EtimsPage /></Gate>} />
        <Route path="audit" element={<Gate perm="audit.read"><AuditPage /></Gate>} />
        <Route path="settings" element={<Gate perm="settings.manage"><BusinessSettingsPage /></Gate>} />
        <Route path="settings/users" element={<Gate perm="users.manage"><UsersPage /></Gate>} />
        <Route path="settings/roles" element={<Gate perm="users.manage"><RolesPage /></Gate>} />
        <Route path="settings/locations" element={<Gate perm="branches.manage"><LocationsPage /></Gate>} />
        <Route path="settings/sync" element={<Gate perm="settings.manage"><SyncPage /></Gate>} />
        <Route path="settings/integrations" element={<Gate perm="integrations.manage"><IntegrationsPage /></Gate>} />
        <Route path="settings/hardware" element={<Gate perm="hardware.manage"><HardwarePage /></Gate>} />
        <Route path="account" element={<AccountPage />} />
        <Route path="support" element={<SupportPage />} />
        <Route path="*" element={<EmptyState title="Page not found" />} />
      </Route>
    </Routes>
  );
}
