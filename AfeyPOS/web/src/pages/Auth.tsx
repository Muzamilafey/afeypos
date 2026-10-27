import { Logo } from '../components/Logo';
import { forwardRef, useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { bridgeConfigured, fingerprint } from '../lib/bridge';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Field, Input, Card, Modal, cx, Spinner } from '../components/ui';
import { Icon } from '../components/icons';

interface PublicConfig {
  deploymentMode: 'standalone' | 'hq' | 'branch';
  branchCode: string | null;
  setupRequired: boolean;
  tenant: { name: string; tagline?: string | null; logoUrl?: string | null } | null;
}

export function usePublicConfig() {
  return useQuery({ queryKey: ['public-config'], queryFn: () => api<PublicConfig>('/public/config') });
}

/** Business logo from settings, falling back to the Afey mark. */
function BusinessMark({ cfg, className }: { cfg?: PublicConfig; className: string }) {
  const [failed, setFailed] = useState(false);
  const url = cfg?.tenant?.logoUrl;
  if (url && !failed) return <img src={url} alt={cfg?.tenant?.name ?? 'Business logo'} className={cx('object-contain', className)} onError={() => setFailed(true)} />;
  return <Logo className={cx('object-contain', className)} />;
}

type AuthTab = 'signin';

const tabClass = (active: boolean) =>
  cx('border-b-2 pb-2 text-lg font-semibold transition', active ? 'border-brand-600 text-brand-700 dark:border-brand-100 dark:text-white' : 'border-transparent text-ink-300 hover:text-ink-500');

/**
 * Split auth card over the wallpaper: the form on the left and a charcoal panel on the right showing
 * the business logo, name and tagline.
 */
function Shell({ title, subtitle, children, wide, tab }: { title: string; subtitle?: string; children: ReactNode; wide?: boolean; tab?: AuthTab }) {
  const cfg = usePublicConfig().data;
  const businessName = cfg?.tenant?.name ?? 'Afey POS';
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-950 p-4 sm:p-8">
      <div aria-hidden="true" className="auth-wallpaper absolute inset-0" />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/20 to-black/55" />
      <div className={cx('relative grid w-full overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5 dark:bg-ink-900', wide ? 'max-w-6xl lg:grid-cols-[1.7fr_1fr]' : 'max-w-4xl md:grid-cols-[1.15fr_1fr]')}>
        <section className="flex flex-col px-6 py-8 sm:px-10 sm:py-10">
          <div className="mb-8 flex items-center gap-3">
            <Logo className="h-9 w-auto" />
            <span className="text-sm font-semibold tracking-tight text-brand-700 dark:text-brand-100">Afey POS</span>
          </div>
          {/* On small screens the side panel is hidden, so show the business here. */}
          <div className={cx('mb-6 flex items-center gap-4', wide ? 'lg:hidden' : 'md:hidden')}>
            <BusinessMark cfg={cfg} className="h-14 w-14 rounded-xl bg-white p-1 shadow ring-1 ring-ink-100" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{businessName}</div>
              {cfg?.tenant?.tagline && <div className="truncate text-xs text-ink-500">{cfg.tenant.tagline}</div>}
            </div>
          </div>
          {tab ? (
            <nav className="mb-6 flex gap-8" aria-label="Account">
              <Link to="/login" aria-current={tab === 'signin' ? 'page' : undefined} className={tabClass(tab === 'signin')}>Sign in</Link>
            </nav>
          ) : (
            <h1 className="mb-1 text-xl font-semibold">{title}</h1>
          )}
          {subtitle && <p className="mb-6 text-sm text-ink-500">{subtitle}</p>}
          <div className="flex-1">{children}</div>
        </section>
        <aside className={cx('relative hidden flex-col items-center justify-center overflow-hidden bg-brand-600 px-10 py-12 text-center text-white', wide ? 'lg:flex' : 'md:flex')}>
          <div aria-hidden="true" className="absolute -right-40 -top-32 h-[34rem] w-[34rem] rounded-full bg-white/[.05]" />
          <div aria-hidden="true" className="absolute -bottom-40 -right-16 h-[30rem] w-[30rem] rounded-full bg-white/[.06]" />
          <div aria-hidden="true" className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-black/10" />
          <div className="relative flex h-40 w-40 items-center justify-center rounded-full bg-white p-5 shadow-2xl ring-8 ring-white/10">
            <BusinessMark cfg={cfg} className="h-full w-full" />
          </div>
          <h2 className="relative mt-8 text-2xl font-semibold leading-tight">{businessName}</h2>
          <p className="relative mt-2 max-w-xs text-sm text-white/70">{cfg?.tenant?.tagline ?? 'Point of sale and business management for every kind of shop'}</p>
          <p className="absolute bottom-6 text-xs text-white/40">Powered by Afey POS</p>
        </aside>
      </div>
    </div>
  );
}

