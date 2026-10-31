/**
 * Centralised business-profile and feature-capability system.
 *
 * Code never checks the business type directly. Instead it asks whether a *module*
 * is enabled (`hasModule(caps, 'quotations')`). The business type only decides which
 * modules, product fields, units, price lists and checkout options are switched on by
 * default when a tenant is created. Owners can enable further modules later; disabling
 * a module hides it but never deletes data.
 */
import type { Permission } from './permissions.js';

export const MODULES = [
  'pos',
  'inventory',
  'purchasing',
  'customers',
  'suppliers',
  'customerCredit',
  'quotations',
  'salesOrders',
  'deliveryNotes',
  'invoices',
  'priceLists',
  'customerPricing',
  'unitConversions',
  'fractionalQuantities',
  'bulkDiscounts',
  'batchExpiry',
  'serialNumbers',
  'warranty',
  'repairs',
  'variants',
  'promotions',
  'loyalty',
  'multiTill',
  'multiBranch',
  'stockTransfers',
  'stocktake',
  'labels',
  'weighedItems',
  'salesReps',
  'prescriptions',
  'ageVerification',
  'expenses',
  'reports',
  'mpesa',
  'payments',
  'etims',
  'sms',
  'email',
  'biometrics',
  'hardware',
  'hr',
  'accounting',
  'crm',
  'onlineStore',
] as const;

export type ModuleKey = (typeof MODULES)[number];

export const MODULE_INFO: Record<ModuleKey, { label: string; description: string }> = {
  pos: { label: 'Point of sale', description: 'Checkout, receipts, tills and shifts' },
  inventory: { label: 'Inventory', description: 'Stock levels, movements and adjustments' },
  purchasing: { label: 'Purchasing', description: 'Purchase orders, goods received notes and supplier invoices' },
  customers: { label: 'Customers', description: 'Customer profiles and history' },
  suppliers: { label: 'Suppliers', description: 'Supplier profiles, balances and payments' },
  customerCredit: { label: 'Customer credit', description: 'Credit sales, limits, statements and ageing' },
  quotations: { label: 'Quotations', description: 'Quotes that convert into sales' },
  salesOrders: { label: 'Sales orders', description: 'Orders for later fulfilment' },
  deliveryNotes: { label: 'Delivery notes', description: 'Dispatch and delivery documents' },
  invoices: { label: 'Invoices', description: 'Customer invoices with due dates' },
  priceLists: { label: 'Price lists', description: 'Retail, wholesale and contractor prices' },
  customerPricing: { label: 'Customer-specific prices', description: 'Negotiated prices per customer' },
  unitConversions: { label: 'Units & conversions', description: 'Cartons, packs, bags, metres and conversion factors' },
  fractionalQuantities: { label: 'Fractional quantities', description: 'Sell 2.5 m, 0.75 kg and similar quantities' },
  bulkDiscounts: { label: 'Bulk discounts', description: 'Quantity-tier pricing and minimum order quantities' },
  batchExpiry: { label: 'Batches & expiry', description: 'Batch numbers, expiry dates and FEFO picking' },
  serialNumbers: { label: 'Serial numbers / IMEI', description: 'Track individual serialised items' },
  warranty: { label: 'Warranty', description: 'Warranty periods and lookups' },
  repairs: { label: 'Repairs', description: 'Repair job records' },
  variants: { label: 'Variants', description: 'Size and colour variants' },
  promotions: { label: 'Promotions & coupons', description: 'Time-bound discounts and coupon codes' },
  loyalty: { label: 'Loyalty', description: 'Points earned and redeemed by customers' },
  multiTill: { label: 'Multiple tills', description: 'Several checkout tills per branch' },
  multiBranch: { label: 'Multiple branches', description: 'Branches, warehouses and branch comparisons' },
  stockTransfers: { label: 'Stock transfers', description: 'Move stock between warehouses and branches' },
  stocktake: { label: 'Stocktaking', description: 'Physical counts and reconciliation' },
  labels: { label: 'Labels & barcodes', description: 'Shelf labels and barcode printing' },
  weighedItems: { label: 'Weighed items', description: 'Scale barcodes and variable-weight products' },
  salesReps: { label: 'Sales reps & commissions', description: 'Assign sales to reps and compute commissions' },
  prescriptions: { label: 'Prescriptions', description: 'Prescription-only medicine controls (pharmacy)' },
  ageVerification: { label: 'Age verification', description: 'Age checks for restricted products (liquor)' },
  expenses: { label: 'Expenses', description: 'Business expenses and petty cash' },
  reports: { label: 'Reports', description: 'Sales, stock and financial reports' },
  mpesa: { label: 'M-Pesa', description: 'Safaricom Daraja STK Push and C2B' },
  etims: { label: 'KRA eTIMS', description: 'Sales, credit notes and items signed by KRA eTIMS (OSCU online or VSCU on the shop network)' },
  payments: { label: 'Payment gateways', description: 'Paystack, Flutterwave, pawaPay, Airtel Money, Kopo Kopo, Hubtel and other mobile-money and card gateways' },
  sms: { label: 'SMS', description: 'SMS receipts and reminders' },
  email: { label: 'Email', description: 'Email receipts, statements and reports' },
  biometrics: { label: 'Biometrics', description: 'Fingerprint verification and attendance' },
  hardware: { label: 'Hardware', description: 'Printers, drawers, scales and displays' },
  hr: { label: 'HR & payroll', description: 'Employees, attendance, leave, advances and Kenyan payroll (PAYE, SHIF, NSSF, Housing Levy) with optional M-Pesa salary payments' },
  accounting: { label: 'Accounting', description: 'Chart of accounts, automatic journals, trial balance, profit & loss and balance sheet' },
  crm: { label: 'CRM', description: 'Customer segments, activities and follow-ups, insights and SMS campaigns' },
  onlineStore: { label: 'Online shop', description: 'A separate shopping website with orders picked and fulfilled from your branches' },
};

