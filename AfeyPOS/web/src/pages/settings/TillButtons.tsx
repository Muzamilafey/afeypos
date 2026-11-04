import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { TillButtonStyle, TillButtons } from '../../lib/tillButtons';
import { ButtonArt, POS_TILE_NAMES, PosTile, type PosTileKind } from '../../components/PosTiles';
import { Icon, ICON_NAMES } from '../../components/icons';
import { Button, Card, Field, Input, Modal, PageHeader, useToast } from '../../components/ui';

const TILES: PosTileKind[] = ['mpesa', 'cash', 'card', 'loyalty', 'voucher', 'customer', 'hold'];
/** The More menu's buttons with their usual icon and colour (as on the till). */
const MORE: { key: string; label: string; icon: string; tone: string }[] = [
  { key: 'more', label: 'More', icon: 'grid', tone: 'text-ink-600 bg-ink-100' },
  { key: 'qty', label: 'Quantity', icon: 'plus', tone: 'text-emerald-600 bg-emerald-50' },
  { key: 'ldisc', label: 'Line discount', icon: 'percent', tone: 'text-sky-600 bg-sky-50' },
  { key: 'del', label: 'Delete item', icon: 'trash', tone: 'text-red-600 bg-red-50' },
  { key: 'gdisc', label: 'Sale discount', icon: 'tag', tone: 'text-violet-600 bg-violet-50' },
  { key: 'resume', label: 'Resume held', icon: 'play', tone: 'text-orange-600 bg-orange-50' },
  { key: 'browse', label: 'Browse products', icon: 'grid', tone: 'text-teal-600 bg-teal-50' },
  { key: 'endshift', label: 'End shift', icon: 'clock', tone: 'text-amber-700 bg-amber-50' },
  { key: 'drawer', label: 'Open drawer', icon: 'wallet', tone: 'text-emerald-700 bg-emerald-50' },
  { key: 'drop', label: 'Drop cash', icon: 'wallet', tone: 'text-amber-700 bg-amber-50' },
  { key: 'display', label: 'Customer display', icon: 'expand', tone: 'text-sky-700 bg-sky-50' },
  { key: 'clear', label: 'Clear sale', icon: 'x', tone: 'text-ink-600 bg-ink-100' },
];

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]!); r.onerror = reject; r.readAsDataURL(file); });

