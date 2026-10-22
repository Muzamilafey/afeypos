import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icon } from './icons';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({ variant = 'primary', size = 'md', loading, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' | 'xl'; loading?: boolean }) {
  const v = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300',
    secondary: 'border border-ink-300 bg-white text-ink-800 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100 dark:hover:bg-ink-800',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
    ghost: 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800',
  }[variant];
  const s = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm', lg: 'px-5 py-3 text-base', xl: 'px-6 py-4 text-lg' }[size];
  return (
    <button {...rest} disabled={rest.disabled || loading} className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed', v, s, className)}>
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

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('input', props.className)} />;
}

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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-ink-100 px-4 py-3 dark:border-ink-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'red' | 'green' }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tone === 'red' && 'text-red-600', tone === 'green' && 'text-emerald-600')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
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

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={id} className={cx('card max-h-[92vh] w-full overflow-hidden rounded-b-none sm:rounded-xl', w)}>
        <header className="flex items-center justify-between border-b border-ink-100 px-5 py-3 dark:border-ink-800">
          <h2 id={id} className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800" aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-ink-100 px-5 py-3 dark:border-ink-800">{footer}</footer>}
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
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
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
      <Modal open={Boolean(state)} onClose={() => close(false)} title={state?.title ?? ''} size="sm" footer={<><Button variant="secondary" onClick={() => close(false)}>Cancel</Button><Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel ?? 'Confirm'}</Button></>}>
        <div className="text-sm text-ink-600 dark:text-ink-300">{state?.message}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-ink-200 dark:border-ink-800" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.key ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-ink-500 hover:text-ink-800')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