/** Text input with a leading icon (and optional trailing button), styled for the auth cards. */
const IconInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon: string; trailing?: ReactNode }>(function IconInput({ icon, trailing, className, ...props }, ref) {
  return (
    <div className="relative">
      <Icon name={icon} className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" />
      <input
        ref={ref}
        {...props}
        className={cx('block w-full rounded-xl border border-ink-200 bg-ink-50/60 py-3 pl-12 pr-12 text-sm shadow-sm placeholder-ink-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200 dark:border-ink-700 dark:bg-ink-950 dark:focus:ring-brand-700', className)}
      />
      {trailing && <div className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</div>}
    </div>
  );
});

type LoginMode = 'password' | 'pin' | 'card' | 'finger';
const MODES: { key: LoginMode; label: string; icon: string }[] = [
  { key: 'password', label: 'Password', icon: 'lock' },
  { key: 'pin', label: 'PIN', icon: 'keypad' },
  { key: 'card', label: 'Staff card', icon: 'idcard' },
  { key: 'finger', label: 'Fingerprint', icon: 'finger' },
];

export function LoginPage() {
  const { login, completeMfa, pinLogin, cardLogin, fingerprintLogin } = useAuth();
  const nav = useNavigate();
  const cfg = usePublicConfig();
  const [mode, setMode] = useState<LoginMode>('password');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [card, setCard] = useState('');
  const [mfa, setMfa] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cfg.data?.setupRequired) nav('/setup');
  }, [cfg.data, nav]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PIN_REQUIRED') pinRef.current?.focus();
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (mfa) await completeMfa(mfa, code);
      else if (mode === 'pin') await pinLogin(email, secret);
      else if (mode === 'card') await cardLogin(card.trim());
      else if (mode === 'finger') {
        const r = await fingerprint<{ loginToken: string }>('login');
        await fingerprintLogin(r.loginToken);
      } else {
        const r = await login(email, secret);
        if (r.mfaRequired) {
          setMfa(r.mfaToken!);
          return;
        }
      }
      nav('/');
    });
  };

  const pin = mode === 'pin';
  const secretInput = (
    <IconInput
      ref={pinRef}
      icon={pin ? 'keypad' : 'lock'}
      aria-label={pin ? 'PIN' : 'Password'}
      type={show ? 'text' : 'password'}
      autoComplete={pin ? 'off' : 'current-password'}
      inputMode={pin ? 'numeric' : undefined}
      maxLength={pin ? 8 : undefined}
      required={mode !== 'card'}
      value={secret}
      onChange={(e) => setSecret(pin ? e.target.value.replace(/\D/g, '') : e.target.value)}
      placeholder={pin ? '4-8 digit PIN' : 'Password'}
      trailing={<button type="button" onClick={() => setShow((v) => !v)} className="rounded-lg p-2 text-ink-400 hover:text-ink-700" aria-label={show ? 'Hide' : 'Show'}><Icon name={show ? 'eyeOff' : 'eye'} className="h-4 w-4" /></button>}
    />
  );
  return (
    <Shell title="Sign in" tab="signin">
      <form onSubmit={submit} className="space-y-5">
        {mfa ? (
          <>
            <p className="text-sm text-ink-500">Enter the 6-digit code from your authenticator app.</p>
            <IconInput icon="lock" aria-label="Authenticator code" autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          </>
        ) : (
          <>
            <div role="radiogroup" aria-label="Sign in with" className="grid grid-cols-4 gap-1 rounded-2xl bg-ink-100 p-1 text-xs font-medium dark:bg-ink-800">
              {MODES.map((m) => (
                <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} onClick={() => { setMode(m.key); setSecret(''); setError(null); }}
                  className={cx('flex flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 transition-colors', mode === m.key ? 'bg-brand-600 text-white shadow dark:bg-brand-100 dark:text-brand-900' : 'text-ink-500 hover:text-ink-700')}>
                  <Icon name={m.icon} className="h-5 w-5" />
                  <span className="whitespace-nowrap">{m.label}</span>
                </button>
              ))}
            </div>
            {(mode === 'password' || mode === 'pin') && (
              <>
                <IconInput icon="mail" aria-label="Email or username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email or username" />
                {secretInput}
              </>
            )}
            {mode === 'card' && (
              <>
                {/* The card alone signs in: scanning it (the scanner sends Enter) submits the form. */}
                <IconInput icon="idcard" aria-label="Staff card" autoFocus autoComplete="off" type="password" value={card} required
                  onChange={(e) => setCard(e.target.value)}
                  placeholder="Scan your staff card" />
                <p className="text-xs text-ink-500">Scan your card: it signs you in straight away.</p>
              </>
            )}
            {mode === 'finger' && (
              <div className="rounded-2xl border border-dashed border-ink-300 p-6 text-center dark:border-ink-700">
                <Icon name="finger" className="mx-auto h-12 w-12 text-brand-600" />
                <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">{busy ? 'Place your finger on the reader…' : bridgeConfigured() ? 'Press Sign in, then place your enrolled finger on the reader.' : 'This computer has no fingerprint reader set up (Hardware → This computer).'}</p>
              </div>
            )}
          </>
        )}
        <ErrorBox error={error} />
        <div className="flex flex-col-reverse items-stretch gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
          {mfa ? (
            <button type="button" className="text-sm text-ink-500 hover:underline" onClick={() => { setMfa(null); setCode(''); }}>Back</button>
          ) : (
            <div className="flex gap-4 text-sm">
              <Link to="/forgot-password" className="text-brand-700 hover:underline dark:text-brand-200">Forgot your password?</Link>
              <button type="button" className="text-brand-700 hover:underline dark:text-brand-200" onClick={() => setClock(true)}>Clock in / out</button>
            </div>
          )}
          <Button type="submit" loading={busy} size="lg" className="rounded-full px-10">{mfa ? 'Verify' : 'Sign in'}</Button>
        </div>
      </form>
      {clock && <ClockModal onClose={() => setClock(false)} />}
    </Shell>
  );
}

