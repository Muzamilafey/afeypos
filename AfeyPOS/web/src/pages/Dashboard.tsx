import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, paymentLabel } from '../lib/format';
import { Card, ErrorBox, Loading, PageHeader, Stat, Button } from '../components/ui';
import { BarChart } from '../components/Chart';

export function DashboardPage() {
  const { me, can, has } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ data: any }>('/reports/dashboard').then((r) => r.data), enabled: can('reports.read') && has('reports'), refetchInterval: 60_000 });
  const widgets = me!.capabilities.dashboardWidgets;
  if (!can('reports.read')) {
    return (
      <div>
        <PageHeader title={`Welcome, ${me!.user.name.split(' ')[0]}`} />
        <div className="grid gap-3 sm:grid-cols-2">
          {can('sales.create') && <Link to="/pos"><Button size="xl" className="w-full">Start selling</Button></Link>}
          {can('shifts.open') && <Link to="/shifts"><Button size="xl" variant="secondary" className="w-full">My shift</Button></Link>}
        </div>
      </div>
    );
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  return (
    <div>
      <PageHeader title="Today" subtitle={`${me!.tenant.name} · ${d.period.from}`} actions={can('sales.create') ? <Link to="/pos"><Button>Open checkout</Button></Link> : undefined} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sales" value={money(d.sales.grossCents)} hint={`${d.sales.count} transactions · avg ${money(d.sales.averageCents)}`} />
        {can('reports.financial') && <Stat label="Gross profit" value={money(d.grossProfitCents)} tone={d.grossProfitCents < 0 ? 'red' : 'green'} hint="Net of tax and returns" />}
        <Stat label="Returns" value={money(d.returnsCents)} />
        {(widgets.includes('receivables') || has('customerCredit')) && <Stat label="Owed by customers" value={money(d.receivablesCents)} hint={`${d.debtorCount} ${d.debtorCount === 1 ? 'customer' : 'customers'}`} />}
        <Stat label="Low stock items" value={d.lowStockCount} tone={d.lowStockCount ? 'red' : undefined} hint={<Link className="text-brand-700" to="/inventory?belowReorder=true">View</Link>} />
        {has('batchExpiry') && <Stat label="Expiring in 30 days" value={d.expiringSoonCount} tone={d.expiringSoonCount ? 'red' : undefined} />}
        <Stat label="Open shifts" value={d.openShifts} />
        {d.sales.creditCents > 0 && <Stat label="Credit sales" value={money(d.sales.creditCents)} />}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Sales by hour" className="lg:col-span-2"><BarChart data={d.hourly.map((h: any) => ({ label: `${h.hour}h`, value: h.totalCents }))} format={money} /></Card>
        <Card title="Payment mix">
          <ul className="space-y-2 text-sm">{d.paymentMix.map((p: any) => <li key={p.method} className="flex justify-between"><span>{paymentLabel(p.method)}</span><span className="tabular-nums">{money(p.totalCents)}</span></li>)}</ul>
          {!d.paymentMix.length && <p className="text-sm text-ink-500">No sales yet today.</p>}
        </Card>
        <Card title="Top products" className="lg:col-span-3">
          <ul className="divide-y divide-ink-100 text-sm dark:divide-ink-800">{d.topProducts.map((p: any) => <li key={p._id} className="flex justify-between py-1.5"><span>{p.name}</span><span className="tabular-nums">{p.qty} · {money(p.total)}</span></li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
