# Reports and financial definitions

All periods are calendar days in the business timezone (`settings.timezone`), converted to UTC for queries. Voided sales are excluded everywhere except the exceptions report.

| Figure | Definition |
|---|---|
| Gross sales | Amount charged on completed sales, including tax, after discounts |
| Discounts | Line + cart discounts given |
| Returns | Refund value of returned items (including tax) |
| Net revenue | Sales excluding tax minus returns excluding tax |
| Output tax | Tax on sales minus tax on returns |
| COGS | Weighted-average cost of items sold minus cost of items restocked from returns |
| Gross profit | Net revenue − COGS |
| Expenses | Recorded expenses (rent, transport, ...) |
| Operating profit | Gross profit − expenses |
| Cash received | Sale payments except credit and loyalty + customer account payments − refunds paid |
| Credit sales | Sold on account (a receivable, not cash) |
| Receivables | Current customer balances with ageing (current, 1-30, 31-60, 61-90, 90+ days past due) |
| Payables | Supplier balances with ageing |
| Inventory value | Σ quantity × weighted average cost per warehouse (retail value also shown) |

Available reports: dashboard, sales by day/week/month/hour/product/category/cashier/branch/till/payment method/customer/sales rep, profit & cash, inventory valuation, stock movements, losses (damage, wastage, expiry, stocktake variances), low stock, expiry, exceptions (voids, returns, discounts, supervisor overrides), cashier shifts (expected vs counted), M-Pesa reconciliation, receivables, payables, purchases by supplier, expenses and cash movements, tax (output by rate, input tax from goods received and expenses), branch comparison, user activity. Most export to CSV.

The tax report is indicative and does not replace KRA eTIMS or professional advice.
