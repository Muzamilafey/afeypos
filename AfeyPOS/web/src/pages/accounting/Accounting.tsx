import { useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, money, todayLocal } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Tabs, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { ReportActions } from '../../components/ReportActions';

const monthStart = () => `${todayLocal().slice(0, 7)}-01`;
const TYPE_LABEL: Record<string, string> = { asset: 'Asset', liability: 'Liability', equity: 'Equity', income: 'Income', expense: 'Expense' };

function Range({ from, to, setFrom, setTo, children }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      {children && <div className="ml-auto flex gap-2">{children}</div>}
    </div>
  );
}

function Section({ title, rows, total, sign = 1 }: { title: string; rows: { code: string; name: string; amountCents: number }[]; total: number; sign?: number }) {
  return (
    <div className="mb-3" data-lines="Account|Amount" data-title={title}>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</div>
      {rows.map((r) => <div data-line key={r.code} className="flex justify-between py-0.5 text-sm"><Link className="hover:underline" to={`/accounting/ledger/${r.code}`}>{r.code} {r.name}</Link><span className="tabular-nums">{money(sign * r.amountCents)}</span></div>)}
      <div data-line-total className="flex justify-between border-t border-ink-200 pt-1 text-sm font-semibold dark:border-ink-700"><span>Total {title.toLowerCase()}</span><span className="tabular-nums">{money(sign * total)}</span></div>
    </div>
  );
}

export function AccountingPage() {
  const [tab, setTab] = useState('pl');
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  return (
    <div>
      <PageHeader title="Accounts" subtitle="Double-entry books kept automatically from sales, purchases, payments, stock, expenses and payroll" actions={can('accounting.manage') && <Button variant="secondary" onClick={() => api<{ data: Record<string, number> }>('/accounting/post', { body: {} }).then((r) => { toast.success(`${Object.values(r.data).reduce((a, b) => a + b, 0)} documents posted`); qc.invalidateQueries(); }).catch(toast.error)}><Icon name="refresh" className="h-4 w-4" />Post now</Button>} />
      <Tabs tabs={[{ key: 'pl', label: 'Profit & loss' }, { key: 'bs', label: 'Balance sheet' }, { key: 'tb', label: 'Trial balance' }, { key: 'vat', label: 'VAT' }, { key: 'coa', label: 'Chart of accounts' }, { key: 'journals', label: 'Journals' }, ...(can('accounting.manage') ? [{ key: 'close', label: 'Close books' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'pl' && <ProfitLoss />}
      {tab === 'bs' && <BalanceSheet />}
      {tab === 'tb' && <TrialBalance />}
      {tab === 'vat' && <Vat />}
      {tab === 'coa' && <Chart />}
      {tab === 'journals' && <Journals />}
      {tab === 'close' && <CloseBooks />}
    </div>
  );
}

function ProfitLoss() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const q = useQuery({ queryKey: ['acct-pl', from, to], queryFn: () => api<{ data: any }>('/accounting/profit-loss', { query: { from, to } }).then((r) => r.data) });
  const sum = (x: any[]) => x.reduce((s, a) => s + a.amountCents, 0);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="max-w-3xl">
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo}>{q.data && <ReportActions target={ref} title="Profit and loss statement" meta={[['Period', `${date(from)} to ${date(to)}`]]} />}</Range>
      {!q.data ? <Loading /> : <div ref={ref}>
        <div className="mb-4 grid grid-cols-3 gap-3">
          <Stat label="Net sales" value={money(q.data.netSalesCents)} />
          <Stat label="Gross profit" value={money(q.data.grossProfitCents)} hint={`Margin ${(q.data.grossMarginBp / 100).toFixed(1)}%`} />
          <Stat label="Net profit" value={money(q.data.netProfitCents)} tone={q.data.netProfitCents < 0 ? 'red' : 'green'} />
        </div>
        <Card actions={<Button size="sm" variant="secondary" onClick={() => download('/accounting/profit-loss', `profit-loss-${from}-${to}.csv`, { from, to, format: 'csv' })}><Icon name="download" className="h-4 w-4" />CSV</Button>}>
          <Section title="Revenue" rows={q.data.revenue} total={q.data.netSalesCents} />
          <Section title="Cost of sales" rows={q.data.cogs} total={sum(q.data.cogs)} />
          <div data-lines="|"><div data-line-total className="mb-3 flex justify-between text-sm font-semibold"><span>Gross profit</span><span>{money(q.data.grossProfitCents)}</span></div></div>
          {q.data.otherIncome.length > 0 && <Section title="Other income" rows={q.data.otherIncome} total={sum(q.data.otherIncome)} />}
          <Section title="Expenses" rows={q.data.expenses} total={sum(q.data.expenses)} />
          <div data-lines="|"><div data-line-total className="flex justify-between border-t-2 border-ink-900 pt-2 text-base font-bold dark:border-ink-100"><span>Net profit</span><span>{money(q.data.netProfitCents)}</span></div></div>
        </Card>
      </div>}
    </div>
  );
}

function BalanceSheet() {
  const [asOf, setAsOf] = useState(todayLocal());
  const q = useQuery({ queryKey: ['acct-bs', asOf], queryFn: () => api<{ data: any }>('/accounting/balance-sheet', { query: { asOf } }).then((r) => r.data) });
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex flex-wrap items-end gap-2"><Field label="As at" className="max-w-xs"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>{q.data && <div className="ml-auto flex gap-2"><ReportActions target={ref} title="Balance sheet" meta={[['As at', date(asOf)], ['Status', q.data.balanced ? 'Balanced' : 'OUT OF BALANCE']]} /></div>}</div>
      {!q.data ? <Loading /> : (
        <div ref={ref}><Card actions={<>{q.data.balanced ? <Badge tone="green">Balanced</Badge> : <Badge tone="red">Out of balance</Badge>}<Button size="sm" variant="secondary" onClick={() => download('/accounting/balance-sheet', `balance-sheet-${asOf}.csv`, { asOf, format: 'csv' })}><Icon name="download" className="h-4 w-4" />CSV</Button></>}>
          <Section title="Assets" rows={q.data.assets} total={q.data.totals.assetsCents} />
          <Section title="Liabilities" rows={q.data.liabilities} total={q.data.totals.liabilitiesCents} />
          <Section title="Equity" rows={[...q.data.equity, { code: '—', name: 'Profit to date (not yet closed)', amountCents: q.data.earningsCents }]} total={q.data.totals.equityCents} />
          <div data-lines="|"><div data-line-total className="flex justify-between border-t-2 border-ink-900 pt-2 font-bold dark:border-ink-100"><span>Liabilities + equity</span><span>{money(q.data.totals.liabilitiesCents + q.data.totals.equityCents)}</span></div></div>
        </Card></div>
      )}
    </div>
  );
}