/** Afey POS is built for food and grocery retail: minimarts and supermarkets (one or many branches). */
export const BUSINESS_TYPES = ['minimart', 'supermarket'] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const PRODUCT_FIELDS = [
  'brand',
  'dimensions',
  'grade',
  'specifications',
  'size',
  'color',
  'material',
  'model',
  'warrantyMonths',
  'expiry',
  'batch',
  'serial',
  'genericName',
  'strength',
  'dosageForm',
  'requiresPrescription',
  'controlledSubstance',
  'abv',
  'volumeMl',
  'ageRestricted',
  'department',
  'plu',
  'soldByWeight',
] as const;

export type ProductField = (typeof PRODUCT_FIELDS)[number];

export const PRICE_LISTS = ['retail', 'wholesale', 'contractor'] as const;
export type PriceListKey = (typeof PRICE_LISTS)[number];

export interface UnitTemplate {
  code: string;
  name: string;
  /** Whether fractional quantities make sense (metres yes, bags no). */
  fractional: boolean;
}

export const STANDARD_UNITS: UnitTemplate[] = [
  { code: 'pc', name: 'Piece', fractional: false },
  { code: 'bag', name: 'Bag', fractional: false },
  { code: 'sheet', name: 'Sheet', fractional: false },
  { code: 'm', name: 'Metre', fractional: true },
  { code: 'ft', name: 'Foot', fractional: true },
  { code: 'kg', name: 'Kilogram', fractional: true },
  { code: 'g', name: 'Gram', fractional: true },
  { code: 't', name: 'Tonne', fractional: true },
  { code: 'l', name: 'Litre', fractional: true },
  { code: 'ml', name: 'Millilitre', fractional: true },
  { code: 'ctn', name: 'Carton', fractional: false },
  { code: 'case', name: 'Case', fractional: false },
  { code: 'box', name: 'Box', fractional: false },
  { code: 'pack', name: 'Pack', fractional: false },
  { code: 'dozen', name: 'Dozen', fractional: false },
  { code: 'roll', name: 'Roll', fractional: false },
  { code: 'pair', name: 'Pair', fractional: false },
  { code: 'bottle', name: 'Bottle', fractional: false },
  { code: 'strip', name: 'Strip', fractional: false },
  { code: 'tab', name: 'Tablet', fractional: false },
  { code: 'set', name: 'Set', fractional: false },
  { code: 'ream', name: 'Ream', fractional: false },
];

