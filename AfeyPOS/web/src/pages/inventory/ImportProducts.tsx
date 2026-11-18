import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { money } from '../../lib/format';
import { buildTemplate, COLUMNS, photoToBase64, readProductFile, type ImportRow } from '../../lib/productSheet';
import { Badge, Button, cx, ErrorBox, PageHeader, Spinner, Stat, Tabs, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Checked { row: number; sku: string; action: 'create' | 'update' | 'error'; error?: string; warnings?: string[] }
interface Line extends ImportRow { id: number; result?: Checked; photoUrl?: string }

const PAGE = 50;
const EDITABLE: { key: string; label: string; width: string; money?: boolean }[] = [
  { key: 'name', label: 'Product name', width: 'min-w-[220px]' }, { key: 'sku', label: 'SKU', width: 'w-28' }, { key: 'barcode', label: 'Barcode', width: 'w-36' },
  { key: 'category', label: 'Category', width: 'w-32' }, { key: 'baseUnit', label: 'Unit', width: 'w-16' },
];

/**
 * Products › Import products: download the Excel template, upload it (with photos), review every product
 * (what will be created or updated, what is wrong, fix it here) and import when every row is right.
 */
export function ImportProductsPage() {
  const { me, can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const showCost = can('products.cost');
  const [step, setStep] = useState<'start' | 'review' | 'done'>('start');
  const [lines, setLines] = useState<Line[]>([]);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(true);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [done, setDone] = useState<{ created: number; updated: number; photos: number } | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const photoFor = useRef<number | null>(null);

  useEffect(() => () => lines.forEach((l) => l.photoUrl && URL.revokeObjectURL(l.photoUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const template = async () => {
    setBusy('template');
    try {
      const [units, cats, brands] = await Promise.all([
        api<{ data: any[] }>('/units').then((r) => r.data.filter((u) => u.active !== false).map((u) => u.code)),
        api<{ data: any[] }>('/categories').then((r) => r.data.map((c) => c.name)),
        api<{ data: any[] }>('/brands').then((r) => r.data.map((b) => b.name)).catch(() => []),
      ]);
      const blob = await buildTemplate({ business: me!.tenant.name, showCost, units, categories: cats, brands });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'Afey-POS-product-import.xlsx';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const check = async (ls: Line[]) => {
    setBusy('check');
    setError(null);
    try {
      const r = await api<{ data: { results: Checked[] } }>('/products-import', { body: { rows: ls.map((l) => ({ ...l.values, _row: String(l.id) })), commit: false } });
      const byRow = new Map(r.data.results.map((x) => [x.row, x]));
      setLines(ls.map((l) => ({ ...l, result: byRow.get(l.id) })));
      setStale(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const open = async (file: File) => {
    setBusy('read');
    setError(null);
    try {
      const rows = await readProductFile(file, showCost);
      if (!rows.length) throw new Error('No products found in the file');
      lines.forEach((l) => l.photoUrl && URL.revokeObjectURL(l.photoUrl));
      const ls: Line[] = rows.map((r) => ({ ...r, id: r._row, photoUrl: r.photo ? URL.createObjectURL(r.photo) : undefined }));
      setFileName(file.name);
      setLines(ls);
      setStep('review');
      setFilter('all');
      setPage(1);
      await check(ls);
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  };

  /** Photos chosen as files: matched to rows by file name = SKU, barcode or product name. */
  const addPhotos = (files: FileList) => {
    const target = photoFor.current;
    photoFor.current = null;
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (target !== null && list[0]) {
      setLines((ls) => ls.map((l) => (l.id === target ? { ...l, photo: list[0], photoUrl: URL.createObjectURL(list[0]!) } : l)));
      return;
    }
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    let matched = 0;
    setLines((ls) => ls.map((l) => {
      const keys = [l.values.sku, l.values.barcode, l.values.name].filter(Boolean).map(norm);
      const f = list.find((x) => keys.includes(norm(x.name.replace(/\.[^.]+$/, ''))));
      if (!f) return l;
      matched++;
      return { ...l, photo: f, photoUrl: URL.createObjectURL(f) };
    }));
    setTimeout(() => toast.info(`${matched} of ${list.length} photos matched to products by file name`), 0);
  };

  const edit = (id: number, key: string, value: string) => {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, values: { ...l.values, [key]: value } } : l)));
    setStale(true);
  };
  const remove = (id: number) => {
    setLines((ls) => ls.filter((l) => l.id !== id));
    setStale(true);
  };

  const commit = async () => {
    setBusy('import');
    setError(null);
    try {
      // Photos first (resized in the browser), then every product in one go.
      const withPhotos = lines.filter((l) => l.photo);
      const image = new Map<number, string>();
      for (const [i, l] of withPhotos.entries()) {
        setBusy(`photo ${i + 1} of ${withPhotos.length}`);
        const r = await api<{ data: { url: string } }>('/files', { body: { base64: await photoToBase64(l.photo!), purpose: 'product_image' } });
        image.set(l.id, r.data.url);
      }
      setBusy('import');
      const r = await api<{ data: { committed: boolean; results: Checked[] } }>('/products-import', { body: { rows: lines.map((l) => ({ ...l.values, ...(image.has(l.id) ? { image: image.get(l.id)! } : {}), _row: String(l.id) })), commit: true } });
      if (!r.data.committed) {
        const byRow = new Map(r.data.results.map((x) => [x.row, x]));
        setLines((ls) => ls.map((l) => ({ ...l, result: byRow.get(l.id) })));
        throw new Error('Some rows changed and need fixing first');
      }
      qc.invalidateQueries({ queryKey: ['products'] });
      setDone({ created: r.data.results.filter((x) => x.action === 'create').length, updated: r.data.results.filter((x) => x.action === 'update').length, photos: image.size });
      setStep('done');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const counts = useMemo(() => ({
    all: lines.length,
    create: lines.filter((l) => l.result?.action === 'create').length,
    update: lines.filter((l) => l.result?.action === 'update').length,
    error: lines.filter((l) => l.result?.action === 'error').length,
    photo: lines.filter((l) => l.photo).length,
  }), [lines]);
  const shown = lines.filter((l) => filter === 'all' || (filter === 'photo' ? !l.photo : l.result?.action === filter));
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE);
  const ready = !stale && counts.error === 0 && lines.length > 0;
  const priceCols = COLUMNS(showCost).filter((c) => c.money);

  return (
    <div>
      <PageHeader title="Import products" subtitle="Add or update many products at once from an Excel sheet, with their photos" actions={<Button variant="secondary" onClick={() => nav('/products')}><Icon name="chevron" className="h-4 w-4 rotate-90" />Products</Button>} />
      <ol className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {[['start', '1', 'Template & file'], ['review', '2', 'Review every product'], ['done', '3', 'Imported']].map(([k, n, label]) => (
          <li key={k} className={cx('flex items-center gap-2 rounded-full px-3 py-1.5 font-semibold', step === k ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-500 dark:bg-ink-800')}>
            <span className={cx('flex h-5 w-5 items-center justify-center rounded-full text-xs', step === k ? 'bg-white/25' : 'bg-white dark:bg-ink-700')}>{n}</span>{label}
          </li>
        ))}
      </ol>
      <input ref={photoInput} type="file" accept="image/*" multiple className="hidden" aria-label="Product photos" onChange={(e) => { if (e.target.files?.length) addPhotos(e.target.files); e.target.value = ''; }} />

      {step === 'start' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card p-5">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"><Icon name="download" className="h-6 w-6" /></div>
            <h2 className="text-base font-bold">1. Download the Excel template</h2>
            <p className="mt-1 text-sm text-ink-500">Formatted and ready to fill: required columns marked, dropdowns for your units, categories and brands, help on every heading, and a photo cell on each row.</p>
            <ul className="mt-3 space-y-1 text-sm text-ink-600 dark:text-ink-300">
              {['Product name, SKU and selling price are required', 'Existing SKUs are updated, new ones are added', 'Put a photo in each row, or upload photos named by SKU'].map((t) => <li key={t} className="flex gap-2"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />{t}</li>)}
            </ul>
            <Button className="mt-4" onClick={template} loading={busy === 'template'}><Icon name="download" className="h-4 w-4" />Download template (.xlsx)</Button>
          </section>
          <section className="card p-5">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"><Icon name="upload" className="h-6 w-6" /></div>
            <h2 className="text-base font-bold">2. Upload the filled file</h2>
            <p className="mt-1 text-sm text-ink-500">Excel (.xlsx) from the template, or a CSV export. Nothing is saved yet: you review every product first.</p>
            <label className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ink-300 p-8 text-center hover:border-brand-500 hover:bg-brand-50/40 dark:border-ink-600 dark:hover:bg-ink-800"
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) open(f); }}>
              {busy === 'read' || busy === 'check' ? <Spinner className="h-6 w-6" /> : <Icon name="file" className="h-8 w-8 text-ink-400" />}
              <span className="font-semibold">{busy === 'read' ? 'Reading the file…' : busy === 'check' ? 'Checking every product…' : 'Choose a file or drop it here'}</span>
              <span className="text-xs text-ink-500">.xlsx or .csv · up to 10,000 products</span>
              <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" className="hidden" aria-label="Product file" onChange={(e) => { const f = e.target.files?.[0]; if (f) open(f); e.target.value = ''; }} />
            </label>
            <ErrorBox error={error} />
          </section>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Products in the file" value={String(counts.all)} hint={fileName} color="blue" icon="box" />
            <Stat label="New" value={String(counts.create)} color="green" icon="plus" />
            <Stat label="Updates" value={String(counts.update)} color="teal" icon="refresh" />
            <Stat label="Need fixing" value={String(counts.error)} color={counts.error ? 'red' : 'purple'} icon="alert" />
            <Stat label="With photo" value={`${counts.photo} / ${counts.all}`} color="yellow" icon="image" />
          </div>
          <div className="card">
            <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 p-3 dark:border-ink-800">
              <Tabs value={filter} onChange={(k) => { setFilter(k); setPage(1); }} tabs={[{ key: 'all', label: `All (${counts.all})` }, { key: 'error', label: `Need fixing (${counts.error})` }, { key: 'create', label: `New (${counts.create})` }, { key: 'update', label: `Updates (${counts.update})` }, { key: 'photo', label: `No photo (${counts.all - counts.photo})` }]} />
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => { photoFor.current = null; photoInput.current?.click(); }}><Icon name="image" className="h-4 w-4" />Add photos</Button>
                <Button variant="secondary" onClick={() => check(lines)} loading={busy === 'check'} disabled={!stale}><Icon name="refresh" className="h-4 w-4" />Check again</Button>
                <Button variant="ghost" onClick={() => { setStep('start'); setLines([]); setError(null); }}>Other file</Button>
              </div>
            </div>
            {stale && !busy && <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100">You changed some products: press <b>Check again</b> before importing.</div>}
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm" data-testid="import-review">
                <thead className="bg-ink-50 dark:bg-ink-900/60"><tr>
                  <th className="th w-10">Row</th><th className="th w-16">Photo</th>
                  {EDITABLE.map((c) => <th key={c.key} className="th">{c.label}</th>)}
                  {priceCols.map((c) => <th key={c.key} className="th num">{c.header}</th>)}
                  <th className="th">Check</th><th className="th" />
                </tr></thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                  {pageRows.map((l) => {
                    const r = l.result;
                    return (
                      <tr key={l.id} className={cx(r?.action === 'error' && 'bg-red-50/60 dark:bg-red-900/10')} data-testid={`import-row-${l.id}`}>
                        <td className="td text-ink-500">{l.id}</td>
                        <td className="td">
                          <button type="button" aria-label={`Photo for ${l.values.name || `row ${l.id}`}`} onClick={() => { photoFor.current = l.id; photoInput.current?.click(); }}
                            className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg border border-ink-200 bg-white hover:border-brand-500 dark:border-ink-700 dark:bg-ink-900">
                            {l.photoUrl ? <img src={l.photoUrl} alt="" className="h-full w-full object-cover" /> : <Icon name="image" className="h-5 w-5 text-ink-300" />}
                          </button>
                        </td>
                        {EDITABLE.map((c) => (
                          <td key={c.key} className="td"><input aria-label={`${c.label} row ${l.id}`} className={cx('input py-1', c.width)} value={l.values[c.key] ?? ''} onChange={(e) => edit(l.id, c.key, e.target.value)} /></td>
                        ))}
                        {priceCols.map((c) => (
                          <td key={c.key} className="td num"><input aria-label={`${c.header} row ${l.id}`} inputMode="decimal" className="input w-24 py-1 text-right" value={l.values[c.key] ?? ''} onChange={(e) => edit(l.id, c.key, e.target.value)} />
                            {l.values[c.key] && !Number.isNaN(Number(l.values[c.key].replace(/,/g, ''))) && <div className="mt-0.5 text-[11px] text-ink-500">{money(Math.round(Number(l.values[c.key].replace(/,/g, '')) * 100))}</div>}
                          </td>
                        ))}
                        <td className="td min-w-[180px]">
                          {!r ? <span className="text-ink-400">—</span> : r.action === 'error'
                            ? <div className="text-red-700 dark:text-red-300"><Badge tone="red">Fix</Badge> <span className="text-xs">{r.error}</span></div>
                            : <div><Badge tone={r.action === 'create' ? 'green' : 'blue'}>{r.action === 'create' ? 'New' : 'Update'}</Badge>{r.warnings?.map((w) => <div key={w} className="mt-0.5 text-[11px] text-ink-500">{w}</div>)}</div>}
                        </td>
                        <td className="td"><Button size="sm" variant="ghost" aria-label={`Leave out row ${l.id}`} onClick={() => remove(l.id)}><Icon name="trash" className="h-4 w-4" /></Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!pageRows.length && <p className="p-6 text-center text-sm text-ink-500">Nothing here.</p>}
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-between border-t border-ink-100 px-3 py-2 text-sm dark:border-ink-800">
                <span className="text-ink-500">Page {page} of {pages} · {shown.length} products</span>
                <div className="flex gap-2"><Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
              </div>
            )}
          </div>
          <ErrorBox error={error} />
          <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-ink-200 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-ink-700 dark:bg-ink-900/95">
            <span className="mr-auto text-sm text-ink-600 dark:text-ink-300">{ready ? `Ready: ${counts.create} new and ${counts.update} updated products${counts.photo ? `, ${counts.photo} photos` : ''}.` : counts.error ? `${counts.error} ${counts.error === 1 ? 'product needs' : 'products need'} fixing (or leave them out) before importing.` : 'Check the products again before importing.'}</span>
            <Button size="md" onClick={commit} disabled={!ready || Boolean(busy)} loading={Boolean(busy && busy !== 'check')}>{busy && busy.startsWith('photo') ? `Uploading ${busy}…` : `Import ${lines.length} products`}</Button>
          </div>
        </div>
      )}

      {step === 'done' && done && (
        <section className="card mx-auto max-w-xl p-8 text-center" role="status" data-testid="import-done">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"><Icon name="check" className="h-8 w-8" /></div>
          <h2 className="text-lg font-bold">Products imported</h2>
          <p className="mt-1 text-sm text-ink-500">{done.created} added, {done.updated} updated{done.photos ? `, ${done.photos} photos` : ''}.</p>
          <div className="mt-5 flex justify-center gap-2">
            <Link to="/products"><Button>See products</Button></Link>
            <Button variant="secondary" onClick={() => { setStep('start'); setLines([]); setDone(null); }}>Import more</Button>
          </div>
        </section>
      )}
    </div>
  );
}