function TrialBalance() {
  const [asOf, setAsOf] = useState(todayLocal());
  const q = useQuery({ queryKey: ['acct-tb', asOf], queryFn: () => api<any>('/accounting/trial-balance', { query: { asOf } }) });
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-end gap-2"><Field label="As at"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><Button variant="secondary" onClick={() => download('/accounting/trial-balance', `trial-balance-${asOf}.csv`, { asOf, format: 'csv' })}><Icon name="download" className="h-4 w-4" />CSV</Button>{q.data && <ReportActions target={ref} title="Trial balance" meta={[['As at', date(asOf)], ['Status', q.data.balanced ? 'Balanced' : 'OUT OF BALANCE']]} />}</div>
      {!q.data ? <Loading /> : <div className="card" ref={ref}><DataTable rows={q.data.data.map((r: any) => ({ ...r, id: r.code }))} columns={[
        { key: 'c', header: 'Account', render: (r: any) => <Link className="hover:underline" to={`/accounting/ledger/${r.code}`}>{r.code} {r.name}</Link> },
        { key: 't', header: 'Type', render: (r: any) => TYPE_LABEL[r.type] },
        { key: 'd', header: 'Debit', className: 'num', render: (r: any) => (r.debitCents ? money(r.debitCents) : '') },
        { key: 'k', header: 'Credit', className: 'num', render: (r: any) => (r.creditCents ? money(r.creditCents) : '') },
      ]} />
        <div data-lines="|"><div data-line-total className="flex justify-between border-t border-ink-200 p-3 text-sm font-semibold dark:border-ink-700"><span>{q.data.balanced ? 'Totals (balanced)' : 'Totals (OUT OF BALANCE)'}</span><span>Debit {money(q.data.totals.debitCents)} · Credit {money(q.data.totals.creditCents)}</span></div></div></div>}
    </div>
  );
}