export interface CheckoutOptions {
  /** Large touch targets and quick keys. */
  touchMode: boolean;
  /** Barcode-first flow: the search box is always focused for scanners. */
  scanFirst: boolean;
  showPriceListSelector: boolean;
  showUnitSelector: boolean;
  allowFractionalQty: boolean;
  requireCustomerForCredit: boolean;
  defaultPriceList: PriceListKey;
}

export interface BusinessProfile {
  type: BusinessType;
  name: string;
  description: string;
  modules: ModuleKey[];
  productFields: ProductField[];
  units: string[];
  priceLists: PriceListKey[];
  checkout: CheckoutOptions;
  dashboardWidgets: string[];
  suggestedCategories: string[];
}

const CORE: ModuleKey[] = ['pos', 'inventory', 'customers', 'suppliers', 'purchasing', 'reports', 'expenses', 'stocktake', 'mpesa', 'payments', 'etims', 'sms', 'email', 'hardware', 'labels', 'hr', 'accounting', 'crm', 'onlineStore'];

const baseCheckout: CheckoutOptions = {
  touchMode: false,
  scanFirst: true,
  showPriceListSelector: false,
  showUnitSelector: false,
  allowFractionalQty: false,
  requireCustomerForCredit: true,
  defaultPriceList: 'retail',
};

export const BUSINESS_PROFILES: Record<BusinessType, BusinessProfile> = {
  minimart: {
    type: 'minimart',
    name: 'Minimart',
    description: 'Fast barcode checkout, M-Pesa, expiry tracking, cashier shifts and credit for regulars. One or a few branches.',
    modules: [...CORE, 'batchExpiry', 'promotions', 'loyalty', 'customerCredit', 'unitConversions', 'multiBranch', 'stockTransfers'],
    productFields: ['brand', 'expiry', 'department'],
    units: ['pc', 'pack', 'kg', 'g', 'l', 'ml', 'ctn', 'dozen'],
    priceLists: ['retail', 'wholesale'],
    checkout: { ...baseCheckout, touchMode: true },
    dashboardWidgets: ['salesToday', 'paymentMix', 'lowStock', 'expiringSoon', 'openShifts', 'topProducts'],
    suggestedCategories: ['Groceries', 'Flour & cereals', 'Cooking oil & fats', 'Dairy', 'Bakery', 'Beverages', 'Snacks & confectionery', 'Household & cleaning', 'Personal care', 'Baby care'],
  },
  supermarket: {
    type: 'supermarket',
    name: 'Supermarket / hypermarket',
    description: 'Many tills and branches, departments, weighed fresh produce, promotions, loyalty, wholesale cartons and branch transfers.',
    modules: [
      ...CORE, 'multiTill', 'multiBranch', 'stockTransfers', 'batchExpiry', 'promotions', 'loyalty', 'weighedItems', 'customerCredit',
      'variants', 'unitConversions', 'priceLists', 'bulkDiscounts', 'invoices', 'quotations', 'salesOrders', 'deliveryNotes',
    ],
    productFields: ['brand', 'expiry', 'department', 'plu', 'soldByWeight'],
    units: ['pc', 'pack', 'kg', 'g', 'l', 'ml', 'ctn', 'case', 'dozen', 'box'],
    priceLists: ['retail', 'wholesale'],
    checkout: { ...baseCheckout, touchMode: false },
    dashboardWidgets: ['salesToday', 'salesByTill', 'departmentSales', 'branchComparison', 'expiringSoon', 'lowStock', 'openShifts'],
    suggestedCategories: ['Fresh produce', 'Butchery', 'Bakery', 'Dairy', 'Frozen', 'Flour & cereals', 'Cooking oil & fats', 'Beverages', 'Wines & spirits', 'Household & cleaning', 'Personal care', 'Baby care', 'Electronics', 'Stationery'],
  },
};

