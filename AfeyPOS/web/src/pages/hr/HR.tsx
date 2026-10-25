import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download, openPrintable } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useLocations } from '../../lib/hooks';
import { date, money } from '../../lib/format';
import { DataTable } from '../../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, StatusBadge, Tabs, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

const thisMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
const lastMonth = () => {
  const d = new Date(Date.now() + 3 * 3600_000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const PAY_TYPES = [{ value: 'monthly', label: 'Monthly salary' }, { value: 'daily', label: 'Daily rate' }, { value: 'hourly', label: 'Hourly rate' }];
const PAY_METHODS = [{ value: 'mpesa', label: 'M-Pesa' }, { value: 'bank', label: 'Bank' }, { value: 'cash', label: 'Cash' }];

// ---------------- employees ----------------

export function EmployeesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const list = useList(['employees'], '/hr/employees', { q: q || undefined, status: status || undefined, limit: 100 });
  const [edit, setEdit] = useState<any>(null);
  return (
    <div>
      <PageHeader title="Employees" subtitle="Payroll details, leave and advances" actions={<>
        <Button variant="secondary" onClick={() => api<{ count: number }>('/hr/employees/import-users', { body: {} }).then((r) => { toast.success(`${r.count} staff logins added as employees`); qc.invalidateQueries({ queryKey: ['employees'] }); }).catch(toast.error)}>Add staff logins</Button>
        <Button onClick={() => setEdit({ name: '', payType: 'monthly', payMethod: 'mpesa', employmentType: 'permanent', rateCents: 0, allowances: [], deductions: [], annualLeaveDays: 21 })}><Icon name="plus" className="h-4 w-4" />Add employee</Button>
      </>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search name, number, ID or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }, { value: 'terminated', label: 'Left' }, { value: '', label: 'All' }]} />
      </div>
      <div className="card"><DataTable rows={list.data?.data} loading={list.isLoading} empty="No employees yet" onRowClick={(r: any) => nav(`/hr/employees/${r._id}`)} columns={[
        { key: 'no', header: 'No.', render: (r: any) => r.employeeNo },
        { key: 'n', header: 'Name', render: (r: any) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-ink-500">{r.jobTitle}</div></div> },
        { key: 't', header: 'Type', render: (r: any) => r.employmentType },
        { key: 'p', header: 'Pay', className: 'num', render: (r: any) => (r.rateCents ? `${money(r.rateCents)}${r.payType === 'monthly' ? '' : r.payType === 'daily' ? ' / day' : ' / hour'}` : <Badge tone="amber">not set</Badge>) },
        { key: 'm', header: 'Paid by', render: (r: any) => r.payMethod },
        { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
      ]} /></div>
      {edit && <EmployeeEditor employee={edit} onClose={() => setEdit(null)} onSaved={(e) => { setEdit(null); qc.invalidateQueries({ queryKey: ['employees'] }); nav(`/hr/employees/${e._id}`); }} />}
    </div>
  );
}

function ItemsEditor({ label, items, onChange, taxable }: { label: string; items: any[]; onChange: (v: any[]) => void; taxable?: boolean }) {
  return (
    <div className="sm:col-span-2">
      <div className="label">{label}</div>
      {items.map((it, i) => (
        <div key={i} className="mb-2 flex flex-wrap items-center gap-2">
          <Input className="w-48" placeholder="Name" value={it.name} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <MoneyInput className="w-36" value={it.amountCents} onChange={(c) => onChange(items.map((x, j) => (j === i ? { ...x, amountCents: c ?? 0 } : x)))} />
          {taxable && <Checkbox label="Taxable" checked={it.taxable !== false} onChange={(v) => onChange(items.map((x, j) => (j === i ? { ...x, taxable: v } : x)))} />}
          <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...items, { name: '', amountCents: 0, ...(taxable ? { taxable: true } : {}) }])}><Icon name="plus" className="h-4 w-4" />Add</Button>
    </div>
  );
}

function EmployeeEditor({ employee, onClose, onSaved }: { employee: any; onClose: () => void; onSaved: (e: any) => void }) {
  const locs = useLocations();
  const [f, setF] = useState<any>({ ...employee, startDate: employee.startDate?.slice(0, 10) ?? '' });
  const [error, setError] = useState<unknown>(null);
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const save = async () => {
    setError(null);
    try {
      const body: any = {
        name: f.name, employeeNo: f.employeeNo || undefined, idNumber: f.idNumber || undefined, kraPin: f.kraPin ?? '', nssfNo: f.nssfNo || undefined, shifNo: f.shifNo || undefined,
        phone: f.phone || undefined, email: f.email ?? '', branchId: f.branchId || null, department: f.department || undefined, jobTitle: f.jobTitle || undefined,
        employmentType: f.employmentType, payType: f.payType, rateCents: f.rateCents ?? 0, allowances: f.allowances.filter((a: any) => a.name), deductions: f.deductions.filter((a: any) => a.name),
        pensionCents: f.pensionCents ?? 0, payMethod: f.payMethod, mpesaPhone: f.mpesaPhone || undefined, bank: f.bank, startDate: f.startDate || undefined, status: f.status ?? 'active',
        annualLeaveDays: Number(f.annualLeaveDays ?? 21), leaveOpeningDays: Number(f.leaveOpeningDays ?? 0),
      };
      if (!employee._id) delete body.status;
      const r = employee._id ? await api<{ data: any }>(`/hr/employees/${employee._id}`, { method: 'PATCH', body }) : await api<{ data: any }>('/hr/employees', { body });
      onSaved(r.data);
    } catch (e) {
      setError(e);
    }
  };
  const rateLabel = f.payType === 'monthly' ? 'Basic salary per month' : f.payType === 'daily' ? 'Rate per day' : 'Rate per hour';
  return (
    <Modal open onClose={onClose} title={employee._id ? `Edit ${employee.name}` : 'Add employee'} size="xl" footer={<Button onClick={save}>Save</Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Full name"><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Employee number" hint={employee._id ? undefined : 'Empty: next EMP- number'}><Input value={f.employeeNo ?? ''} onChange={(e) => set('employeeNo', e.target.value)} /></Field>
        <Field label="Job title"><Input value={f.jobTitle ?? ''} onChange={(e) => set('jobTitle', e.target.value)} /></Field>
        <Field label="National ID"><Input value={f.idNumber ?? ''} onChange={(e) => set('idNumber', e.target.value)} /></Field>
        <Field label="KRA PIN"><Input value={f.kraPin ?? ''} placeholder="A123456789B" onChange={(e) => set('kraPin', e.target.value.toUpperCase())} /></Field>
        <Field label="Phone"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="NSSF number"><Input value={f.nssfNo ?? ''} onChange={(e) => set('nssfNo', e.target.value)} /></Field>
        <Field label="SHA / SHIF number"><Input value={f.shifNo ?? ''} onChange={(e) => set('shifNo', e.target.value)} /></Field>
        <Field label="Email"><Input value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Branch"><Select value={f.branchId ?? ''} onChange={(e) => set('branchId', e.target.value)} placeholder="Head office / all" options={(locs.data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>
        <Field label="Department"><Input value={f.department ?? ''} onChange={(e) => set('department', e.target.value)} /></Field>
        <Field label="Start date"><Input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="Employment"><Select value={f.employmentType} onChange={(e) => set('employmentType', e.target.value)} options={[{ value: 'permanent', label: 'Permanent' }, { value: 'contract', label: 'Contract' }, { value: 'casual', label: 'Casual' }]} /></Field>
        <Field label="Paid"><Select value={f.payType} onChange={(e) => set('payType', e.target.value)} options={PAY_TYPES} /></Field>
        <Field label={rateLabel}><MoneyInput value={f.rateCents} onChange={(c) => set('rateCents', c ?? 0)} /></Field>
        <Field label="Pay salary by"><Select value={f.payMethod} onChange={(e) => set('payMethod', e.target.value)} options={PAY_METHODS} /></Field>
        {f.payMethod === 'mpesa' && <Field label="M-Pesa number"><Input value={f.mpesaPhone ?? ''} placeholder={f.phone || '07XX XXX XXX'} onChange={(e) => set('mpesaPhone', e.target.value)} /></Field>}
        {f.payMethod === 'bank' && <>
          <Field label="Bank"><Input value={f.bank?.name ?? ''} onChange={(e) => set('bank', { ...f.bank, name: e.target.value })} /></Field>
          <Field label="Account number"><Input value={f.bank?.accountNo ?? ''} onChange={(e) => set('bank', { ...f.bank, accountNo: e.target.value })} /></Field>
        </>}
        <Field label="Pension (extra, per month)"><MoneyInput value={f.pensionCents ?? 0} onChange={(c) => set('pensionCents', c ?? 0)} /></Field>
        <Field label="Annual leave days"><Input type="number" value={f.annualLeaveDays ?? 21} onChange={(e) => set('annualLeaveDays', e.target.value)} /></Field>
        <Field label="Leave days brought forward"><Input type="number" value={f.leaveOpeningDays ?? 0} onChange={(e) => set('leaveOpeningDays', e.target.value)} /></Field>
        {employee._id && <Field label="Status"><Select value={f.status} onChange={(e) => set('status', e.target.value)} options={[{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }, { value: 'terminated', label: 'Left the business' }]} /></Field>}
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ItemsEditor label="Monthly allowances" items={f.allowances} onChange={(v) => set('allowances', v)} taxable />
        <ItemsEditor label="Monthly deductions after tax (SACCO, welfare, loans)" items={f.deductions} onChange={(v) => set('deductions', v)} />
      </div>
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

export function EmployeeDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['employee', id], queryFn: () => api<{ data: any }>(`/hr/employees/${id}`).then((r) => r.data) });
  const [edit, setEdit] = useState(false);
  const [leave, setLeave] = useState(false);
  const [advance, setAdvance] = useState(false);
  if (!q.data) return <Loading />;
  const e = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['employee', id] });
  return (
    <div className="max-w-5xl">
      <PageHeader title={e.name} subtitle={`${e.employeeNo}${e.jobTitle ? ` · ${e.jobTitle}` : ''}`} actions={<>
        <Button variant="secondary" onClick={() => setLeave(true)}>Record leave</Button>
        <Button variant="secondary" onClick={() => setAdvance(true)}>Salary advance</Button>
        <Button onClick={() => setEdit(true)}>Edit</Button>
      </>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={e.payType === 'monthly' ? 'Basic salary' : e.payType === 'daily' ? 'Daily rate' : 'Hourly rate'} value={money(e.rateCents)} hint={`Paid by ${e.payMethod}`} />
        <Stat label="Annual leave available" value={`${e.leave.available} days`} hint={`${e.leave.accrued} accrued · ${e.leave.taken} taken${e.leave.pending ? ` · ${e.leave.pending} pending` : ''}`} />
        <Stat label="This month on site" value={`${e.attendance.days} days`} hint={`${e.attendance.hours} hours${e.attendance.clockedIn ? ' · clocked in now' : ''}`} />
        <Stat label="Advances outstanding" value={money(e.advances.filter((a: any) => a.status === 'paid').reduce((s: number, a: any) => s + a.amountCents - a.recoveredCents, 0))} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {[['KRA PIN', e.kraPin], ['National ID', e.idNumber], ['NSSF', e.nssfNo], ['SHA / SHIF', e.shifNo], ['Phone', e.phone], ['M-Pesa', e.mpesaPhone], ['Started', date(e.startDate)], ['Employment', e.employmentType]].map(([k, v]) => <div key={k}><dt className="text-ink-500">{k}</dt><dd>{v || '—'}</dd></div>)}
          </dl>
          {!e.kraPin && <p className="mt-2 text-xs text-amber-700">Add the KRA PIN before filing PAYE.</p>}
        </Card>
        <Card title="Payslips">
          <DataTable rows={e.payslips.map((p: any) => ({ ...p, _id: p.runId }))} empty="No payslips yet" columns={[
            { key: 'p', header: 'Month', render: (p: any) => <Link className="underline" to={`/hr/payroll/${p.runId}`}>{p.period}</Link> },
            { key: 'g', header: 'Gross', className: 'num', render: (p: any) => money(p.grossCents) },
            { key: 'n', header: 'Net', className: 'num', render: (p: any) => money(p.netCents) },
            { key: 'x', header: '', render: (p: any) => <Button size="sm" variant="secondary" onClick={() => openPrintable(`/hr/payroll/${p.runId}/payslips?lineId=${p.lineId}`)}><Icon name="printer" className="h-4 w-4" /></Button> },
          ]} />
        </Card>
        <Card title="Leave">
          <DataTable rows={e.leaveRequests} empty="No leave recorded" columns={[
            { key: 't', header: 'Type', render: (l: any) => l.type }, { key: 'd', header: 'Dates', render: (l: any) => `${date(l.from)} – ${date(l.to)}` },
            { key: 'n', header: 'Days', className: 'num', render: (l: any) => l.days }, { key: 's', header: 'Status', render: (l: any) => <StatusBadge status={l.status} /> },
          ]} />
        </Card>
        <Card title="Salary advances">
          <DataTable rows={e.advances} empty="No advances" columns={[
            { key: 'n', header: 'No.', render: (a: any) => a.number }, { key: 'a', header: 'Amount', className: 'num', render: (a: any) => money(a.amountCents) },
            { key: 'r', header: 'Recovered', className: 'num', render: (a: any) => money(a.recoveredCents) }, { key: 's', header: 'Status', render: (a: any) => <StatusBadge status={a.status} /> },
          ]} />
        </Card>
      </div>
      {edit && <EmployeeEditor employee={e} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); refresh(); }} />}
      {leave && <LeaveModal employeeId={e._id} onClose={() => setLeave(false)} onDone={() => { setLeave(false); refresh(); }} />}
      {advance && <AdvanceModal employee={e} onClose={() => setAdvance(false)} onDone={() => { setAdvance(false); refresh(); }} />}
    </div>
  );
}