function Vat() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const q = useQuery({ queryKey: ['acct-vat', from, to], queryFn: () => api<any>('/accounting/vat', { query: { from, to } }) });
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="max-w-3xl">
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo}>{q.data && <ReportActions target={ref} title="VAT summary" meta={[['Period', `${date(from)} to ${date(to)}`]]} />}</Range>
      {!q.data ? <Loading /> : <div ref={ref}>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Output VAT" value={money(q.data.data.outputVatCents)} hint={`${money(q.data.data.outputOnSalesCents)} on sales, less ${money(q.data.data.outputReversedOnReturnsCents)} on returns`} />
          <Stat label="Input VAT" value={money(q.data.data.inputVatCents)} hint="Purchases and expenses" />
          <Stat label={q.data.data.netPayableCents >= 0 ? 'VAT payable' : 'VAT to carry forward'} value={money(Math.abs(q.data.data.netPayableCents))} tone={q.data.data.netPayableCents > 0 ? 'red' : 'green'} />
        </div>
        <p data-report-text className="mt-3 text-sm text-ink-500">{q.data.note}</p>
      </div>}
    </div>
  );
}

function Chart() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['acct-accounts'], queryFn: () => api<{ data: any[] }>('/accounting/accounts').then((r) => r.data) });
  const [f, setF] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="max-w-5xl">
      {can('accounting.manage') && <div className="mb-3 flex justify-end"><Button onClick={() => { setF({ code: '', name: '', type: 'expense' }); setError(null); }}><Icon name="plus" className="h-4 w-4" />Add account</Button></div>}
      <div className="card"><DataTable rows={(q.data ?? []).map((a) => ({ ...a, id: a.code }))} loading={q.isLoading} columns={[
        { key: 'c', header: 'Code', render: (a: any) => a.code },
        { key: 'n', header: 'Account', render: (a: any) => <Link className="hover:underline" to={`/accounting/ledger/${a.code}`}>{a.name}</Link> },
        { key: 't', header: 'Type', render: (a: any) => <span>{TYPE_LABEL[a.type]}{a.key && !a.key.startsWith('expense:') && <span className="ml-1 text-xs text-ink-400">system</span>}</span> },
        { key: 'b', header: 'Balance', className: 'num', render: (a: any) => money(a.balanceCents) },
      ]} /></div>
      {f && (
        <Modal open onClose={() => setF(null)} title="Add account" footer={<Button onClick={() => api('/accounting/accounts', { body: f }).then(() => { setF(null); qc.invalidateQueries({ queryKey: ['acct-accounts'] }); }).catch(setError)}>Save</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input value={f.code} placeholder="1510" onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} /></Field>
            <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          </div>
          <div className="mt-3"><ErrorBox error={error} /></div>
        </Modal>
      )}
    </div>
  );
}

