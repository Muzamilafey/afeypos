import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLocations } from '../../lib/hooks';
import { date, dateTime, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, MoneyInput, Select, Stat, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

const KINDS = [
  { value: 'bank', label: 'Bank account' }, { value: 'mpesa', label: 'M-Pesa' }, { value: 'cash', label: 'Cash / safe' },
  { value: 'petty_cash', label: 'Petty cash float' }, { value: 'card', label: 'Card settlement' }, { value: 'other', label: 'Other' },
];
const MOVES = [
  { value: 'deposit', label: 'Deposit (cash banked)' }, { value: 'withdrawal', label: 'Withdrawal' }, { value: 'transfer', label: 'Transfer to another account' },
  { value: 'charge', label: 'Bank charge' }, { value: 'interest', label: 'Interest received' },
];

/** Accounts → Money accounts: where the money sits, what moved, and ticking it off against the bank statement. */
export function MoneyAccounts() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const locs = useLocations();
  const manage = can('accounting.manage');
  const accounts = useQuery({ queryKey: ['money-accounts'], queryFn: () => api<{ data: any[]; totalCents: number }>('/accounting/money-accounts') });
  const chart = useQuery({ queryKey: ['chart'], queryFn: () => api<{ data: any[] }>('/accounting/accounts').then((r) => r.data.filter((a) => a.type === 'asset')) });
  const [edit, setEdit] = useState<any>(null);
  const [move, setMove] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['money-accounts'] }); qc.invalidateQueries({ queryKey: ['bank-transactions'] }); };

  const save = async () => {
    setError(null);
    try {
      const body = { ...edit, branchId: edit.branchId || null, openingBalanceCents: edit.openingBalanceCents ?? 0 };
      if (edit._id) await api(`/accounting/money-accounts/${edit._id}`, { method: 'PATCH', body });
      else await api('/accounting/money-accounts', { body });
      setEdit(null);
      refresh();
      toast.success('Saved');
    } catch (e) { setError(e); }
  };
  const record = async () => {
    setError(null);
    try {
      await api('/accounting/bank-transactions', { body: { ...move, toAccountId: move.kind === 'transfer' ? move.toAccountId : undefined } });
      setMove(null);
      refresh();
      toast.success('Recorded');
    } catch (e) { setError(e); }
  };

  if (!accounts.data) return <Loading />;
  const rows = accounts.data.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Money the books show" value={money(accounts.data.totalCents)} hint={`${rows.filter((a) => a.active !== false).length} accounts in use`} color="teal" icon="wallet" />
        <Stat label="Not ticked off yet" value={String(rows.reduce((s, a) => s + (a.unreconciled ?? 0), 0))} hint="Movements waiting for a statement" color="yellow" icon="clipboard" />
      </div>
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 p-3 dark:border-ink-800">
          <h2 className="text-[13px] font-bold">Where the money sits</h2>
          {manage && (
            <div className="flex gap-2">
              {!rows.length && <Button size="sm" variant="secondary" onClick={() => api('/accounting/money-accounts/defaults', { body: {} }).then(() => { refresh(); toast.success('The usual accounts were added'); }).catch(toast.error)}>Add the usual accounts</Button>}
              <Button size="sm" onClick={() => { setError(null); setEdit({ name: '', kind: 'bank', accountCode: '1020', paymentMethods: [] }); }}><Icon name="plus" className="h-4 w-4" />New account</Button>
            </div>
          )}
        </div>
        <DataTable rows={rows} empty="No money accounts yet: add the usual ones to get going" columns={[
          { key: 'n', header: 'Account', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{KINDS.find((k) => k.value === r.kind)?.label}{r.bank ? ` · ${r.bank}` : ''}{r.accountNumber ? ` · ${r.accountNumber}` : ''}</div></div> },
          { key: 'c', header: 'Ledger account', render: (r: any) => r.accountCode },
          { key: 'b', header: 'Balance', className: 'num font-semibold', render: (r: any) => money(r.balanceCents) },
          { key: 'u', header: 'Not ticked off', className: 'num', render: (r: any) => (r.unreconciled ? <Badge tone="amber">{r.unreconciled}</Badge> : '—') },
          { key: 's', header: '', render: (r: any) => (r.active === false ? <Badge tone="gray">not in use</Badge> : null) },
          ...(manage ? [{ key: 'a', header: '', render: (r: any) => (
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={() => { setError(null); setMove({ accountId: r._id, kind: 'deposit', amountCents: null }); }}>Record movement</Button>
              <Button size="sm" variant="ghost" onClick={() => { setError(null); setEdit({ ...r }); }}>Edit</Button>
            </div>
          ) }] : []),
        ]} />
      </div>

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit._id ? `Edit ${edit.name}` : 'New money account'} footer={<>
          {edit._id && <Button variant="danger" onClick={async () => {
            if (!(await confirm({ title: `Remove ${edit.name}?`, message: 'Only possible while it has no movements. Otherwise make it "not in use".', confirmLabel: 'Remove', danger: true }))) return;
            api(`/accounting/money-accounts/${edit._id}`, { method: 'DELETE' }).then(() => { setEdit(null); refresh(); toast.success('Removed'); }).catch(setError);
          }}>Remove</Button>}
          <Button onClick={save}>Save</Button>
        </>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Equity current account" /></Field>
            <Field label="What it is"><Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })} options={KINDS} /></Field>
            <Field label="Bank / provider"><Input value={edit.bank ?? ''} onChange={(e) => setEdit({ ...edit, bank: e.target.value })} /></Field>
            <Field label="Account number"><Input value={edit.accountNumber ?? ''} onChange={(e) => setEdit({ ...edit, accountNumber: e.target.value })} /></Field>
            <Field label="Ledger account" hint="Where it sits in the chart of accounts">
              <Select value={edit.accountCode} onChange={(e) => setEdit({ ...edit, accountCode: e.target.value })} options={(chart.data ?? []).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
            </Field>
            <Field label="Opening balance" hint="What was in it when you started"><MoneyInput value={edit.openingBalanceCents ?? 0} onChange={(v) => setEdit({ ...edit, openingBalanceCents: v ?? 0 })} /></Field>
            {(locs.data?.branches.length ?? 0) > 1 && (
              <Field label="Branch" hint="Leave empty for the whole business">
                <Select value={edit.branchId ?? ''} onChange={(e) => setEdit({ ...edit, branchId: e.target.value })} placeholder="All branches" options={(locs.data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))} />
              </Field>
            )}
            <Field label="Notes" className="sm:col-span-2"><Input value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
            {edit._id && <div className="sm:col-span-2"><Checkbox label="In use" checked={edit.active !== false} onChange={(v) => setEdit({ ...edit, active: v })} /></div>}
          </div>
          <ErrorBox error={error} />
        </Modal>
      )}

      {move && (
        <Modal open onClose={() => setMove(null)} title="Record a movement" footer={<Button onClick={record}>Record</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What happened"><Select value={move.kind} onChange={(e) => setMove({ ...move, kind: e.target.value })} options={MOVES} /></Field>
            <Field label="Amount"><MoneyInput value={move.amountCents} onChange={(v) => setMove({ ...move, amountCents: v })} /></Field>
            {move.kind === 'transfer' && (
              <Field label="Into"><Select value={move.toAccountId ?? ''} onChange={(e) => setMove({ ...move, toAccountId: e.target.value })} placeholder="Choose an account" options={rows.filter((a) => a._id !== move.accountId && a.active !== false).map((a) => ({ value: a._id, label: a.name }))} /></Field>
            )}
            <Field label="Date"><Input type="date" value={move.date ?? new Date().toISOString().slice(0, 10)} onChange={(e) => setMove({ ...move, date: e.target.value })} /></Field>
            <Field label="Reference" hint="Deposit slip, statement line"><Input value={move.reference ?? ''} onChange={(e) => setMove({ ...move, reference: e.target.value })} /></Field>
            <Field label="Note" className="sm:col-span-2"><Input value={move.memo ?? ''} onChange={(e) => setMove({ ...move, memo: e.target.value })} /></Field>
          </div>
          <p className="mt-2 text-xs text-ink-500">The books are posted for you: a deposit moves cash from the safe into the account, a transfer moves it between accounts, and charges go to Bank charges.</p>
          <ErrorBox error={error} />
        </Modal>
      )}
    </div>
  );
}

