import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { STUDIO_ICONS, type StoreStudio, type StudioIconText, type StudioLink } from '@afeypos/shared';
import { api } from '../lib/api';
import { Button, Checkbox, cx, Field, Input, Loading, PageHeader, Select, useConfirm, useToast } from '../components/ui';
import { Icon } from '../components/icons';

/**
 * Store studio: edit the online shop's look and content with a live preview of the real shop website.
 * The preview loads the shop with ?studio=1 and receives the unsaved design by postMessage.
 */

type Section = 'brand' | 'topBar' | 'nav' | 'hero' | 'categories' | 'sections' | 'banners' | 'why' | 'newsletter' | 'footer' | 'pages' | 'seo' | 'payments';
const SECTIONS: { key: Section; label: string; icon: string; hint: string; anchor?: string }[] = [
  { key: 'brand', label: 'Brand & colours', icon: 'sparkles', hint: 'Logo, tagline, colours and corners' },
  { key: 'topBar', label: 'Top bar', icon: 'megaphone', hint: 'The strip above the header', anchor: 'topBar' },
  { key: 'nav', label: 'Menu', icon: 'menu', hint: 'Links under the header', anchor: 'nav' },
  { key: 'hero', label: 'Hero', icon: 'image', hint: 'The big welcome banner', anchor: 'hero' },
  { key: 'categories', label: 'Categories', icon: 'grid', hint: 'Round category shortcuts', anchor: 'categories' },
  { key: 'sections', label: 'Product sections', icon: 'package', hint: 'Featured, new, best sellers, deals', anchor: 'featured' },
  { key: 'banners', label: 'Promo banners', icon: 'tag', hint: 'Two offers side by side', anchor: 'banners' },
  { key: 'why', label: 'Why shop with us', icon: 'star', hint: 'Reasons to buy from you', anchor: 'why' },
  { key: 'newsletter', label: 'Newsletter', icon: 'mail', hint: 'Email sign-up', anchor: 'newsletter' },
  { key: 'footer', label: 'Footer & social', icon: 'layersStack', hint: 'Links, social media, apps', anchor: 'footer' },
  { key: 'pages', label: 'Pages', icon: 'file', hint: 'About, delivery, FAQ, policies' },
  { key: 'seo', label: 'Search engines', icon: 'search', hint: 'Title and description on Google' },
  { key: 'payments', label: 'Payments & address', icon: 'card', hint: 'M-Pesa and card accounts for the shop' },
];

const THEMES: { name: string; primary: string; accent: string; soft: string; footer: string; hero: string }[] = [
  { name: 'Forest', primary: '#1f3d2b', accent: '#e8a33d', soft: '#f5f1ea', footer: '#1f3328', hero: '#efe9df' },
  { name: 'Ocean', primary: '#16365c', accent: '#2fb5c9', soft: '#eef4f9', footer: '#122a47', hero: '#e3eef8' },
  { name: 'Berry', primary: '#5b1f45', accent: '#f08aa8', soft: '#faf0f4', footer: '#45142f', hero: '#f6e3ec' },
  { name: 'Sunset', primary: '#7a2e12', accent: '#f5a623', soft: '#fdf3ea', footer: '#5c220c', hero: '#fbe8d6' },
  { name: 'Charcoal', primary: '#22262b', accent: '#d4b26a', soft: '#f3f3f1', footer: '#1a1d21', hero: '#ebeae6' },
  { name: 'Fresh', primary: '#13724a', accent: '#ffcf3f', soft: '#f0f8f3', footer: '#0d5236', hero: '#dff1e7' },
];

const ICON_OPTIONS = STUDIO_ICONS.map((i) => ({ value: i, label: i[0]!.toUpperCase() + i.slice(1) }));

// ---------------- small editors ----------------

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} className="h-9 w-11 cursor-pointer rounded-sm border border-[#d5d9de] bg-white p-0.5" value={value} onChange={(e) => onChange(e.target.value)} />
        <Input value={text} maxLength={7} onChange={(e) => { setText(e.target.value); if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase()); }} />
      </div>
    </Field>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return <div className="rounded-sm bg-[#f5f6f8] px-3 py-2.5 dark:bg-ink-800"><Checkbox label={label} checked={on} onChange={onChange} /></div>;
}

