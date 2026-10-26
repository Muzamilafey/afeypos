import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { LoyaltyProgram } from '@afeypos/shared';
import { api, openPrintable } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useList } from '../lib/hooks';
import { date, dateTime, money } from '../lib/format';
import { getWorkstation } from '../lib/workstation';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, cx, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Tabs, useToast } from '../components/ui';
import { Icon } from '../components/icons';

const pct = (bp: number) => String(bp / 100);

/** Loyalty program: rules, members with cards, points history and adjustments. */
export function LoyaltyPage() {
  const [tab, setTab] = useState('members');
  const q = useQuery({ queryKey: ['loyalty-program'], queryFn: () => api<{ data: { program: LoyaltyProgram; tiers: { name: string; minSpendCents: number }[]; stats: { members: number; pointsOutstanding: number; valueOutstandingCents: number } } }>('/loyalty/program').then((r) => r.data) });
  if (!q.data) return <Loading />;
  const { program, stats } = q.data;
  return (
    <div className="max-w-6xl">
      <PageHeader title={`Loyalty program · ${program.name}`} subtitle="Customers earn points on every purchase and pay with them later. Give each member a card to scan at the till." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Members with a card" value={stats.members} icon="users" color="green" />
        <Stat label="Points not yet used" value={stats.pointsOutstanding.toLocaleString()} icon="star" color="yellow" />
        <Stat label="Their value" value={money(stats.valueOutstandingCents)} icon="wallet" color="purple" hint="What the business owes in points" />
        <Stat label="Earning" value={`1 pt / ${money(program.pointsPerUnitCents)}`} icon="percent" color="blue" hint={`1 point = ${money(program.pointValueCents)}`} />
      </div>
      <Tabs tabs={[{ key: 'members', label: 'Members' }, { key: 'program', label: 'Program rules' }]} value={tab} onChange={setTab} />
      <div className="mt-4">{tab === 'members' ? <Members program={program} /> : <ProgramForm data={q.data} onSaved={() => q.refetch()} />}</div>
    </div>
  );
}

