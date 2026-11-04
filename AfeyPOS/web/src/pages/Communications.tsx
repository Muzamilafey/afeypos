import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, PageHeader, Select, Tabs, useToast } from '../components/ui';
import { Icon } from '../components/icons';

type Audience = 'customers' | 'staff' | 'suppliers';
interface Template { id: string; name: string; audiences: Audience[]; subject: string; sms: string; body: string }

const AUDIENCES: { key: Audience; label: string }[] = [
  { key: 'customers', label: 'Customers' },
  { key: 'staff', label: 'Staff' },
  { key: 'suppliers', label: 'Suppliers' },
];

/** Communications: send SMS or email to customers, staff or suppliers, from ready templates or your own words. */
export function CommunicationsPage() {
  const { has } = useAuth();
  const [tab, setTab] = useState<'send' | 'history'>('send');
  return (
    <div className="max-w-5xl">
      <PageHeader title="Communications" subtitle="Send an SMS or email to your customers, staff or suppliers — from a ready template or your own message." />
      <Tabs value={tab} onChange={(k) => setTab(k as 'send' | 'history')} tabs={[{ key: 'send', label: 'Send a message' }, { key: 'history', label: 'History' }]} />
      {tab === 'send' ? <Compose smsOn={has('sms')} emailOn={has('email')} /> : <History />}
    </div>
  );
}