function LeaveModal({ employeeId, onClose, onDone }: { employeeId?: string; onClose: () => void; onDone: () => void }) {
  const employees = useList(['employees', 'pick'], '/hr/employees', { status: 'active', limit: 500 }, !employeeId);
  const [f, setF] = useState<any>({ employeeId, type: 'annual', from: '', to: '', reason: '' });
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal open onClose={onClose} title="Record leave" footer={<Button disabled={!f.employeeId || !f.from || !f.to} onClick={() => api('/hr/leave', { body: { ...f, reason: f.reason || undefined, days: f.days ? Number(f.days) : undefined } }).then(onDone).catch(setError)}>Save</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!employeeId && <Field label="Employee" className="sm:col-span-2"><Select value={f.employeeId ?? ''} onChange={(e) => setF({ ...f, employeeId: e.target.value })} placeholder="Choose…" options={(employees.data?.data ?? []).map((x: any) => ({ value: x._id, label: `${x.name} (${x.employeeNo})` }))} /></Field>}
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'unpaid'].map((x) => ({ value: x, label: x }))} /></Field>
        <Field label="Days" hint="Empty: counted Monday to Saturday"><Input type="number" value={f.days ?? ''} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
        <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Reason" className="sm:col-span-2"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

function AdvanceModal({ employee, onClose, onDone }: { employee?: any; onClose: () => void; onDone: () => void }) {
  const employees = useList(['employees', 'pick'], '/hr/employees', { status: 'active', limit: 500 }, !employee);
  const [f, setF] = useState<any>({ employeeId: employee?._id, amountCents: 0, installmentCents: 0, payMethod: employee?.payMethod === 'mpesa' ? 'mpesa' : 'cash', reason: '' });
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal open onClose={onClose} title="Salary advance" footer={<Button disabled={!f.employeeId || !f.amountCents} onClick={() => api('/hr/advances', { body: { ...f, installmentCents: f.installmentCents || undefined, reason: f.reason || undefined } }).then(onDone).catch(setError)}>Request</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!employee && <Field label="Employee" className="sm:col-span-2"><Select value={f.employeeId ?? ''} onChange={(e) => setF({ ...f, employeeId: e.target.value })} placeholder="Choose…" options={(employees.data?.data ?? []).map((x: any) => ({ value: x._id, label: `${x.name} (${x.employeeNo})` }))} /></Field>}
        <Field label="Amount"><MoneyInput value={f.amountCents} onChange={(c) => setF({ ...f, amountCents: c ?? 0 })} /></Field>
        <Field label="Recover per month" hint="Empty: all next payroll"><MoneyInput value={f.installmentCents || null} onChange={(c) => setF({ ...f, installmentCents: c ?? 0 })} /></Field>
        <Field label="Pay by"><Select value={f.payMethod} onChange={(e) => setF({ ...f, payMethod: e.target.value })} options={PAY_METHODS} /></Field>
        <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
      <p className="mt-2 text-xs text-ink-500">Another person with payroll approval approves the advance before it is paid.</p>
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}