/** Settings > Till buttons: the owner chooses the icon or picture, wording and colours of each checkout button. */
export function TillButtonsPage() {
  const toast = useToast();
  const { reload } = useAuth();
  const [buttons, setButtons] = useState<TillButtons | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Load once; the toast helper changes each render, so it must not be a dependency (that refetch wiped edits).
  useEffect(() => { api<{ data: TillButtons }>('/settings/till-buttons').then((r) => setButtons(r.data)).catch((e) => toast.error(e)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!buttons) return null;
  const set = (key: string, look: TillButtonStyle | undefined) => setButtons({ ...buttons, [key]: look });
  const save = async () => {
    setBusy(true);
    try {
      const clean = Object.fromEntries(Object.entries(buttons).filter(([, v]) => v && Object.values(v).some(Boolean)));
      await api('/settings/till-buttons', { method: 'PUT', body: { buttons: clean } });
      await reload();
      toast.success('Till buttons saved: the tills show them now');
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const nameOf = (key: string) => (TILES.includes(key as PosTileKind) ? POS_TILE_NAMES[key as PosTileKind] : MORE.find((m) => m.key === key)?.label ?? key);
  return (
    <div className="max-w-6xl">
      <PageHeader title="Till buttons" subtitle="Choose the icon or your own picture, the wording and the colours of the checkout buttons and the More actions. Click a button to change it."
        actions={<Button loading={busy} onClick={save}>Save buttons</Button>} />
      <Card title="Checkout buttons" className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="till-button-previews">
          {TILES.map((k) => (
            <div key={k} className="space-y-1">
              <PosTile kind={k} label={`Change ${POS_TILE_NAMES[k]}`} onClick={() => setEditing(k)} custom={buttons[k]} />
              <div className="flex items-center justify-between px-0.5 text-[11px] text-ink-500"><span>{POS_TILE_NAMES[k]}</span>{buttons[k] && <span className="font-semibold text-brand-600">Changed</span>}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="More actions">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
          {MORE.map((m) => {
            const look = buttons[m.key];
            return (
              <button key={m.key} type="button" aria-label={`Change ${m.label}`} onClick={() => setEditing(m.key)}
                style={{ ...(look?.bg ? { background: look.bg } : {}), ...(look?.text ? { color: look.text } : {}) }}
                className="relative flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-lg border border-ink-100 bg-white p-3 transition hover:-translate-y-px hover:border-brand-300 hover:shadow-md dark:border-ink-800 dark:bg-ink-900">
                {look && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand-500" aria-label="Changed" />}
                <ButtonArt look={look} icon={m.icon} className={`h-9 w-9 rounded-full ${m.tone}`} size="h-[18px] w-[18px]" />
                <span className="text-center text-[12px] font-extrabold uppercase tracking-wide">{look?.label || m.label}</span>
              </button>
            );
          })}
        </div>
      </Card>
      {editing && <EditButton name={nameOf(editing)} look={buttons[editing] ?? {}} onClose={() => setEditing(null)} onChange={(l) => set(editing, l)} />}
    </div>
  );
}

function EditButton({ name, look, onChange, onClose }: { name: string; look: TillButtonStyle; onChange: (l: TillButtonStyle | undefined) => void; onClose: () => void }) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [q, setQ] = useState('');
  // The current button's look, merged across every change (the prop can lag behind rapid edits).
  const current = useRef<TillButtonStyle>(look);
  const [, force] = useState(0);
  const patch = (p: Partial<TillButtonStyle>) => { current.current = { ...current.current, ...p }; onChange({ ...current.current }); force((n) => n + 1); };
  const upload = async (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast.error('Use a PNG, JPEG or WEBP picture');
    if (file.size > 3_000_000) return toast.error('The picture must be smaller than 3 MB');
    setUploading(true);
    try {
      const r = await api<{ data: { id: string } }>('/files', { body: { base64: await toBase64(file), purpose: 'attachment' } });
      patch({ image: r.data.id, icon: undefined });
    } catch (e) { toast.error(e); } finally { setUploading(false); }
  };
  const look2 = current.current;
  const icons = ICON_NAMES().filter((i) => !q || i.includes(q.toLowerCase()));
  return (
    <Modal open onClose={onClose} title={`Change: ${name}`} icon="sliders" size="lg"
      footer={<><Button variant="secondary" onClick={() => { onChange(undefined); onClose(); }}>Back to the usual look</Button><Button onClick={onClose}>Done</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Wording" hint="Blank = the usual" className="sm:col-span-3"><Input value={look2.label ?? ''} maxLength={24} placeholder={name} onChange={(e) => patch({ label: e.target.value || undefined })} /></Field>
          <Field label="Background colour">
            <div className="flex items-center gap-2"><input type="color" aria-label="Background colour" value={look2.bg ?? '#ffffff'} onChange={(e) => patch({ bg: e.target.value })} className="h-9 w-14 cursor-pointer rounded border border-ink-200" />{look2.bg && <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => patch({ bg: undefined })}>Usual</button>}</div>
          </Field>
          <Field label="Text colour">
            <div className="flex items-center gap-2"><input type="color" aria-label="Text colour" value={look2.text ?? '#111827'} onChange={(e) => patch({ text: e.target.value })} className="h-9 w-14 cursor-pointer rounded border border-ink-200" />{look2.text && <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => patch({ text: undefined })}>Usual</button>}</div>
          </Field>
          <Field label="Your own picture" hint="PNG, JPEG or WEBP, up to 3 MB">
            <div className="flex items-center gap-2">
              <label className="btn-secondary inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-ink-200 px-3 py-1.5 text-sm font-semibold">
                <Icon name="upload" className="h-4 w-4" />{uploading ? 'Uploading…' : 'Upload'}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload picture" onChange={(e) => upload(e.target.files?.[0])} />
              </label>
              {look2.image && <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => patch({ image: undefined })}>Remove picture</button>}
            </div>
          </Field>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">Or pick an icon</span>
            <Input className="max-w-[12rem]" placeholder="Search icons" aria-label="Search icons" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="grid max-h-64 grid-cols-6 gap-1.5 overflow-y-auto sm:grid-cols-10" role="listbox" aria-label="Icons">
            {icons.map((i) => (
              <button key={i} type="button" role="option" aria-selected={look2.icon === i} title={i} aria-label={`Icon ${i}`} onClick={() => patch({ icon: i, image: undefined })}
                className={`flex h-10 items-center justify-center rounded-md border ${look2.icon === i ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-500/30' : 'border-ink-100 hover:border-brand-300 dark:border-ink-800'}`}>
                <Icon name={i} className="h-5 w-5" />
              </button>
            ))}
          </div>
          {look2.icon && <button type="button" className="mt-2 text-xs text-brand-600 hover:underline" onClick={() => patch({ icon: undefined })}>Use the usual drawing</button>}
        </div>
      </div>
    </Modal>
  );
}