function Compose({ smsOn, emailOn }: { smsOn: boolean; emailOn: boolean }) {
  const toast = useToast();
  const templates = useQuery({ queryKey: ['comm-templates'], queryFn: () => api<{ data: Template[] }>('/communications/templates').then((r) => r.data) });
  const [audience, setAudience] = useState<Audience>('customers');
  const [channel, setChannel] = useState<'sms' | 'email'>(smsOn ? 'sms' : 'email');
  const [templateId, setTemplateId] = useState('promo');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [withBalance, setWithBalance] = useState(false);
  const [tags, setTags] = useState('');
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);

  const filters = () => ({ audience, channel, ...(audience === 'customers' && withBalance ? { withBalance: true } : {}), ...(audience === 'customers' && tags.trim() ? { tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}) });
  const reach = useQuery({
    queryKey: ['comm-reach', audience, channel, withBalance, tags],
    queryFn: () => api<{ data: { count: number; sample: string[] } }>('/communications/recipients', { body: filters() }).then((r) => r.data),
  });

  // When the template or audience changes, drop in the ready wording.
  useEffect(() => {
    const t = templates.data?.find((x) => x.id === templateId);
    if (t) { setSubject(t.subject); setMessage(channel === 'sms' ? t.sms : t.body); }
  }, [templateId, channel, templates.data]);
  // Keep the template choice valid for the chosen audience.
  const forAudience = (templates.data ?? []).filter((t) => t.audiences.includes(audience));
  useEffect(() => { if (forAudience.length && !forAudience.some((t) => t.id === templateId)) setTemplateId(forAudience[0]!.id); }, [audience, templates.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (test: boolean) => {
    setBusy(true); setError(null); setSent(null);
    try {
      const r = await api<{ data: { queued: number; skipped: number; total: number } }>('/communications/send', { body: { ...filters(), subject: channel === 'email' ? subject : undefined, message, ...(test ? { testTo } : {}) } });
      if (test) toast.success(`Test ${channel} sent to ${testTo}`);
      else { setSent(`Queued ${r.data.queued} ${channel === 'sms' ? 'messages' : 'emails'}${r.data.skipped ? `, ${r.data.skipped} skipped` : ''}.`); toast.success(`Sending to ${r.data.queued} ${audience}`); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (!smsOn && !emailOn) return <Card><p className="text-sm">Turn on SMS or email first under <a className="underline" href="/settings/integrations">Settings → Integrations</a>, then you can message your contacts here.</p></Card>;
  const chars = message.length;
  const smsParts = Math.max(1, Math.ceil(chars / 160));
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <Card title="Who and how">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Send to"><Select value={audience} onChange={(e) => setAudience(e.target.value as Audience)} options={AUDIENCES.map((a) => ({ value: a.key, label: a.label }))} /></Field>
            <Field label="By"><Select value={channel} onChange={(e) => setChannel(e.target.value as 'sms' | 'email')} options={[...(smsOn ? [{ value: 'sms', label: 'SMS' }] : []), ...(emailOn ? [{ value: 'email', label: 'Email' }] : [])]} /></Field>
          </div>
          {audience === 'customers' && (
            <div className="mt-3 space-y-2 rounded-lg bg-ink-50 p-3 dark:bg-ink-800/40">
              <Checkbox label="Only customers who owe a balance" checked={withBalance} onChange={setWithBalance} />
              <Field label="Only customers with any of these tags (optional)" hint="Comma-separated, e.g. hotel, estate A"><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="hotel, wholesale" /></Field>
              <p className="text-xs text-ink-500">Only customers who agreed to receive messages are included.</p>
            </div>
          )}
        </Card>
        <Card title="Message">
          <div className="space-y-3">
            <Field label="Ready template"><Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} options={forAudience.map((t) => ({ value: t.id, label: t.name }))} /></Field>
            {channel === 'email' && <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>}
            <Field label="Message" hint={channel === 'sms' ? `${chars} characters · ${smsParts} SMS${smsParts > 1 ? ' parts' : ''}` : undefined}>
              <textarea className="input min-h-[140px]" value={message} maxLength={2000} onChange={(e) => setMessage(e.target.value)} placeholder="Write your message. Use {{name}} for the person's name and {{business}} for your business name." />
            </Field>
            <p className="text-xs text-ink-500">{'{{name}}'} and {'{{business}}'} are filled in for each person.</p>
            <ErrorBox error={error} />
            {sent && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 dark:bg-emerald-950/30" data-testid="comm-sent">{sent}</p>}
          </div>
        </Card>
      </div>
      <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <Card title="Reach">
          <div className="text-3xl font-black tabular-nums" data-testid="comm-reach">{reach.data?.count ?? '…'}</div>
          <p className="text-xs text-ink-500">{AUDIENCES.find((a) => a.key === audience)?.label} reachable by {channel.toUpperCase()}{audience === 'customers' ? ' who agreed to messages' : ''}.</p>
          {reach.data?.sample?.length ? <p className="mt-2 text-xs text-ink-400">e.g. {reach.data.sample.join(', ')}…</p> : null}
          <Button className="mt-3 w-full" size="lg" loading={busy} disabled={!message.trim() || !(reach.data?.count ?? 0)} onClick={() => send(false)}>Send to {reach.data?.count ?? 0}</Button>
        </Card>
        <Card title="Try it first">
          <Field label={channel === 'sms' ? 'Send a test SMS to' : 'Send a test email to'}><Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={channel === 'sms' ? '07…' : 'you@example.com'} /></Field>
          <Button variant="secondary" className="mt-2 w-full" disabled={!testTo.trim() || !message.trim() || busy} onClick={() => send(true)}>Send test</Button>
        </Card>
      </div>
    </div>
  );
}

function History() {
  const q = useQuery({ queryKey: ['comm-log'], queryFn: () => api<{ data: any[] }>('/communications/log').then((r) => r.data), refetchInterval: 20_000 });
  return (
    <Card bodyClassName="p-0">
      <DataTable rows={q.data?.map((r) => ({ ...r, _id: r.id }))} loading={q.isLoading} error={q.error} empty="No messages sent yet" columns={[
        { key: 'd', header: 'Time', render: (r) => dateTime(r.at) },
        { key: 'c', header: 'Channel', render: (r) => <Badge tone="blue">{r.channel === 'sms' ? 'SMS' : 'Email'}</Badge> },
        { key: 't', header: 'To', render: (r) => r.to },
        { key: 's', header: 'Message', render: (r) => <span className="line-clamp-1 text-xs text-ink-500">{r.subject ? `${r.subject}: ` : ''}{r.body}</span> },
        { key: 'st', header: 'Status', render: (r) => <Badge tone={r.status === 'sent' ? 'green' : r.status === 'failed' ? 'red' : 'amber'}>{r.status}</Badge> },
      ]} />
      <p className="flex items-center gap-1.5 px-4 py-2 text-xs text-ink-500"><Icon name="info" className="h-3.5 w-3.5" />Delivery runs in the background; refresh to see the status update.</p>
    </Card>
  );
}