// ---------------- leave & advances ----------------

export function LeavePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [tab, setTab] = useState('leave');
  const [status, setStatus] = useState('pending');
  const leave = useList(['hr-leave'], '/hr/leave', { status: status || undefined });
  const advances = useList(['hr-advances'], '/hr/advances', {});
  const [modal, setModal] = useState<'leave' | 'advance' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['hr-leave'] }).then(() => qc.invalidateQueries({ queryKey: ['hr-advances'] }));
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast.success(msg); refresh(); }).catch(toast.error);
  return (
    <div>
      <PageHeader title="Leave & advances" actions={<><Button variant="secondary" onClick={() => setModal('advance')}>Salary advance</Button><Button onClick={() => setModal('leave')}>Record leave</Button></>} />
      <Tabs tabs={[{ key: 'leave', label: 'Leave' }, { key: 'advances', label: 'Salary advances' }]} value={tab} onChange={setTab} />
      {tab === 'leave' && <>
        <Select className="mb-3 max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'pending', label: 'Waiting for approval' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: '', label: 'All' }]} />
        <div className="card"><DataTable rows={leave.data?.data} loading={leave.isLoading} empty="No leave" columns={[
          { key: 'e', header: 'Employee', render: (l: any) => <Link className="underline" to={`/hr/employees/${l.employeeId}`}>{l.employee?.name}</Link> },
          { key: 't', header: 'Type', render: (l: any) => l.type }, { key: 'd', header: 'Dates', render: (l: any) => `${date(l.from)} – ${date(l.to)}` },
          { key: 'n', header: 'Days', className: 'num', render: (l: any) => l.days }, { key: 'r', header: 'Reason', render: (l: any) => l.reason ?? '' },
          { key: 's', header: 'Status', render: (l: any) => <StatusBadge status={l.status} /> },
          { key: 'a', header: '', render: (l: any) => l.status === 'pending' && <div className="flex gap-1"><Button size="sm" onClick={() => act(api(`/hr/leave/${l._id}/decide`, { body: { approve: true } }), 'Leave approved')}>Approve</Button><Button size="sm" variant="secondary" onClick={() => act(api(`/hr/leave/${l._id}/decide`, { body: { approve: false } }), 'Leave rejected')}>Reject</Button></div> },
        ]} /></div>
      </>}
      {tab === 'advances' && <div className="card"><DataTable rows={advances.data?.data} loading={advances.isLoading} empty="No advances" columns={[
        { key: 'no', header: 'No.', render: (a: any) => a.number },
        { key: 'e', header: 'Employee', render: (a: any) => a.employee?.name }, { key: 'a', header: 'Amount', className: 'num', render: (a: any) => money(a.amountCents) },
        { key: 'i', header: 'Per month', className: 'num', render: (a: any) => money(a.installmentCents) }, { key: 'o', header: 'Outstanding', className: 'num', render: (a: any) => money(a.outstandingCents) },
        { key: 'm', header: 'Pay by', render: (a: any) => a.payMethod }, { key: 's', header: 'Status', render: (a: any) => <StatusBadge status={a.status} /> },
        { key: 'x', header: '', render: (a: any) => <div className="flex gap-1">
          {a.status === 'requested' && can('payroll.approve') && <><Button size="sm" onClick={() => act(api(`/hr/advances/${a._id}/approve`, { body: { approve: true } }), 'Advance approved')}>Approve</Button><Button size="sm" variant="secondary" onClick={() => act(api(`/hr/advances/${a._id}/approve`, { body: { approve: false } }), 'Advance rejected')}>Reject</Button></>}
          {a.status === 'approved' && !a.payoutId && can('payroll.manage') && <Button size="sm" onClick={() => act(api(`/hr/advances/${a._id}/pay`, { body: {} }), a.payMethod === 'mpesa' ? 'M-Pesa payout created: approve and send it under M-Pesa → Payouts' : 'Advance recorded as paid')}>Pay</Button>}
          {a.payoutId && a.status === 'approved' && <Badge tone="blue">M-Pesa payout pending</Badge>}
        </div> },
      ]} /></div>}
      {modal === 'leave' && <LeaveModal onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal === 'advance' && <AdvanceModal onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
    </div>
  );
}