function TextArea({ value, onChange, rows = 3, maxLength, label }: { value: string; onChange: (v: string) => void; rows?: number; maxLength: number; label: string }) {
  return <Field label={label}><textarea className="input" rows={rows} maxLength={maxLength} value={value} onChange={(e) => onChange(e.target.value)} /></Field>;
}

/** Ordered list with add, remove and move up/down. */
function ListEditor<T>({ items, onChange, max, blank, title, render, itemLabel }: { items: T[]; onChange: (v: T[]) => void; max: number; blank: () => T; title: string; itemLabel: (t: T, i: number) => string; render: (item: T, set: (v: T) => void) => ReactNode }) {
  const move = (i: number, d: number) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between"><span className="label mb-0">{title}</span><span className="text-[11px] text-ink-500">{items.length}/{max}</span></div>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="rounded-sm border border-[#e3e6ea] bg-white p-3 dark:border-ink-700 dark:bg-ink-900">
            <div className="mb-2 flex items-center gap-1">
              <span className="flex-1 truncate text-xs font-semibold text-ink-600">{itemLabel(it, i)}</span>
              <button type="button" className="rounded p-1 text-ink-500 hover:bg-ink-100 disabled:opacity-30" disabled={i === 0} aria-label={`Move ${itemLabel(it, i)} up`} onClick={() => move(i, -1)}><Icon name="chevron" className="h-3.5 w-3.5 -rotate-90" /></button>
              <button type="button" className="rounded p-1 text-ink-500 hover:bg-ink-100 disabled:opacity-30" disabled={i === items.length - 1} aria-label={`Move ${itemLabel(it, i)} down`} onClick={() => move(i, 1)}><Icon name="chevron" className="h-3.5 w-3.5 rotate-90" /></button>
              <button type="button" className="rounded p-1 text-red-600 hover:bg-red-50" aria-label={`Remove ${itemLabel(it, i)}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
            {render(it, (v) => onChange(items.map((x, j) => (j === i ? v : x))))}
          </div>
        ))}
      </div>
      {items.length < max && <Button size="sm" variant="secondary" className="mt-2" onClick={() => onChange([...items, blank()])}><Icon name="plus" className="h-4 w-4" />Add</Button>}
    </div>
  );
}

function IconTextEditor({ label, items, onChange, max, withText = true }: { label: string; items: StudioIconText[]; onChange: (v: StudioIconText[]) => void; max: number; withText?: boolean }) {
  return (
    <ListEditor title={label} items={items} onChange={onChange} max={max} blank={() => ({ icon: 'star' as const, title: 'New item', text: '' })} itemLabel={(t) => t.title || 'Item'}
      render={(it, set) => (
        <div className="grid grid-cols-[7.5rem_1fr] gap-2">
          <Select aria-label="Icon" value={it.icon} onChange={(e) => set({ ...it, icon: e.target.value as StudioIconText['icon'] })} options={ICON_OPTIONS} />
          <Input aria-label="Item title" value={it.title} maxLength={60} onChange={(e) => set({ ...it, title: e.target.value })} />
          {withText && <Input aria-label="Item text" className="col-span-2" placeholder="Small text (optional)" value={it.text ?? ''} maxLength={80} onChange={(e) => set({ ...it, text: e.target.value })} />}
        </div>
      )} />
  );
}

function LinksEditor({ label, items, onChange, max }: { label: string; items: StudioLink[]; onChange: (v: StudioLink[]) => void; max: number }) {
  return (
    <ListEditor title={label} items={items} onChange={onChange} max={max} blank={() => ({ label: 'New link', to: '/shop' })} itemLabel={(l) => l.label || 'Link'}
      render={(l, set) => (
        <div className="grid grid-cols-2 gap-2">
          <Input aria-label="Link text" value={l.label} maxLength={40} onChange={(e) => set({ ...l, label: e.target.value })} />
          <Input aria-label="Link goes to" value={l.to} maxLength={300} placeholder="/shop or https://…" onChange={(e) => set({ ...l, to: e.target.value })} />
        </div>
      )} />
  );
}

async function readFile(file: File) {
  return new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(file); });
}

/** Uploaded images are private files; the editor keeps data URLs to show them here and in the preview. */
function ImageField({ label, value, onChange, images, onImage, hint }: { label: string; value?: string; onChange: (v: string) => void; images: Record<string, string>; onImage: (url: string, data: string) => void; hint?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    if (file.size > 3 * 1024 * 1024) return toast.error('Images must be smaller than 3 MB');
    setBusy(true);
    try {
      const data = await readFile(file);
      const r = await api<{ data: { url: string } }>('/files', { body: { base64: data.split(',')[1] } });
      onImage(r.data.url, data);
      onChange(r.data.url);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const src = value ? images[value] ?? (value.startsWith('https://') ? value : undefined) : undefined;
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-24 items-center justify-center overflow-hidden rounded-sm bg-[#f5f6f8] ring-1 ring-[#e3e6ea] dark:bg-ink-800 dark:ring-ink-700">
          {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : value ? <span className="text-[10px] text-ink-400">loading</span> : <Icon name="image" className="h-6 w-6 text-ink-300" />}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="cursor-pointer"><span className="inline-flex items-center gap-1.5 rounded-sm border border-[#d5d9de] bg-white px-2.5 py-1.5 text-xs font-semibold hover:bg-[#f5f6f8] dark:border-ink-700 dark:bg-ink-900">{busy ? 'Uploading…' : value ? 'Change image' : 'Upload image'}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label={`Upload ${label}`} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          {value && <button type="button" className="text-left text-xs text-red-600 hover:underline" onClick={() => onChange('')}>Remove</button>}
        </div>
      </div>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/** Data URLs of the uploaded files the studio uses (loaded with the signed-in session). */
function useStudioImages(studio: StoreStudio | null) {
  const [images, setImages] = useState<Record<string, string>>({});
  const urls = useMemo(() => (studio ? [studio.brand.logoUrl, studio.hero.imageUrl, ...studio.categories.items.map((c) => c.imageUrl), ...studio.banners.items.map((b) => b.imageUrl)].filter((u): u is string => Boolean(u?.startsWith('/api/v1/files/'))) : []), [studio]);
  const key = urls.join('|');
  useEffect(() => {
    let live = true;
    (async () => {
      for (const u of urls) {
        if (images[u]) continue;
        try {
          const r = await api<Response>(u.replace(/^\/api\/v1/, ''), { raw: true });
          if (!r.ok) continue;
          const blob = await r.blob();
          const data = await new Promise<string>((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.readAsDataURL(blob); });
          if (live) setImages((m) => ({ ...m, [u]: data }));
        } catch {
          /* missing file */
        }
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const add = useCallback((url: string, data: string) => setImages((m) => ({ ...m, [url]: data })), []);
  return { images, add };
}

// ---------------- page ----------------

interface StudioData {
  studio: StoreStudio; defaults: StoreStudio; saved: boolean;
  payments: { mpesaConfigId: string | null; gatewayConfigId: string | null; publicUrl: string };
  options: { mpesa: { id: string; name: string; shortcode: string; environment: string; isDefault: boolean }[]; gateways: { id: string; name: string; label: string; environment: string }[] };
}

export function StoreStudioPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['store-studio'], queryFn: () => api<{ data: StudioData }>('/settings/store-studio').then((r) => r.data) });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<{ data: any[] }>('/categories').then((r) => r.data) });
  const [s, setS] = useState<StoreStudio | null>(null);
  const [pay, setPay] = useState<StudioData['payments'] | null>(null);
  const [section, setSection] = useState<Section>('brand');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const popup = useRef<Window | null>(null);
  const { images, add: addImage } = useStudioImages(s);

  useEffect(() => {
    if (q.data && !s) {
      setS(q.data.studio);
      setPay(q.data.payments);
    }
  }, [q.data, s]);

  const shopUrl = (pay?.publicUrl || 'http://localhost:5174').replace(/\/$/, '');
  const shopOrigin = useMemo(() => {
    try {
      return new URL(shopUrl).origin;
    } catch {
      return null;
    }
  }, [shopUrl]);

  const send = useCallback((msg: unknown) => {
    if (!shopOrigin) return;
    for (const w of [frame.current?.contentWindow, popup.current && !popup.current.closed ? popup.current : null]) w?.postMessage(msg, shopOrigin);
  }, [shopOrigin]);

  // Send the draft whenever it changes (and when a preview says it is ready).
  useEffect(() => {
    if (!s) return;
    const t = setTimeout(() => send({ type: 'afey-studio', studio: s, images }), 150);
    return () => clearTimeout(t);
  }, [s, images, send]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== shopOrigin || e.data?.type !== 'afey-studio-ready') return;
      if (s) (e.source as Window | null)?.postMessage({ type: 'afey-studio', studio: s, images }, shopOrigin);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [s, images, shopOrigin]);
  useEffect(() => {
    const anchor = SECTIONS.find((x) => x.key === section)?.anchor;
    if (anchor) send({ type: 'afey-studio-goto', section: anchor });
  }, [section, send]);
  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (q.isLoading || !s || !pay || !q.data) return <Loading />;
  const d = q.data.defaults;
  const edit = <K extends keyof StoreStudio>(k: K, v: StoreStudio[K]) => {
    setS({ ...s, [k]: v });
    setDirty(true);
  };
  const part = <K extends keyof StoreStudio>(k: K) => (patch: Partial<StoreStudio[K]>) => edit(k, { ...(s[k] as object), ...patch } as StoreStudio[K]);
  const editPay = (patch: Partial<StudioData['payments']>) => {
    setPay({ ...pay, ...patch });
    setDirty(true);
  };
  const imgProps = { images, onImage: addImage };

  const save = async () => {
    setSaving(true);
    try {
      await api('/settings/store-studio', { method: 'PUT', body: { studio: s } });
      await api('/settings/business', { method: 'PATCH', body: { settings: { store: { mpesaConfigId: pay.mpesaConfigId || null, gatewayConfigId: pay.gatewayConfigId || null, publicUrl: pay.publicUrl.trim() } } } });
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['store-studio'] });
      toast.success('Shop design published');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const resetSection = async () => {
    const key = section as keyof StoreStudio;
    if (section === 'payments' || !(key in d)) return;
    if (!(await confirm({ title: 'Reset this section?', message: 'It goes back to the original design. Nothing is saved until you press Publish.', confirmLabel: 'Reset' }))) return;
    edit(key, d[key]);
  };
  const discard = async () => {
    if (!(await confirm({ title: 'Discard changes?', message: 'Your unpublished changes are lost.', confirmLabel: 'Discard' }))) return;
    setS(q.data.studio);
    setPay(q.data.payments);
    setDirty(false);
  };
  const openWindow = () => {
    popup.current = window.open(`${shopUrl}/?studio=1`, 'afey-shop-preview');
  };
  const catOptions = (cats.data ?? []).map((c) => ({ value: c._id, label: c.name }));
  const current = SECTIONS.find((x) => x.key === section)!;

  const editor: Record<Section, ReactNode> = {
    brand: (
      <div className="space-y-4">
        <Field label="Tagline" hint="Shown under the shop name"><Input value={s.brand.tagline} maxLength={80} onChange={(e) => part('brand')({ tagline: e.target.value })} /></Field>
        <ImageField label="Logo" hint="Square PNG or JPEG. Without one, a leaf mark is shown." value={s.brand.logoUrl} onChange={(v) => part('brand')({ logoUrl: v })} {...imgProps} />
        <div>
          <div className="label">Colour themes</div>
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((t) => (
              <button key={t.name} type="button" className="rounded-sm border border-[#e3e6ea] p-2 text-left text-xs font-semibold hover:border-brand-500 dark:border-ink-700" onClick={() => { setS({ ...s, brand: { ...s.brand, primary: t.primary, accent: t.accent, soft: t.soft, footer: t.footer }, hero: { ...s.hero, background: t.hero } }); setDirty(true); }}>
                <span className="mb-1.5 flex h-5 overflow-hidden rounded-sm">{[t.primary, t.accent, t.soft, t.hero].map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}</span>{t.name}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ColorField label="Main colour" value={s.brand.primary} onChange={(v) => part('brand')({ primary: v })} />
          <ColorField label="Highlight colour" value={s.brand.accent} onChange={(v) => part('brand')({ accent: v })} />
          <ColorField label="Soft background" value={s.brand.soft} onChange={(v) => part('brand')({ soft: v })} />
          <ColorField label="Footer colour" value={s.brand.footer} onChange={(v) => part('brand')({ footer: v })} />
        </div>
        <Field label="Corners"><Select value={s.brand.radius} onChange={(e) => part('brand')({ radius: e.target.value as StoreStudio['brand']['radius'] })} options={[{ value: 'soft', label: 'Soft (rounded)' }, { value: 'round', label: 'Very round' }, { value: 'square', label: 'Square' }]} /></Field>
      </div>
    ),
    topBar: (
      <div className="space-y-4">
        <Toggle label="Show the top bar" on={s.topBar.enabled} onChange={(v) => part('topBar')({ enabled: v })} />
        <IconTextEditor label="Messages" items={s.topBar.items} onChange={(v) => part('topBar')({ items: v })} max={4} withText={false} />
      </div>
    ),
    nav: <LinksEditor label="Menu links" items={s.nav} onChange={(v) => edit('nav', v)} max={10} />,
    hero: (
      <div className="space-y-4">
        <Toggle label="Show the hero banner" on={s.hero.enabled} onChange={(v) => part('hero')({ enabled: v })} />
        <Field label="Small heading"><Input value={s.hero.eyebrow} maxLength={40} onChange={(e) => part('hero')({ eyebrow: e.target.value })} /></Field>
        <Field label="Title"><Input value={s.hero.title} maxLength={90} onChange={(e) => part('hero')({ title: e.target.value })} /></Field>
        <TextArea label="Text" value={s.hero.subtitle} maxLength={240} onChange={(v) => part('hero')({ subtitle: v })} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Button text"><Input value={s.hero.buttonText} maxLength={30} onChange={(e) => part('hero')({ buttonText: e.target.value })} /></Field>
          <Field label="Button goes to"><Input value={s.hero.buttonLink} maxLength={300} onChange={(e) => part('hero')({ buttonLink: e.target.value })} /></Field>
        </div>
        <ImageField label="Picture" hint="Wide photo, at least 1000 px. Without one, a drawn basket is shown." value={s.hero.imageUrl} onChange={(v) => part('hero')({ imageUrl: v })} {...imgProps} />
        <div className="grid grid-cols-2 gap-3">
          <ColorField label="Background" value={s.hero.background} onChange={(v) => part('hero')({ background: v })} />
          <Field label="Handwritten note"><Input value={s.hero.note ?? ''} maxLength={40} onChange={(e) => part('hero')({ note: e.target.value })} /></Field>
        </div>
        <IconTextEditor label="Feature badges" items={s.hero.features} onChange={(v) => part('hero')({ features: v })} max={4} />
      </div>
    ),
    categories: (
      <div className="space-y-4">
        <Toggle label="Show categories on the home page" on={s.categories.enabled} onChange={(v) => part('categories')({ enabled: v })} />
        <Field label="Heading"><Input value={s.categories.title ?? ''} placeholder="Shop by Category" maxLength={60} onChange={(e) => part('categories')({ title: e.target.value })} /></Field>
        <p className="text-xs text-ink-500">Leave the list empty to show your product categories automatically.</p>
        <ListEditor title="Category circles" items={s.categories.items} onChange={(v) => part('categories')({ items: v })} max={16} itemLabel={(c) => c.label || 'Category'}
          blank={() => ({ label: cats.data?.[0]?.name ?? 'Category', categoryId: cats.data?.[0]?._id ?? '', color: '#e8f1e4', icon: 'basket' as const })}
          render={(c, set) => (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Select aria-label="Opens category" value={c.categoryId ?? ''} placeholder="All products" options={catOptions} onChange={(e) => set({ ...c, categoryId: e.target.value, label: c.label || catOptions.find((o) => o.value === e.target.value)?.label || '' })} />
                <Input aria-label="Label" value={c.label} maxLength={40} onChange={(e) => set({ ...c, label: e.target.value })} />
                <Select aria-label="Icon" value={c.icon ?? 'basket'} options={ICON_OPTIONS} onChange={(e) => set({ ...c, icon: e.target.value as StudioIconText['icon'] })} />
                <div className="flex items-center gap-2"><input type="color" aria-label="Circle colour" className="h-9 w-11 rounded-sm border border-[#d5d9de] p-0.5" value={c.color} onChange={(e) => set({ ...c, color: e.target.value })} /><span className="text-xs text-ink-500">Circle colour</span></div>
              </div>
              <ImageField label="Picture (instead of the icon)" value={c.imageUrl} onChange={(v) => set({ ...c, imageUrl: v })} {...imgProps} />
            </div>
          )} />
      </div>
    ),
    sections: (
      <div className="space-y-3">
        {([['featured', 'Products you tick “Feature on the home page”'], ['deals', 'Products with a “was” price'], ['newArrivals', 'Newest products first'], ['bestSellers', 'Most sold in the last 90 days']] as const).map(([k, hint]) => (
          <div key={k} className="rounded-sm border border-[#e3e6ea] p-3 dark:border-ink-700">
            <Checkbox label={`Show “${s.sections[k].title || k}”`} checked={s.sections[k].enabled} onChange={(v) => part('sections')({ [k]: { ...s.sections[k], enabled: v } })} />
            <Input className="mt-2" aria-label={`${k} title`} value={s.sections[k].title} maxLength={60} onChange={(e) => part('sections')({ [k]: { ...s.sections[k], title: e.target.value } })} />
            <p className="mt-1 text-xs text-ink-500">{hint}</p>
          </div>
        ))}
      </div>
    ),
    banners: (
      <div className="space-y-4">
        <Toggle label="Show promo banners" on={s.banners.enabled} onChange={(v) => part('banners')({ enabled: v })} />
        <ListEditor title="Banners" items={s.banners.items} onChange={(v) => part('banners')({ items: v })} max={4} itemLabel={(b) => b.title || 'Banner'}
          blank={(): StoreStudio['banners']['items'][number] => ({ title: 'New offer', text: '', buttonText: 'Shop now', link: '/shop', background: '#e9e4da', dark: false })}
          render={(b, set) => (
            <div className="space-y-2">
              <Input aria-label="Banner title" value={b.title} maxLength={60} onChange={(e) => set({ ...b, title: e.target.value })} />
              <Input aria-label="Banner text" value={b.text} maxLength={160} placeholder="Short text" onChange={(e) => set({ ...b, text: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <Input aria-label="Banner button" value={b.buttonText} maxLength={30} onChange={(e) => set({ ...b, buttonText: e.target.value })} />
                <Input aria-label="Banner link" value={b.link} maxLength={300} onChange={(e) => set({ ...b, link: e.target.value })} />
              </div>
              <div className="flex items-center gap-3"><input type="color" aria-label="Banner colour" className="h-9 w-11 rounded-sm border border-[#d5d9de] p-0.5" value={b.background} onChange={(e) => set({ ...b, background: e.target.value })} /><Checkbox label="White text (dark colour)" checked={b.dark} onChange={(v) => set({ ...b, dark: v })} /></div>
              <ImageField label="Picture (right half)" value={b.imageUrl} onChange={(v) => set({ ...b, imageUrl: v })} {...imgProps} />
            </div>
          )} />
      </div>
    ),
    why: (
      <div className="space-y-4">
        <Toggle label="Show “why shop with us”" on={s.why.enabled} onChange={(v) => part('why')({ enabled: v })} />
        <Field label="Heading"><Input value={s.why.title} maxLength={60} onChange={(e) => part('why')({ title: e.target.value })} /></Field>
        <IconTextEditor label="Reasons" items={s.why.items} onChange={(v) => part('why')({ items: v })} max={6} />
      </div>
    ),
    newsletter: (
      <div className="space-y-4">
        <Toggle label="Show the newsletter sign-up" on={s.newsletter.enabled} onChange={(v) => part('newsletter')({ enabled: v })} />
        <Field label="Heading"><Input value={s.newsletter.title} maxLength={60} onChange={(e) => part('newsletter')({ title: e.target.value })} /></Field>
        <TextArea label="Text" value={s.newsletter.text} maxLength={200} onChange={(v) => part('newsletter')({ text: v })} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Button"><Input value={s.newsletter.buttonText} maxLength={30} onChange={(e) => part('newsletter')({ buttonText: e.target.value })} /></Field>
          <Field label="Handwritten note"><Input value={s.newsletter.note ?? ''} maxLength={60} onChange={(e) => part('newsletter')({ note: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-ink-500">Sign-ups are added to Customers with consent to receive offers.</p>
      </div>
    ),
    footer: (
      <div className="space-y-4">
        <TextArea label="About the shop" value={s.footer.about} maxLength={240} onChange={(v) => part('footer')({ about: v })} />
        <div>
          <div className="label">Social media</div>
          <div className="grid gap-2">
            {(['facebook', 'instagram', 'tiktok', 'youtube', 'x', 'pinterest'] as const).map((k) => (
              <Input key={k} aria-label={k} placeholder={`https://${k === 'x' ? 'x' : k}.com/yourshop`} value={s.footer.social[k] ?? ''} maxLength={300} onChange={(e) => part('footer')({ social: { ...s.footer.social, [k]: e.target.value } })} />
            ))}
            <Input aria-label="whatsapp" placeholder="WhatsApp number, e.g. 254712345678" value={s.footer.social.whatsapp ?? ''} maxLength={20} onChange={(e) => part('footer')({ social: { ...s.footer.social, whatsapp: e.target.value.replace(/[^\d+]/g, '') } })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Android app link"><Input value={s.footer.apps.android ?? ''} placeholder="https://play.google.com/…" maxLength={300} onChange={(e) => part('footer')({ apps: { ...s.footer.apps, android: e.target.value } })} /></Field>
          <Field label="iPhone app link"><Input value={s.footer.apps.ios ?? ''} placeholder="https://apps.apple.com/…" maxLength={300} onChange={(e) => part('footer')({ apps: { ...s.footer.apps, ios: e.target.value } })} /></Field>
        </div>
        <ListEditor title="Link columns" items={s.footer.columns} onChange={(v) => part('footer')({ columns: v })} max={4} itemLabel={(c) => c.title || 'Column'} blank={() => ({ title: 'More', links: [] })}
          render={(c, set) => (
            <div className="space-y-2">
              <Input aria-label="Column title" value={c.title} maxLength={40} onChange={(e) => set({ ...c, title: e.target.value })} />
              <LinksEditor label="Links" items={c.links} onChange={(v) => set({ ...c, links: v })} max={8} />
            </div>
          )} />
        <Field label="Copyright line" hint="Empty: © year and shop name"><Input value={s.footer.copyright ?? ''} maxLength={120} onChange={(e) => part('footer')({ copyright: e.target.value })} /></Field>
      </div>
    ),
    pages: (
      <div className="space-y-3">
        <p className="text-xs text-ink-500">Link to a page with <code>/page/address</code>. Leave a blank line between paragraphs; a line ending in “?” shows as a question.</p>
        <ListEditor title="Pages" items={s.pages} onChange={(v) => edit('pages', v)} max={20} itemLabel={(p) => `${p.title} (/page/${p.slug})`} blank={() => ({ slug: `page-${s.pages.length + 1}`, title: 'New page', body: '' })}
          render={(p, set) => (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Input aria-label="Page title" value={p.title} maxLength={80} onChange={(e) => set({ ...p, title: e.target.value })} />
                <Input aria-label="Page address" value={p.slug} maxLength={40} onChange={(e) => set({ ...p, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
              </div>
              <textarea className="input" aria-label="Page text" rows={5} maxLength={10_000} value={p.body} onChange={(e) => set({ ...p, body: e.target.value })} />
            </div>
          )} />
      </div>
    ),
    seo: (
      <div className="space-y-4">
        <Field label="Page title on Google" hint="Up to 70 characters"><Input value={s.seo.title ?? ''} maxLength={70} onChange={(e) => part('seo')({ title: e.target.value })} /></Field>
        <TextArea label="Description on Google" value={s.seo.description ?? ''} maxLength={160} onChange={(v) => part('seo')({ description: v })} />
      </div>
    ),
    payments: (
      <div className="space-y-4">
        <Field label="Shop web address" hint="Where customers open the shop. Used for this preview and to bring card customers back after paying."><Input value={pay.publicUrl} placeholder="https://shop.yoursupermarket.co.ke" onChange={(e) => editPay({ publicUrl: e.target.value })} /></Field>
        <Field label="M-Pesa account for online orders" hint="Online orders can be paid to a different Paybill or Till than the tills use.">
          <Select value={pay.mpesaConfigId ?? ''} placeholder="Same as the POS (branch default)" onChange={(e) => editPay({ mpesaConfigId: e.target.value || null })}
            options={q.data.options.mpesa.map((m) => ({ value: m.id, label: `${m.name}${m.shortcode ? ` · ${m.shortcode}` : ''}${m.environment === 'sandbox' ? ' (sandbox)' : ''}` }))} />
        </Field>
        <Field label="Card payments" hint="A gateway with a hosted checkout page (Paystack, Flutterwave…). Set it up under Settings → Integrations.">
          <Select value={pay.gatewayConfigId ?? ''} placeholder="No card payments" onChange={(e) => editPay({ gatewayConfigId: e.target.value || null })}
            options={q.data.options.gateways.map((g) => ({ value: g.id, label: `${g.name} · ${g.label}${g.environment === 'sandbox' ? ' (sandbox)' : ''}` }))} />
        </Field>
        <p className="text-xs text-ink-500">Delivery, pickup and pay-on-delivery are set on the Online shop page.</p>
      </div>
    ),
  };

  return (
    <div className="space-y-3">
      <PageHeader title="Store studio" subtitle="Design your online shop and see it live before you publish"
        actions={<>
          {dirty && <span className="self-center text-xs font-semibold text-amber-600">Unpublished changes</span>}
          <Button variant="secondary" disabled={!dirty} onClick={discard}>Discard</Button>
          <Button loading={saving} onClick={save}>Publish</Button>
        </>} />
      <div className="grid gap-3 xl:grid-cols-[400px_1fr]">
        <div className="card flex min-h-0 flex-col xl:h-[calc(100vh-190px)]">
          <div className="panel-head">
            <Select aria-label="Section" className="!py-1.5 text-sm font-semibold" value={section} onChange={(e) => setSection(e.target.value as Section)} options={SECTIONS.map((x) => ({ value: x.key, label: x.label }))} />
          </div>
          <div className="flex min-h-0 flex-1">
            <nav className="hidden w-14 shrink-0 flex-col border-r border-[#e3e6ea] bg-[#f5f6f8] py-1 dark:border-ink-700 dark:bg-ink-900 sm:flex" aria-label="Studio sections">
              {SECTIONS.map((x) => (
                <button key={x.key} type="button" title={x.label} aria-label={x.label} aria-current={section === x.key} onClick={() => setSection(x.key)}
                  className={cx('mx-1 my-0.5 flex h-10 items-center justify-center rounded-sm', section === x.key ? 'bg-brand-500 text-white' : 'text-ink-500 hover:bg-white dark:hover:bg-ink-800')}>
                  <Icon name={x.icon} className="h-[18px] w-[18px]" />
                </button>
              ))}
            </nav>
            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              <div className="mb-4 flex items-start justify-between gap-2">
                <div><h2 className="text-sm font-bold">{current.label}</h2><p className="text-xs text-ink-500">{current.hint}</p></div>
                {section !== 'payments' && <button type="button" className="shrink-0 text-xs text-ink-500 hover:text-brand-600 hover:underline" onClick={resetSection}>Reset</button>}
              </div>
              {editor[section]}
            </div>
          </div>
        </div>
        <div className="card flex min-h-[600px] flex-col xl:h-[calc(100vh-190px)]">
          <div className="panel-head gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold"><span className="h-2 w-2 rounded-full bg-green-500" />Live preview</span>
            <span className="min-w-0 flex-1 truncate rounded-sm bg-[#f5f6f8] px-2 py-1 text-[11px] text-ink-500 dark:bg-ink-800">{shopUrl}</span>
            <div className="flex rounded-sm border border-[#d5d9de] dark:border-ink-700" role="group" aria-label="Preview size">
              {(['desktop', 'mobile'] as const).map((v) => <button key={v} type="button" aria-pressed={device === v} className={cx('px-2.5 py-1 text-xs font-semibold capitalize', device === v ? 'bg-brand-500 text-white' : 'text-ink-600')} onClick={() => setDevice(v)}>{v}</button>)}
            </div>
            <button type="button" className="panel-tool" aria-label="Reload preview" title="Reload preview" onClick={() => setReloadKey((k) => k + 1)}><Icon name="refresh" className="h-4 w-4" /></button>
            <button type="button" className="panel-tool" aria-label="Open preview in a new window" title="Open preview in a new window" onClick={openWindow}><Icon name="expand" className="h-4 w-4" /></button>
          </div>
          <div className="flex flex-1 justify-center overflow-hidden bg-[#e9ecef] p-3 dark:bg-ink-950">
            {shopOrigin ? (
              <iframe key={`${shopUrl}-${reloadKey}`} ref={frame} title="Shop preview" src={`${shopUrl}/?studio=1`}
                className={cx('h-full rounded-sm bg-white shadow-sm transition-all', device === 'mobile' ? 'w-[390px]' : 'w-full')} />
            ) : <p className="self-center text-sm text-ink-500">Enter the shop web address under Payments & address to see the preview.</p>}
          </div>
          <p className="border-t border-[#e3e6ea] px-3 py-2 text-[11px] text-ink-500 dark:border-ink-700">Changes show here at once. Customers see them after you press <strong>Publish</strong>. If the preview stays blank, the shop website is not running at this address or does not allow this page to show it (SHOP_FRAME_ANCESTORS); use the new-window button.</p>
        </div>
      </div>
    </div>
  );
}
