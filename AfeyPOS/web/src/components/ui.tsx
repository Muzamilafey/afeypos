import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icon } from './icons';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({ variant = 'primary', size = 'md', loading, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' | 'xl'; loading?: boolean }) {
  const v = {
    primary: 'bg-brand-500 text-white hover:bg-brand-600 disabled:bg-brand-300 dark:disabled:bg-brand-800',
    secondary: 'border border-[#d5d9de] bg-white text-ink-700 hover:bg-[#f5f6f8] dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100 dark:hover:bg-ink-800',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    ghost: 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800',
  }[variant];
  const s = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm', lg: 'px-5 py-3 text-base', xl: 'px-6 py-4 text-lg' }[size];
  return (
    <button {...rest} disabled={rest.disabled || loading} className={cx('inline-flex items-center justify-center gap-2 rounded-sm font-semibold transition disabled:cursor-not-allowed', v, s, className)}>
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <svg className={cx('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-label="Loading"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" /><path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="4" /></svg>;
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600" role="alert">{error}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  return <input ref={ref} {...props} className={cx('input', props.className)} />;
});

export function Select({ options, placeholder, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select {...props} className={cx('input', props.className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function MoneyInput({ value, onChange, ...rest }: { value: number | null | undefined; onChange: (cents: number | null) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value === null || value === undefined ? '' : (value / 100).toFixed(2));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(value === null || value === undefined ? '' : (value / 100).toFixed(2));
      last.current = value;
    }
  }, [value]);
  return (
    <Input
      inputMode="decimal"
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(/,/g, ''));
        const cents = e.target.value.trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 100);
        last.current = cents;
        onChange(cents);
      }}
    />
  );
}

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'green' | 'red' | 'amber' | 'blue'; children: ReactNode }) {
  const t = { gray: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200', green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300', red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', blue: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300' }[tone];
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', t)}>{children}</span>;
}

