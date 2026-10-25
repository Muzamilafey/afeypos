import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS } from '@afeypos/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { bridge, bridgeConfigured } from '../../lib/bridge';
import { code128Svg } from '../../components/barcode';
import { Badge, Button, ErrorBox, Field, Input, Select, useConfirm, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

interface CardData { code: string; employeeNo?: string; name: string; jobTitle?: string; roles: string[]; issuedAt: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Prints a CR80 (85.6 × 54 mm) staff ID card with a Code 128 barcode, for a card printer or A4 cut-out. */
export function printStaffCard(card: CardData, business: string) {
  const role = card.jobTitle || card.roles.map((r) => ROLE_LABELS[r as keyof typeof ROLE_LABELS] ?? r).join(', ');
  const w = window.open('', '_blank', 'width=520,height=420');
  if (!w) throw new Error('Allow pop-ups to print the card');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(card.name)} staff card</title><style>
  @page { size: 85.6mm 54mm; margin: 0; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .card { box-sizing: border-box; width: 85.6mm; height: 54mm; padding: 4mm 5mm; display: flex; flex-direction: column; justify-content: space-between; border-radius: 3mm; border: 0.3mm solid #ccc; background: #fff; color: #111; }
  .top { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 0.6mm solid #0f766e; padding-bottom: 1.5mm; }
  .biz { font-weight: 700; font-size: 3.6mm; color: #0f766e; } .tag { font-size: 2.4mm; text-transform: uppercase; letter-spacing: .3mm; color: #555; }
  .name { font-size: 5mm; font-weight: 700; margin-top: 2mm; } .role { font-size: 3mm; color: #333; } .no { font-size: 2.8mm; color: #555; margin-top: .5mm; }
  .bc { text-align: center; } .bc svg { width: 70mm; height: 11mm; } .code { font: 2.4mm ui-monospace, Menlo, monospace; letter-spacing: .4mm; }
  @media screen { body { background: #eee; padding: 10mm; } }
  </style></head><body><div class="card">
  <div class="top"><span class="biz">${esc(business)}</span><span class="tag">Staff</span></div>
  <div><div class="name">${esc(card.name)}</div><div class="role">${esc(role)}</div>${card.employeeNo ? `<div class="no">${esc(card.employeeNo)}</div>` : ''}</div>
  <div class="bc">${code128Svg(card.code, 40, 2)}<div class="code">${esc(card.code)}</div></div>
  </div><script>window.onload = () => window.print();</script></body></html>`);
  w.document.close();
}

const FINGERS = ['right_index', 'right_thumb', 'right_middle', 'left_index', 'left_thumb', 'left_middle'].map((f) => ({ value: f, label: f.replace('_', ' ') }));

/** Card, PIN and fingerprint for one employee, shown in the user editor. */
export function StaffAccessPanel({ user, onChanged }: { user: any; onChanged: () => void }) {
  const { me, has, can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [finger, setFinger] = useState('right_index');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(null);
  const biometrics = has('biometrics') && can('biometrics.enroll');
  const enrolled = useQuery({ queryKey: ['bio-enrolled'], queryFn: () => api<{ data: { userId: string; fingers: string[] }[] }>('/biometrics/enrolled').then((r) => r.data), enabled: biometrics });
  const fingers = enrolled.data?.find((x) => x.userId === user._id)?.fingers ?? [];

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy('');
    }
  };
  const business = me?.tenant.name ?? '';
  const issue = () => act('issue', async () => {
    if (user.card && !(await confirm({ title: 'Issue a new card?', message: 'The old card stops working immediately.', confirmLabel: 'Issue new card' }))) return;
    const r = await api<{ data: CardData }>(`/settings/users/${user._id}/card`, { body: {} });
    toast.success(`Card issued (…${r.data.code.slice(-4)})`);
    onChanged();
    printStaffCard(r.data, business);
  });
  const reprint = () => act('print', async () => printStaffCard((await api<{ data: CardData }>(`/settings/users/${user._id}/card`)).data, business));
  const revoke = () => act('revoke', async () => {
    if (!(await confirm({ title: 'Revoke this card?', message: 'It will no longer sign in, approve or clock in.', confirmLabel: 'Revoke', danger: true }))) return;
    await api(`/settings/users/${user._id}/card`, { method: 'DELETE' });
    toast.success('Card revoked');
    onChanged();
  });
  const savePin = () => act('pin', async () => {
    await api(`/settings/users/${user._id}`, { method: 'PATCH', body: { pin } });
    setPin('');
    toast.success(pin ? 'PIN set' : 'PIN removed');
    onChanged();
  });
  const enroll = () => act('enroll', async () => {
    toast.success('Place the finger on the reader (three times for some readers)');
    const cap = await bridge<{ deviceId: string; userId: string; finger: string; format: string; template: string; signature: string }>('/fingerprint/enroll-capture', { userId: user._id, finger }, 90_000);
    await api('/biometrics/enroll', { body: cap });
    toast.success(`${finger.replace('_', ' ')} enrolled`);
    qc.invalidateQueries({ queryKey: ['bio-enrolled'] });
  });
  const removeFingers = () => act('remove', async () => {
    if (!(await confirm({ title: 'Delete fingerprints?', message: `All enrolled fingerprints of ${user.name} are deleted.`, confirmLabel: 'Delete', danger: true }))) return;
    await api(`/biometrics/templates/${user._id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['bio-enrolled'] });
  });

  return (
    <div className="mt-5 space-y-4 border-t border-ink-100 pt-4 dark:border-ink-800">
      <div>
        <div className="label">Staff card</div>
        <div className="flex flex-wrap items-center gap-2">
          {user.card ? <Badge tone="green">Card …{user.card.last4}</Badge> : <Badge>No card</Badge>}
          <Button size="sm" variant="secondary" loading={busy === 'issue'} onClick={issue}><Icon name="idcard" className="h-4 w-4" />{user.card ? 'Issue new card' : 'Issue card'}</Button>
          {user.card && <Button size="sm" variant="secondary" loading={busy === 'print'} onClick={reprint}><Icon name="printer" className="h-4 w-4" />Print card</Button>}
          {user.card && <Button size="sm" variant="ghost" loading={busy === 'revoke'} onClick={revoke}>Revoke</Button>}
        </div>
        <p className="mt-1 text-xs text-ink-500">Scanning the card signs in, approves and clocks in, with the PIN below unless the business allows card only.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={user.hasPin ? 'Change till PIN' : 'Set till PIN'}><Input inputMode="numeric" maxLength={8} className="w-36" value={pin} placeholder="4-8 digits" onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></Field>
        <Button size="sm" variant="secondary" disabled={pin.length > 0 && pin.length < 4} loading={busy === 'pin'} onClick={savePin}>{pin ? 'Save PIN' : user.hasPin ? 'Remove PIN' : 'Save PIN'}</Button>
      </div>
      {biometrics && (
        <div>
          <div className="label">Fingerprints</div>
          <div className="flex flex-wrap items-end gap-2">
            {fingers.length ? fingers.map((f) => <Badge key={f} tone="green">{f.replace('_', ' ')}</Badge>) : <Badge>None enrolled</Badge>}
            <Select className="w-40" value={finger} onChange={(e) => setFinger(e.target.value)} options={FINGERS} />
            <Button size="sm" variant="secondary" disabled={!bridgeConfigured()} loading={busy === 'enroll'} onClick={enroll}><Icon name="finger" className="h-4 w-4" />Enrol finger</Button>
            {fingers.length > 0 && <Button size="sm" variant="ghost" loading={busy === 'remove'} onClick={removeFingers}>Delete fingerprints</Button>}
          </div>
          {!bridgeConfigured() && <p className="mt-1 text-xs text-ink-500">Enrol on a till that has the device bridge and reader set up (Hardware → This computer).</p>}
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
