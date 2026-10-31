import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, money, qty } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { BarChart } from '../../components/Chart';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Stat, Tabs } from '../../components/ui';
import { Icon } from '../../components/icons';
import { ReportActions } from '../../components/ReportActions';
import { Period } from '../Finance';

type Tab = 'forecastDays' | 'forecastMonths' | 'pairs' | 'overstock' | 'seasonality';

const TABS: { key: Tab; label: string; subtitle: string; csv: boolean }[] = [
  { key: 'forecastDays', label: 'Stock prediction (days)', subtitle: 'How long the stock of each product lasts, the day it runs out and how much to order', csv: true },
  { key: 'forecastMonths', label: 'Stock prediction (months)', subtitle: 'What each month used, and what the next three months are expected to need', csv: true },
  { key: 'pairs', label: 'Bought together', subtitle: 'Products customers put in the same basket: place them together and offer them with each other', csv: true },
  { key: 'overstock', label: 'Money in slow stock', subtitle: 'Stock that lasts far longer than it should: money standing still on the shelf', csv: true },
  { key: 'seasonality', label: 'Busy days & months', subtitle: 'Which weekdays and months sell most, so buying follows the busy days', csv: false },
];

const pct = (bp: number) => `${(bp / 100).toFixed(0)}%`;
const tone = (s: string) => (s === 'order now' ? 'red' : s === 'order soon' ? 'amber' : s === 'not selling' ? 'blue' : 'green') as 'red';

