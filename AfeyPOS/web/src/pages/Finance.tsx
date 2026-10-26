import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useList, useLocations } from '../lib/hooks';
import { dateTime, daysAgoLocal, money, paymentLabel, qty, todayLocal } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { BarChart } from '../components/Chart';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, StatusBadge, Tabs, useToast } from '../components/ui';
import { ProductPicker } from '../components/ProductPicker';
import { Icon } from '../components/icons';

function Period({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      {[['Today', 0], ['7 days', 6], ['30 days', 29]].map(([l, d]) => <Button key={l as string} size="sm" variant="secondary" onClick={() => { setFrom(daysAgoLocal(d as number)); setTo(todayLocal()); }}>{l}</Button>)}
    </div>
  );
}

export function ReportsPage() {
  const { can, has } = useAuth();
  const [tab, setTab] = useState('daily');
  const [from, setFrom] = useState(daysAgoLocal(6));
  const [to, setTo] = useState(todayLocal());
  const [groupBy, setGroupBy] = useState('day');
  const [deadDays, setDeadDays] = useState(30);
  const [leadDays, setLeadDays] = useState(7);
  const period = { from, to };
  const q = useQuery({
    queryKey: ['report', tab, from, to, groupBy, deadDays, leadDays],
    queryFn: () => {
      const map: Record<string, [string, Record<string, unknown>]> = {
        sales: ['/reports/sales', { ...period, groupBy }], profit: ['/reports/profit', period], inventory: ['/reports/inventory-valuation', {}], receivables: ['/reports/receivables', {}],
        payables: ['/reports/payables', {}], exceptions: ['/reports/exceptions', period], tax: ['/reports/tax', period], branches: ['/reports/branches', period], shifts: ['/reports/shifts', period],
        losses: ['/reports/losses', period], expenses: ['/reports/expenses', period], purchases: ['/reports/purchases', period], activity: ['/reports/activity', period],
        daily: ['/reports/daily-summary', period], returns: ['/reports/returns', period], basket: ['/reports/basket', period], discounts: ['/reports/discounts', period],
        performance: ['/reports/product-performance', period], dead: ['/reports/dead-stock', { ...period, days: deadDays }], reorder: ['/reports/reorder', { ...period, leadDays }],
      };
      const [path, query] = map[tab];
      return api<any>(path, { query });
    },
  });
  const tabs = [
    { key: 'daily', label: 'Daily summary' }, { key: 'sales', label: 'Sales' }, { key: 'basket', label: 'Baskets & peak hours' }, { key: 'returns', label: 'Returns' }, { key: 'discounts', label: 'Discounts' },
    ...(can('reports.financial') ? [{ key: 'performance', label: 'Product performance' }] : []), { key: 'dead', label: 'Dead stock' }, ...(can('inventory.read') ? [{ key: 'reorder', label: 'Reorder' }] : []), ...(can('reports.financial') ? [{ key: 'profit', label: 'Profit & cash' }, { key: 'inventory', label: 'Stock value' }, { key: 'tax', label: 'Tax' }, { key: 'purchases', label: 'Purchases' }, { key: 'expenses', label: 'Expenses' }] : []),
    ...(can('reports.financial') && has('customerCredit') ? [{ key: 'receivables', label: 'Receivables' }] : []), ...(can('reports.financial') ? [{ key: 'payables', label: 'Payables' }] : []),
    { key: 'exceptions', label: 'Voids & discounts' }, { key: 'losses', label: 'Losses' }, { key: 'shifts', label: 'Cashier shifts' }, ...(has('multiBranch') ? [{ key: 'branches', label: 'Branches' }] : []), ...(can('audit.read') ? [{ key: 'activity', label: 'User activity' }] : []),
  ];
  const d = q.data;
  const csvTabs = ['sales', 'inventory', 'shifts', 'branches', 'losses', 'purchases', 'activity', 'daily', 'returns', 'performance', 'dead', 'reorder'];
  const csvPath: Record<string, string> = { sales: '/reports/sales', inventory: '/reports/inventory-valuation', daily: '/reports/daily-summary', performance: '/reports/product-performance', dead: '/reports/dead-stock', reorder: '/reports/reorder' };
  return (
    <div>
      <PageHeader title="Reports" subtitle="Periods use the business timezone" actions={csvTabs.includes(tab) && <Button variant="secondary" onClick={() => download(csvPath[tab] ?? `/reports/${tab}`, `${tab}.csv`, { ...period, groupBy, days: deadDays, leadDays, format: 'csv' })}><Icon name="download" className="h-4 w-4" />CSV</Button>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {!['inventory', 'receivables', 'payables', 'dead', 'reorder'].includes(tab) && <div className="mb-4"><Period from={from} to={to} setFrom={setFrom} setTo={setTo} /></div>}
      {tab === 'dead' && <div className="mb-4 max-w-xs"><Field label="No sale for (days)"><Input type="number" min={1} value={deadDays} onChange={(e) => setDeadDays(Math.max(1, Number(e.target.value) || 30))} /></Field></div>}
      {tab === 'reorder' && <div className="mb-4 max-w-xs"><Field label="Supplier lead time (days)"><Input type="number" min={0} value={leadDays} onChange={(e) => setLeadDays(Math.max(0, Number(e.target.value) || 0))} /></Field></div>}
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <>
          {tab === 'sales' && (
            <div className="space-y-4">
              <Select className="max-w-xs" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} options={['day', 'week', 'month', 'hour', 'weekday', 'product', 'category', 'department', 'brand', 'cashier', 'branch', 'till', 'paymentMethod', 'customer', 'salesRep'].map((x) => ({ value: x, label: `By ${x}` }))} />
              {['day', 'week', 'month', 'hour'].includes(groupBy) && <Card><BarChart data={d.data.map((r: any) => ({ label: r._id, value: r.grossCents }))} format={money} /></Card>}
              <div className="card"><DataTable rows={d.data.map((r: any, i: number) => ({ ...r, id: String(r._id ?? i) }))} columns={[
                { key: 'k', header: groupBy, render: (r: any) => r.name ?? r._id ?? '—' },
                ...(d.data[0]?.count !== undefined ? [{ key: 'c', header: 'Count', className: 'num', render: (r: any) => r.count }] : []),
                ...(d.data[0]?.qty !== undefined ? [{ key: 'q', header: 'Qty', className: 'num', render: (r: any) => qty(r.qty) }] : []),
                { key: 'g', header: 'Sales (incl. tax)', className: 'num', render: (r: any) => money(r.grossCents) },
                ...(can('reports.financial') && d.data[0]?.grossProfitCents !== undefined ? [{ key: 'p', header: 'Gross profit', className: 'num', render: (r: any) => money(r.grossProfitCents) }] : []),
                ...(d.data[0]?.discountCents !== undefined ? [{ key: 'd', header: 'Discounts', className: 'num', render: (r: any) => money(r.discountCents) }] : []),
              ]} /></div>
            </div>
          )}
          {tab === 'profit' && (() => {
            const r = d.data[0];
            return (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Gross sales (incl. tax)" value={money(r.grossSalesCents)} hint={`${r.salesCount} sales`} />
                <Stat label="Returns" value={money(r.returnsCents)} />
                <Stat label="Net revenue (excl. tax)" value={money(r.netRevenueCents)} />
                <Stat label="Output tax" value={money(r.outputTaxCents)} />
                <Stat label="Cost of goods sold" value={money(r.cogsCents)} />
                <Stat label="Gross profit" value={money(r.grossProfitCents)} hint={`Margin ${(r.grossMarginBp / 100).toFixed(1)}%`} tone={r.grossProfitCents < 0 ? 'red' : 'green'} />
                <Stat label="Expenses" value={money(r.expensesCents)} />
                <Stat label="Operating profit" value={money(r.operatingProfitCents)} tone={r.operatingProfitCents < 0 ? 'red' : 'green'} />
                <Stat label="Cash actually received" value={money(r.cashReceivedCents)} hint="Payments collected less refunds paid" />
                <Stat label="Sold on credit" value={money(r.creditSalesCents)} hint="Receivable, not cash" />
              </div>
            );
          })()}
          {tab === 'inventory' && <><div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Stock value at cost" value={money(d.totalValueCents)} hint="Weighted average cost" /><Stat label="Retail value" value={money(d.retailValueCents)} /></div><div className="card"><DataTable rows={d.data} columns={[{ key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 'q', header: 'Qty', className: 'num', render: (r: any) => `${qty(r.qty)} ${r.unit}` }, { key: 'c', header: 'Avg cost', className: 'num', render: (r: any) => money(r.avgCostCents) }, { key: 'v', header: 'Value', className: 'num', render: (r: any) => money(r.valueCents) }]} /></div></>}
          {(tab === 'receivables' || tab === 'payables') && <div className="card"><div className="p-3 font-semibold">Total {money(d.totalCents)}</div><DataTable rows={d.data} columns={[{ key: 'n', header: tab === 'receivables' ? 'Customer' : 'Supplier', render: (r: any) => (r.customer ?? r.supplier)?.name }, ...[['current', 'Current'], ['d1_30', '1-30'], ['d31_60', '31-60'], ['d61_90', '61-90'], ['d90plus', '90+'], ['total', 'Total']].map(([k, l]) => ({ key: k, header: l, className: 'num', render: (r: any) => money(r[k]) }))]} /></div>}
          {tab === 'tax' && <div className="grid gap-3 sm:grid-cols-4"><Stat label="Output tax" value={money(d.data.outputTaxCents)} /><Stat label="Input tax" value={money(d.data.inputTaxCents)} /><Stat label="Net payable" value={money(d.data.netTaxPayableCents)} /><Card className="sm:col-span-4"><p className="text-sm text-ink-500">{d.data.note}</p>{d.data.outputByRate.map((r: any) => <div key={r.rateBp} className="flex justify-between text-sm"><span>{r.rateBp / 100}%</span><span>net {money(r.netCents)} · tax {money(r.taxCents)}</span></div>)}</Card></div>}
          {tab === 'exceptions' && <div className="grid gap-4 lg:grid-cols-3"><Stat label="Voided" value={money(d.data.totals.voidsCents)} hint={`${d.data.voids.length} sales`} /><Stat label="Returned" value={money(d.data.totals.returnsCents)} hint={`${d.data.returns.length} returns`} /><Stat label="Discounts given" value={money(d.data.totals.discountsCents)} hint={`${d.data.discounts.length} sales`} /><Card title="Supervisor overrides" className="lg:col-span-3"><ul className="text-sm">{d.data.overrides.map((s: any) => <li key={s._id}>{s.number}: {s.overrides.map((o: any) => o.action).join('; ')}</li>)}</ul></Card></div>}
          {['branches', 'shifts', 'losses', 'purchases', 'activity'].includes(tab) && <div className="card"><DataTable rows={d.data.map((r: any, i: number) => ({ ...r, id: String(i) }))} columns={Object.keys(d.data[0] ?? {}).filter((k) => !['_id', 'productId', 'warehouseId'].includes(k)).map((k) => ({ key: k, header: k.replace(/Cents$/, '').replace(/([A-Z])/g, ' $1'), className: /Cents$|count|qty/i.test(k) ? 'num' : undefined, render: (r: any) => (/Cents$/.test(k) ? money(r[k]) : /At$/.test(k) ? dateTime(r[k]) : typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k] ?? '')) }))} /></div>}
          {tab === 'daily' && <RetailDaily d={d} />}
          {tab === 'basket' && <RetailBasket d={d.data} />}
          {tab === 'returns' && <RetailReturns d={d.data} />}
          {tab === 'discounts' && <RetailDiscounts d={d.data} />}
          {tab === 'performance' && <RetailPerformance d={d} />}
          {tab === 'dead' && <><div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Value tied up" value={money(d.totalValueCents)} hint={`${d.data.length} products without a sale in ${d.days} days`} tone={d.totalValueCents ? 'red' : undefined} /></div><div className="card"><DataTable rows={d.data.map((r: any) => ({ ...r, id: r.productId }))} empty="Every stocked product sold recently" columns={[{ key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 'q', header: 'On hand', className: 'num', render: (r: any) => `${qty(r.qty)} ${r.unit}` }, { key: 'v', header: 'Cost value', className: 'num', render: (r: any) => money(r.valueCents) }, { key: 'rv', header: 'Retail value', className: 'num', render: (r: any) => money(r.retailValueCents) }, { key: 'l', header: 'Last sold', render: (r: any) => (r.lastSoldAt ? `${dateTime(r.lastSoldAt)} (${r.daysSinceSale} d)` : 'Never') }]} /></div></>}
          {tab === 'reorder' && <><div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Products to reorder" value={String(d.data.length)} /><Stat label="Estimated cost" value={money(d.totalCostCents)} hint={`Sales rate of the last ${d.params.days} days, cover ${d.params.leadDays + d.params.coverDays} days`} /></div><div className="card"><DataTable rows={d.data.map((r: any) => ({ ...r, id: r.productId }))} empty="Nothing needs reordering" columns={[{ key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 's', header: 'Last supplier', render: (r: any) => r.supplier || '—' }, { key: 'h', header: 'On hand', className: 'num', render: (r: any) => qty(r.onHand) }, { key: 'o', header: 'On order', className: 'num', render: (r: any) => qty(r.onOrder) }, { key: 'a', header: 'Sells / day', className: 'num', render: (r: any) => r.avgDailySales }, { key: 'd', header: 'Days left', className: 'num', render: (r: any) => (r.daysLeft ?? '—') }, { key: 'q', header: 'Order', className: 'num font-semibold', render: (r: any) => `${qty(r.suggestQty)} ${r.unit}` }, { key: 'c', header: 'Est. cost', className: 'num', render: (r: any) => money(r.estCostCents) }]} /></div></>}
          {tab === 'expenses' && <div className="grid gap-4 lg:grid-cols-2"><Card title="By category">{d.data.map((r: any) => <div key={r._id} className="flex justify-between text-sm"><span>{r._id}</span><span>{money(r.totalCents)}</span></div>)}</Card><Card title="Cash movements">{d.cashMovements.map((r: any) => <div key={r._id} className="flex justify-between text-sm"><span>{r._id}</span><span>{money(r.totalCents)}</span></div>)}</Card></div>}
        </>
      )}
    </div>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;

function RetailDaily({ d }: { d: any }) {
  const t = d.totals ?? {};
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sales (incl. tax)" value={money(t.grossCents ?? 0)} hint={`${t.salesCount ?? 0} receipts · average ${money(t.avgBasketCents ?? 0)}`} />
        <Stat label="Money collected" value={money(t.netCollectedCents ?? 0)} hint="Cash, M-Pesa, card and bank less refunds paid" />
        <Stat label="Returns" value={money(t.returnsCents ?? 0)} hint={`${t.returnsCount ?? 0} returns`} tone={t.returnsCents ? 'red' : undefined} />
        <Stat label="Voids" value={money(t.voidsCents ?? 0)} hint={`${t.voidsCount ?? 0} voided`} tone={t.voidsCount ? 'red' : undefined} />
      </div>
      <div className="card"><DataTable rows={d.data.map((r: any) => ({ ...r, id: r.date }))} empty="No trading in this period" columns={[
        { key: 'd', header: 'Day', render: (r: any) => r.date }, { key: 'c', header: 'Receipts', className: 'num', render: (r: any) => r.salesCount },
        { key: 'g', header: 'Sales', className: 'num', render: (r: any) => money(r.grossCents) }, { key: 'di', header: 'Discounts', className: 'num', render: (r: any) => money(r.discountCents) },
        { key: 't', header: 'Tax', className: 'num', render: (r: any) => money(r.taxCents) }, { key: 'ca', header: 'Cash', className: 'num', render: (r: any) => money(r.cashCents) },
        { key: 'm', header: 'M-Pesa', className: 'num', render: (r: any) => money(r.mpesaCents) }, { key: 'cd', header: 'Card', className: 'num', render: (r: any) => money(r.cardCents) },
        { key: 'cr', header: 'Credit', className: 'num', render: (r: any) => money(r.creditCents) }, { key: 'r', header: 'Returns', className: 'num', render: (r: any) => money(r.returnsCents) },
        { key: 'v', header: 'Voids', className: 'num', render: (r: any) => (r.voidsCount ? `${r.voidsCount} · ${money(r.voidsCents)}` : '—') },
        { key: 'n', header: 'Collected', className: 'num font-semibold', render: (r: any) => money(r.netCollectedCents) },
      ]} /></div>
    </div>
  );
}