export interface TenantCapabilityInput {
  businessType: BusinessType;
  /** Extra modules enabled by the owner after onboarding. */
  enabledModules?: ModuleKey[];
  /** Modules explicitly hidden by the owner. Data is preserved. */
  disabledModules?: ModuleKey[];
  /** Plan entitlements (cloud). Undefined = no restriction (local installation). */
  entitledModules?: ModuleKey[];
}

export interface Capabilities {
  businessType: BusinessType;
  modules: ModuleKey[];
  productFields: ProductField[];
  units: string[];
  priceLists: PriceListKey[];
  checkout: CheckoutOptions;
  dashboardWidgets: string[];
}

/** Fields that become available when a module is turned on, independent of business type. */
const MODULE_FIELDS: Partial<Record<ModuleKey, ProductField[]>> = {
  batchExpiry: ['expiry', 'batch'],
  serialNumbers: ['serial'],
  warranty: ['warrantyMonths'],
  prescriptions: ['requiresPrescription', 'controlledSubstance', 'genericName', 'strength', 'dosageForm'],
  ageVerification: ['ageRestricted'],
  weighedItems: ['plu', 'soldByWeight'],
  variants: ['size', 'color'],
};

export function resolveCapabilities(input: TenantCapabilityInput): Capabilities {
  const profile = BUSINESS_PROFILES[input.businessType];
  const set = new Set<ModuleKey>([...profile.modules, ...(input.enabledModules ?? [])]);
  for (const m of input.disabledModules ?? []) if (m !== 'pos' && m !== 'inventory') set.delete(m);
  if (input.entitledModules) {
    const ent = new Set(input.entitledModules);
    for (const m of [...set]) if (!ent.has(m)) set.delete(m);
  }
  const modules = MODULES.filter((m) => set.has(m));
  const fields = new Set<ProductField>(profile.productFields);
  for (const m of modules) for (const f of MODULE_FIELDS[m] ?? []) fields.add(f);
  const priceLists = new Set<PriceListKey>(profile.priceLists);
  if (set.has('priceLists')) for (const p of PRICE_LISTS) priceLists.add(p);
  return {
    businessType: input.businessType,
    modules,
    productFields: PRODUCT_FIELDS.filter((f) => fields.has(f)),
    units: profile.units,
    priceLists: PRICE_LISTS.filter((p) => priceLists.has(p)),
    checkout: {
      ...profile.checkout,
      allowFractionalQty: profile.checkout.allowFractionalQty || set.has('fractionalQuantities'),
      showUnitSelector: profile.checkout.showUnitSelector || set.has('unitConversions'),
      showPriceListSelector: profile.checkout.showPriceListSelector || set.has('priceLists'),
    },
    dashboardWidgets: profile.dashboardWidgets,
  };
}

export function hasModule(caps: Pick<Capabilities, 'modules'>, module: ModuleKey): boolean {
  return caps.modules.includes(module);
}

export interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: string;
  module?: ModuleKey;
  anyModule?: ModuleKey[];
  permission?: Permission;
  group: 'sell' | 'stock' | 'buy' | 'parties' | 'people' | 'reports' | 'finance' | 'admin';
}

