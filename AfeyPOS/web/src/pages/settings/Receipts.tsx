import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RECEIPT_DEFAULTS, RECEIPT_TEMPLATE_INFO, RECEIPT_TEMPLATES, type ReceiptCustomField, type ReceiptSettings, type ReceiptShow } from '@afeypos/shared';
import { api } from '../../lib/api';
import { Button, Card, Checkbox, cx, ErrorBox, Field, Input, Loading, PageHeader, Select, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

interface ReceiptForm {
  receipt: ReceiptSettings;
  receiptHeader: string;
  receiptFooter: string;
}

const SHOW_GROUPS: { title: string; items: [keyof ReceiptShow, string][] }[] = [
  { title: 'Business', items: [['logo', 'Logo'], ['tagline', 'Tagline'], ['address', 'Address'], ['phone', 'Phone'], ['email', 'Email'], ['taxPin', 'KRA PIN']] },
  { title: 'Sale details', items: [['cashier', 'Cashier name'], ['till', 'Till'], ['branch', 'Branch'], ['customer', 'Customer']] },
  { title: 'Items and totals', items: [['sku', 'Item codes (SKU)'], ['unitPrice', 'Unit prices'], ['itemCount', 'Item count'], ['taxSummary', 'VAT summary'], ['savings', '"You saved" line'], ['loyalty', 'Loyalty points']] },
  { title: 'Bottom', items: [['barcode', 'Receipt barcode (for returns)'], ['qr', 'KRA eTIMS QR code'], ['poweredBy', '"Powered by Afey POS"']] },
];

/** Small drawing of each template so the choice is visual. */
function TemplateThumb({ template }: { template: ReceiptSettings['template'] }) {
  const line = (w: string, extra = '') => <div className={cx('h-[3px] rounded-full bg-ink-300 dark:bg-ink-600', extra)} style={{ width: w }} />;
  return (
    <div className={cx('mx-auto flex h-24 w-16 flex-col gap-[5px] rounded-sm bg-white p-1.5 shadow ring-1 ring-ink-200 dark:bg-ink-100', template === 'elegant' && 'font-serif')}>
      <div className={cx('mx-auto rounded-sm bg-ink-700', template === 'bold' ? 'h-2 w-11' : template === 'elegant' ? 'h-1.5 w-8 rounded-full' : 'h-1.5 w-9')} />
      {line('70%', 'mx-auto')}
      {template === 'modern' && <div className="h-[5px] w-full rounded-sm bg-ink-800" />}
      <div className={cx(template === 'elegant' ? 'mx-auto w-3 border-t-2 border-dotted border-ink-400' : template === 'bold' ? 'border-t-2 border-ink-800' : 'border-t border-dashed border-ink-400')} />
      {(template === 'compact' ? [1, 2, 3, 4, 5] : [1, 2, 3]).map((i) => <div key={i} className="flex justify-between">{line(template === 'compact' ? '55%' : '45%')}{line('22%')}</div>)}
      <div className={cx('mt-auto flex justify-between rounded-sm px-0.5 py-[2px]', template === 'bold' ? 'bg-ink-900' : template === 'modern' ? 'ring-1 ring-ink-800' : '')}>
        <div className={cx('h-[4px] w-5 rounded-full', template === 'bold' ? 'bg-white' : 'bg-ink-700')} /><div className={cx('h-[4px] w-4 rounded-full', template === 'bold' ? 'bg-white' : 'bg-ink-700')} />
      </div>
      <div className="mx-auto h-2 w-10 bg-[repeating-linear-gradient(90deg,#333_0_1px,transparent_1px_3px)]" />
    </div>
  );
}

export function ReceiptSettingsPage() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['receipt-settings'], queryFn: () => api<{ data: ReceiptForm }>('/settings/receipt').then((r) => r.data) });
  const [form, setForm] = useState<ReceiptForm | null>(null);
  const [sample, setSample] = useState<'sample' | 'latest'>('sample');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const timer = useRef<number>();

  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);

  // Live preview: the server renders the unsaved settings exactly as they will print.
  useEffect(() => {
    if (!form) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api<Response>('/settings/receipt/preview', { body: { ...form, sample }, raw: true })
        .then((r) => r.text())
        .then(setPreview)
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [form, sample]);

  if (!form) return <Loading />;
  const r = form.receipt;
  const setR = (patch: Partial<ReceiptSettings>) => { setForm({ ...form, receipt: { ...r, ...patch } }); setDirty(true); };
  const setShow = (k: keyof ReceiptShow, v: boolean) => setR({ show: { ...r.show, [k]: v } });
  const setField = (i: number, patch: Partial<ReceiptCustomField>) => setR({ customFields: r.customFields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api<{ data: ReceiptForm }>('/settings/receipt', { method: 'PUT', body: form });
      setForm(res.data); setDirty(false); q.refetch();
      toast.success('Receipt settings saved. New receipts use them right away.');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const printTest = () => {
    const w = window.open('', '_blank', 'width=420,height=700');
    if (!w) return toast.error('Allow pop-ups to print');
    w.document.open(); w.document.write(preview); w.document.close();
    setTimeout(() => w.print(), 400);
  };

  return (
    <div className="max-w-7xl">
      <PageHeader title="Receipts" subtitle="Choose how printed and sent receipts look: template, paper, what to show and your own lines."
        actions={<>
          <Button variant="secondary" onClick={() => { setForm({ ...form, receipt: RECEIPT_DEFAULTS }); setDirty(true); }}>Reset to defaults</Button>
          <Button loading={busy} disabled={!dirty} onClick={save}>{dirty ? 'Save changes' : 'Saved'}</Button>
        </>} />
      <ErrorBox error={error} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-4">
          <Card title="Template">
            <div role="radiogroup" aria-label="Receipt template" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              {RECEIPT_TEMPLATES.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={r.template === t} onClick={() => setR({ template: t })}
                  className={cx('rounded-lg border p-3 text-center transition hover:-translate-y-px hover:shadow-md', r.template === t ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-500/10' : 'border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-900')}>
                  <TemplateThumb template={t} />
                  <div className="mt-2 text-sm font-semibold">{RECEIPT_TEMPLATE_INFO[t].label}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-500">{RECEIPT_TEMPLATE_INFO[t].description}</div>
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field label="Paper width"><Select value={r.paper} onChange={(e) => setR({ paper: e.target.value as ReceiptSettings['paper'] })} options={[{ value: '80mm', label: '80 mm (42 characters)' }, { value: '58mm', label: '58 mm (32 characters)' }]} /></Field>
              <Field label="Text size"><Select value={r.fontSize} onChange={(e) => setR({ fontSize: e.target.value as ReceiptSettings['fontSize'] })} options={[{ value: 'small', label: 'Small' }, { value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }]} /></Field>
              <Field label="Receipt title"><Input value={r.title} maxLength={40} placeholder="e.g. SALES RECEIPT (empty hides it)" onChange={(e) => setR({ title: e.target.value })} /></Field>
            </div>
          </Card>

          <Card title="Header and footer">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Header text" hint="Under the business details, e.g. opening hours."><textarea className="input min-h-[70px]" maxLength={200} value={form.receiptHeader} onChange={(e) => { setForm({ ...form, receiptHeader: e.target.value }); setDirty(true); }} /></Field>
              <Field label="Footer text" hint="Last line, e.g. a thank-you."><textarea className="input min-h-[70px]" maxLength={300} value={form.receiptFooter} onChange={(e) => { setForm({ ...form, receiptFooter: e.target.value }); setDirty(true); }} /></Field>
              <Field label="Promotion / message" hint="Printed in bold near the bottom."><textarea className="input min-h-[60px]" maxLength={300} value={r.message} placeholder="e.g. Double points every Friday!" onChange={(e) => setR({ message: e.target.value })} /></Field>
              <Field label="Return policy"><textarea className="input min-h-[60px]" maxLength={400} value={r.returnPolicy} placeholder="e.g. Goods may be returned within 7 days with this receipt." onChange={(e) => setR({ returnPolicy: e.target.value })} /></Field>
            </div>
          </Card>

          <Card title="Show on the receipt">
            <div className="grid gap-4 sm:grid-cols-2">
              {SHOW_GROUPS.map((g) => (
                <fieldset key={g.title}>
                  <legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-ink-500">{g.title}</legend>
                  <div className="grid gap-1.5">{g.items.map(([k, label]) => <Checkbox key={k} label={label} checked={r.show[k]} onChange={(v) => setShow(k, v)} />)}</div>
                </fieldset>
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-500">The logo is set in Settings &gt; Business and prints on browser receipts. KRA eTIMS details always print once an invoice is signed; only the QR code can be hidden.</p>
          </Card>

          <Card title="Extra fields" actions={<Button size="sm" variant="secondary" disabled={r.customFields.length >= 12} onClick={() => setR({ customFields: [...r.customFields, { label: '', value: '', position: 'bottom' }] })}><Icon name="plus" className="h-3.5 w-3.5" />Add field</Button>}>
            {r.customFields.length === 0
              ? <p className="text-sm text-ink-500">Add your own lines, such as <b>Paybill: 123456</b>, <b>Till No: 987654</b>, <b>Website: myshop.co.ke</b> or <b>WhatsApp: 0712 345 678</b>.</p>
              : (
                <div className="space-y-2">
                  {r.customFields.map((f, i) => (
                    <div key={i} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_150px_auto]" aria-label={`Extra field ${i + 1}`} role="group">
                      <Field label="Label"><Input value={f.label} maxLength={30} placeholder="Paybill" onChange={(e) => setField(i, { label: e.target.value })} /></Field>
                      <Field label="Value"><Input value={f.value} maxLength={80} placeholder="123456" onChange={(e) => setField(i, { value: e.target.value })} /></Field>
                      <Field label="Position"><Select value={f.position} onChange={(e) => setField(i, { position: e.target.value as ReceiptCustomField['position'] })} options={[{ value: 'top', label: 'With sale details' }, { value: 'bottom', label: 'Near the bottom' }]} /></Field>
                      <div className="flex gap-1 pb-0.5">
                        <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => { const c = [...r.customFields]; [c[i - 1], c[i]] = [c[i]!, c[i - 1]!]; setR({ customFields: c }); }}>↑</Button>
                        <Button size="sm" variant="ghost" aria-label={`Remove extra field ${i + 1}`} onClick={() => setR({ customFields: r.customFields.filter((_, j) => j !== i) })}><Icon name="trash" className="h-4 w-4" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </Card>
        </div>

        <aside className="lg:sticky lg:top-16 lg:self-start">
          <Card title="Live preview" actions={<Button size="sm" variant="secondary" onClick={printTest} disabled={!preview}><Icon name="printer" className="h-3.5 w-3.5" />Print test</Button>} bodyClassName="p-0">
            <div className="flex items-center gap-2 border-b border-ink-100 px-3 py-2 text-xs dark:border-ink-800">
              <span className="text-ink-500">Show</span>
              {(['sample', 'latest'] as const).map((k) => (
                <button key={k} type="button" onClick={() => setSample(k)} aria-pressed={sample === k} className={cx('rounded-full px-2.5 py-0.5 font-semibold', sample === k ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300')}>{k === 'sample' ? 'Sample sale' : 'Latest real sale'}</button>
              ))}
            </div>
            <iframe title="Receipt preview" srcDoc={preview} sandbox="allow-same-origin" className="h-[72vh] w-full rounded-b-lg bg-[#e9ebee]" />
          </Card>
          <p className="mt-2 text-xs text-ink-500">Thermal printers print the same content in their own font; the template changes rules, spacing and the size of the business name and total. Reprints and credit notes use these settings too.</p>
        </aside>
      </div>
    </div>
  );
}