function RetailBasket({ d }: { d: any }) {
  const s = d.summary;
  const max = Math.max(1, ...d.heatmap.map((h: any) => h.count));
  const hours = Array.from({ length: 24 }, (_, h) => h).filter((h) => d.heatmap.some((x: any) => x.hour === h) || (h >= 7 && h <= 21));
  const cell = (wd: number, h: number) => d.heatmap.find((x: any) => x.weekday === wd && x.hour === h);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Transactions" value={String(s.transactions)} />
        <Stat label="Average basket" value={money(s.avgBasketCents)} hint={`${s.avgLines} lines · ${s.avgUnits} units`} />
        <Stat label="Largest basket" value={money(s.largestCents)} />
        <Stat label="Known customers" value={pct(s.identifiedCustomersBp)} hint="Sales linked to a customer (loyalty)" />
      </div>
      <Card title="Basket sizes (KES)"><BarChart data={d.buckets.map((b: any) => ({ label: b.label, value: b.count }))} format={(v: number) => String(v)} /></Card>
      <Card title="Busy hours (receipts)">
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead><tr><th className="px-1" />{hours.map((h) => <th key={h} className="px-1 font-normal text-ink-500">{String(h).padStart(2, '0')}</th>)}</tr></thead>
            <tbody>{[2, 3, 4, 5, 6, 7, 1].map((wd) => (
              <tr key={wd}><td className="pr-2 text-ink-500">{WEEKDAYS[wd - 1]}</td>{hours.map((h) => {
                const c = cell(wd, h);
                return <td key={h} title={c ? `${c.count} receipts · ${money(c.grossCents)}` : ''} className="h-7 w-8 rounded text-center tabular-nums" style={{ background: c ? `rgba(16,185,129,${0.15 + 0.85 * (c.count / max)})` : undefined }}>{c?.count ?? ''}</td>;
              })}</tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function RetailReturns({ d }: { d: any }) {
  const rows = (x: any[], label: (r: any) => string) => x.map((r: any, i: number) => <div key={i} className="flex justify-between text-sm"><span>{label(r)}</span><span className="tabular-nums">{r.count ?? qty(r.qty)} · {money(r.refundCents)}</span></div>);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Refunded" value={money(d.summary.refundCents)} hint={`${d.summary.count} returns`} tone={d.summary.refundCents ? 'red' : undefined} />
        <Stat label="Return rate" value={pct(d.summary.returnRateBp)} hint={`of ${money(d.summary.salesCents)} sales`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="By reason">{rows(d.byReason, (r) => r.name)}</Card>
        <Card title="By refund method">{rows(d.byMethod, (r) => r._id)}</Card>
        <Card title="By staff">{rows(d.byCashier, (r) => `${r.name}${r.approved ? ` (${r.approved} approved)` : ''}`)}</Card>
      </div>
      <Card title="Most returned products"><DataTable rows={d.byProduct.map((r: any) => ({ ...r, id: String(r._id) }))} empty="No returns" columns={[{ key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 'q', header: 'Qty', className: 'num', render: (r: any) => qty(r.qty) }, { key: 'rs', header: 'Back to shelf', className: 'num', render: (r: any) => qty(r.restockedQty) }, { key: 'a', header: 'Refunded', className: 'num', render: (r: any) => money(r.refundCents) }]} /></Card>
    </div>
  );
}

function RetailDiscounts({ d }: { d: any }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3"><Stat label="Discounts given" value={money(d.totalCents)} /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By cashier"><DataTable rows={d.byCashier.map((r: any) => ({ ...r, id: String(r._id) }))} empty="No discounts" columns={[{ key: 'n', header: 'Cashier', render: (r: any) => r.name }, { key: 'c', header: 'Sales', className: 'num', render: (r: any) => r.count }, { key: 'a', header: 'Discount', className: 'num', render: (r: any) => money(r.discountCents) }, { key: 'r', header: 'Rate', className: 'num', render: (r: any) => pct(r.rateBp) }]} /></Card>
        <Card title="By promotion"><DataTable rows={d.byPromotion.map((r: any) => ({ ...r, id: String(r._id) }))} empty="No promotions used" columns={[{ key: 'n', header: 'Promotion', render: (r: any) => r.name }, { key: 'c', header: 'Lines', className: 'num', render: (r: any) => r.count }, { key: 'a', header: 'Discount', className: 'num', render: (r: any) => money(r.discountCents) }, { key: 's', header: 'Sales', className: 'num', render: (r: any) => money(r.salesCents) }]} /></Card>
      </div>
      <Card title="By product"><DataTable rows={d.byProduct.map((r: any) => ({ ...r, id: String(r._id) }))} empty="No discounts" columns={[{ key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 'c', header: 'Lines', className: 'num', render: (r: any) => r.count }, { key: 'a', header: 'Discount', className: 'num', render: (r: any) => money(r.discountCents) }]} /></Card>
    </div>
  );
}

function RetailPerformance({ d }: { d: any }) {
  const tone = (c: string) => (c === 'A' ? 'green' : c === 'B' ? 'blue' : 'gray') as 'green';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">{d.classes.map((c: any) => <Stat key={c.class} label={`Class ${c.class}`} value={money(c.netCents)} hint={`${c.products} products · ${c.class === 'A' ? 'top 80% of revenue' : c.class === 'B' ? 'next 15%' : 'last 5%'}`} />)}</div>
      <div className="card"><DataTable rows={d.data.map((r: any) => ({ ...r, id: String(r.productId) }))} empty="No sales in this period" columns={[
        { key: 'r', header: '#', className: 'num', render: (r: any) => r.rank }, { key: 'n', header: 'Product', render: (r: any) => r.name }, { key: 'c', header: 'ABC', render: (r: any) => <Badge tone={tone(r.abc)}>{r.abc}</Badge> },
        { key: 'q', header: 'Qty sold', className: 'num', render: (r: any) => qty(r.qtySold) }, { key: 'g', header: 'Sales', className: 'num', render: (r: any) => money(r.grossCents) },
        { key: 'p', header: 'Gross profit', className: 'num', render: (r: any) => money(r.grossProfitCents) }, { key: 'm', header: 'Margin', className: 'num', render: (r: any) => pct(r.marginBp) },
        { key: 's', header: 'Share', className: 'num', render: (r: any) => pct(r.shareBp) }, { key: 'h', header: 'On hand', className: 'num', render: (r: any) => qty(r.onHand) },
        { key: 'dc', header: 'Days of cover', className: 'num', render: (r: any) => (r.daysOfCover ?? '—') },
      ]} /></div>
    </div>
  );
}

export function ExpensesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useList(['expenses'], '/expenses', { limit: 50 });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>({ category: '', amountCents: null, method: 'cash', payee: '', reference: '' });
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <PageHeader title="Expenses" actions={<Button onClick={() => setOpen(true)}><Icon name="plus" className="h-4 w-4" />Record expense</Button>} />
      <div className="card"><DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} columns={[
        { key: 'n', header: 'Number', render: (r: any) => r.number }, { key: 'd', header: 'Date', render: (r: any) => dateTime(r.date) }, { key: 'c', header: 'Category', render: (r: any) => r.category },
        { key: 'p', header: 'Payee', render: (r: any) => r.payee ?? '' }, { key: 'm', header: 'Method', render: (r: any) => r.method }, { key: 'a', header: 'Amount', className: 'num', render: (r: any) => money(r.amountCents) },
      ]} /></div>
      <Modal open={open} onClose={() => setOpen(false)} title="Record expense" footer={<Button onClick={async () => { try { await api('/expenses', { body: { ...f, payee: f.payee || undefined, reference: f.reference || undefined } }); setOpen(false); qc.invalidateQueries({ queryKey: ['expenses'] }); toast.success('Saved'); } catch (e) { setError(e); } }}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category"><Input list="exp-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /><datalist id="exp-cats">{['Rent', 'Electricity', 'Water', 'Transport', 'Salaries', 'Airtime', 'Repairs', 'Licences'].map((c) => <option key={c} value={c} />)}</datalist></Field>
          <Field label="Amount"><MoneyInput value={f.amountCents} onChange={(v) => setF({ ...f, amountCents: v })} /></Field>
          <Field label="Paid with"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} options={['cash', 'mpesa', 'bank', 'card', 'other'].map((x) => ({ value: x, label: x }))} /></Field>
          <Field label="Payee"><Input value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} /></Field>
          <Field label="Reference" className="sm:col-span-2"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        </div>
        <ErrorBox error={error} />
      </Modal>
    </div>
  );
}