// ---------------- attendance ----------------

export function AttendancePage() {
  const [period, setPeriod] = useState(thisMonth());
  const q = useQuery({ queryKey: ['hr-attendance', period], queryFn: () => api<{ data: any[] }>('/hr/attendance', { query: { period } }).then((r) => r.data) });
  return (
    <div>
      <PageHeader title="Attendance" subtitle="From clock in / out with staff cards and fingerprints" actions={<Button variant="secondary" onClick={() => download('/hr/attendance', `attendance-${period}.csv`, { period, format: 'csv' })}><Icon name="download" className="h-4 w-4" />CSV</Button>} />
      <Field label="Month" className="mb-3 max-w-xs"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
      <div className="card"><DataTable rows={(q.data ?? []).map((r) => ({ ...r, id: r.employeeNo }))} loading={q.isLoading} empty="Only employees linked to a staff login have attendance" columns={[
        { key: 'no', header: 'No.', render: (r: any) => r.employeeNo }, { key: 'n', header: 'Name', render: (r: any) => r.name },
        { key: 'd', header: 'Days present', className: 'num', render: (r: any) => r.daysPresent }, { key: 'h', header: 'Hours', className: 'num', render: (r: any) => r.hoursWorked },
        { key: 'c', header: 'Now', render: (r: any) => (r.clockedInNow ? <Badge tone="green">clocked in</Badge> : '') },
      ]} /></div>
    </div>
  );
}

