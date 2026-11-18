import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, Input, PageHeader, Select, useToast } from '../components/ui';
import { Icon } from '../components/icons';

interface Msg { role: 'user' | 'assistant'; text: string; mode?: string; tools?: string[] }

/** AI Business Assistant: questions in plain language, answered from this business's own figures (read only). */
export function AssistantPage() {
  const { can } = useAuth();
  const status = useQuery({ queryKey: ['assistant-status'], queryFn: () => api<{ data: { mode: 'ai' | 'builtin'; provider: string | null; model: string | null; suggestions: string[]; usage: { mine: number; userLimit: number } } }>('/assistant/status').then((r) => r.data) });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs.length, busy]);
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setError(null);
    const history = msgs.slice(-10).map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: 'user', text: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api<{ data: { answer: string; mode: string; tools: string[] } }>('/assistant/ask', { body: { question, history } });
      setMsgs((m) => [...m, { role: 'assistant', text: r.data.answer, mode: r.data.mode, tools: r.data.tools }]);
      status.refetch();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const s = status.data;
  return (
    <div className="max-w-5xl">
      <PageHeader title="AI Business Assistant" subtitle="Ask about sales, profit, stock, branches and staff. Answers come only from your own figures and what you are allowed to see; the assistant cannot change anything."
        actions={s && <Badge tone={s.mode === 'ai' ? 'green' : 'gray'}>{s.mode === 'ai' ? `AI: ${s.model}` : 'Built-in answers (no AI set up)'}</Badge>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <Card bodyClassName="p-0">
          <div className="h-[55vh] space-y-3 overflow-y-auto p-4" data-testid="assistant-chat">
            {!msgs.length && <p className="text-sm text-ink-500">Try one of the questions on the right, or type your own.</p>}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex gap-2'}>
                {m.role === 'assistant' && <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/15"><Icon name="sparkles" className="h-4 w-4" /></div>}
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${m.role === 'user' ? 'bg-brand-500 text-white' : 'bg-ink-50 dark:bg-ink-800'}`}>
                  {m.text}
                  {m.role === 'assistant' && m.tools && m.tools.length > 0 && <div className="mt-1 text-[11px] text-ink-400">From: {m.tools.map((t) => t.replace(/_/g, ' ')).join(', ')}</div>}
                </div>
              </div>
            ))}
            {busy && <div className="text-sm text-ink-500" data-testid="assistant-thinking">Looking at your figures…</div>}
            <div ref={end} />
          </div>
          <div className="flex gap-2 border-t border-ink-100 p-3 dark:border-ink-800">
            <Input aria-label="Ask a question" placeholder="Ask another question…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void ask(q); } }} />
            <Button loading={busy} onClick={() => ask(q)} aria-label="Send"><Icon name="play" className="h-4 w-4" /></Button>
          </div>
          <div className="px-3 pb-3"><ErrorBox error={error} /></div>
        </Card>
        <div className="space-y-3">
          <Card title="Questions to try">
            <div className="flex flex-col gap-1">
              {(s?.suggestions ?? []).map((x) => <button key={x} type="button" className="rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink-50 dark:hover:bg-ink-800" onClick={() => ask(x)}>{x}</button>)}
            </div>
          </Card>
          {s?.mode === 'ai' && <p className="text-xs text-ink-500">Today you asked {s.usage.mine} of {s.usage.userLimit} AI questions.</p>}
        </div>
      </div>
      {can('settings.manage') && <AssistantSettings onSaved={() => status.refetch()} />}
    </div>
  );
}

function AssistantSettings({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const cfg = useQuery({ queryKey: ['assistant-config'], queryFn: () => api<{ data: any }>('/assistant/config').then((r) => r.data) });
  const log = useQuery({ queryKey: ['assistant-log'], queryFn: () => api<{ data: any[]; last30Days: any }>('/assistant/log') });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (cfg.data && !f) setF({ ...cfg.data, apiKey: '' }); }, [cfg.data, f]);
  if (!f) return null;
  const save = async () => {
    try {
      await api('/assistant/config', { method: 'PUT', body: { enabled: f.enabled, provider: f.provider, model: f.model || undefined, apiKey: f.apiKey || undefined, userDailyLimit: Number(f.userDailyLimit), dailyLimit: Number(f.dailyLimit) } });
      toast.success('Assistant settings saved');
      setF({ ...f, apiKey: '', hasKey: f.hasKey || Boolean(f.apiKey) });
      onSaved();
    } catch (e) { toast.error(e); }
  };
  const t = log.data?.last30Days;
  return (
    <Card className="mt-4" title="AI provider (owners and administrators)" actions={<Button size="sm" onClick={save}>Save</Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3"><Checkbox label="Use an AI provider for questions (without it, the built-in answers still work)" checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} /></div>
        <Field label="Provider"><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} options={[{ value: 'anthropic', label: 'Anthropic (Claude)' }, { value: 'openai', label: 'OpenAI' }, { value: 'gemini', label: 'Google Gemini' }]} /></Field>
        <Field label="Model" hint={f.provider === 'anthropic' ? `Blank = ${f.defaults?.anthropic}` : 'The model name from your provider'}><Input value={f.model ?? ''} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder={f.provider === 'anthropic' ? f.defaults?.anthropic : ''} /></Field>
        <Field label="API key" hint={f.hasKey ? 'A key is saved (hidden). Type a new one to replace it.' : 'Kept encrypted on the server, never shown again'}><Input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} autoComplete="off" /></Field>
        <Field label="AI questions per person per day"><Input type="number" min={1} value={f.userDailyLimit} onChange={(e) => setF({ ...f, userDailyLimit: e.target.value })} /></Field>
        <Field label="AI questions per day (whole business)"><Input type="number" min={1} value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: e.target.value })} /></Field>
      </div>
      {t && <p className="mt-3 text-xs text-ink-500">Last 30 days: {t.questions} questions ({t.aiQuestions} by AI, {t.failed} failed), {t.inputTokens.toLocaleString()} input and {t.outputTokens.toLocaleString()} output tokens.</p>}
      <p className="mt-1 text-xs text-ink-500">The assistant reads through fixed, read-only reports that check each person's permissions and branches. It never sees passwords, API keys or payment credentials, and it cannot change data.</p>
    </Card>
  );
}