export function PromotionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['promotions'], queryFn: () => api<{ data: any[] }>('/promotions').then((r) => r.data) });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>({ name: '', kind: 'percent', percent: '10', price: null, couponCode: '', startsAt: '', endsAt: '', products: [] as any[] });
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <PageHeader title="Promotions & coupons" actions={<Button onClick={() => setOpen(true)}><Icon name="plus" className="h-4 w-4" />New promotion</Button>} />
      <div className="card"><DataTable rows={list.data} loading={list.isLoading} error={list.error} columns={[
        { key: 'n', header: 'Name', render: (r: any) => r.name }, { key: 'k', header: 'Offer', render: (r: any) => (r.kind === 'percent' ? `${r.value / 100}% off` : `Price ${money(r.value)}`) },
        { key: 'c', header: 'Coupon', render: (r: any) => r.couponCode ?? '—' }, { key: 'u', header: 'Uses', render: (r: any) => r.uses }, { key: 'w', header: 'Window', render: (r: any) => `${r.startsAt ? new Date(r.startsAt).toLocaleDateString() : '…'} – ${r.endsAt ? new Date(r.endsAt).toLocaleDateString() : '…'}` },
        { key: 'a', header: 'Active', render: (r: any) => <Button size="sm" variant="secondary" onClick={() => api(`/promotions/${r._id}`, { method: 'PATCH', body: { active: !r.active } }).then(() => qc.invalidateQueries({ queryKey: ['promotions'] }))}>{r.active ? 'Active' : 'Paused'}</Button> },
      ]} /></div>
      <Modal open={open} onClose={() => setOpen(false)} title="New promotion" size="lg" footer={<Button onClick={async () => {
        try { await api('/promotions', { body: { name: f.name, kind: f.kind, value: f.kind === 'percent' ? Math.round(Number(f.percent) * 100) : f.price, couponCode: f.couponCode || undefined, startsAt: f.startsAt || undefined, endsAt: f.endsAt || undefined, productIds: f.products.map((p: any) => p._id) } }); setOpen(false); qc.invalidateQueries({ queryKey: ['promotions'] }); toast.success('Promotion created'); } catch (e) { setError(e); }
      }}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={[{ value: 'percent', label: 'Percentage off' }, { value: 'fixed_price', label: 'Special price' }]} /></Field>
          {f.kind === 'percent' ? <Field label="Percent off"><Input value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} /></Field> : <Field label="Special price (per base unit)"><MoneyInput value={f.price} onChange={(v) => setF({ ...f, price: v })} /></Field>}
          <Field label="Coupon code (optional)"><Input value={f.couponCode} onChange={(e) => setF({ ...f, couponCode: e.target.value.toUpperCase() })} /></Field>
          <Field label="Starts"><Input type="date" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
          <Field label="Ends"><Input type="date" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field>
        </div>
        <div className="mt-3"><ProductPicker onPick={(p) => setF({ ...f, products: [...f.products, p] })} /><div className="mt-2 flex flex-wrap gap-1">{f.products.map((p: any) => <Badge key={p._id}>{p.name}</Badge>)}</div></div>
        <ErrorBox error={error} />
      </Modal>
    </div>
  );
}

