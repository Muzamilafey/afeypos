import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, paymentLabel } from '../lib/format';
import { Button, Card, ErrorBox, Loading, Stat } from '../components/ui';
import { CHART_COLORS, GroupedBars, HBars, Legend, LineChart, Pie, Ring, compact } from '../components/Chart';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MOVE_LABEL: Record<string, string> = {
  opening: 'Opening stock', purchase_receipt: 'Goods received', sale: 'Sales', sale_return: 'Customer returns', supplier_return: 'Returned to supplier', adjustment: 'Adjustments',
  damage: 'Damage', wastage: 'Wastage', expiry: 'Expired', transfer_out: 'Transfers out', transfer_in: 'Transfers in', stocktake: 'Stocktake', sync: 'Sync',
};
const PO_LABEL: Record<string, string> = { draft: 'Draft', sent: 'Sent', partially_received: 'Part received', received: 'Received', cancelled: 'Cancelled' };

/** "View all" link in a card header, to the full page behind the card. */
export function ViewAll({ to, label = 'View all' }: { to: string; label?: string }) {
  return <Link to={to} className="text-[11px] font-semibold text-brand-600 hover:underline">{label}</Link>;
}

function Rows({ rows, empty }: { rows: { name: ReactNode; value: ReactNode; tone?: string }[]; empty: string }) {
  if (!rows.length) return <p className="py-2 text-[12px] text-ink-500">{empty}</p>;
  return (
    <ul className="divide-y divide-[#f0f1f3] text-[12.5px] dark:divide-ink-800">
      {rows.map((r, i) => <li key={i} className="flex items-center justify-between gap-2 py-1.5"><span className="min-w-0 truncate">{r.name}</span><span className={`shrink-0 tabular-nums ${r.tone ?? 'text-ink-600 dark:text-ink-300'}`}>{r.value}</span></li>)}
    </ul>
  );
}

const monthLabel = (m: string) => MONTHS[+m.slice(5, 7) - 1];