/** Attendance from the sign-in screen: staff card (+PIN) or fingerprint; nobody needs to be signed in. */
function ClockModal({ onClose }: { onClose: () => void }) {
  const [card, setCard] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ name: string; kind: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (fn: () => Promise<{ name: string; kind: string }>) => {
    setBusy(true);
    setError(null);
    try {
      setDone(await fn());
      setCard('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const byCard = () => go(async () => (await api<{ data: { name: string; kind: string } }>('/auth/clock', { body: { code: card.trim() } })).data);
  const byFinger = () => go(async () => {
    const r = await fingerprint<{ attendance: { kind: string }; user: { name: string } }>('attendance');
    return { name: r.user.name, kind: r.attendance.kind };
  });
  return (
    <Modal open onClose={onClose} title="Clock in / out" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={busy} disabled={!card} onClick={byCard}>Clock with card</Button></>}>
      {done && <p className="mb-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200" role="status">{done.name}: {done.kind === 'clock_in' ? 'clocked in' : 'clocked out'} at {new Date().toLocaleTimeString()}</p>}
      <div className="space-y-3">
        <Field label="Staff card" hint="Scan your card: it clocks you in or out straight away."><Input autoFocus type="password" autoComplete="off" value={card} onChange={(e) => setCard(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && card.trim()) { e.preventDefault(); byCard(); } }} placeholder="Scan your card" /></Field>
        {bridgeConfigured() && <Button variant="secondary" className="w-full" loading={busy} onClick={byFinger}><Icon name="finger" className="h-4 w-4" />Use fingerprint</Button>}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

/** One-time installation setup: business type, business details and the owner account. */
export function SetupPage() {
  const cfg = usePublicConfig();
  const qc = useQueryClient();
  const nav = useNavigate();
  const types = useQuery({ queryKey: ['business-types'], queryFn: () => api<{ data: { type: string; name: string; description: string; modules: string[] }[] }>('/public/business-types') });
  const [form, setForm] = useState({ businessName: '', businessType: 'supermarket', ownerName: '', email: '', password: '', phone: '', taxPin: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (cfg.data && !cfg.data.setupRequired && !done) nav('/login', { replace: true });
  }, [cfg.data, done, nav]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/public/register', { body: { ...form, phone: form.phone || undefined, taxPin: form.taxPin || undefined } });
      setDone(true);
      await qc.invalidateQueries({ queryKey: ['public-config'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Shell title="Your business is ready" subtitle="Your owner account, first branch and till are set up.">
        <p className="mb-6 text-sm">Sign in with the email and password you just created.</p>
        <Link to="/login"><Button size="lg" className="w-full rounded-full">Sign in</Button></Link>
      </Shell>
    );
  }

  if (cfg.data?.deploymentMode === 'branch') {
    return (
      <Shell title="Connect this branch to head office" subtitle="Branch servers are not set up from scratch.">
        <p className="text-sm text-ink-600 dark:text-ink-300">Create the branch at head office (Settings → Branches), copy its sync token into this server's <code>server/.env</code> as <code>SYNC_TOKEN</code>, set <code>SYNC_HQ_URL</code> and <code>BRANCH_CODE</code>, then restart. The business, staff and products download automatically.</p>
      </Shell>
    );
  }

  return (
    <Shell title="Set up this installation" subtitle="One business per installation. Choose its type and create the owner account." wide>
      <form onSubmit={submit} className="space-y-6">
        <div>
          <div className="label">What kind of shop is this?</div>
          {types.isLoading && <div className="flex items-center gap-2 py-4 text-sm text-ink-500"><Spinner className="h-4 w-4" />Loading business types…</div>}
          {types.isError && (
            <div className="space-y-2 py-2">
              <ErrorBox error="Can't reach the Afey POS server, so business types could not be loaded. Check that the API is running (the terminal shows the error), then retry." />
              <Button type="button" variant="secondary" size="sm" onClick={() => types.refetch()}>Retry</Button>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {types.data?.data.map((t) => (
              <button type="button" key={t.type} onClick={() => setForm((f) => ({ ...f, businessType: t.type }))} aria-pressed={form.businessType === t.type}
                className={cx('rounded-xl border p-3 text-left transition', form.businessType === t.type ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600 dark:border-brand-200 dark:bg-white/10 dark:ring-brand-200' : 'border-ink-200 hover:border-ink-400 dark:border-ink-700')}>
                <div className="font-medium">{t.name}</div>
                <div className="mt-0.5 text-xs text-ink-500">{t.description}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-500">This sets menus, product fields, checkout and reports. You can turn modules on or off later in Settings.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name"><Input required value={form.businessName} onChange={set('businessName')} /></Field>
          <Field label="KRA PIN (optional)" hint="Printed on receipts and used for eTIMS"><Input value={form.taxPin} onChange={(e) => setForm((f) => ({ ...f, taxPin: e.target.value.toUpperCase() }))} placeholder="P051234567X" /></Field>
          <Field label="Your name"><Input required value={form.ownerName} onChange={set('ownerName')} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={set('phone')} placeholder="0712 345 678" /></Field>
          <Field label="Email"><Input type="email" required value={form.email} onChange={set('email')} /></Field>
          <Field label="Password" hint="At least 8 characters with letters and numbers"><Input type="password" required minLength={8} value={form.password} onChange={set('password')} /></Field>
        </div>
        <ErrorBox error={error} />
        <div className="flex justify-end">
          <Button type="submit" size="lg" className="rounded-full px-10" loading={busy} disabled={!form.businessType}>Finish setup</Button>
        </div>
      </form>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Shell title="Reset your password" subtitle="We will email you a link to choose a new password.">
      {sent ? <p className="text-sm">If an account exists for {email}, we have emailed a reset link. It expires in 30 minutes.</p> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); try { await api('/auth/password/forgot', { body: { email } }); setSent(true); } catch (err) { setError(err); } }}>
          <IconInput icon="mail" aria-label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" />
          <ErrorBox error={error} />
          <Button type="submit" size="lg" className="w-full rounded-full">Send reset link</Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link to="/login" className="text-brand-700 hover:underline dark:text-brand-200">Back to sign in</Link></p>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <Shell title="Choose a new password" subtitle="At least 8 characters with letters and numbers.">
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); try { await api('/auth/password/reset', { body: { token: params.get('token'), password } }); nav('/login'); } catch (err) { setError(err); } }}>
        <IconInput icon="lock" aria-label="New password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" />
        <ErrorBox error={error} />
        <Button type="submit" size="lg" className="w-full rounded-full">Save password</Button>
      </form>
    </Shell>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ['verify', params.get('token')], queryFn: () => api('/auth/email/verify', { body: { token: params.get('token') } }), retry: false });
  return (
    <Shell title="Email verification">
      {q.isLoading ? 'Verifying…' : q.error ? <ErrorBox error={q.error} /> : <p className="text-sm">Your email address is verified.</p>}
      <p className="mt-6 text-center text-sm"><Link to="/" className="text-brand-700 hover:underline dark:text-brand-200">Continue</Link></p>
    </Shell>
  );
}

export { Card };