export function RepairsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useList(['repairs'], '/repairs', { limit: 50 });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>({ customerName: '', customerPhone: '', itemDescription: '', serial: '', fault: '' });
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <PageHeader title="Repairs" actions={<Button onClick={() => setOpen(true)}><Icon name="plus" className="h-4 w-4" />Book in repair</Button>} />
      <div className="card"><DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} columns={[
        { key: 'n', header: 'Job', render: (r: any) => r.number }, { key: 'c', header: 'Customer', render: (r: any) => `${r.customerName ?? ''} ${r.customerPhone ?? ''}` }, { key: 'i', header: 'Item', render: (r: any) => <div>{r.itemDescription}<div className="text-xs text-ink-500">{r.serial}</div></div> },
        { key: 'w', header: 'Warranty', render: (r: any) => (r.underWarranty ? <Badge tone="green">in warranty</Badge> : '—') }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
        { key: 'a', header: '', render: (r: any) => <Select className="w-40" value={r.status} onChange={(e) => api(`/repairs/${r._id}`, { method: 'PATCH', body: { status: e.target.value } }).then(() => qc.invalidateQueries({ queryKey: ['repairs'] })).catch(toast.error)} options={['received', 'diagnosing', 'awaiting_parts', 'repairing', 'ready', 'collected', 'cancelled'].map((x) => ({ value: x, label: x.replace('_', ' ') }))} /> },
      ]} /></div>
      <Modal open={open} onClose={() => setOpen(false)} title="Book in repair" footer={<Button onClick={async () => { try { await api('/repairs', { body: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }); setOpen(false); qc.invalidateQueries({ queryKey: ['repairs'] }); } catch (e) { setError(e); } }}>Save</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">{[['customerName', 'Customer name'], ['customerPhone', 'Phone'], ['itemDescription', 'Item'], ['serial', 'Serial / IMEI'], ['fault', 'Reported fault']].map(([k, l]) => <Field key={k} label={l}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}</div>
        <ErrorBox error={error} />
      </Modal>
    </div>
  );
}

