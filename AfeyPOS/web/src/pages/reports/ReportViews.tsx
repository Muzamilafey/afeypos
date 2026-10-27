/**
 * Reports › one page per report (menu entries). Most reuse the existing report tabs with a fixed grouping; the ones
 * here combine several reports (financial, inventory, HR, suppliers) or need their own layout.
 */
import { api } from '../../lib/api';
import { date, dateTime, money, qty } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Card, Stat, StatusBadge } from '../../components/ui';

export interface ReportView {
  title: string;
  subtitle: string;
  /** An existing tab of the Reports page… */
  tab?: string;
  /** …with its grouping fixed (Sales grouped by customer, brand, cashier). */
  groupBy?: string;
  days?: number;
  /** Or one of the views below. */
  custom?: 'inventory' | 'hr' | 'financial' | 'balance' | 'transactions' | 'trending' | 'top' | 'suppliers' | 'transfers';
  /** No period (stock on hand, balances). */
  noPeriod?: boolean;
  csv?: string;
}

export const REPORT_VIEWS: Record<string, ReportView> = {
  sales: { title: 'Sales Reports', subtitle: 'Sales by day, week, month, product, category, payment method and more', tab: 'sales' },
  inventory: { title: 'Inventory Reports', subtitle: 'Stock on hand at cost and retail, and what is at or below its reorder level', custom: 'inventory', noPeriod: true },
  hr: { title: 'HR Reports', subtitle: 'Attendance for the month and payroll runs', custom: 'hr' },
  financial: { title: 'Financial Reports', subtitle: 'Revenue, cost, profit, cash received, tax and expenses', custom: 'financial' },
  customers: { title: 'Customer Reports', subtitle: 'What each customer bought; walk-in sales together', tab: 'sales', groupBy: 'customer' },
  brands: { title: 'Brand Report', subtitle: 'Sales and profit by brand', tab: 'sales', groupBy: 'brand' },
  'balance-sheet': { title: 'Balance Sheet', subtitle: 'Assets, liabilities and equity at the end of the period', custom: 'balance' },
  transactions: { title: 'Transaction Report', subtitle: 'Every sale in the period: time, cashier, till, customer, payment and total', custom: 'transactions', csv: '/reports/transactions' },
  profit: { title: 'Profit Report', subtitle: 'Gross profit and margin per product (ABC ranking)', tab: 'performance' },
  'user-sales': { title: 'User Sales', subtitle: 'Sales per cashier or staff member', tab: 'sales', groupBy: 'cashier' },
  'branch-sales': { title: 'Branch Sales', subtitle: 'Sales, profit and stock value per branch', tab: 'branches' },
  losses: { title: 'Loss Report', subtitle: 'Damaged, expired, stolen and written-off stock', tab: 'losses' },
  trending: { title: 'Trending Products', subtitle: 'Products selling more than in the period before (same length)', custom: 'trending' },
  'most-selling': { title: 'Most Selling Products', subtitle: 'Best sellers by quantity, with their sales value', custom: 'top' },
  'not-selling': { title: 'Not Selling (3 Days)', subtitle: 'Products in stock with no sale in the last days', tab: 'dead', days: 3, noPeriod: true },
  suppliers: { title: 'Supplier Report', subtitle: 'What was bought from each supplier and what is still owed', custom: 'suppliers' },
  drawer: { title: 'Drawer Calculations', subtitle: 'Cash expected in each till drawer against what was counted at closing', tab: 'shifts' },
  'stock-transfers': { title: 'Stock Transfer Report', subtitle: 'Transfers between stores and branches in the period', custom: 'transfers', csv: '/reports/stock-transfers' },
};

/** Days between two YYYY-MM-DD dates, inclusive. */
const spanDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
const shift = (d: string, days: number) => new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10);