// ---------------- payroll ----------------

export function PayrollPage() {
  const nav = useNavigate();
  const locs = useLocations();
  const list = useQuery({ queryKey: ['payroll'], queryFn: () => api<{ data: any[] }>('/hr/payroll').then((r) => r.data) });
  const [create, setCreate] = useState<{ period: string; branchId: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <PageHeader title="Payroll" subtitle="PAYE, SHIF, NSSF and Housing Levy are calculated for you" actions={<Button onClick={() => setCreate({ period: lastMonth(), branchId: '' })}><Icon name="plus" className="h-4 w-4" />Run payroll</Button>} />
      <div className="card"><DataTable rows={list.data} loading={list.isLoading} empty="No payroll yet" onRowClick={(r: any) => nav(`/hr/payroll/${r._id}`)} columns={[
        { key: 'n', header: 'Payroll', render: (r: any) => r.number }, { key: 'p', header: 'Month', render: (r: any) => r.period },
        { key: 'b', header: 'Branch', render: (r: any) => locs.data?.branches.find((b) => b._id === r.branchId)?.name ?? 'All' },
        { key: 'e', header: 'Staff', className: 'num', render: (r: any) => r.totals?.employees }, { key: 'g', header: 'Gross', className: 'num', render: (r: any) => money(r.totals?.grossCents) },
        { key: 'net', header: 'Net pay', className: 'num', render: (r: any) => money(r.totals?.netCents) }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
      ]} /></div>
      {create && (
        <Modal open onClose={() => setCreate(null)} title="Run payroll" footer={<Button onClick={() => api<{ data: any }>('/hr/payroll', { body: { period: create.period, branchId: create.branchId || undefined } }).then((r) => nav(`/hr/payroll/${r.data._id}`)).catch(setError)}>Calculate</Button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Month"><Input type="month" value={create.period} onChange={(e) => setCreate({ ...create, period: e.target.value })} /></Field>
            {(locs.data?.branches.length ?? 0) > 1 && <Field label="Branch"><Select value={create.branchId} onChange={(e) => setCreate({ ...create, branchId: e.target.value })} placeholder="All employees" options={(locs.data?.branches ?? []).map((b) => ({ value: b._id, label: b.name }))} /></Field>}
          </div>
          <p className="mt-2 text-xs text-ink-500">Daily and hourly staff are paid for the days and hours they clocked in; you can adjust each payslip before approval.</p>
          <div className="mt-3"><ErrorBox error={error} /></div>
        </Modal>
      )}
    </div>
  );
}

export function PayrollRunPage() {
  const { id } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { can, has } = useAuth();
  const q = useQuery({ queryKey: ['payroll', id], queryFn: () => api<{ data: any }>(`/hr/payroll/${id}`).then((r) => r.data) });
  const [line, setLine] = useState<any>(null);
  if (!q.data) return <Loading />;
  const run = q.data;
  const t = run.totals ?? {};
  const refresh = () => qc.invalidateQueries({ queryKey: ['payroll'] });
  const act = (p: Promise<any>, msg: string | ((r: any) => string)) => p.then((r) => { toast.success(typeof msg === 'string' ? msg : msg(r)); refresh(); }).catch(toast.error);
  const payoutStatus = (pid: string) => run.payouts?.find((p: any) => p._id === pid)?.status;
  return (
    <div>
      <PageHeader title={`Payroll ${run.period}`} subtitle={`${run.number} · prepared by ${run.preparedByName ?? '—'}${run.approvedByName ? ` · approved by ${run.approvedByName}` : ''}`} actions={<>
        <Button variant="secondary" onClick={() => openPrintable(`/hr/payroll/${run._id}/payslips`)}><Icon name="printer" className="h-4 w-4" />Payslips</Button>
        <Button variant="secondary" onClick={() => download(`/hr/payroll/${run._id}/statutory`, `statutory-${run.period}.csv`, { format: 'csv' })}><Icon name="download" className="h-4 w-4" />PAYE / SHIF / NSSF</Button>
        {run.lines.some((l: any) => l.payMethod === 'bank') && <Button variant="secondary" onClick={() => download(`/hr/payroll/${run._id}/bank-file`, `bank-${run.period}.csv`)}>Bank file</Button>}
        {run.status === 'draft' && <Button variant="secondary" onClick={() => act(api(`/hr/payroll/${run._id}/recalculate`, { body: {} }), 'Recalculated')}>Recalculate</Button>}
        {run.status === 'draft' && can('payroll.approve') && <Button onClick={async () => { if (await confirm({ title: 'Approve payroll?', message: `Net pay ${money(t.netCents)} for ${t.employees} employees. Advance recoveries are booked.`, confirmLabel: 'Approve' })) act(api(`/hr/payroll/${run._id}/approve`, { body: {} }), 'Payroll approved'); }}>Approve</Button>}
        {run.status === 'approved' && has('mpesa') && run.lines.some((l: any) => l.payMethod === 'mpesa' && !l.payoutId) && <Button onClick={() => act(api(`/hr/payroll/${run._id}/mpesa-payouts`, { body: {} }), (r) => `${r.data.created} M-Pesa payouts created; approve and send them under M-Pesa → Payouts${r.data.skipped.length ? ` (${r.data.skipped.join('; ')})` : ''}`)}>Pay by M-Pesa</Button>}
        {run.status === 'approved' && <Button variant="secondary" onClick={() => act(api(`/hr/payroll/${run._id}/mark-paid`, { body: {} }), 'Bank and cash salaries recorded as paid')}>Mark bank / cash paid</Button>}
        {['draft', 'approved'].includes(run.status) && can('payroll.approve') && <Button variant="ghost" onClick={async () => { if (await confirm({ title: 'Cancel this payroll?', message: 'Recovered advances are given back.', confirmLabel: 'Cancel payroll', danger: true })) act(api(`/hr/payroll/${run._id}/cancel`, { body: {} }), 'Payroll cancelled'); }}>Cancel</Button>}
      </>} />
      <div className="mb-4 flex items-center gap-2"><StatusBadge status={run.status} /><span className="text-xs text-ink-500">{run.rules}</span></div>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-5">
        <Stat label="Gross pay" value={money(t.grossCents)} hint={`${t.employees} employees`} />
        <Stat label="Net pay" value={money(t.netCents)} />
        <Stat label="PAYE" value={money(t.payeCents)} hint="File on iTax by the 9th" />
        <Stat label="NSSF + SHIF + levy" value={money((t.nssfCents ?? 0) + (t.nssfEmployerCents ?? 0) + (t.shifCents ?? 0) + (t.ahlCents ?? 0) + (t.ahlEmployerCents ?? 0))} hint="Employee and employer shares" />
        <Stat label="Total employer cost" value={money(t.employerCostCents)} />
      </div>
      <div className="card"><DataTable rows={run.lines} onRowClick={run.status === 'draft' ? (l: any) => setLine(l) : undefined} columns={[
        { key: 'n', header: 'Employee', render: (l: any) => <div><div className="font-medium">{l.name}</div><div className="text-xs text-ink-500">{l.employeeNo}{l.payType !== 'monthly' ? ` · ${l.payType === 'daily' ? `${l.daysWorked ?? 0} days` : `${l.hoursWorked ?? 0} h`}` : ''}</div></div> },
        { key: 'g', header: 'Gross', className: 'num', render: (l: any) => money(l.grossCents) },
        { key: 'ns', header: 'NSSF', className: 'num', render: (l: any) => money(l.nssfCents) },
        { key: 'sh', header: 'SHIF', className: 'num', render: (l: any) => money(l.shifCents) },
        { key: 'ah', header: 'Levy', className: 'num', render: (l: any) => money(l.ahlCents) },
        { key: 'pa', header: 'PAYE', className: 'num', render: (l: any) => money(l.payeCents) },
        { key: 'o', header: 'Other', className: 'num', render: (l: any) => money((l.deductions ?? []).reduce((s: number, d: any) => s + d.amountCents, 0) + (l.advanceRecoveryCents ?? 0)) },
        { key: 'net', header: 'Net pay', className: 'num font-semibold', render: (l: any) => money(l.netCents) },
        { key: 'm', header: 'Paid', render: (l: any) => (l.paid ? <Badge tone="green">paid</Badge> : l.payoutId ? <Badge tone="blue">M-Pesa {payoutStatus(l.payoutId) ?? ''}</Badge> : l.payMethod) },
        { key: 'x', header: '', render: (l: any) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); openPrintable(`/hr/payroll/${run._id}/payslips?lineId=${l._id}`); }}><Icon name="printer" className="h-4 w-4" /></Button> },
      ]} /></div>
      {run.status === 'draft' && <p className="mt-2 text-xs text-ink-500">Click an employee to enter days, hours, overtime, a bonus or one-off items.</p>}
      {line && <LineEditor runId={run._id} line={line} onClose={() => setLine(null)} onSaved={() => { setLine(null); refresh(); }} />}
    </div>
  );
}