export function MpesaPage() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const list = useList(['intents'], '/payments/intents', { q: q || undefined, provider: 'mpesa', limit: 50 });
  const rec = useQuery({ queryKey: ['mpesa-rec'], queryFn: () => api<{ data: any }>('/payments/mpesa/reconciliation').then((r) => r.data) });
  return (
    <div>
      <PageHeader title="M-Pesa" subtitle="Payments are only marked successful after Safaricom confirms them" />
      {rec.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {rec.data.summary.map((s: any) => <Stat key={s._id} label={s._id} value={money(s.amountCents)} hint={`${s.count} ${s.count === 1 ? "payment" : "payments"} · ${money(s.allocatedCents)} used`} />)}
          <Stat label="Received, not yet applied" value={money(rec.data.unallocated.reduce((a: number, i: any) => a + i.paidAmountCents - i.allocatedCents, 0))} tone={rec.data.unallocated.length ? 'red' : undefined} hint={`${rec.data.unallocated.length} ${rec.data.unallocated.length === 1 ? "payment needs" : "payments need"} allocation`} />
        </div>
      )}
      <div className="card">
        <div className="border-b border-ink-100 p-3 dark:border-ink-800"><Input className="max-w-xs" placeholder="Receipt number or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} columns={[
          { key: 'd', header: 'Time', render: (r: any) => dateTime(r.createdAt) }, { key: 's', header: 'Source', render: (r: any) => (r.source === 'stk' ? 'STK push' : 'Paybill/Till') },
          { key: 'p', header: 'Payer', render: (r: any) => `${r.payerName ?? ''} ${r.phone ?? ''}` }, { key: 'r', header: 'Receipt', render: (r: any) => r.receiptNumber ?? '—' },
          { key: 'a', header: 'Amount', className: 'num', render: (r: any) => money(r.paidAmountCents ?? r.amountCents) }, { key: 'st', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          { key: 'al', header: 'Applied to', render: (r: any) => r.allocatedTo?.number ?? (r.status === 'succeeded' ? <Badge tone="amber">unallocated</Badge> : '') },
          { key: 'x', header: '', render: (r: any) => (r.status === 'pending' ? <Button size="sm" variant="secondary" onClick={() => api(`/payments/intents/${r.id}/query`, { body: {} }).then(() => list.refetch()).catch(toast.error)}>Check</Button> : null) },
        ]} />
      </div>
      <SafaricomLog />
    </div>
  );
}