export function statusTone(s: string): 'gray' | 'green' | 'red' | 'amber' | 'blue' {
  if (['completed', 'succeeded', 'active', 'approved', 'received', 'sent', 'posted', 'open', 'delivered', 'converted', 'ready', 'collected'].includes(s)) return 'green';
  if (['failed', 'voided', 'cancelled', 'rejected', 'suspended', 'dead', 'expired', 'returned'].includes(s)) return 'red';
  if (['pending', 'trial', 'past_due', 'partially_returned', 'partially_received', 'in_transit', 'counting', 'queued', 'draft'].includes(s)) return 'amber';
  return 'gray';
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status.replace(/_/g, ' ')}</Badge>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[15px] font-bold text-ink-800 dark:text-white">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-500 dark:text-ink-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Panel with a header strip: title, actions and the template toolbar (refresh, minimise, maximise). */
export function Card({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [max, setMax] = useState(false);
  const qc = useContext(QueryRefreshCtx);
  return (
    <section className={cx('card', max && 'fixed inset-4 z-50 overflow-auto shadow-2xl', className)}>
      {(title || actions) && (
        <header className="panel-head">
          <h2 className="truncate text-[13px] font-bold text-ink-800 dark:text-white">{title}</h2>
          <div className="flex items-center gap-1">
            {actions}
            {title && <span className="ml-1 hidden items-center sm:flex">
              {qc && <button type="button" className="panel-tool" aria-label="Refresh" title="Refresh" onClick={() => qc()}><Icon name="refresh" className="h-3.5 w-3.5" /></button>}
              <button type="button" className="panel-tool" aria-label={collapsed ? 'Expand panel' : 'Minimise panel'} title={collapsed ? 'Expand' : 'Minimise'} onClick={() => setCollapsed((v) => !v)}><Icon name={collapsed ? 'plus' : 'minus'} className="h-3.5 w-3.5" /></button>
              <button type="button" className="panel-tool" aria-label={max ? 'Restore panel' : 'Maximise panel'} title={max ? 'Restore' : 'Maximise'} onClick={() => setMax((v) => !v)}><Icon name={max ? 'x' : 'expand'} className="h-3.5 w-3.5" /></button>
            </span>}
          </div>
        </header>
      )}
      {!collapsed && <div className={cx('p-3', bodyClassName)}>{children}</div>}
    </section>
  );
}

/** Lets panels refresh the page's data without each page wiring it (set by the app shell). */
export const QueryRefreshCtx = createContext<(() => void) | null>(null);

const TILE_BG = { purple: 'bg-tile-purple', blue: 'bg-tile-blue', red: 'bg-tile-red', yellow: 'bg-tile-yellow', teal: 'bg-tile-teal', green: 'bg-tile-green' } as const;
const TILE_COLORS = Object.values(TILE_BG);
const tileColor = (key: string) => TILE_COLORS[[...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % TILE_COLORS.length];

/** Solid colour figure tile (admin template). Red tone always shows red, green tone green. */
export function Stat({ label, value, hint, tone, color, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'red' | 'green'; color?: 'purple' | 'blue' | 'red' | 'yellow' | 'teal' | 'green'; icon?: string }) {
  const bg = color ? TILE_BG[color] : tone === 'red' ? TILE_BG.red : tone === 'green' ? TILE_BG.green : tileColor(label);
  return (
    <div className={cx('relative overflow-hidden rounded-sm p-3 text-white shadow-[0_1px_1px_rgba(0,0,0,0.06)]', bg)}>
      <div className="relative z-10 text-2xl font-bold tabular-nums leading-tight">{value}</div>
      <div className="relative z-10 text-[12px] font-semibold opacity-90">{label}</div>
      {hint && <div className="relative z-10 mt-1 text-[11px] opacity-80 [&_a]:underline">{hint}</div>}
      <svg viewBox="0 0 60 40" className="pointer-events-none absolute -bottom-1 right-2 h-12 w-20 opacity-25" aria-hidden="true">
        {icon ? null : <g fill="currentColor">{[12, 22, 16, 30, 24, 36].map((h, i) => <rect key={i} x={4 + i * 9} y={40 - h} width="6" height={h} rx="1" />)}</g>}
      </svg>
      {icon && <span className="pointer-events-none absolute bottom-1 right-2 opacity-25" aria-hidden="true"><Icon name={icon} className="h-12 w-12" /></span>}
    </div>
  );
}

export function EmptyState({ title, children, icon = 'box' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center text-ink-500">
      <Icon name={icon} className="mb-3 h-10 w-10 text-ink-300" />
      <p className="font-medium text-ink-700 dark:text-ink-200">{title}</p>
      {children && <div className="mt-1 text-sm">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{msg}</div>;
}

export function Loading() {
  return <div className="flex items-center justify-center p-10 text-ink-500"><Spinner /></div>;
}

/**
 * Dialogs. Centred card by default; `variant="drawer"` slides in from the right for long forms. On phones both
 * become a bottom sheet. Optional icon and subtitle in the header; the footer is a tinted action bar.
 */
/**
 * Dialogs open as a panel from the right taking half the page (wider for "xl", like product browsing), with
 * the actions pinned at the bottom; on phones they rise as a bottom sheet. "center" keeps a centred box.
 */
export function Modal({ open, onClose, title, subtitle, icon, children, footer, size = 'md', variant = 'drawer' }: {
  open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; icon?: string; children: ReactNode; footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl'; variant?: 'center' | 'drawer';
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    // Keep the page behind still and put focus inside the dialog.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const active = document.activeElement as HTMLElement | null;
    setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) panel.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button:not([aria-label=Close])')?.focus();
    }, 0);
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
      active?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const drawer = variant === 'drawer';
  const w = drawer ? (size === 'xl' ? 'sm:w-[70vw] sm:min-w-[560px]' : 'sm:w-1/2 sm:min-w-[460px]') : { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <div className={cx('modal-backdrop fixed inset-0 z-50 flex bg-[#14171c]/55 backdrop-blur-[2px]', drawer ? 'items-end justify-end sm:items-stretch' : 'items-end justify-center sm:items-center sm:p-4')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={id}
        className={cx('relative flex w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-ink-900',
          drawer ? 'modal-drawer max-h-[94vh] rounded-t-xl sm:h-full sm:max-h-none sm:rounded-none' : 'modal-panel max-h-[94vh] rounded-t-xl sm:max-h-[90vh] sm:rounded-lg', w)}>
        <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-brand-500 via-[#3fb8b0] to-[#9b7fd6]" aria-hidden="true" />
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-ink-200 sm:hidden" aria-hidden="true" />
        <header className="flex items-start gap-3 px-6 pb-4 pt-5">
          {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-200"><Icon name={icon} className="h-5 w-5" /></span>}
          <div className="min-w-0 flex-1">
            <h2 id={id} className="text-[15px] font-bold leading-6 text-ink-900 dark:text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-500 dark:text-ink-400">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-400 transition hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-ink-800" aria-label="Close"><Icon name="x" className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-ink-100 px-6 py-5 dark:border-ink-800">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-100 bg-[#f7f8fa] px-6 py-3.5 dark:border-ink-800 dark:bg-ink-950/40">{footer}</footer>}
      </div>
    </div>
  );
}

// ---- toasts ----
interface Toast { id: number; tone: 'success' | 'error' | 'info'; text: string }
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* Top right, under the header: clear of dialog footers and the side panel's buttons. */}
      <div className="pointer-events-none fixed right-4 top-16 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto rounded-lg px-4 py-3 text-sm text-white shadow-lg', t.tone === 'success' && 'bg-emerald-600', t.tone === 'error' && 'bg-red-600', t.tone === 'info' && 'bg-ink-800')}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const push = useContext(ToastCtx);
  return { success: (t: string) => push('success', t), error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e)), info: (t: string) => push('info', t) };
}

// ---- confirm dialog ----
const ConfirmCtx = createContext<(opts: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }) => Promise<boolean>>(async () => false);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((opts: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={Boolean(state)} onClose={() => close(false)} title={state?.title ?? ''} icon={state?.danger ? 'flag' : 'info'} size="sm" footer={<><Button variant="secondary" onClick={() => close(false)}>Cancel</Button><Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel ?? 'Confirm'}</Button></>}>
        <div className="text-sm text-ink-600 dark:text-ink-300">{state?.message}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-[#e1e4e8] dark:border-ink-800" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} className={cx('-mb-px whitespace-nowrap border px-3 py-2 text-[13px] font-semibold', value === t.key ? 'border-[#e1e4e8] border-b-white bg-white text-ink-800 dark:border-ink-800 dark:border-b-ink-900 dark:bg-ink-900 dark:text-white' : 'border-transparent text-ink-500 hover:text-ink-800')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
