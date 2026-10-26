import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, paymentLabel } from '../lib/format';
import { Button, Card, ErrorBox, Loading, Stat } from '../components/ui';
import { CHART_COLORS, GroupedBars, HBars, Legend, LineChart, Pie, Ring, Sparkline, compact } from '../components/Chart';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Rows of name · value · share, like the template's list widgets. */
function ShareList({ rows, color = CHART_COLORS[0], empty = 'Nothing yet', format = money, to }: { rows: { name: string; value: number; extra?: string }[]; color?: string; empty?: string; format?: (v: number) => string; to?: string }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (!rows.length) return <p className="py-2 text-[12px] text-ink-500">{empty}</p>;
  return (
    <ul className="divide-y divide-[#f0f1f3] text-[12.5px] dark:divide-ink-800">
      {rows.map((r) => (
        <li key={r.name} className="flex items-center gap-2 py-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
          <span className="min-w-0 flex-1 truncate">{to ? <Link to={to} className="hover:text-brand-600">{r.name}</Link> : r.name}{r.extra && <span className="ml-1 text-ink-400">{r.extra}</span>}</span>
          <span className="tabular-nums text-ink-500">{format(r.value)}</span>
          <span className="w-10 text-right font-semibold tabular-nums">{total ? Math.round((r.value / total) * 100) : 0}%</span>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage() {
  const { can, has } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ data: any }>('/reports/dashboard').then((r) => r.data), enabled: can('reports.read') && has('reports'), refetchInterval: 60_000 });
  if (!can('reports.read')) {
    return (
      <Card title="Quick start">
        <div className="grid gap-3 sm:grid-cols-2">
          {can('sales.create') && <Link to="/pos"><Button size="xl" className="w-full">Start selling</Button></Link>}
          {can('shifts.open') && <Link to="/shifts"><Button size="xl" variant="secondary" className="w-full">My shift</Button></Link>}
        </div>
      </Card>
    );
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const days = d.daily30 ?? [];
  const sales30 = days.reduce((s: number, x: any) => s + x.salesCents, 0);
  const receipts30 = days.reduce((s: number, x: any) => s + x.count, 0);
  const ev = d.expenseVsProfit ?? [];
  const evLabels = ev.map((m: any) => MONTHS[+m.month.slice(5, 7) - 1]);
  const hours = d.hourlyCompare ?? [];
  const pay = d.payments30 ?? [];
  const weekMax = (d.weekday ?? []).reduce((a: any, w: any) => (w.totalCents > (a?.totalCents ?? -1) ? w : a), null);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat color="purple" icon="receipt" value={compact(d.sales.grossCents)} label="Sales today" hint={`${d.sales.count} receipts · avg ${money(d.sales.averageCents)}`} />
        <Stat color="blue" icon="cart" value={d.sales.count.toLocaleString()} label="Orders today" hint={`${d.openShifts} open ${d.openShifts === 1 ? 'shift' : 'shifts'}`} />
        <Stat color="red" icon="users" value={d.customersCount.toLocaleString()} label="Customers" hint={d.debtorCount ? `${d.debtorCount} owe ${money(d.receivablesCents)}` : 'No balances owed'} />
        <Stat color="yellow" icon="box" value={d.lowStockCount.toLocaleString()} label="Low stock items" hint={<Link to="/inventory?belowReorder=true">{d.outOfStockCount} out of stock · view</Link>} />
      </div>

      <Card title="Data Panel Widget">
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="mb-2 flex items-baseline justify-between"><span className="text-[13px] font-bold">Sales, last 30 days</span><span className="text-[12px] text-brand-600">{money(sales30)} ({receipts30.toLocaleString()} receipts)</span></div>
            <GroupedBars labels={days.map((x: any) => x.day.slice(8))} series={[{ name: 'Sales', values: days.map((x: any) => x.salesCents) }, ...(can('reports.financial') ? [{ name: 'Gross profit', values: days.map((x: any) => x.profitCents) }] : [])]} every={5} />
            <div className="mt-2"><Legend items={[{ name: 'Sales' }, ...(can('reports.financial') ? [{ name: 'Gross profit' }] : [])]} /></div>
          </div>
          <div className="space-y-3 lg:col-span-4">
            <div><div className="mb-1 flex justify-between text-[13px] font-bold"><span>Top products</span>{can('reports.read') && <Link to="/reports" className="text-[11px] font-semibold text-brand-600">View report</Link>}</div>
              <ShareList rows={(d.top?.rows ?? []).slice(0, 5).map((r: any) => ({ name: r.name, value: r.totalCents }))} empty="No sales in 30 days" /></div>
            <div><div className="mb-1 flex justify-between text-[13px] font-bold"><span>Top customers</span>{can('customers.read') && <Link to="/customers" className="text-[11px] font-semibold text-brand-600">View all</Link>}</div>
              <ShareList rows={(d.topCustomers ?? []).slice(0, 4).map((r: any) => ({ name: r.name, value: r.totalCents, extra: `${r.visits}×` }))} color={CHART_COLORS[1]} empty="Sales to named customers appear here" /></div>
          </div>
          <div className="lg:col-span-3">
            <div className="mb-1 text-[13px] font-bold">Payment methods</div>
            <ShareList rows={pay.map((p: any) => ({ name: paymentLabel(p.method), value: p.totalCents }))} color={CHART_COLORS[2]} empty="No payments yet" />
          </div>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3">
          <Card title="Column Graph">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex h-28 items-end gap-2">
                {pay.slice(0, 5).map((p: any, i: number) => <div key={p.method} className="flex-1 rounded-t-sm" title={`${paymentLabel(p.method)} ${money(p.totalCents)}`} style={{ height: `${Math.max(6, (p.totalCents / Math.max(1, pay[0]?.totalCents ?? 1)) * 100)}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} />)}
              </div>
              <ul className="space-y-1.5 text-[12px]">{pay.slice(0, 5).map((p: any, i: number) => <li key={p.method} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} /><span className="flex-1 truncate">{paymentLabel(p.method)}</span><span className="text-ink-500">{compact(p.totalCents)}</span></li>)}</ul>
            </div>
          </Card>
          <Card title="Area Graph" actions={<span className="text-[11px] text-ink-500">Today vs yesterday</span>}>
            <LineChart labels={hours.map((h: any) => `${h.hour}h`)} series={[{ name: 'Today', values: hours.map((h: any) => h.todayCents) }, { name: 'Yesterday', values: hours.map((h: any) => h.yesterdayCents), color: CHART_COLORS[1] }]} every={3} />
            <div className="mt-2"><Legend items={[{ name: 'Today' }, { name: 'Yesterday', color: CHART_COLORS[1] }]} /></div>
          </Card>
          <Card title="Pie Chart" actions={<span className="text-[11px] text-ink-500">Sales by category, 30 days</span>}>
            <Pie rows={(d.categories ?? []).map((c: any) => ({ name: c.name, value: c.totalCents }))} />
          </Card>
          <Card title="Low stock">
            <ul className="divide-y divide-[#f0f1f3] text-[12.5px] dark:divide-ink-800">{(d.lowStockList ?? []).map((l: any) => <li key={l.name} className="flex justify-between py-1.5"><span className="truncate">{l.name}</span><span className={l.qty <= 0 ? 'font-semibold text-tile-red' : 'text-ink-500'}>{l.qty} / {l.reorderLevel}</span></li>)}</ul>
            {!(d.lowStockList ?? []).length && <p className="text-[12px] text-ink-500">Nothing below its reorder level.</p>}
          </Card>
        </div>

        <div className="space-y-3">
          <Card title="Sales by weekday">
            <div className="mb-2 text-center"><div className="text-2xl font-bold">{weekMax ? WEEKDAYS[weekMax.weekday - 1] : '—'}</div><div className="text-[11px] text-ink-500">Busiest day over the last 30 days</div></div>
            <div className="flex h-36 items-end gap-2 px-2">{(d.weekday ?? []).map((w: any) => <div key={w.weekday} className="flex flex-1 flex-col items-center gap-1"><div className="w-full rounded-t-sm bg-[#4a9be3]" style={{ height: `${Math.max(3, (w.totalCents / Math.max(1, weekMax?.totalCents ?? 1)) * 110)}px` }} title={money(w.totalCents)} /><span className="text-[10px] text-ink-500">{WEEKDAYS[w.weekday - 1]}</span></div>)}</div>
          </Card>
          <Card title="Circulars">
            <div className="grid grid-cols-3 gap-2">
              <Ring value={(d.rates?.inStockBp ?? 0) / 100} label="Products in stock" color={CHART_COLORS[0]} />
              {can('reports.financial') && <Ring value={(d.rates?.margin30Bp ?? 0) / 100} label="Gross margin" color={CHART_COLORS[4]} />}
              <Ring value={(d.rates?.repeatCustomersBp ?? 0) / 100} label="Repeat customers" color={CHART_COLORS[1]} />
            </div>
          </Card>
          {can('reports.financial') && <Card title="Bar Graph" actions={<span className="text-[11px] text-ink-500">Expenses vs profit</span>}>
            <HBars labels={evLabels} series={[{ name: 'Expenses', values: ev.map((m: any) => m.expensesCents), color: CHART_COLORS[1] }, { name: 'Profit', values: ev.map((m: any) => m.profitCents) }]} />
            <div className="mt-2"><Legend items={[{ name: 'Expenses', color: CHART_COLORS[1] }, { name: 'Profit' }]} /></div>
          </Card>}
          <Card title="Sparklines" actions={<span className="text-[11px] text-ink-500">Last 7 days</span>}>
            <ul className="divide-y divide-[#f0f1f3] text-[12.5px] dark:divide-ink-800">{(d.paymentTrend7 ?? []).map((p: any, i: number) => <li key={p.method} className="flex items-center justify-between py-2"><span>{paymentLabel(p.method)}</span><Sparkline values={p.series} color={CHART_COLORS[(i + 2) % CHART_COLORS.length]} /></li>)}</ul>
            {!(d.paymentTrend7 ?? []).length && <p className="text-[12px] text-ink-500">No sales this week.</p>}
          </Card>
          {can('reports.financial') && <Card title="Area Graph" actions={<Legend items={[{ name: 'Expense', color: CHART_COLORS[1] }, { name: 'Profit', color: CHART_COLORS[2] }]} />}>
            <LineChart fill labels={evLabels} series={[{ name: 'Expense', values: ev.map((m: any) => m.expensesCents), color: CHART_COLORS[1] }, { name: 'Profit', values: ev.map((m: any) => m.profitCents), color: CHART_COLORS[2] }]} height={160} />
          </Card>}
        </div>

        <div className="space-y-3">
          <Card title={`Top ${d.top?.by === 'branch' ? 'branches' : 'products'}`}>
            <ShareList rows={(d.top?.rows ?? []).map((r: any) => ({ name: r.name, value: r.totalCents }))} empty="No sales in 30 days" />
          </Card>
          <Card title="Cashiers today">
            <ShareList rows={(d.cashiersToday ?? []).map((c: any) => ({ name: c.name, value: c.totalCents, extra: `${c.count} sales` }))} color={CHART_COLORS[3]} empty="No sales yet today" />
          </Card>
          <Card title="Payment mix today">
            <ShareList rows={(d.paymentMix ?? []).map((p: any) => ({ name: paymentLabel(p.method), value: p.totalCents }))} color={CHART_COLORS[4]} empty="No sales yet today" />
          </Card>
          <Card title="Stock & catalogue">
            <ul className="divide-y divide-[#f0f1f3] text-[12.5px] dark:divide-ink-800">
              <li className="flex justify-between py-1.5"><span>Products</span><span className="font-semibold">{d.productsCount.toLocaleString()}</span></li>
              <li className="flex justify-between py-1.5"><span>Units in stock</span><span className="font-semibold">{d.stockUnits.toLocaleString()}</span></li>
              <li className="flex justify-between py-1.5"><span>Out of stock</span><span className="font-semibold text-tile-red">{d.outOfStockCount}</span></li>
              {has('batchExpiry') && <li className="flex justify-between py-1.5"><span>Expiring in 30 days</span><span className="font-semibold">{d.expiringSoonCount}</span></li>}
              <li className="flex justify-between py-1.5"><span>Returns today</span><span className="font-semibold">{money(d.returnsCents)}</span></li>
            </ul>
          </Card>
          <Card title="Text List" actions={<span className="text-[11px] text-ink-500">Latest sales</span>}>
            <ol className="list-decimal space-y-1.5 pl-5 text-[12.5px]">{(d.recentSales ?? []).map((r: any) => <li key={r.number}><span className="font-semibold">{r.number}</span> · {money(r.totalCents)} <span className="text-ink-400">{dateTime(r.at)}</span></li>)}</ol>
            {!(d.recentSales ?? []).length && <p className="text-[12px] text-ink-500">No sales yet.</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}
