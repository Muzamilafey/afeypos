/** Default chart of accounts for a Kenyan minimart / supermarket. `key` marks accounts used by automatic posting. */
export interface AccountDef { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; subtype: string; key?: string }

export const DEFAULT_CHART: AccountDef[] = [
  { code: '1000', name: 'Cash on hand (tills)', type: 'asset', subtype: 'cash', key: 'cash' },
  { code: '1005', name: 'Cash in safe / in transit', type: 'asset', subtype: 'cash', key: 'cash_transit' },
  { code: '1010', name: 'M-Pesa (Paybill / Till)', type: 'asset', subtype: 'cash', key: 'mpesa' },
  { code: '1020', name: 'Bank', type: 'asset', subtype: 'cash', key: 'bank' },
  { code: '1030', name: 'Card settlements receivable', type: 'asset', subtype: 'current_asset', key: 'card' },
  { code: '1040', name: 'Payment gateway clearing', type: 'asset', subtype: 'current_asset', key: 'gateway' },
  { code: '1100', name: 'Accounts receivable (customers)', type: 'asset', subtype: 'receivable', key: 'ar' },
  { code: '1200', name: 'Inventory', type: 'asset', subtype: 'inventory', key: 'inventory' },
  { code: '1300', name: 'VAT input (recoverable)', type: 'asset', subtype: 'current_asset', key: 'vat_input' },
  { code: '1400', name: 'Staff salary advances', type: 'asset', subtype: 'current_asset', key: 'advances' },
  { code: '1500', name: 'Fixtures, fittings and equipment', type: 'asset', subtype: 'fixed_asset' },
  { code: '2000', name: 'Accounts payable (suppliers)', type: 'liability', subtype: 'payable', key: 'ap' },
  { code: '2100', name: 'VAT output (payable to KRA)', type: 'liability', subtype: 'tax', key: 'vat_output' },
  { code: '2200', name: 'PAYE payable', type: 'liability', subtype: 'payroll', key: 'paye' },
  { code: '2210', name: 'NSSF payable', type: 'liability', subtype: 'payroll', key: 'nssf' },
  { code: '2220', name: 'SHIF payable', type: 'liability', subtype: 'payroll', key: 'shif' },
  { code: '2230', name: 'Housing levy payable', type: 'liability', subtype: 'payroll', key: 'ahl' },
  { code: '2240', name: 'NITA payable', type: 'liability', subtype: 'payroll', key: 'nita' },
  { code: '2250', name: 'Net salaries payable', type: 'liability', subtype: 'payroll', key: 'salaries_payable' },
  { code: '2260', name: 'Other payroll deductions payable', type: 'liability', subtype: 'payroll', key: 'payroll_deductions' },
  { code: '2270', name: 'Pension contributions payable', type: 'liability', subtype: 'payroll', key: 'pension' },
  { code: '2300', name: 'Customer store credit', type: 'liability', subtype: 'current_liability', key: 'store_credit' },
  { code: '2310', name: 'Gift vouchers outstanding', type: 'liability', subtype: 'current_liability', key: 'vouchers' },
  { code: '3000', name: "Owner's capital", type: 'equity', subtype: 'equity', key: 'capital' },
  { code: '3100', name: 'Retained earnings', type: 'equity', subtype: 'equity', key: 'retained' },
  { code: '3200', name: 'Opening balances', type: 'equity', subtype: 'equity', key: 'opening' },
  { code: '4000', name: 'Sales', type: 'income', subtype: 'sales', key: 'sales' },
  { code: '4100', name: 'Sales returns', type: 'income', subtype: 'sales', key: 'returns' },
  { code: '4110', name: 'Loyalty points redeemed', type: 'income', subtype: 'sales', key: 'loyalty' },
  { code: '4200', name: 'Other income', type: 'income', subtype: 'other_income', key: 'other_income' },
  { code: '4300', name: 'Stock gains (count surplus)', type: 'income', subtype: 'other_income', key: 'stock_gains' },
  { code: '5000', name: 'Cost of goods sold', type: 'expense', subtype: 'cogs', key: 'cogs' },
  { code: '5100', name: 'Stock losses (damage, expiry, shrinkage)', type: 'expense', subtype: 'cogs', key: 'stock_losses' },
  { code: '6000', name: 'Salaries and wages', type: 'expense', subtype: 'operating_expense', key: 'salaries' },
  { code: '6010', name: 'Employer NSSF', type: 'expense', subtype: 'operating_expense', key: 'nssf_employer' },
  { code: '6020', name: 'Employer housing levy', type: 'expense', subtype: 'operating_expense', key: 'ahl_employer' },
  { code: '6030', name: 'NITA levy', type: 'expense', subtype: 'operating_expense', key: 'nita_expense' },
  { code: '6900', name: 'Rounding and differences', type: 'expense', subtype: 'operating_expense', key: 'rounding' },
  { code: '6950', name: 'Bad debts written off', type: 'expense', subtype: 'operating_expense', key: 'bad_debts' },
];

/** Expense categories get their own accounts from 6100 upwards. */
export const EXPENSE_CODE_START = 6100;
export const EXPENSE_CODE_END = 6899;