export async function loadCustomView(custom: NonNullable<ReportView['custom']>, period: { from: string; to: string }, can: (p: string) => boolean): Promise<any> {
  const get = (path: string, query: Record<string, unknown> = {}) => api<any>(path, { query });
  switch (custom) {
    case 'inventory': {
      const [value, low] = await Promise.all([can('reports.financial') ? get('/reports/inventory-valuation') : Promise.resolve(null), get('/reports/low-stock')]);
      return { value, low: low.data };
    }
    case 'hr': {
      const month = period.to.slice(0, 7);
      const [attendance, payroll] = await Promise.all([get('/hr/attendance', { period: month }), can('payroll.manage') ? get('/hr/payroll') : Promise.resolve({ data: [] })]);
      return { month, attendance: attendance.data, payroll: payroll.data };
    }
    case 'financial': {
      const [profit, tax, expenses] = await Promise.all([get('/reports/profit', period), get('/reports/tax', period), get('/reports/expenses', period)]);
      return { profit: profit.data[0], tax: tax.data, expenses };
    }
    case 'balance':
      return (await get('/accounting/balance-sheet', { asOf: period.to })).data;
    case 'transactions':
      return (await get('/reports/transactions', period)).data;
    case 'transfers':
      return (await get('/reports/stock-transfers', period)).data;
    case 'top':
      return (await get('/reports/sales', { ...period, groupBy: 'product' })).data.slice().sort((a: any, b: any) => (b.qty ?? 0) - (a.qty ?? 0)).slice(0, 200);
    case 'trending': {
      const n = spanDays(period.from, period.to);
      const before = { from: shift(period.from, -n), to: shift(period.from, -1) };
      const [now, prev] = await Promise.all([get('/reports/sales', { ...period, groupBy: 'product' }), get('/reports/sales', { ...before, groupBy: 'product' })]);
      const old = new Map(prev.data.map((r: any) => [String(r._id), r]));
      const rows = now.data.map((r: any) => {
        const p: any = old.get(String(r._id));
        const was = p?.qty ?? 0;
        return { ...r, prevQty: was, prevGrossCents: p?.grossCents ?? 0, change: r.qty - was, growthPct: was ? Math.round(((r.qty - was) / was) * 100) : null };
      }).filter((r: any) => r.change > 0).sort((a: any, b: any) => (b.growthPct ?? 1e9) - (a.growthPct ?? 1e9) || b.change - a.change);
      return { before, rows: rows.slice(0, 200) };
    }
    case 'suppliers': {
      const [purchases, payables] = await Promise.all([get('/reports/purchases', period), get('/reports/payables')]);
      return { purchases: purchases.data, payables };
    }
  }
}

const sumOf = (rows: any[], k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);