function LineEditor({ runId, line, onClose, onSaved }: { runId: string; line: any; onClose: () => void; onSaved: () => void }) {
  const input = line.input ?? {};
  const [f, setF] = useState<any>({ daysWorked: input.daysWorked ?? line.daysWorked ?? '', hoursWorked: input.hoursWorked ?? line.hoursWorked ?? '', overtimeCents: input.overtimeCents ?? 0, bonusCents: input.bonusCents ?? 0, extraAllowances: input.extraAllowances ?? [], extraDeductions: input.extraDeductions ?? [], holdAdvance: Boolean(input.holdAdvance) });
  const [error, setError] = useState<unknown>(null);
  const save = () => api(`/hr/payroll/${runId}/lines/${line._id}`, { method: 'PATCH', body: {
    ...(line.payType === 'daily' && f.daysWorked !== '' ? { daysWorked: Number(f.daysWorked) } : {}), ...(line.payType === 'hourly' && f.hoursWorked !== '' ? { hoursWorked: Number(f.hoursWorked) } : {}),
    overtimeCents: f.overtimeCents, bonusCents: f.bonusCents, extraAllowances: f.extraAllowances.filter((x: any) => x.name), extraDeductions: f.extraDeductions.filter((x: any) => x.name), holdAdvance: f.holdAdvance,
  } }).then(onSaved).catch(setError);
  return (
    <Modal open onClose={onClose} title={`${line.name}: ${money(line.netCents)} net`} size="lg" footer={<Button onClick={save}>Recalculate payslip</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {line.payType === 'daily' && <Field label="Days worked"><Input type="number" value={f.daysWorked} onChange={(e) => setF({ ...f, daysWorked: e.target.value })} /></Field>}
        {line.payType === 'hourly' && <Field label="Hours worked"><Input type="number" value={f.hoursWorked} onChange={(e) => setF({ ...f, hoursWorked: e.target.value })} /></Field>}
        <Field label="Overtime"><MoneyInput value={f.overtimeCents} onChange={(c) => setF({ ...f, overtimeCents: c ?? 0 })} /></Field>
        <Field label="Bonus"><MoneyInput value={f.bonusCents} onChange={(c) => setF({ ...f, bonusCents: c ?? 0 })} /></Field>
        <ItemsEditor label="One-off allowances this month" items={f.extraAllowances} onChange={(v) => setF({ ...f, extraAllowances: v })} taxable />
        <ItemsEditor label="One-off deductions this month" items={f.extraDeductions} onChange={(v) => setF({ ...f, extraDeductions: v })} />
        {line.advanceRecoveryCents > 0 || f.holdAdvance ? <Checkbox label="Skip salary advance recovery this month" checked={f.holdAdvance} onChange={(v) => setF({ ...f, holdAdvance: v })} /> : null}
      </div>
      <div className="mt-3"><ErrorBox error={error} /></div>
    </Modal>
  );
}
