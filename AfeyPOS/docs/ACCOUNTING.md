# Accounting

*Finance → Accounts* (module **Accounting**). Afey POS keeps double-entry books by itself: every sale, return, purchase, payment, stock write-off, expense and payroll becomes a balanced journal. Accounts are kept on the head-office server (which receives every branch's documents) or on a standalone shop server.

## Chart of accounts

A Kenyan retail chart is created automatically:

| Group | Accounts |
|---|---|
| Cash and payments | 1000 cash in tills, 1005 cash in safe, 1010 M-Pesa, 1020 bank, 1030 card settlements, 1040 payment gateway |
| Other assets | 1100 receivables, 1200 inventory, 1300 VAT input, 1400 staff advances, 1500 fixtures |
| Liabilities | 2000 payables; 2100 VAT output; 2200–2270 PAYE, NSSF, SHIF, housing levy, NITA, net salaries, payroll deductions and pension payable; 2300 customer store credit |
| Equity | 3000 owner's capital, 3100 retained earnings, 3200 opening balances |
| Income | 4000 sales, 4100 returns, 4110 loyalty redeemed, 4200 other income, 4300 stock gains |
| Cost of sales | 5000 cost of goods sold, 5100 stock losses |
| Expenses | 6000–6030 salaries and employer contributions; each expense category gets its own account from 6100; 6900 rounding; 6950 bad debts |

Add your own accounts (vehicles, loans, rent deposit) under *Chart of accounts*. System accounts can be renamed but not removed.

## What is posted

| Document | Journal |
|---|---|
| Sale | Dr cash / M-Pesa / card / bank / gateway / receivable per payment; Cr sales (net) and VAT output; Dr cost of sales, Cr inventory (weighted-average cost) |
| Void | Reverses the sale journal |
| Return | Dr sales returns and VAT output; Cr the refund account (cash, M-Pesa, card, customer account, store credit); restocked items Dr inventory, Cr cost of sales |
| Goods received | Dr inventory (net) and VAT input; Cr payables |
| Return to supplier | Dr payables; Cr inventory |
| Supplier / customer payment | Payables or receivables against cash, M-Pesa or bank |
| Expense | Dr its category account and VAT input; Cr how it was paid |
| Stock count, damage, expiry, adjustments | Dr stock losses, Cr inventory (or Dr inventory, Cr stock gains) |
| Opening stock and balances | Against opening balances equity |
| Payroll (approved) | Dr salaries, employer NSSF, housing levy, NITA; Cr PAYE, NSSF, SHIF, levy, NITA, deductions, advance recoveries, net salaries payable |
| Salaries and advances paid | Net salaries payable / staff advances against M-Pesa, bank or cash |
| Till cash in / out | Cash in till against cash in safe |

Posting runs every 10 minutes, and every report posts anything outstanding first, so statements are always current. Each document is posted exactly once. *Close books → Rebuild* recreates the automatic journals from the documents; manual journals are kept.

The books agree with the operational reports, and the automated tests check this on a full business cycle:
- inventory = stock valuation;
- receivables and payables = the customer and supplier balances;
- net sales and gross profit = the profit report (the ledger also charges stock written off);
- output VAT = the tax report;
- the trial balance and balance sheet balance.

## Statements

- **Profit & loss** for any period: revenue, cost of sales, gross profit and margin, other income, expenses, net profit.
- **Balance sheet** as at a date, including profit to date not yet closed.
- **Trial balance** as at a date (optionally per branch).
- **VAT**: output VAT on sales less returns, input VAT on purchases and expenses, and the net payable. The VAT 3 return is due by the 20th; input VAT needs valid eTIMS supplier invoices.
- **General ledger** per account with running balance (click any account).
- **Journals**: search, open, and reverse manual journals.

Everything exports to CSV.

## Manual journals and closing

Manual journals are for things outside the shop system, such as opening bank balances, owner's capital and drawings, depreciation, loans and accruals. They must balance. Set a **lock date** after filing a period; manual journals on or before it are refused.

## Verification status

The posting rules and statements are covered by automated tests over a full trading cycle. They have not been reviewed by a Kenyan accountant; have yours review the chart and the first month's statements before relying on them for filing.