function Journals() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['acct-journals', from, to, search, page], queryFn: () => api<any>('/accounting/journals', { query: { from, to, q: search || undefined, page, limit: 30 } }) });
  const [open, setOpen] = useState<any>(null);
  const [manual, setManual] = useState(false);
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2"><Range from={from} to={to} setFrom={setFrom} setTo={setTo} /><Field label="Search" className="mb-4"><Input value={search} placeholder="Number, memo or document" onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></Field></div>
        {can('accounting.manage') && <Button className="mb-4" onClick={() => setManual(true)}><Icon name="plus" className="h-4 w-4" />Manual journal</Button>}
      </div>
      <div className="card"><DataTable rows={q.data?.data} loading={q.isLoading} page={page} total={q.data?.total} limit={30} onPage={setPage} onRowClick={(j: any) => setOpen(j)} columns={[
        { key: 'd', header: 'Date', render: (j: any) => date(j.date) }, { key: 'n', header: 'Journal', render: (j: any) => j.number },
        { key: 'm', header: 'Description', render: (j: any) => <span>{j.memo}{j.manual && <span className="ml-2"><Badge>manual</Badge></span>}{j.reversedBy && <span className="ml-2"><Badge tone="amber">reversed</Badge></span>}</span> },
        { key: 't', header: 'Amount', className: 'num', render: (j: any) => money(j.totalCents) },
      ]} /></div>
      {open && (
        <Modal open onClose={() => setOpen(null)} title={`${open.number} · ${date(open.date)}`} size="lg" footer={open.manual && !open.reversedBy && can('accounting.manage') ? <Button variant="danger" onClick={async () => { if (await confirm({ title: 'Reverse this journal?', message: 'A reversing journal is posted today.', confirmLabel: 'Reverse', danger: true })) api(`/accounting/journals/${open._id}/reverse`, { body: {} }).then(() => { setOpen(null); qc.invalidateQueries({ queryKey: ['acct-journals'] }); toast.success('Reversed'); }).catch(toast.error); }}>Reverse</Button> : undefined}>
          <p className="mb-3 text-sm">{open.memo}</p>
          <table className="min-w-full text-sm"><thead><tr><th className="th">Account</th><th className="th num">Debit</th><th className="th num">Credit</th></tr></thead>
            <tbody>{open.lines.map((l: any, i: number) => <tr key={i}><td className="td"><Link className="hover:underline" to={`/accounting/ledger/${l.accountCode}`}>{l.accountCode}</Link>{l.memo ? ` · ${l.memo}` : ''}</td><td className="td num">{l.debitCents ? money(l.debitCents) : ''}</td><td className="td num">{l.creditCents ? money(l.creditCents) : ''}</td></tr>)}</tbody></table>
        </Modal>
      )}
      {manual && <ManualJournal onClose={() => setManual(false)} onDone={() => { setManual(false); qc.invalidateQueries({ queryKey: ['acct-journals'] }); }} />}
    </div>
  );
}

function ManualJournal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const accounts = useQuery({ queryKey: ['acct-accounts'], queryFn: () => api<{ data: any[] }>('/accounting/accounts').then((r) => r.data) });
  const [f, setF] = useState<any>({ date: todayLocal(), memo: '', lines: [{ accountCode: '', debitCents: 0, creditCents: 0 }, { accountCode: '', debitCents: 0, creditCents: 0 }] });
  const [error, setError] = useState<unknown>(null);
  const dr = f.lines.reduce((s: number, l: any) => s + (l.debitCents || 0), 0);
  const cr = f.lines.reduce((s: number, l: any) => s + (l.creditCents || 0), 0);
  const setLine = (i: number, patch: any) => setF({ ...f, lines: f.lines.map((l: any, j: number) => (j === i ? { ...l, ...patch } : l)) });
  const options = (accounts.data ?? []).filter((a) => a.active).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));
  return (
    <Modal open onClose={onClose} title="Manual journal" size="xl" footer={<>
      <span className={`mr-auto text-sm ${dr === cr ? 'text-emerald-700' : 'text-red-600'}`}>Debits {money(dr)} · Credits {money(cr)}</span>
      <Button disabled={dr !== cr || dr === 0 || f.memo.length < 2} onClick={() => api('/accounting/journals', { body: { date: f.date, memo: f.memo, lines: f.lines.filter((l: any) => l.accountCode && (l.debitCents || l.creditCents)) } }).then(onDone).catch(setError)}>Post journal</Button>
    </>}>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Input value={f.memo} placeholder="Opening bank balance, depreciation, owner drawings…" onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
      </div>
      {f.lines.map((l: any, i: number) => (
        <div key={i} className="mb-2 grid grid-cols-[1fr_9rem_9rem_2rem] gap-2">
          <Select value={l.accountCode} onChange={(e) => setLine(i, { accountCode: e.target.value })} placeholder="Account…" options={options} />
          <MoneyInput placeholder="Debit" value={l.debitCents || null} onChange={(c) => setLine(i, { debitCents: c ?? 0, creditCents: 0 })} />
          <MoneyInput placeholder="Credit" value={l.creditCents || null} onChange={(c) => setLine(i, { creditCents: c ?? 0, debitCents: 0 })} />
          <Button size="sm" variant="ghost" aria-label="Remove line" disabled={f.lines.length <= 2} onClick={() => setF({ ...f, lines: f.lines.filter((_: any, j: number) => j !== i) })}><Icon name="x" className="h-4 w-4" /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setF({ ...f, lines: [...f.lines, { accountCode: '', debitCents: 0, creditCents: 0 }] })}><Icon name="plus" className="h-4 w-4" />Line</Button>
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

function CloseBooks() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['acct-settings'], queryFn: () => api<{ data: { lockDate: string | null } }>('/accounting/settings').then((r) => r.data) });
  const [lock, setLock] = useState('');
  if (!q.data) return <Loading />;
  return (
    <div className="max-w-2xl space-y-4">
      <Card title="Lock date">
        <p className="mb-3 text-sm text-ink-600 dark:text-ink-300">Once a period is reported to KRA or your accountant, lock it: manual journals dated on or before the lock date are refused. {q.data.lockDate ? <>Books are closed up to <strong>{date(q.data.lockDate)}</strong>.</> : 'No period is locked.'}</p>
        <div className="flex items-end gap-2">
          <Field label="Close up to"><Input type="date" value={lock} onChange={(e) => setLock(e.target.value)} /></Field>
          <Button disabled={!lock} onClick={() => api('/accounting/settings', { method: 'PATCH', body: { lockDate: lock } }).then(() => { toast.success('Books locked'); q.refetch(); }).catch(toast.error)}>Lock</Button>
          {q.data.lockDate && <Button variant="ghost" onClick={() => api('/accounting/settings', { method: 'PATCH', body: { lockDate: null } }).then(() => q.refetch())}>Unlock</Button>}
        </div>
      </Card>
      <Card title="Rebuild automatic journals">
        <p className="mb-3 text-sm text-ink-600 dark:text-ink-300">Deletes every automatic journal and posts them again from the documents (sales, purchases, payments, stock, expenses, payroll). Manual journals are kept. Use after correcting the chart of accounts.</p>
        <Button variant="secondary" onClick={async () => { if (await confirm({ title: 'Rebuild the ledger?', message: 'Automatic journals are recreated from the documents.', confirmLabel: 'Rebuild' })) api('/accounting/post', { body: { rebuild: true } }).then(() => { toast.success('Ledger rebuilt'); qc.invalidateQueries(); }).catch(toast.error); }}>Rebuild</Button>
      </Card>
    </div>
  );
}

