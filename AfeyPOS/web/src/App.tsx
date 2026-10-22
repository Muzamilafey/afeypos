import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ModuleKey, Permission } from '@afeypos/shared';
import { useAuth } from './lib/auth';
import { AppShell } from './layouts/AppShell';
import { Loading, EmptyState } from './components/ui';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { POSPage } from './pages/POS';
import { SaleDetailPage, SalesPage, ShiftsPage } from './pages/sales/Sales';
import { PurchasingPage } from './pages/sales/Purchasing';
import { DocumentsPage } from './pages/sales/Documents';
import { ProductEditPage, ProductsPage } from './pages/inventory/Products';
import { AdjustmentsPage, LabelsPage, MovementsPage, StockLevelsPage, StocktakesPage, TransfersPage } from './pages/inventory/Inventory';
import { PartiesPage, PartyDetailPage } from './pages/parties/Parties';
import { AuditPage, ExpensesPage, MpesaPage, OnlinePaymentsPage, PromotionsPage, ReportsPage, RepairsPage } from './pages/Finance';
import { AccountPage, BusinessSettingsPage, HardwarePage, IntegrationsPage, LocationsPage, UsersPage } from './pages/settings/Settings';
import { PlatformAudit, PlatformJobs, PlatformLayout, PlatformOverview, PlatformPlans, PlatformSupport, PlatformTenantDetail, PlatformTenants } from './pages/platform/Platform';

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
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/setup" element={<RegisterPage setup />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/platform" element={<PlatformLayout />}>
        <Route index element={<PlatformOverview />} />
        <Route path="tenants" element={<PlatformTenants />} />
        <Route path="tenants/:id" element={<PlatformTenantDetail />} />
        <Route path="plans" element={<PlatformPlans />} />
        <Route path="support" element={<PlatformSupport />} />
        <Route path="jobs" element={<PlatformJobs />} />
        <Route path="audit" element={<PlatformAudit />} />
      </Route>
      <Route element={<Protected><AppShell /></Protected>}>
        <Route index element={<DashboardPage />} />
        <Route path="pos" element={<Gate perm="sales.create" module="pos"><POSPage /></Gate>} />
        <Route path="sales" element={<Gate perm="sales.read"><SalesPage /></Gate>} />
        <Route path="sales/:id" element={<Gate perm="sales.read"><SaleDetailPage /></Gate>} />
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
        <Route path="purchasing" element={<Gate perm="purchasing.read" module="purchasing"><PurchasingPage /></Gate>} />
        <Route path="customers" element={<Gate perm="customers.read"><PartiesPage kind="customer" /></Gate>} />
        <Route path="customers/:id" element={<Gate perm="customers.read"><PartyDetailPage kind="customer" /></Gate>} />
        <Route path="suppliers" element={<Gate perm="suppliers.read"><PartiesPage kind="supplier" /></Gate>} />
        <Route path="suppliers/:id" element={<Gate perm="suppliers.read"><PartyDetailPage kind="supplier" /></Gate>} />
        <Route path="promotions" element={<Gate perm="prices.manage" module="promotions"><PromotionsPage /></Gate>} />
        <Route path="reports" element={<Gate perm="reports.read"><ReportsPage /></Gate>} />
        <Route path="expenses" element={<Gate perm="expenses.manage"><ExpensesPage /></Gate>} />
        <Route path="payments/mpesa" element={<Gate perm="payments.reconcile" module="mpesa"><MpesaPage /></Gate>} />
        <Route path="payments/online" element={<Gate perm="payments.reconcile" module="payments"><OnlinePaymentsPage /></Gate>} />
        <Route path="audit" element={<Gate perm="audit.read"><AuditPage /></Gate>} />
        <Route path="settings" element={<Gate perm="settings.manage"><BusinessSettingsPage /></Gate>} />
        <Route path="settings/users" element={<Gate perm="users.manage"><UsersPage /></Gate>} />
        <Route path="settings/locations" element={<Gate perm="branches.manage"><LocationsPage /></Gate>} />
        <Route path="settings/integrations" element={<Gate perm="integrations.manage"><IntegrationsPage /></Gate>} />
        <Route path="settings/hardware" element={<Gate perm="hardware.manage"><HardwarePage /></Gate>} />
        <Route path="account" element={<AccountPage />} />
        <Route path="*" element={<EmptyState title="Page not found" />} />
      </Route>
    </Routes>
  );
}