/** Accounts → Reconciliation: tick off what the bank's statement shows until the difference is nothing. */
export function Reconciliation() {
  const { can } = useAuth();
  const toast = useToast();
  const accounts = useQuery({ queryKey: ['money-accounts'], queryFn: () => api<{ data: any[] }>('/accounting/money-accounts').then((r) => r.data) });
  const [accountId, setAccountId] = useState('');
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [statement, setStatement] = useState<number | null>(null);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const id = accountId || accounts.data?.[0]?._id || '';
  const q = useQuery({
    queryKey: ['reconciliation', id, to, statement],
    queryFn: () => api<any>('/accounting/reconciliation', { query: { accountId: id, to, ...(statement === null ? {} : { statementBalanceCents: statement }) } }),
    enabled: Boolean(id),
  });
  const tick = async (journalIds: string[], reconciled: boolean) => {
    setBusy(true);
    try {
      await api('/accounting/reconciliation', { body: { accountId: id, journalIds, reconciled, statementRef: ref || undefined } });
      await q.refetch();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  if (!accounts.data?.length) return <Card>Add a money account first (Money accounts tab).</Card>;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Account"><Select value={id} onChange={(e) => setAccountId(e.target.value)} options={accounts.data.map((a) => ({ value: a._id, label: a.name }))} /></Field>
        <Field label="Up to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Balance on the statement"><MoneyInput value={statement} onChange={setStatement} /></Field>
        <Field label="Statement reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. OCT-2026" /></Field>
      </div>
      {!d ? <Loading /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="The books say" value={money(d.summary.bookBalanceCents)} color="blue" icon="doc" />
            <Stat label="Ticked off" value={money(d.summary.reconciledBalanceCents)} color="teal" icon="check" />
            <Stat label="Still to tick off" value={money(d.summary.notReconciledCents)} color="yellow" icon="clock" />
            <Stat label="Difference to the statement" value={d.summary.differenceCents === null ? '—' : money(d.summary.differenceCents)}
              hint={d.summary.differenceCents === 0 ? 'Agrees with the bank' : 'Enter the statement balance'} tone={d.summary.differenceCents ? 'red' : 'green'} />
          </div>
          <div className="card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 p-3 dark:border-ink-800">
              <span className="text-xs text-ink-500">Everything that touched this account, newest first.</span>
              {can('accounting.manage') && (
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" loading={busy} onClick={() => tick(d.data.filter((r: any) => !r.reconciledAt).map((r: any) => r.journalId), true)}>Tick all off</Button>
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => tick(d.data.filter((r: any) => r.reconciledAt).map((r: any) => r.journalId), false)}>Untick all</Button>
                </div>
              )}
            </div>
            <DataTable rows={d.data.map((r: any) => ({ ...r, id: String(r.journalId) }))} empty="Nothing on this account yet" columns={[
              { key: 'd', header: 'Date', render: (r: any) => date(r.date) },
              { key: 'n', header: 'Entry', render: (r: any) => r.number },
              { key: 'm', header: 'What it was', render: (r: any) => <div>{r.memo}{r.source?.number && <div className="text-xs text-ink-500">{r.source.type} {r.source.number}</div>}</div> },
              { key: 'a', header: 'Amount', className: 'num', render: (r: any) => <span className={r.amountCents < 0 ? 'text-red-600' : ''}>{money(r.amountCents)}</span> },
              { key: 's', header: 'Statement', render: (r: any) => (r.reconciledAt ? <span className="text-xs text-ink-500">{r.statementRef || dateTime(r.reconciledAt)}</span> : '') },
              ...(can('accounting.manage') ? [{ key: 't', header: 'Ticked off', render: (r: any) => <Checkbox label="" checked={Boolean(r.reconciledAt)} onChange={(v) => tick([r.journalId], v)} /> }] : []),
            ]} />
          </div>
        </>
      )}
    </div>
  );
}