export function LedgerPage() {
  const { code } = useParams();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const q = useQuery({ queryKey: ['acct-ledger', code, from, to], queryFn: () => api<any>(`/accounting/ledger/${code}`, { query: { from, to } }) });
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="max-w-5xl">
      <PageHeader title={q.data ? `${q.data.account.code} ${q.data.account.name}` : 'Ledger'} subtitle="General ledger with running balance" actions={<Button variant="secondary" onClick={() => download(`/accounting/ledger/${code}`, `ledger-${code}.csv`, { from, to, format: 'csv' })}><Icon name="download" className="h-4 w-4" />CSV</Button>} />
      <Range from={from} to={to} setFrom={setFrom} setTo={setTo}>{q.data && <ReportActions target={ref} title={`Ledger ${q.data.account.code} ${q.data.account.name}`} meta={[['Period', `${date(from)} to ${date(to)}`]]} />}</Range>
      {!q.data ? <Loading /> : <div ref={ref}>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Opening balance" value={money(q.data.openingCents)} /><Stat label="Closing balance" value={money(q.data.closingCents)} /></div>
        <div className="card"><DataTable rows={q.data.data.map((r: any, i: number) => ({ ...r, id: `${r.journalId}-${i}` }))} empty="No entries in this period" columns={[
          { key: 'd', header: 'Date', render: (r: any) => date(r.date) }, { key: 'n', header: 'Journal', render: (r: any) => r.number },
          { key: 'm', header: 'Description', render: (r: any) => r.memo }, { key: 's', header: 'Document', render: (r: any) => r.source },
          { key: 'dr', header: 'Debit', className: 'num', render: (r: any) => (r.debitCents ? money(r.debitCents) : '') },
          { key: 'cr', header: 'Credit', className: 'num', render: (r: any) => (r.creditCents ? money(r.creditCents) : '') },
          { key: 'b', header: 'Balance', className: 'num', render: (r: any) => money(r.balanceCents) },
        ]} /></div>
      </div>}
    </div>
  );
}
