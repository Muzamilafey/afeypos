/**
 * A simple searchable picker for a product's KRA eTIMS item classification code (itemClsCd).
 * Pick a common category to fill the code in one tap, or type any custom code by hand. The built-in
 * list is a convenience starting point grounded in UNSPSC categories — the hint reminds the cashier to
 * confirm the exact code against the business's live KRA eTIMS classification list.
 */
import { useMemo, useState } from 'react';
import { ETIMS_ITEM_CLASSES, etimsItemClass, searchEtimsItemClasses } from '@afeypos/shared';
import { Field, Input } from './ui';

export function EtimsItemClassPicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const known = etimsItemClass(value);
  const groups = useMemo(() => {
    const matches = searchEtimsItemClasses(query);
    const byGroup = new Map<string, typeof ETIMS_ITEM_CLASSES>();
    for (const c of matches) {
      const list = byGroup.get(c.group) ?? [];
      list.push(c);
      byGroup.set(c.group, list);
    }
    return [...byGroup.entries()];
  }, [query]);

  return (
    <Field label="Item classification code" hint="KRA's code for this kind of item. Pick a category below, or type a code. Confirm it against your KRA eTIMS classification list.">
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input inputMode="numeric" value={value} placeholder="e.g. 50200000" onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
          <button type="button" onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded-md border border-ink-200 px-3 text-sm font-semibold text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:text-ink-200 dark:hover:bg-ink-800">
            {open ? 'Close' : 'Choose'}
          </button>
        </div>
        {known && !open && <div className="text-xs text-emerald-600">{known.name} · {known.group}</div>}
        {open && (
          <div className="rounded-lg border border-ink-100 bg-white p-2 dark:border-ink-800 dark:bg-ink-900">
            <Input autoFocus value={query} placeholder="Search categories (e.g. soda, cement, dawa)…" onChange={(e) => setQuery(e.target.value)} />
            <div className="mt-2 max-h-64 overflow-y-auto">
              {groups.length === 0 && <div className="px-2 py-3 text-sm text-ink-500">No matching category. Type the code by hand above.</div>}
              {groups.map(([group, items]) => (
                <div key={group} className="mb-1">
                  <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink-400">{group}</div>
                  {items.map((c) => (
                    <button key={c.code} type="button"
                      onClick={() => { onChange(c.code); setOpen(false); setQuery(''); }}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-brand-50 dark:hover:bg-ink-800 ${value === c.code ? 'bg-brand-50 dark:bg-ink-800' : ''}`}>
                      <span className="text-ink-700 dark:text-ink-200">{c.name}</span>
                      <span className="shrink-0 font-mono text-xs text-ink-400">{c.code}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Field>
  );
}