/** Reports › Stock analysis: what sells together, what stock will do next, and what is tying money up. */
export function StockAnalysisPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('forecastDays');
  const [from, setFrom] = useState(() => new Date(Date.now() - 27 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(28);
  const [leadDays, setLeadDays] = useState(7);
  const [coverDays, setCoverDays] = useState(14);
  const ref = useRef<HTMLDivElement>(null);
  const info = TABS.find((t) => t.key === tab)!;
  const stockTab = tab === 'forecastDays' || tab === 'forecastMonths' || tab === 'overstock';
  const query = { from, to, tab, days, leadDays, coverDays };
  const q = useQuery({ queryKey: ['stock-analysis', tab, from, to, days, leadDays, coverDays], queryFn: () => api<any>('/reports/stock-analysis', { query }) });
  const d = q.data;
  const meta: [string, string][] = [
    ...(stockTab ? [['Sales rate from', `the last ${days} days`] as [string, string]] : [['Period', from === to ? date(from) : `${date(from)} to ${date(to)}`] as [string, string]]),
    ...(tab === 'forecastDays' || tab === 'overstock' ? [['Delivery takes', `${leadDays} days`] as [string, string], ['Keep stock for', `${coverDays} days`] as [string, string]] : []),
  ];
  const showCost = can('reports.financial');

  return (
    <div>
      <PageHeader title="Stock analysis" subtitle={`${info.subtitle}. Predictions follow what this shop actually sold.`} actions={<>
        {d && <ReportActions target={ref} title={`Stock analysis · ${info.label}`} subtitle={info.subtitle} meta={meta} />}
        {d && info.csv && <Button variant="secondary" onClick={() => download('/reports/stock-analysis', `stock-${tab}.csv`, { ...query, format: 'csv' })}><Icon name="download" className="h-4 w-4" />CSV</Button>}
      </>} />
      <Tabs tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} value={tab} onChange={(k) => setTab(k as Tab)} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {!stockTab && <Period from={from} to={to} setFrom={setFrom} setTo={setTo} />}
        {stockTab && <Field label="Sales of the last (days)" className="max-w-[12rem]"><Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} options={[7, 14, 28, 60, 90, 180].map((n) => ({ value: String(n), label: `${n} days` }))} /></Field>}
        {(tab === 'forecastDays' || tab === 'overstock') && <>
          <Field label="Delivery takes (days)" className="max-w-[10rem]"><Input type="number" min={0} value={leadDays} onChange={(e) => setLeadDays(Math.max(0, Number(e.target.value) || 0))} /></Field>
          <Field label="Keep stock for (days)" className="max-w-[10rem]"><Input type="number" min={1} value={coverDays} onChange={(e) => setCoverDays(Math.max(1, Number(e.target.value) || 1))} /></Field>
        </>}
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : d && (
        <div ref={ref} className="space-y-4">
          {tab === 'forecastDays' && <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Order now" value={String(d.summary.orderNow)} hint="Runs out before the next delivery arrives" color={d.summary.orderNow ? 'red' : 'green'} icon="alert" />
              <Stat label="Order soon" value={String(d.summary.orderSoon)} color="yellow" icon="clock" />
              <Stat label="Not selling" value={String(d.summary.notSelling)} hint="In stock, nothing sold in the period" color="blue" icon="box" />
              {showCost && <Stat label="Cost to restock everything" value={money(d.summary.orderCostCents)} color="purple" icon="wallet" />}
            </div>
            <div className="card"><DataTable rows={d.data.map((r: any) => ({ ...r, id: String(r.productId) }))} empty="No stock to predict yet" columns={[
              { key: 'n', header: 'Product', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.sku}</div></div> },
              { key: 'h', header: 'In stock', className: 'num', render: (r: any) => `${qty(r.onHand)} ${r.unit}` },
              { key: 'o', header: 'On order', className: 'num', render: (r: any) => (r.onOrder ? qty(r.onOrder) : '—') },
              { key: 'd', header: 'Sells / day', className: 'num', render: (r: any) => qty(r.perDay) },
              { key: 'l', header: 'Days left', className: 'num font-semibold', render: (r: any) => (r.daysLeft === null ? '—' : r.daysLeft) },
              { key: 'x', header: 'Runs out', render: (r: any) => (r.outOn ? date(r.outOn) : '—') },
              { key: 'e7', header: 'Next 7 days', className: 'num', render: (r: any) => qty(r.expected7) },
              { key: 'e30', header: 'Next 30 days', className: 'num', render: (r: any) => qty(r.expected30) },
              { key: 'q', header: 'Order', className: 'num', render: (r: any) => (r.orderQty ? <span className="font-semibold">{qty(r.orderQty)} {r.unit}</span> : '—') },
              ...(showCost ? [{ key: 'c', header: 'Cost', className: 'num', render: (r: any) => (r.orderCostCents ? money(r.orderCostCents) : '') }] : []),
              { key: 's', header: 'Status', render: (r: any) => <Badge tone={tone(r.status)}>{r.status}</Badge> },
            ]} /></div>
          </>}

          {tab === 'forecastMonths' && <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat label="Products selling" value={String(d.data.length)} hint={`Months ${d.months[0]} to ${d.months.at(-1)}`} color="blue" icon="chart" />
              {showCost && <Stat label="Cost to cover the next 3 months" value={money(d.totalOrderCostCents)} color="purple" icon="wallet" />}
            </div>
            <div className="card"><DataTable rows={d.data.map((r: any) => ({ ...r, id: String(r.productId) }))} empty="No sales history yet" columns={[
              { key: 'n', header: 'Product', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.sku}</div></div> },
              ...d.months.map((m: string) => ({ key: m, header: m.slice(2), className: 'num', render: (r: any) => qty(r.months[m] ?? 0) })),
              { key: 'h', header: 'In stock', className: 'num', render: (r: any) => qty(r.onHand) },
              { key: 'e', header: 'Expected / month', className: 'num font-semibold', render: (r: any) => qty(r.expectedPerMonth) },
              ...d.nextMonths.map((m: string) => ({ key: m, header: `${m.slice(2)} (expected)`, className: 'num', render: (r: any) => qty(r.next3[m] ?? 0) })),
              { key: 'o', header: 'Order for 3 months', className: 'num', render: (r: any) => (r.orderForNext3 ? <span className="font-semibold">{qty(r.orderForNext3)} {r.unit}</span> : '—') },
              ...(showCost ? [{ key: 'c', header: 'Cost', className: 'num', render: (r: any) => (r.orderCostCents ? money(r.orderCostCents) : '') }] : []),
            ]} /></div>
          </>}

          {tab === 'pairs' && <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat label="Receipts with 2+ products" value={String(d.receipts)} color="blue" icon="cart" />
              <Stat label="Pairs found" value={String(d.data.length)} hint="Bought together at least twice" color="teal" icon="layers" />
            </div>
            <div className="card"><DataTable rows={d.data.map((r: any, i: number) => ({ ...r, id: String(i) }))} empty="No products were bought together in this period" columns={[
              { key: 'a', header: 'Product', render: (r: any) => r.a },
              { key: 'b', header: 'Bought with', render: (r: any) => r.b },
              { key: 'c', header: 'Receipts', className: 'num font-semibold', render: (r: any) => r.count },
              { key: 'x', header: 'Of its buyers', className: 'num', render: (r: any) => pct(r.withABp) },
              { key: 'y', header: 'Of the other’s', className: 'num', render: (r: any) => pct(r.withBBp) },
              { key: 's', header: 'Sales together', className: 'num', render: (r: any) => money(r.salesCents) },
            ]} /></div>
          </>}

          {tab === 'overstock' && <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Stat label="Products overstocked" value={String(d.data.length)} hint="More than 2 months of cover" color={d.data.length ? 'yellow' : 'green'} icon="box" />
              {showCost && <Stat label="Money standing still" value={money(d.totalExcessValueCents)} hint="Value above what the period needs" color="red" icon="wallet" />}
            </div>
            <div className="card"><DataTable rows={d.data.map((r: any) => ({ ...r, id: String(r.productId) }))} empty="No product is overstocked" columns={[
              { key: 'n', header: 'Product', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.sku}</div></div> },
              { key: 'h', header: 'In stock', className: 'num', render: (r: any) => `${qty(r.onHand)} ${r.unit}` },
              { key: 'd', header: 'Sells / day', className: 'num', render: (r: any) => qty(r.perDay) },
              { key: 'm', header: 'Months of cover', className: 'num font-semibold', render: (r: any) => (r.monthsOfCover === null ? 'never sells' : r.monthsOfCover) },
              { key: 't', header: 'Enough would be', className: 'num', render: (r: any) => qty(r.target) },
              { key: 'e', header: 'Too much', className: 'num', render: (r: any) => qty(r.excess) },
              ...(showCost ? [{ key: 'v', header: 'Money in it', className: 'num', render: (r: any) => money(r.excessValueCents) }] : []),
            ]} /></div>
          </>}

          {tab === 'seasonality' && <>
            <Card title="Sales by weekday"><BarChart data={d.data.weekdays.map((w: any) => ({ label: w.name.slice(0, 3), value: w.grossCents }))} format={money} /></Card>
            <div className="card"><DataTable rows={d.data.weekdays.map((r: any) => ({ ...r, id: r.name }))} empty="No sales in this period" columns={[
              { key: 'n', header: 'Weekday', render: (r: any) => r.name },
              { key: 'c', header: 'Receipts', className: 'num', render: (r: any) => r.count },
              { key: 'u', header: 'Units sold', className: 'num', render: (r: any) => qty(r.units) },
              { key: 'g', header: 'Sales', className: 'num', render: (r: any) => money(r.grossCents) },
              { key: 'v', header: 'Against the average', className: 'num', render: (r: any) => <span className={r.vsAverageBp >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'}>{r.vsAverageBp >= 0 ? '+' : ''}{pct(r.vsAverageBp)}</span> },
            ]} /></div>
            <Card title="Sales by month (last 12 months)"><BarChart data={d.data.months.map((m: any) => ({ label: m.month.slice(2), value: m.grossCents }))} format={money} /></Card>
            <div className="card"><DataTable rows={d.data.months.map((r: any) => ({ ...r, id: r.month }))} empty="No sales yet" columns={[
              { key: 'm', header: 'Month', render: (r: any) => r.month },
              { key: 'c', header: 'Receipts', className: 'num', render: (r: any) => r.count },
              { key: 'u', header: 'Units sold', className: 'num', render: (r: any) => qty(r.units) },
              { key: 'g', header: 'Sales', className: 'num', render: (r: any) => money(r.grossCents) },
            ]} /></div>
          </>}
        </div>
      )}
    </div>
  );
}