export const NAVIGATION: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', icon: 'home', group: 'sell' },
  { key: 'pos', label: 'Checkout', path: '/pos', icon: 'cart', module: 'pos', permission: 'sales.create', group: 'sell' },
  { key: 'sales', label: 'Sales history', path: '/sales', icon: 'receipt', module: 'pos', permission: 'sales.read', group: 'sell' },
  { key: 'quotations', label: 'Quotations', path: '/documents/quotation', icon: 'doc', module: 'quotations', permission: 'quotations.manage', group: 'sell' },
  { key: 'salesOrders', label: 'Sales orders', path: '/documents/sales_order', icon: 'doc', module: 'salesOrders', permission: 'quotations.manage', group: 'sell' },
  { key: 'deliveryNotes', label: 'Delivery notes', path: '/documents/delivery_note', icon: 'truck', module: 'deliveryNotes', permission: 'sales.read', group: 'sell' },
  { key: 'onlineOrders', label: 'Online orders', path: '/online-orders', icon: 'store', module: 'onlineStore', permission: 'orders.manage', group: 'sell' },
  { key: 'returns', label: 'Returns', path: '/returns', icon: 'undo', module: 'pos', permission: 'sales.read', group: 'sell' },
  { key: 'shifts', label: 'Shifts & tills', path: '/shifts', icon: 'clock', module: 'pos', permission: 'shifts.open', group: 'sell' },
  { key: 'repairs', label: 'Repairs', path: '/repairs', icon: 'wrench', module: 'repairs', permission: 'sales.create', group: 'sell' },
  { key: 'products', label: 'Products', path: '/products', icon: 'box', module: 'inventory', permission: 'products.read', group: 'stock' },
  { key: 'units', label: 'Units', path: '/inventory/units', icon: 'layers', module: 'inventory', permission: 'products.read', group: 'stock' },
  { key: 'receiveStock', label: 'Receive stock', path: '/inventory/receive', icon: 'package', module: 'inventory', permission: 'inventory.receive', group: 'stock' },
  { key: 'stock', label: 'Stock levels', path: '/inventory', icon: 'layers', module: 'inventory', permission: 'inventory.read', group: 'stock' },
  { key: 'transfers', label: 'Stock transfers', path: '/inventory/transfers', icon: 'shuffle', module: 'stockTransfers', permission: 'inventory.transfer', group: 'stock' },
  { key: 'categories', label: 'Categories', path: '/inventory/categories', icon: 'grid', module: 'inventory', permission: 'products.read', group: 'stock' },
  { key: 'brands', label: 'Brands', path: '/inventory/brands', icon: 'tag', module: 'inventory', permission: 'products.read', group: 'stock' },
  { key: 'stockAlerts', label: 'Stock alerts', path: '/inventory/alerts', icon: 'alert', module: 'inventory', permission: 'inventory.read', group: 'stock' },
  { key: 'vouchers', label: 'Vouchers', path: '/vouchers', icon: 'tag', module: 'pos', permission: 'vouchers.manage', group: 'stock' },
  { key: 'labels', label: 'Barcode labels', path: '/labels', icon: 'tag', module: 'labels', permission: 'products.read', group: 'stock' },
  { key: 'barcodeVerify', label: 'Barcode verify', path: '/inventory/barcode-verify', icon: 'barcode', module: 'inventory', permission: 'products.read', group: 'stock' },
  { key: 'movements', label: 'Stock movements', path: '/inventory/movements', icon: 'activity', module: 'inventory', permission: 'inventory.read', group: 'stock' },
  { key: 'adjustments', label: 'Adjustments', path: '/inventory/adjustments', icon: 'sliders', module: 'inventory', permission: 'inventory.adjust', group: 'stock' },
  { key: 'stocktake', label: 'Stocktake', path: '/inventory/stocktakes', icon: 'clipboard', module: 'stocktake', permission: 'inventory.stocktake', group: 'stock' },
  { key: 'customers', label: 'Customers', path: '/customers', icon: 'users', module: 'customers', permission: 'customers.read', group: 'parties' },
  { key: 'suppliers', label: 'Suppliers', path: '/suppliers', icon: 'factory', module: 'suppliers', permission: 'suppliers.read', group: 'buy' },
  { key: 'supplierQuotations', label: 'Supplier quotations', path: '/purchasing/quotations', icon: 'doc', module: 'purchasing', permission: 'purchasing.read', group: 'buy' },
  { key: 'purchasing', label: 'Purchase orders', path: '/purchasing', icon: 'truck', module: 'purchasing', permission: 'purchasing.read', group: 'buy' },
  { key: 'goodsReceived', label: 'Goods received', path: '/purchasing/receiving', icon: 'package', module: 'purchasing', permission: 'purchasing.read', group: 'buy' },
  { key: 'promotions', label: 'Promotions', path: '/promotions', icon: 'percent', module: 'promotions', permission: 'prices.manage', group: 'parties' },
  { key: 'employees', label: 'Employees', path: '/hr/employees', icon: 'users', module: 'hr', permission: 'hr.manage', group: 'people' },
  { key: 'payroll', label: 'Payroll', path: '/hr/payroll', icon: 'wallet', module: 'hr', permission: 'payroll.manage', group: 'people' },
  { key: 'leave', label: 'Leave & advances', path: '/hr/leave', icon: 'clock', module: 'hr', permission: 'hr.manage', group: 'people' },
  { key: 'attendance', label: 'Attendance', path: '/hr/attendance', icon: 'clipboard', module: 'hr', permission: 'hr.manage', group: 'people' },
  { key: 'loyalty', label: 'Loyalty program', path: '/loyalty', icon: 'star', module: 'loyalty', permission: 'customers.read', group: 'parties' },
  { key: 'crm', label: 'CRM & campaigns', path: '/crm', icon: 'users', module: 'crm', permission: 'customers.read', group: 'parties' },
  { key: 'accounting', label: 'Accounts', path: '/accounting', icon: 'doc', module: 'accounting', permission: 'accounting.read', group: 'finance' },
  // Reports: one menu entry per report (pages/Finance.tsx ReportsPage, by path).
  { key: 'reportSales', label: 'Sales Reports', path: '/reports/sales', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportInventory', label: 'Inventory Reports', path: '/reports/inventory', icon: 'chart', module: 'reports', permission: 'inventory.read', group: 'reports' },
  { key: 'reportHr', label: 'HR Reports', path: '/reports/hr', icon: 'chart', module: 'hr', permission: 'hr.manage', group: 'reports' },
  { key: 'reportFinancial', label: 'Financial Reports', path: '/reports/financial', icon: 'chart', module: 'reports', permission: 'reports.financial', group: 'reports' },
  { key: 'reportCustomers', label: 'Customer Reports', path: '/reports/customers', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportBrands', label: 'Brand Report', path: '/reports/brands', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportBalance', label: 'Balance Sheet', path: '/reports/balance-sheet', icon: 'chart', module: 'accounting', permission: 'accounting.read', group: 'reports' },
  { key: 'reportTransactions', label: 'Transaction Report', path: '/reports/transactions', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportProfit', label: 'Profit Report', path: '/reports/profit', icon: 'chart', module: 'reports', permission: 'reports.financial', group: 'reports' },
  { key: 'reportUserSales', label: 'User Sales', path: '/reports/user-sales', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportBranchSales', label: 'Branch Sales', path: '/reports/branch-sales', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportLosses', label: 'Loss Report', path: '/reports/losses', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportTrending', label: 'Trending Products', path: '/reports/trending', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportTop', label: 'Most Selling Products', path: '/reports/most-selling', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportNotSelling', label: 'Not Selling (3 Days)', path: '/reports/not-selling', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportSuppliers', label: 'Supplier Report', path: '/reports/suppliers', icon: 'chart', module: 'suppliers', permission: 'reports.financial', group: 'reports' },
  { key: 'reportDrawer', label: 'Drawer Calculations', path: '/reports/drawer', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'reportStockAnalysis', label: 'Stock analysis', path: '/reports/stock-analysis', icon: 'trendUp', module: 'reports', permission: 'inventory.read', group: 'reports' },
  { key: 'reportTransfers', label: 'Stock Transfer Report', path: '/reports/stock-transfers', icon: 'chart', module: 'stockTransfers', permission: 'inventory.read', group: 'reports' },
  { key: 'reports', label: 'More reports', path: '/reports', icon: 'chart', module: 'reports', permission: 'reports.read', group: 'reports' },
  { key: 'expenses', label: 'Expenses', path: '/expenses', icon: 'wallet', module: 'expenses', permission: 'expenses.manage', group: 'finance' },
  { key: 'mpesa', label: 'M-Pesa', path: '/payments/mpesa', icon: 'phone', module: 'mpesa', permission: 'payments.reconcile', group: 'finance' },
  { key: 'payouts', label: 'M-Pesa payouts', path: '/payments/payouts', icon: 'phone', module: 'mpesa', permission: 'payouts.request', group: 'finance' },
  { key: 'etims', label: 'KRA eTIMS', path: '/etims', icon: 'shield', module: 'etims', permission: 'reports.financial', group: 'finance' },
  { key: 'cardTerminalPayments', label: 'Card terminal payments', path: '/payments/card-terminals', icon: 'card', module: 'pos', permission: 'terminals.reconcile', group: 'finance' },
  { key: 'gatewayPayments', label: 'Online payments', path: '/payments/online', icon: 'card', module: 'payments', permission: 'payments.reconcile', group: 'finance' },
  { key: 'audit', label: 'Audit trail', path: '/audit', icon: 'shield', permission: 'audit.read', group: 'finance' },
  { key: 'settings', label: 'Settings', path: '/settings', icon: 'settings', permission: 'settings.manage', group: 'admin' },
  { key: 'receiptSettings', label: 'Receipts', path: '/settings/receipts', icon: 'receipt', module: 'pos', permission: 'settings.manage', group: 'admin' },
  { key: 'checkoutRules', label: 'Checkout rules', path: '/settings/checkout-rules', icon: 'lock', module: 'pos', permission: 'settings.manage', group: 'admin' },
  { key: 'cardTerminals', label: 'Bank card terminals', path: '/settings/payments/terminals', icon: 'card', module: 'pos', permission: 'terminals.manage', group: 'admin' },
  { key: 'users', label: 'Users', path: '/settings/users', icon: 'user', permission: 'users.manage', group: 'admin' },
  { key: 'roles', label: 'Roles & permissions', path: '/settings/roles', icon: 'shield', permission: 'users.manage', group: 'admin' },
  { key: 'locations', label: 'Branches & tills', path: '/settings/locations', icon: 'map', permission: 'branches.manage', group: 'admin' },
  { key: 'sync', label: 'Branch sync', path: '/settings/sync', icon: 'refresh', module: 'multiBranch', permission: 'settings.manage', group: 'admin' },
  { key: 'onlineShop', label: 'Online shop', path: '/settings/online-shop', icon: 'store', module: 'onlineStore', permission: 'settings.manage', group: 'admin' },
  { key: 'storeStudio', label: 'Store studio', path: '/settings/store-studio', icon: 'sparkles', module: 'onlineStore', permission: 'settings.manage', group: 'admin' },
  { key: 'integrations', label: 'Integrations', path: '/settings/integrations', icon: 'plug', permission: 'integrations.manage', group: 'admin' },
  { key: 'hardware', label: 'Hardware', path: '/settings/hardware', icon: 'printer', module: 'hardware', permission: 'hardware.manage', group: 'admin' },
];

export function navigationFor(caps: Pick<Capabilities, 'modules'>, permissions: ReadonlySet<Permission>): NavItem[] {
  return NAVIGATION.filter(
    (n) =>
      (!n.module || caps.modules.includes(n.module)) &&
      (!n.anyModule || n.anyModule.some((m) => caps.modules.includes(m))) &&
      (!n.permission || permissions.has(n.permission)),
  );
}