/** Accounting graphs from the ledger: profit by month, cash movement, balances, expenses and VAT. */
export function AccountingSection() {
  const q = useQuery({ queryKey: ['accounting-dashboard'], queryFn: () => api<{ data: any }>('/accounting/dashboard').then((r) => r.data), refetchInterval: 120_000 });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return null;
  const d = q.data;
  const m = d.monthly as any[];
  const labels = m.map((x) => monthLabel(x.month));
  const b = d.balances;
  const t = d.thisMonth;
  return (
    <div className="space-y-3" data-testid="accounting-dashboard">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat color="teal" icon="wallet" value={compact(b.cashCents)} label="Cash, M-Pesa & bank" hint={<Link to="/accounting?tab=money">{b.cashAccounts.length} accounts · view</Link>} />
        <Stat color="green" icon="chart" value={compact(t.netProfitCents)} label="Net profit this month" hint={`Net margin ${(t.netMarginBp / 100).toFixed(1)}% · gross ${(t.grossMarginBp / 100).toFixed(1)}%`} />
        <Stat color="blue" icon="users" value={compact(b.receivablesCents)} label="Customers owe you" hint={<Link to="/reports/customers">Receivables · view</Link>} />
        <Stat color="red" icon="truck" value={compact(b.payablesCents)} label="You owe suppliers" hint={<Link to="/reports/suppliers">Payables · view</Link>} />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="Revenue, costs and net profit (12 months)" className="lg:col-span-2" actions={<ViewAll to="/accounting?tab=pl" label="Profit & loss" />}>
          <GroupedBars labels={labels} series={[{ name: 'Revenue', values: m.map((x) => x.revenueCents) }, { name: 'Cost of sales', values: m.map((x) => x.cogsCents), color: CHART_COLORS[1] }, { name: 'Expenses', values: m.map((x) => x.expensesCents), color: CHART_COLORS[3] }]} />
          <div className="mt-2"><Legend items={[{ name: 'Revenue' }, { name: 'Cost of sales', color: CHART_COLORS[1] }, { name: 'Expenses', color: CHART_COLORS[3] }]} /></div>
          <div className="mt-3">
            <LineChart fill labels={labels} series={[{ name: 'Net profit', values: m.map((x) => x.netProfitCents), color: CHART_COLORS[5] }, { name: 'Gross profit', values: m.map((x) => x.grossProfitCents), color: CHART_COLORS[2] }]} height={130} />
            <div className="mt-1"><Legend items={[{ name: 'Net profit', color: CHART_COLORS[5] }, { name: 'Gross profit', color: CHART_COLORS[2] }]} /></div>
          </div>
        </Card>
        <Card title="Where the money is" actions={<ViewAll to="/accounting?tab=bs" label="Balance sheet" />}>
          <Pie rows={[
            ...b.cashAccounts.map((a: any) => ({ name: a.name, value: Math.max(0, a.balanceCents) })),
            { name: 'Stock', value: Math.max(0, b.inventoryCents) },
            { name: 'Customers owe', value: Math.max(0, b.receivablesCents) },
          ].filter((x) => x.value > 0)} />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Ring value={b.currentRatio == null ? 0 : Math.min(100, (b.currentRatio / 2) * 100)} label={`Current ratio ${b.currentRatio ?? '—'}`} color={CHART_COLORS[4]} />
            <Ring value={Math.max(0, t.grossMarginBp / 100)} label="Gross margin this month" color={CHART_COLORS[0]} />
          </div>
        </Card>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="Money in and out" actions={<ViewAll to="/reports/cash-flow" />}>
          <HBars labels={labels.slice(-6)} series={[{ name: 'In', values: m.slice(-6).map((x) => x.cashInCents), color: CHART_COLORS[5] }, { name: 'Out', values: m.slice(-6).map((x) => x.cashOutCents), color: CHART_COLORS[3] }]} />
          <div className="mt-2"><Legend items={[{ name: 'In', color: CHART_COLORS[5] }, { name: 'Out', color: CHART_COLORS[3] }]} /></div>
        </Card>
        <Card title="Expenses this month" actions={<ViewAll to="/expenses" />}>
          {t.expensesByAccount.length ? <Pie rows={t.expensesByAccount.slice(0, 6).map((e: any) => ({ name: e.name, value: e.amountCents }))} /> : <p className="text-[12px] text-ink-500">No expenses recorded this month.</p>}
        </Card>
        <Card title="Owed now" actions={<ViewAll to="/accounting?tab=vat" label="VAT" />}>
          <Rows empty="" rows={[
            { name: 'VAT on sales this month', value: money(t.vat.outputCents) },
            { name: 'VAT on purchases this month', value: money(t.vat.inputCents) },
            { name: 'VAT to pay KRA (this month)', value: money(t.vat.netPayableCents), tone: 'font-semibold' },
            { name: 'VAT owed (all periods)', value: money(b.vatOwedCents) },
            { name: <Link to="/hr/payroll" className="hover:text-brand-600">Payroll owed (PAYE, NSSF, SHIF, salaries)</Link>, value: money(b.payrollOwedCents) },
            { name: <Link to="/reports/suppliers" className="hover:text-brand-600">Suppliers</Link>, value: money(b.payablesCents) },
          ]} />
          <p className="mt-2 text-[11px] text-ink-500">VAT 3 is due by the 20th of the following month.</p>
        </Card>
      </div>
    </div>
  );
}

/** Accountant / auditor: the books first, then the day's trading. */
export function FinanceDashboard() {
  const { can } = useAuth();
  const sales = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ data: any }>('/reports/dashboard').then((r) => r.data), enabled: can('reports.read') });
  const s = sales.data;
  return (
    <div className="space-y-3">
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat color="purple" icon="receipt" value={compact(s.sales.grossCents)} label="Sales today" hint={<Link to="/reports/sales">{s.sales.count} receipts · view</Link>} />
          <Stat color="green" icon="chart" value={compact(s.grossProfitCents)} label="Gross profit today" hint={<Link to="/reports/profit">Profit report · view</Link>} />
          <Stat color="yellow" icon="refresh" value={compact(s.returnsCents)} label="Refunds today" hint={<Link to="/returns">Returns · view</Link>} />
          <Stat color="red" icon="users" value={compact(s.receivablesCents ?? 0)} label="Customer balances" hint={<Link to="/reports/customers">{s.debtorCount ?? 0} customers · view</Link>} />
        </div>
      )}
      <AccountingSection />
      {s && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="Sales and gross profit, last 30 days" actions={<ViewAll to="/reports/financial" />}>
            <GroupedBars labels={(s.daily30 ?? []).map((x: any) => x.day.slice(8))} series={[{ name: 'Sales', values: (s.daily30 ?? []).map((x: any) => x.salesCents) }, { name: 'Gross profit', values: (s.daily30 ?? []).map((x: any) => x.profitCents) }]} every={5} />
            <div className="mt-2"><Legend items={[{ name: 'Sales' }, { name: 'Gross profit' }]} /></div>
          </Card>
          <Card title="Payments received, last 30 days" actions={<ViewAll to="/reports/transactions" />}>
            <Pie rows={(s.payments30 ?? []).map((p: any) => ({ name: paymentLabel(p.method), value: p.totalCents }))} />
          </Card>
        </div>
      )}
    </div>
  );
}