export function CustomView({ custom, d }: { custom: NonNullable<ReportView['custom']>; d: any }) {
  if (custom === 'inventory') {
    return (
      <div className="space-y-4">
        {d.value && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Stock value at cost" value={money(d.value.totalValueCents)} hint="Weighted average cost" /><Stat label="Retail value" value={money(d.value.retailValueCents)} /><Stat label="At or below reorder level" value={String(d.low.length)} tone={d.low.length ? 'red' : undefined} /></div>}
        <Card title="At or below the reorder level"><DataTable rows={d.low.map((r: any, i: number) => ({ ...r, id: `${r.productId}-${i}` }))} empty="Nothing is below its reorder level" columns={[
          { key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 's', header: 'SKU', render: (r: any) => r.sku },
          { key: 'q', header: 'On hand', className: 'num', render: (r: any) => qty(r.qty) }, { key: 'r', header: 'Reorder level', className: 'num', render: (r: any) => qty(r.reorderLevel) },
          { key: 'o', header: 'Reorder qty', className: 'num', render: (r: any) => (r.reorderQty ? qty(r.reorderQty) : '—') },
        ]} /></Card>
        {d.value && <Card title="Stock on hand"><DataTable rows={d.value.data.map((r: any, i: number) => ({ ...r, id: String(r.productId ?? i) }))} columns={[
          { key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 'q', header: 'Qty', className: 'num', render: (r: any) => `${qty(r.qty)} ${r.unit ?? ''}` },
          { key: 'c', header: 'Avg cost', className: 'num', render: (r: any) => money(r.avgCostCents) }, { key: 'v', header: 'Value', className: 'num', render: (r: any) => money(r.valueCents) },
        ]} /></Card>}
      </div>
    );
  }
  if (custom === 'hr') {
    const totals = d.payroll.reduce((a: any, r: any) => ({ gross: a.gross + (r.totals?.grossCents ?? 0), net: a.net + (r.totals?.netCents ?? 0) }), { gross: 0, net: 0 });
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Staff with attendance" value={String(d.attendance.length)} hint={`Month ${d.month}`} />
          <Stat label="Days present" value={String(sumOf(d.attendance, 'daysPresent'))} />
          <Stat label="Hours worked" value={String(Math.round(sumOf(d.attendance, 'hoursWorked')))} />
          <Stat label="Clocked in now" value={String(d.attendance.filter((r: any) => r.clockedInNow).length)} />
        </div>
        <Card title={`Attendance ${d.month}`}><DataTable rows={d.attendance.map((r: any) => ({ ...r, id: r.employeeNo }))} empty="Only employees linked to a staff login have attendance" columns={[
          { key: 'no', header: 'No.', render: (r: any) => r.employeeNo }, { key: 'n', header: 'Name', render: (r: any) => r.name },
          { key: 'd', header: 'Days present', className: 'num', render: (r: any) => r.daysPresent }, { key: 'h', header: 'Hours', className: 'num', render: (r: any) => r.hoursWorked },
        ]} /></Card>
        {d.payroll.length > 0 && <Card title={`Payroll runs (gross ${money(totals.gross)}, net ${money(totals.net)})`}><DataTable rows={d.payroll.map((r: any) => ({ ...r, id: r._id }))} columns={[
          { key: 'p', header: 'Period', render: (r: any) => r.period }, { key: 'n', header: 'Number', render: (r: any) => r.number }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          { key: 'e', header: 'Employees', className: 'num', render: (r: any) => r.totals?.employees ?? '' }, { key: 'g', header: 'Gross', className: 'num', render: (r: any) => money(r.totals?.grossCents) },
          { key: 'pa', header: 'PAYE', className: 'num', render: (r: any) => money(r.totals?.payeCents) }, { key: 'ne', header: 'Net pay', className: 'num', render: (r: any) => money(r.totals?.netCents) },
        ]} /></Card>}
      </div>
    );
  }
  if (custom === 'financial') {
    const r = d.profit ?? {};
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Gross sales (incl. tax)" value={money(r.grossSalesCents)} hint={`${r.salesCount ?? 0} sales`} />
          <Stat label="Net revenue (excl. tax)" value={money(r.netRevenueCents)} />
          <Stat label="Cost of goods sold" value={money(r.cogsCents)} />
          <Stat label="Gross profit" value={money(r.grossProfitCents)} hint={`Margin ${((r.grossMarginBp ?? 0) / 100).toFixed(1)}%`} tone={r.grossProfitCents < 0 ? 'red' : 'green'} />
          <Stat label="Expenses" value={money(r.expensesCents)} />
          <Stat label="Operating profit" value={money(r.operatingProfitCents)} tone={r.operatingProfitCents < 0 ? 'red' : 'green'} />
          <Stat label="Cash actually received" value={money(r.cashReceivedCents)} />
          <Stat label="Returns" value={money(r.returnsCents)} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Tax">
            <div data-lines="|Amount">
              <div data-line className="flex justify-between text-sm"><span>Output tax</span><span>{money(d.tax.outputTaxCents)}</span></div>
              <div data-line className="flex justify-between text-sm"><span>Input tax</span><span>{money(d.tax.inputTaxCents)}</span></div>
              <div data-line-total className="flex justify-between border-t border-ink-200 pt-1 text-sm font-semibold dark:border-ink-700"><span>Net payable</span><span>{money(d.tax.netTaxPayableCents)}</span></div>
            </div>
          </Card>
          <Card title="Expenses by category">
            <div data-lines="Category|Amount">
              {d.expenses.data.map((x: any) => <div data-line key={x._id} className="flex justify-between text-sm"><span>{x._id}</span><span>{money(x.totalCents)}</span></div>)}
              <div data-line-total className="flex justify-between border-t border-ink-200 pt-1 text-sm font-semibold dark:border-ink-700"><span>Total</span><span>{money(sumOf(d.expenses.data, 'totalCents'))}</span></div>
            </div>
          </Card>
        </div>
      </div>
    );
  }
  if (custom === 'balance') {
    const section = (title: string, rows: any[], total: number) => (
      <div className="mb-3" data-lines="Account|Amount" data-title={title}>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</div>
        {rows.map((r) => <div data-line key={r.code} className="flex justify-between py-0.5 text-sm"><span>{r.code} {r.name}</span><span className="tabular-nums">{money(r.amountCents)}</span></div>)}
        <div data-line-total className="flex justify-between border-t border-ink-200 pt-1 text-sm font-semibold dark:border-ink-700"><span>Total {title.toLowerCase()}</span><span className="tabular-nums">{money(total)}</span></div>
      </div>
    );
    return (
      <Card className="max-w-3xl" title={d.balanced ? 'Balanced' : 'Out of balance'}>
        {section('Assets', d.assets, d.totals.assetsCents)}
        {section('Liabilities', d.liabilities, d.totals.liabilitiesCents)}
        {section('Equity', [...d.equity, { code: '—', name: 'Profit to date (not yet closed)', amountCents: d.earningsCents }], d.totals.equityCents)}
        <div data-lines="|"><div data-line-total className="flex justify-between border-t-2 border-ink-900 pt-2 font-bold dark:border-ink-100"><span>Liabilities + equity</span><span>{money(d.totals.liabilitiesCents + d.totals.equityCents)}</span></div></div>
      </Card>
    );
  }
  if (custom === 'transactions') {
    const done = d.filter((r: any) => r.status !== 'voided');
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Transactions" value={String(d.length)} hint={d.length >= 5000 ? 'First 5,000 shown' : undefined} />
          <Stat label="Total (not voided)" value={money(sumOf(done, 'totalCents'))} />
          <Stat label="Tax" value={money(sumOf(done, 'taxCents'))} />
          <Stat label="Voided" value={String(d.length - done.length)} tone={d.length - done.length ? 'red' : undefined} />
        </div>
        <div className="card"><DataTable rows={d.map((r: any) => ({ ...r, id: r.number }))} empty="No sales in this period" columns={[
          { key: 'n', header: 'Receipt', render: (r: any) => r.number }, { key: 't', header: 'Time', render: (r: any) => dateTime(r.completedAt) },
          { key: 'c', header: 'Cashier', render: (r: any) => r.cashier }, { key: 'ti', header: 'Till', render: (r: any) => r.till }, { key: 'cu', header: 'Customer', render: (r: any) => r.customer || 'Walk-in' },
          { key: 'i', header: 'Items', className: 'num', render: (r: any) => qty(r.items) }, { key: 'p', header: 'Paid with', render: (r: any) => r.paidWith },
          { key: 'd', header: 'Discount', className: 'num', render: (r: any) => (r.discountCents ? money(r.discountCents) : '') }, { key: 'a', header: 'Total', className: 'num font-semibold', render: (r: any) => money(r.totalCents) },
          { key: 's', header: 'Status', render: (r: any) => (r.status === 'completed' ? 'completed' : <Badge tone={r.status === 'voided' ? 'red' : 'amber'}>{r.status.replace('_', ' ')}</Badge>) },
        ]} /></div>
      </div>
    );
  }
  if (custom === 'transfers') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Transfers" value={String(d.length)} /><Stat label="Units moved" value={qty(sumOf(d, 'qty'))} />
          <Stat label="In transit" value={String(d.filter((r: any) => r.status === 'in_transit').length)} /><Stat label="Received" value={String(d.filter((r: any) => r.status === 'received').length)} />
        </div>
        <div className="card"><DataTable rows={d.map((r: any) => ({ ...r, id: r.number }))} empty="No transfers in this period" columns={[
          { key: 'n', header: 'Transfer', render: (r: any) => r.number }, { key: 'd', header: 'Created', render: (r: any) => date(r.createdAt) },
          { key: 'f', header: 'From', render: (r: any) => r.from }, { key: 't', header: 'To', render: (r: any) => r.to },
          { key: 'p', header: 'Products', className: 'num', render: (r: any) => r.products }, { key: 'q', header: 'Qty', className: 'num', render: (r: any) => qty(r.qty) },
          { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          { key: 'r', header: 'Received', render: (r: any) => (r.receivedAt ? dateTime(r.receivedAt) : '—') },
        ]} /></div>
      </div>
    );
  }
  if (custom === 'top') {
    return (
      <div className="card"><DataTable rows={d.map((r: any, i: number) => ({ ...r, id: String(r._id), rank: i + 1 }))} empty="No sales in this period" columns={[
        { key: 'r', header: '#', className: 'num', render: (r: any) => r.rank }, { key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 's', header: 'SKU', render: (r: any) => r.sku ?? '' },
        { key: 'q', header: 'Qty sold', className: 'num font-semibold', render: (r: any) => qty(r.qty) }, { key: 'g', header: 'Sales', className: 'num', render: (r: any) => money(r.grossCents) },
        ...(d[0]?.grossProfitCents !== undefined ? [{ key: 'p', header: 'Gross profit', className: 'num', render: (r: any) => money(r.grossProfitCents) }] : []),
      ]} /></div>
    );
  }
  if (custom === 'trending') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-ink-500" data-report-text>Compared with {date(d.before.from)} to {date(d.before.to)}.</p>
        <div className="card"><DataTable rows={d.rows.map((r: any) => ({ ...r, id: String(r._id) }))} empty="No product sold more than in the period before" columns={[
          { key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 'p', header: 'Before', className: 'num', render: (r: any) => qty(r.prevQty) },
          { key: 'q', header: 'Now', className: 'num font-semibold', render: (r: any) => qty(r.qty) }, { key: 'c', header: 'More sold', className: 'num', render: (r: any) => `+${qty(r.change)}` },
          { key: 'g', header: 'Growth', className: 'num', render: (r: any) => (r.growthPct === null ? <Badge tone="green">new</Badge> : <Badge tone="green">+{r.growthPct}%</Badge>) },
          { key: 's', header: 'Sales now', className: 'num', render: (r: any) => money(r.grossCents) },
        ]} /></div>
      </div>
    );
  }
  // suppliers
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Bought in the period" value={money(sumOf(d.purchases, 'totalCents'))} hint={`${sumOf(d.purchases, 'count')} deliveries`} />
        <Stat label="Owed to suppliers now" value={money(d.payables.totalCents)} tone={d.payables.totalCents ? 'red' : undefined} />
      </div>
      <Card title="Purchases by supplier"><DataTable rows={d.purchases.map((r: any, i: number) => ({ ...r, id: String(r._id ?? i) }))} empty="Nothing received from suppliers in this period" columns={[
        { key: 's', header: 'Supplier', render: (r: any) => r.supplier ?? 'No supplier (stock received)' }, { key: 'c', header: 'Deliveries', className: 'num', render: (r: any) => r.count },
        { key: 't', header: 'Total', className: 'num', render: (r: any) => money(r.totalCents) }, { key: 'v', header: 'VAT', className: 'num', render: (r: any) => money(r.taxCents) },
        { key: 'p', header: 'Paid', className: 'num', render: (r: any) => money(r.paidCents) },
      ]} /></Card>
      <Card title="Owed to suppliers (by age)"><DataTable rows={d.payables.data.map((r: any, i: number) => ({ ...r, id: String(r._id ?? i) }))} empty="Nothing owed" columns={[
        { key: 'n', header: 'Supplier', render: (r: any) => r.supplier?.name }, ...[['current', 'Current'], ['d1_30', '1-30'], ['d31_60', '31-60'], ['d61_90', '61-90'], ['d90plus', '90+'], ['total', 'Total']].map(([k, l]) => ({ key: k, header: l, className: 'num', render: (r: any) => money(r[k]) })),
      ]} /></Card>
    </div>
  );
}
