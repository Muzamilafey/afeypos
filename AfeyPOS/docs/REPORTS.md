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

Available reports: dashboard, daily (Z) summary, sales by day/week/month/hour/weekday/product/category/department/brand/cashier/branch/till/payment method/customer/sales rep, profit & cash, inventory valuation, stock movements, losses (damage, wastage, expiry, stocktake variances), low stock, expiry, exceptions (voids, returns, discounts, supervisor overrides), cashier shifts (expected vs counted), M-Pesa reconciliation, receivables, payables, purchases by supplier, expenses and cash movements, tax (output by rate, input tax from goods received and expenses), branch comparison, user activity, and the supermarket reports below. Most export to CSV.

## Supermarket and minimart reports

| Report | What it shows |
|---|---|
| Daily summary (`/reports/daily-summary`) | One row per local day: receipts, sales, discounts, tax, cash / M-Pesa / card / bank / credit taken, returns, voids. *Collected* = cash + M-Pesa + card + bank − refunds paid in cash, M-Pesa or card. |
| Baskets & peak hours (`/reports/basket`) | Average basket value, lines and units per basket, largest basket, share of sales linked to a customer, basket-size bands, and a weekday × hour heatmap of receipts. |
| Returns (`/reports/returns`) | Refunded value and return rate (refunds ÷ gross sales), by reason, refund method, staff member (with how many a manager approved) and product (qty back on the shelf vs written off). Voids are excluded; they appear under voids. |
| Discounts (`/reports/discounts`) | Discount given by cashier (with rate of their sales), by product and by promotion. |
| Product performance (`/reports/product-performance`) | Per product: quantity sold net of returns, sales, gross profit, margin, share of revenue, on hand, days of cover (on hand ÷ average daily quantity in the period), and **ABC class** by cumulative net revenue (A = first 80 %, B = next 15 %, C = the rest). |
| Dead stock (`/reports/dead-stock?days=30`) | Products holding stock with no sale in the last N days (never-sold products count from their latest delivery), with cost and retail value tied up. |
| Reorder (`/reports/reorder?leadDays=7&coverDays=14&days=28`) | Average daily sales over `days`; reorder point = max(reorder level, daily sales × lead time × 1.5). When on hand + open purchase orders ≤ reorder point, it suggests enough to cover lead time + cover days (at least the product's reorder quantity), grouped by the last supplier delivered from. |

## Returns policy

*Settings → Business*: the **return window** (days, default 14; 0 = no limit), **manager approval above** an amount, and whether returned items go back on the shelf by default. Cashiers can start a return; a supervisor approves it with a PIN (`sales.return`). Sales outside the window, and refunds above the approval amount, need someone with `returns.approve` (owners, administrators, branch managers). M-Pesa refunds can be sent back to the customer's phone as a B2C payout that a second person approves (see MPESA.md). Each return prints a credit note; with eTIMS it is also sent to KRA as a credit note.

The tax report is indicative and does not replace KRA eTIMS or professional advice.