const EVENT_OUTCOMES: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  matched_expected: { label: 'Matched to the till', tone: 'green' },
  matched_expected_later: { label: 'Matched to the till', tone: 'green' },
  recorded: { label: 'Received, not matched (use it at the till)', tone: 'amber' },
  duplicate: { label: 'Already recorded', tone: 'gray' },
  unknown_shortcode: { label: 'Unknown Till/Paybill number: check the M-Pesa settings', tone: 'red' },
  malformed: { label: 'Unreadable message', tone: 'red' },
};

/** What Safaricom actually sent (C2B confirmations, STK results): shows whether confirmations arrive at all. */
function SafaricomLog() {
  const q = useQuery({ queryKey: ['mpesa-events'], queryFn: () => api<{ data: any[] }>('/payments/mpesa/events', { query: { limit: 30 } }).then((r) => r.data), refetchInterval: 15_000 });
  return (
    <Card title="Messages from Safaricom" className="mt-4">
      <p className="mb-2 text-sm text-ink-500">Every payment confirmation Safaricom sent to this server. If a customer paid the Till and nothing shows here, Safaricom is not sending confirmations: register the C2B URLs again (Settings → Integrations) for the store number of the Till.</p>
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} empty="Nothing received from Safaricom yet" columns={[
        { key: 't', header: 'Time', render: (r: any) => dateTime(r.at) },
        { key: 'k', header: 'Message', render: (r: any) => ({ c2b_confirmation: 'Paybill/Till payment', c2b_validation: 'Validation', stk_callback: 'Prompt result', stk_query: 'Prompt status' } as Record<string, string>)[r.kind] ?? r.kind },
        { key: 'n', header: 'Till/Paybill', render: (r: any) => r.payload?.BusinessShortCode ?? '' },
        { key: 'r', header: 'Receipt', render: (r: any) => r.payload?.TransID ?? '' },
        { key: 'a', header: 'Amount', className: 'num', render: (r: any) => (r.payload?.TransAmount ? money(Math.round(Number(r.payload.TransAmount) * 100)) : '') },
        { key: 'o', header: 'Result', render: (r: any) => { const o = EVENT_OUTCOMES[r.outcome ?? '']; return o ? <Badge tone={o.tone}>{o.label}</Badge> : <span className="text-xs text-ink-500">{r.outcome ?? ''}</span>; } },
      ]} />
    </Card>
  );
}