/** Cashier / salesperson: my sales, my shift, what I sold. */
export function MySalesDashboard() {
  const { can, me } = useAuth();
  const q = useQuery({ queryKey: ['dashboard-me'], queryFn: () => api<{ data: any }>('/dashboard/me').then((r) => r.data), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data.mySales;
  if (!s) return <StockDashboard />;
  const best = s.week.reduce((a: any, d: any) => (d.totalCents > (a?.totalCents ?? -1) ? d : a), null);
  return (
    <div className="space-y-3" data-testid="my-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">Hello {me?.user.name.split(' ')[0]}, here is your day</h1>
        <div className="flex gap-2">
          {can('sales.create') && <Link to="/pos"><Button><span>Start selling</span></Button></Link>}
          {can('shifts.open') && <Link to="/shifts"><Button variant="secondary">My shift</Button></Link>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat color="purple" icon="receipt" value={compact(s.today.totalCents)} label="My sales today" hint={`${s.today.count} receipts`} />
        <Stat color="blue" icon="cart" value={money(s.today.averageCents)} label="Average receipt" />
        <Stat color="teal" icon="clock" value={s.shift ? 'Open' : 'Closed'} label="My shift" hint={s.shift ? `${s.shift.number ?? ''} since ${dateTime(s.shift.openedAt)}` : <Link to="/pos">Start one at the till</Link>} />
        <Stat color="yellow" icon="chart" value={compact(s.week.reduce((a: number, d: any) => a + d.totalCents, 0))} label="My sales, 7 days" hint={best?.totalCents ? `Best: ${WEEKDAYS[new Date(`${best.day}T12:00:00`).getDay()]}` : undefined} />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="My sales this week" className="lg:col-span-2" actions={<ViewAll to="/sales" />}>
          <GroupedBars labels={s.week.map((d: any) => WEEKDAYS[new Date(`${d.day}T12:00:00`).getDay()])} series={[{ name: 'Sales', values: s.week.map((d: any) => d.totalCents) }]} />
        </Card>
        <Card title="How customers paid me today" actions={<ViewAll to="/sales" />}>
          {s.payments.length ? <Pie rows={s.payments.map((p: any) => ({ name: paymentLabel(p.method), value: p.totalCents }))} /> : <p className="text-[12px] text-ink-500">No sales yet today.</p>}
        </Card>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="What I sold today" actions={<ViewAll to="/sales" />}>
          <Rows empty="No sales yet today." rows={s.topItems.map((x: any) => ({ name: `${x.name} × ${x.qty}`, value: money(x.totalCents) }))} />
        </Card>
        <Card title="My latest receipts" actions={<ViewAll to="/sales" />}>
          <Rows empty="No receipts yet." rows={s.recent.map((r: any) => ({ name: <Link to={`/sales/${r.id}`} className="font-semibold hover:text-brand-600">{r.number}</Link>, value: <>{money(r.totalCents)} <span className="text-ink-400">{dateTime(r.at)}</span></> }))} />
        </Card>
      </div>
    </div>
  );
}

/** Stock and buying roles: what needs doing in the store and with suppliers. */
export function StockDashboard() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['dashboard-me'], queryFn: () => api<{ data: any }>('/dashboard/me').then((r) => r.data), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const st = q.data.stock;
  const pu = q.data.purchasing;
  if (!st && !pu) {
    return <Card title="Quick start"><p className="text-sm text-ink-500">Your role has no dashboard figures. Use the menu to open your pages.</p></Card>;
  }
  return (
    <div className="space-y-3" data-testid="stock-dashboard">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {st && <Stat color="red" icon="box" value={String(st.low.length)} label="Low stock items" hint={<Link to="/inventory/alerts">{st.outOfStock} out of stock · view</Link>} />}
        {st && <Stat color="yellow" icon="truck" value={String(st.transfers.length)} label="Transfers on the way" hint={<Link to="/inventory/transfers">View transfers</Link>} />}
        {st && <Stat color="purple" icon="check" value={String(st.adjustmentsToApprove)} label="Adjustments to approve" hint={<Link to="/inventory/adjustments">{st.stocktakesOpen} stocktakes open · view</Link>} />}
        {st?.valueCents != null && <Stat color="teal" icon="wallet" value={compact(st.valueCents)} label="Stock value (at cost)" hint={<Link to="/reports/inventory">{Math.round(st.units ?? 0).toLocaleString()} units · view</Link>} />}
        {pu && <Stat color="blue" icon="file" value={String(pu.awaiting.length)} label="Orders awaiting delivery" hint={<Link to="/purchasing">Purchase orders · view</Link>} />}
        {pu && <Stat color="red" icon="truck" value={compact(pu.owedCents)} label="Owed to suppliers" hint={<Link to="/suppliers">{pu.suppliersOwed} suppliers · view</Link>} />}
      </div>
      {st && (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card title="Below reorder level" actions={<ViewAll to="/inventory/alerts" />}>
            <Rows empty="Nothing below its reorder level." rows={st.low.map((l: any) => ({ name: l.name, value: `${l.qty} / ${l.reorderLevel}`, tone: l.qty <= 0 ? 'font-semibold text-tile-red' : undefined }))} />
          </Card>
          <Card title="Stock movement, last 7 days" actions={<ViewAll to="/inventory/movements" />}>
            {st.movements7.length ? <HBars labels={st.movements7.slice(0, 7).map((m: any) => MOVE_LABEL[m.type] ?? m.type)} series={[{ name: 'Movements', values: st.movements7.slice(0, 7).map((m: any) => m.count) }]} /> : <p className="text-[12px] text-ink-500">No stock movement this week.</p>}
          </Card>
          <Card title="Transfers" actions={<ViewAll to="/inventory/transfers" />}>
            <Rows empty="No transfers waiting." rows={st.transfers.map((x: any) => ({ name: <span className="font-semibold">{x.number}</span>, value: `${x.status === 'in_transit' ? 'On the way' : 'Draft'} · ${x.lines} items` }))} />
            {st.expiringSoon > 0 && <p className="mt-2 text-[12px] font-semibold text-amber-700"><Link to="/reports/stock-ageing">{st.expiringSoon} batches expire within 30 days · view</Link></p>}
          </Card>
        </div>
      )}
      {pu && (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card title="Purchase orders by status" actions={<ViewAll to="/purchasing" />}>
            {pu.byStatus.length ? <Pie rows={pu.byStatus.map((b: any) => ({ name: PO_LABEL[b.status] ?? b.status, value: b.count }))} /> : <p className="text-[12px] text-ink-500">No purchase orders yet.</p>}
          </Card>
          <Card title="Awaiting delivery" actions={<ViewAll to="/purchasing/receiving" label="Receive goods" />}>
            <Rows empty="Nothing awaiting delivery." rows={pu.awaiting.map((p: any) => ({ name: <><span className="font-semibold">{p.number}</span> · {p.supplier}</>, value: <>{money(p.totalCents)}{p.expectedAt ? <span className="text-ink-400"> · due {dateTime(p.expectedAt).slice(0, 10)}</span> : null}</> }))} />
          </Card>
          <Card title="Most owed suppliers" actions={can('suppliers.read') ? <ViewAll to="/suppliers" /> : undefined}>
            <Rows empty="Nothing owed to suppliers." rows={pu.topOwed.map((x: any) => ({ name: x.name, value: money(x.balanceCents) }))} />
          </Card>
        </div>
      )}
    </div>
  );
}