function ProgramForm({ data, onSaved }: { data: { program: LoyaltyProgram; tiers: { name: string; minSpendCents: number }[] }; onSaved: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [p, setP] = useState<LoyaltyProgram>(data.program);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (patch: Partial<LoyaltyProgram>) => setP({ ...p, ...patch });
  const save = async () => {
    setBusy(true); setError(null);
    try { await api('/loyalty/program', { method: 'PUT', body: p }); toast.success('Loyalty program saved'); onSaved(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const example = Math.floor(100000 / p.pointsPerUnitCents);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Earning and spending">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Program name" className="sm:col-span-2"><Input value={p.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Spend for 1 point"><MoneyInput value={p.pointsPerUnitCents} onChange={(v) => set({ pointsPerUnitCents: Math.max(1, v ?? 1) })} /></Field>
          <Field label="Value of 1 point"><MoneyInput value={p.pointValueCents} onChange={(v) => set({ pointValueCents: Math.max(1, v ?? 1) })} /></Field>
          <Field label="Fewest points per payment" hint="0 = any amount"><Input inputMode="numeric" value={String(p.minRedeemPoints)} onChange={(e) => set({ minRedeemPoints: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></Field>
          <Field label="Most of a sale paid with points (%)"><Input inputMode="decimal" value={pct(p.maxRedeemBp)} onChange={(e) => set({ maxRedeemBp: Math.round(Math.min(100, Math.max(0, Number(e.target.value) || 0)) * 100) })} /></Field>
          <Field label="Welcome bonus (points)" hint="Given once when a customer gets a card"><Input inputMode="numeric" value={String(p.welcomeBonus)} onChange={(e) => set({ welcomeBonus: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></Field>
        </div>
        <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">Example: a {money(100000)} purchase earns <b>{example} points</b>, worth <b>{money(example * p.pointValueCents)}</b> on the next visit ({((example * p.pointValueCents) / 1000).toFixed(1)}% back).</p>
      </Card>
      <Card title="Tiers earn faster">
        <p className="mb-3 text-xs text-ink-500">Tiers come from the last 12 months of spending (set them in <Link className="text-brand-600 hover:underline" to="/crm">CRM</Link>). 1 = normal speed, 2 = double points.</p>
        <div className="space-y-2">
          {data.tiers.length === 0 && <p className="text-sm text-ink-500">No tiers yet.</p>}
          {data.tiers.map((t) => (
            <div key={t.name} className="flex items-center gap-3">
              <span className="w-28 font-semibold">{t.name}</span>
              <span className="w-36 text-xs text-ink-500">from {money(t.minSpendCents)}/year</span>
              <Input aria-label={`${t.name} multiplier`} className="w-24" inputMode="decimal" value={String((p.tierMultipliersBp[t.name] ?? 10000) / 10000)}
                onChange={(e) => set({ tierMultipliersBp: { ...p.tierMultipliersBp, [t.name]: Math.round(Math.max(0, Number(e.target.value) || 0) * 10000) } })} />
              <span className="text-xs text-ink-500">× points</span>
            </div>
          ))}
        </div>
      </Card>
      <div className="lg:col-span-2">
        <ErrorBox error={error} />
        <Button loading={busy} disabled={!can('settings.manage')} onClick={save}>Save program</Button>
        {!can('settings.manage') && <span className="ml-3 text-xs text-ink-500">Only users who can change settings can edit the program.</span>}
      </div>
    </div>
  );
}

function Members({ program }: { program: LoyaltyProgram }) {
  const toast = useToast();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [all, setAll] = useState(false);
  const list = useList<any>(['loyalty-members'], '/loyalty/members', { q: q || undefined, page, limit: 25, all: all ? 'true' : undefined });
  const [open, setOpen] = useState<any>(null);
  const enroll = async (c: any) => {
    try {
      const r = await api<{ data: any }>(`/loyalty/members/${c._id}/enroll`, { body: {} });
      toast.success(`${r.data.name}: card ${r.data.loyaltyCardNo}`);
      list.refetch();
      setOpen(r.data);
    } catch (e) { toast.error(e); }
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search name, phone or card" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); setPage(1); }} />Show all customers (to give cards)</label>
      </div>
      <div className="card">
        <DataTable rows={list.data?.data} loading={list.isLoading} page={page} total={list.data?.total} limit={25} onPage={setPage} empty="No members yet. Tick “Show all customers” to give someone a card." onRowClick={(r: any) => setOpen(r)}
          columns={[
            { key: 'n', header: 'Customer', render: (r: any) => <div><div className="font-semibold">{r.name}</div><div className="text-xs text-ink-500">{r.phone}</div></div> },
            { key: 'c', header: 'Card', render: (r: any) => (r.loyaltyCardNo ? <span className="font-mono text-xs">{r.loyaltyCardNo}</span> : <Badge>No card</Badge>) },
            { key: 'p', header: 'Points', className: 'num', render: (r: any) => <b>{(r.loyaltyPoints ?? 0).toLocaleString()}</b> },
            { key: 'v', header: 'Worth', className: 'num', render: (r: any) => money((r.loyaltyPoints ?? 0) * program.pointValueCents) },
            { key: 'j', header: 'Joined', render: (r: any) => (r.loyaltyJoinedAt ? date(r.loyaltyJoinedAt) : '—') },
            { key: 'a', header: '', render: (r: any) => (
              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                {r.loyaltyCardNo
                  ? <Button size="sm" variant="secondary" onClick={() => openPrintable(`/loyalty/cards?ids=${r._id}`).catch(toast.error)}><Icon name="printer" className="h-3.5 w-3.5" />Card</Button>
                  : (can('loyalty.manage') || can('customers.manage')) && <Button size="sm" onClick={() => enroll(r)}>Give card</Button>}
              </div>
            ) },
          ]} />
      </div>
      {open && <MemberDrawer member={open} program={program} onClose={() => setOpen(null)} onChanged={() => list.refetch()} />}
    </div>
  );
}

function MemberDrawer({ member, program, onClose, onChanged }: { member: any; program: LoyaltyProgram; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const hist = useQuery({ queryKey: ['loyalty-history', member._id], queryFn: () => api<{ data: any[] }>(`/loyalty/members/${member._id}/history`, { query: { limit: 50 } }).then((r) => r.data) });
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [balance, setBalance] = useState<number>(member.loyaltyPoints ?? 0);
  const [error, setError] = useState<unknown>(null);
  const adjust = async () => {
    setError(null);
    try {
      const r = await api<{ data: { balance: number } }>(`/loyalty/members/${member._id}/adjust`, { body: { points: Math.trunc(Number(points)), note } });
      setBalance(r.data.balance); setPoints(''); setNote(''); hist.refetch(); onChanged();
      toast.success('Points adjusted');
    } catch (e) { setError(e); }
  };
  const KIND: Record<string, string> = { earn: 'Earned', redeem: 'Paid with', bonus: 'Bonus', adjust: 'Adjusted', reverse: 'Reversed' };
  return (
    <Modal open variant="drawer" size="lg" onClose={onClose} title={member.name} icon="star" subtitle={member.loyaltyCardNo ? `Card ${member.loyaltyCardNo}` : 'No card yet'}>
      <div className="space-y-4">
        <div className="flex items-center gap-4 rounded-lg bg-[#556b47] p-4 text-white">
          <div><div className="text-xs uppercase tracking-widest opacity-80">{program.name}</div><div className="text-3xl font-black">{balance.toLocaleString()} pts</div><div className="text-sm opacity-90">worth {money(balance * program.pointValueCents)}</div></div>
          {member.loyaltyCardNo && <Button variant="secondary" className="ml-auto" onClick={() => openPrintable(`/loyalty/cards?ids=${member._id}`).catch(toast.error)}><Icon name="printer" className="h-4 w-4" />Print card</Button>}
        </div>
        {can('loyalty.manage') && (
          <fieldset className="rounded-lg border border-ink-100 p-3 dark:border-ink-800">
            <legend className="px-1 text-xs font-bold uppercase tracking-wide text-ink-500">Adjust points</legend>
            <div className="grid items-end gap-2 sm:grid-cols-[120px_minmax(0,1fr)_auto]">
              <Field label="Points (+/−)"><Input inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/[^\d-]/g, ''))} placeholder="e.g. 50 or -20" /></Field>
              <Field label="Reason"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Goodwill for late delivery" /></Field>
              <Button disabled={!points || Number(points) === 0 || note.trim().length < 3} onClick={adjust}>Save</Button>
            </div>
            <div className="mt-2"><ErrorBox error={error} /></div>
          </fieldset>
        )}
        <div>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">Points history</h3>
          {!hist.data ? <Loading /> : hist.data.length === 0 ? <p className="text-sm text-ink-500">No points yet.</p> : (
            <ul className="divide-y divide-ink-100 text-sm dark:divide-ink-800">
              {hist.data.map((h) => (
                <li key={h._id} className="flex items-center gap-3 py-2">
                  <span className={cx('w-16 text-right font-mono font-bold', h.points > 0 ? 'text-emerald-600' : 'text-red-600')}>{h.points > 0 ? '+' : ''}{h.points}</span>
                  <span className="min-w-0 flex-1"><span className="font-semibold">{KIND[h.kind] ?? h.kind}</span>{h.saleNumber && <span className="text-ink-500"> · {h.saleNumber}</span>}{h.note && <span className="block truncate text-xs text-ink-500">{h.note}</span>}</span>
                  <span className="text-xs text-ink-500">{dateTime(h.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------- gift vouchers ----------------

const SOURCE_LABEL: Record<string, string> = { sold: 'Sold', promo: 'Promotion', compensation: 'Goodwill' };

export function VouchersPage() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: ['vouchers', status, q, page], queryFn: () => api<{ data: any[]; total: number; outstanding: { count: number; balanceCents: number } }>('/vouchers', { query: { status: status || undefined, q: q || undefined, page, limit: 25 } }) });
  const [issuing, setIssuing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [cancel, setCancel] = useState<any>(null);
  const print = (ids: string[], paper: 'a4' | 'receipt' = 'a4') => openPrintable(`/vouchers/print?ids=${ids.join(',')}&paper=${paper}`).catch(toast.error);
  return (
    <div className="max-w-6xl">
      <PageHeader title="Gift vouchers" subtitle="Sell vouchers, give them as promotions or goodwill, and accept them at the till (Pay with Voucher). A voucher can be spent in parts until its balance runs out."
        actions={<><Button variant="secondary" disabled={!selected.length} onClick={() => print(selected)}><Icon name="printer" className="h-4 w-4" />Print selected ({selected.length})</Button><Button onClick={() => setIssuing(true)}><Icon name="plus" className="h-4 w-4" />Issue vouchers</Button></>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Active vouchers" value={list.data?.outstanding.count ?? '—'} icon="tag" color="yellow" />
        <Stat label="Still to be spent" value={list.data ? money(list.data.outstanding.balanceCents) : '—'} icon="wallet" color="purple" hint="Owed to voucher holders" />
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search code, batch or note" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Select className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} options={[{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'used', label: 'Used up' }, { value: 'cancelled', label: 'Cancelled' }]} />
      </div>
      <div className="card">
        <DataTable rows={list.data?.data} loading={list.isLoading} page={page} total={list.data?.total} limit={25} onPage={setPage} empty="No vouchers yet"
          columns={[
            { key: 's', header: '', render: (r: any) => <input type="checkbox" aria-label={`Select ${r.code}`} checked={selected.includes(r._id)} onChange={(e) => setSelected(e.target.checked ? [...selected, r._id] : selected.filter((x) => x !== r._id))} /> },
            { key: 'c', header: 'Code', render: (r: any) => <span className="font-mono font-semibold">{r.code}</span> },
            { key: 'b', header: 'Balance', className: 'num', render: (r: any) => <span><b>{money(r.balanceCents)}</b><span className="text-xs text-ink-500"> / {money(r.initialCents)}</span></span> },
            { key: 'src', header: 'Type', render: (r: any) => SOURCE_LABEL[r.source] ?? r.source },
            { key: 'e', header: 'Expires', render: (r: any) => (r.expiresAt ? date(r.expiresAt) : 'Never') },
            { key: 'st', header: 'Status', render: (r: any) => <Badge tone={r.usable ? 'green' : r.status === 'cancelled' ? 'red' : 'gray'}>{r.usable ? 'Active' : r.problem?.replace(/^This voucher /, '') ?? r.status}</Badge> },
            { key: 'u', header: 'Used on', render: (r: any) => <span className="text-xs text-ink-500">{(r.redemptions ?? []).map((x: any) => x.saleNumber).join(', ') || '—'}</span> },
            { key: 'a', header: '', render: (r: any) => <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => print([r._id], 'receipt')}>Print</Button>{r.status !== 'cancelled' && <Button size="sm" variant="ghost" onClick={() => setCancel(r)}>Cancel</Button>}</div> },
          ]} />
      </div>
      {issuing && <IssueVouchers onClose={() => setIssuing(false)} onDone={(rows) => { setIssuing(false); list.refetch(); setSelected(rows.map((r) => r._id)); print(rows.map((r) => r._id), rows.length > 1 ? 'a4' : 'receipt'); }} />}
      {cancel && <CancelVoucher voucher={cancel} onClose={() => setCancel(null)} onDone={() => { setCancel(null); list.refetch(); }} />}
    </div>
  );
}

function IssueVouchers({ onClose, onDone }: { onClose: () => void; onDone: (rows: any[]) => void }) {
  const [f, setF] = useState({ amountCents: 100000 as number | null, quantity: '1', source: 'sold', method: 'cash', reference: '', expires: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const d = new Date(); d.setFullYear(d.getFullYear() + 1);
    setF((x) => ({ ...x, expires: d.toISOString().slice(0, 10) }));
  }, []);
  const qty = Math.max(1, Math.min(200, Math.floor(Number(f.quantity) || 1)));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ data: any[] }>('/vouchers', { body: {
        amountCents: f.amountCents, quantity: qty, source: f.source, note: f.note || undefined, expiresAt: f.expires ? new Date(`${f.expires}T23:59:59`).toISOString() : undefined,
        payment: f.source === 'sold' ? { method: f.method, reference: f.reference || undefined, tillId: f.method === 'cash' ? getWorkstation().tillId : undefined } : undefined,
      } });
      onDone(r.data);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Issue gift vouchers" icon="tag" size="md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.amountCents} onClick={save}>Issue {qty > 1 ? `${qty} vouchers` : 'voucher'} and print</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Value of each voucher"><MoneyInput value={f.amountCents} onChange={(v) => setF({ ...f, amountCents: v })} autoFocus /></Field>
        <Field label="How many"><Input inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Type"><Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} options={[{ value: 'sold', label: 'Sold to a customer' }, { value: 'promo', label: 'Promotion (free)' }, { value: 'compensation', label: 'Goodwill / compensation' }]} /></Field>
        <Field label="Valid until" hint="Empty = never expires"><Input type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></Field>
        {f.source === 'sold' && (
          <>
            <Field label="Paid with"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} options={[{ value: 'cash', label: 'Cash (into this till’s drawer)' }, { value: 'mpesa', label: 'M-Pesa' }, { value: 'card', label: 'Card' }, { value: 'bank', label: 'Bank transfer' }]} /></Field>
            {f.method !== 'cash' && <Field label="Payment reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="M-Pesa code or approval code" /></Field>}
          </>
        )}
        <Field label="Note" className="sm:col-span-2"><Input value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Christmas promotion, or the buyer's name" /></Field>
      </div>
      {f.source === 'sold' && f.amountCents ? <p className="mt-3 text-sm">Collect <b>{money((f.amountCents ?? 0) * qty)}</b> from the customer.</p> : null}
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

function CancelVoucher({ voucher, onClose, onDone }: { voucher: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal open onClose={onClose} title={`Cancel ${voucher.code}`} icon="x" size="sm" subtitle={`Balance ${money(voucher.balanceCents)} will no longer be usable.`}
      footer={<><Button variant="secondary" onClick={onClose}>Keep it</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={() => api(`/vouchers/${voucher._id}/cancel`, { body: { reason } }).then(onDone).catch(setError)}>Cancel voucher</Button></>}>
      <Field label="Reason"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Reported lost" /></Field>
      <div className="mt-2"><ErrorBox error={error} /></div>
    </Modal>
  );
}