export function OnlinePaymentsPage() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const list = useList(['gateway-intents'], '/payments/intents', { q: q || undefined, provider: 'gateway', limit: 50 });
  const rec = useQuery({ queryKey: ['gateway-rec'], queryFn: () => api<{ data: any }>('/payments/online/reconciliation').then((r) => r.data) });
  const byProvider = new Map<string, { count: number; amountCents: number; allocatedCents: number }>();
  for (const s of rec.data?.summary ?? []) {
    if (s._id.status !== 'succeeded') continue;
    const cur = byProvider.get(s._id.provider) ?? { count: 0, amountCents: 0, allocatedCents: 0 };
    byProvider.set(s._id.provider, { count: cur.count + s.count, amountCents: cur.amountCents + s.amountCents, allocatedCents: cur.allocatedCents + s.allocatedCents });
  }
  return (
    <div>
      <PageHeader title="Online payments" subtitle="Paystack, Flutterwave, pawaPay, Airtel Money and other gateways. A payment counts only after the provider's API confirms it." />
      {rec.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[...byProvider].map(([p, v]) => <Stat key={p} label={paymentLabel('gateway', p)} value={money(v.amountCents)} hint={`${v.count} confirmed · ${money(v.allocatedCents)} used`} />)}
          <Stat label="Received, not yet applied" value={money(rec.data.unallocated.reduce((a: number, i: any) => a + i.paidAmountCents - i.allocatedCents, 0))} tone={rec.data.unallocated.length ? 'red' : undefined} hint={`${rec.data.unallocated.length} unallocated · ${rec.data.lateConfirmations.length} late`} />
        </div>
      )}
      <div className="card">
        <div className="border-b border-ink-100 p-3 dark:border-ink-800"><Input className="max-w-xs" placeholder="Receipt, reference or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} empty="No gateway payments yet" columns={[
          { key: 'd', header: 'Time', render: (r: any) => dateTime(r.createdAt) },
          { key: 'g', header: 'Gateway', render: (r: any) => paymentLabel('gateway', r.provider) },
          { key: 's', header: 'Type', render: (r: any) => (r.source === 'link' ? 'Payment link' : 'Phone prompt') },
          { key: 'p', header: 'Payer', render: (r: any) => `${r.payerName ?? ''} ${r.phone ?? ''}` },
          { key: 'r', header: 'Receipt', render: (r: any) => r.receiptNumber ?? <span className="text-xs text-ink-500">{r.reference}</span> },
          { key: 'a', header: 'Amount', className: 'num', render: (r: any) => `${r.currency ?? ''} ${money(r.paidAmountCents ?? r.amountCents)}` },
          { key: 'st', header: 'Status', render: (r: any) => <span title={r.resultDesc ?? ''}><StatusBadge status={r.status} /></span> },
          { key: 'al', header: 'Applied to', render: (r: any) => r.allocatedTo?.number ?? (r.status === 'succeeded' ? <Badge tone="amber">unallocated</Badge> : '') },
          { key: 'x', header: '', render: (r: any) => (r.status === 'pending' ? <Button size="sm" variant="secondary" onClick={() => api(`/payments/intents/${r.id}/query`, { body: {} }).then(() => list.refetch()).catch(toast.error)}>Check</Button> : null) },
        ]} />
      </div>
    </div>
  );
}

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const list = useList(['audit'], '/audit', { page, action: action || undefined, limit: 50 });
  return (
    <div>
      <PageHeader title="Audit trail" subtitle="Security and business events. Entries cannot be edited." />
      <div className="card">
        <div className="border-b border-ink-100 p-3 dark:border-ink-800"><Input className="max-w-xs" placeholder="Filter by action (e.g. sale, auth, support)" value={action} onChange={(e) => setAction(e.target.value)} /></div>
        <DataTable rows={list.data?.data} loading={list.isLoading} error={list.error} page={page} total={list.data?.total} limit={50} onPage={setPage} columns={[
          { key: 't', header: 'Time', render: (r: any) => dateTime(r.at) }, { key: 'a', header: 'Action', render: (r: any) => <code className="text-xs">{r.action}</code> },
          { key: 'u', header: 'By', render: (r: any) => r.actor?.name ?? r.actor?.kind }, { key: 'e', header: 'Record', render: (r: any) => (r.entity ? `${r.entity}` : '') },
          { key: 'd', header: 'Details', render: (r: any) => <span className="line-clamp-2 text-xs text-ink-500">{r.details ? JSON.stringify(r.details) : ''}</span> }, { key: 'ip', header: 'IP', render: (r: any) => r.ip ?? '' },
        ]} />
      </div>
    </div>
  );
}

export { useLocations };
