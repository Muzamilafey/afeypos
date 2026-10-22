import { Logo } from '../components/Logo';
import { useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Field, Input, Card, cx } from '../components/ui';
import { Icon } from '../components/icons';

interface PublicConfig {
  deploymentMode: 'local' | 'cloud';
  baseDomain: string;
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

type AuthTab = 'signin' | 'signup';

const tabClass = (active: boolean) =>
  cx('border-b-2 pb-2 text-lg font-semibold transition', active ? 'border-brand-600 text-brand-700 dark:border-brand-100 dark:text-white' : 'border-transparent text-ink-300 hover:text-ink-500');

/**
 * Split auth card over the wallpaper: the form on the left (with Sign in / Sign up tabs) and a
 * charcoal panel on the right showing the business logo, name and tagline.
 */
function Shell({ title, subtitle, children, wide, tab }: { title: string; subtitle?: string; children: ReactNode; wide?: boolean; tab?: AuthTab }) {
  const cfg = usePublicConfig().data;
  const canSignUp = cfg?.deploymentMode === 'cloud';
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
              {canSignUp && <Link to="/register" aria-current={tab === 'signup' ? 'page' : undefined} className={tabClass(tab === 'signup')}>Sign up</Link>}
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
function IconInput({ icon, trailing, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { icon: string; trailing?: ReactNode }) {
  return (
    <div className="relative">
      <Icon name={icon} className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-400" />
      <input
        {...props}
        className={cx('block w-full rounded-xl border border-ink-200 bg-ink-50/60 py-3 pl-12 pr-12 text-sm shadow-sm placeholder-ink-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200 dark:border-ink-700 dark:bg-ink-950 dark:focus:ring-brand-700', className)}
      />
      {trailing && <div className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</div>}
    </div>
  );
}

export function LoginPage() {
  const { login, completeMfa, pinLogin } = useAuth();
  const nav = useNavigate();
  const cfg = usePublicConfig();
  const [mode, setMode] = useState<'password' | 'pin'>('password');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [mfa, setMfa] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cfg.data?.setupRequired) nav('/setup');
  }, [cfg.data, nav]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfa) await completeMfa(mfa, code);
      else if (mode === 'pin') await pinLogin(email, secret);
      else {
        const r = await login(email, secret);
        if (r.mfaRequired) {
          setMfa(r.mfaToken!);
          return;
        }
      }
      nav('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (cfg.data && cfg.data.deploymentMode === 'cloud' && !cfg.data.tenant) {
    return (
      <Shell title="Point of sale for every kind of shop" tab="signin">
        <p className="mb-6 text-sm text-ink-600 dark:text-ink-300">Open your business address (for example <strong>yourshop.{cfg.data.baseDomain}</strong>) to sign in, or create a new business.</p>
        <Link to="/register"><Button size="lg" className="w-full rounded-full">Create a business</Button></Link>
      </Shell>
    );
  }

  const pin = mode === 'pin';
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
            <div role="radiogroup" aria-label="Sign in with" className="relative grid grid-cols-2 rounded-full bg-ink-100 p-1 text-sm font-medium dark:bg-ink-800">
              <span aria-hidden="true" className={cx('absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-brand-600 shadow transition-transform duration-200 dark:bg-brand-100', pin && 'translate-x-full')} />
              {(['password', 'pin'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { setMode(m); setSecret(''); setError(null); }}
                  className={cx('relative z-10 flex items-center justify-center gap-2 rounded-full py-2 transition-colors', mode === m ? 'text-white dark:text-brand-900' : 'text-ink-500 hover:text-ink-700')}>
                  <Icon name={m === 'pin' ? 'keypad' : 'lock'} className="h-4 w-4" />
                  {m === 'pin' ? 'Cashier PIN' : 'Password'}
                </button>
              ))}
            </div>
            <IconInput icon="mail" aria-label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" />
            <IconInput
              icon={pin ? 'keypad' : 'lock'}
              aria-label={pin ? 'PIN' : 'Password'}
              type={show ? 'text' : 'password'}
              autoComplete={pin ? 'off' : 'current-password'}
              inputMode={pin ? 'numeric' : undefined}
              maxLength={pin ? 8 : undefined}
              required
              value={secret}
              onChange={(e) => setSecret(pin ? e.target.value.replace(/\D/g, '') : e.target.value)}
              placeholder={pin ? '4-8 digit PIN' : 'Password'}
              trailing={<button type="button" onClick={() => setShow((v) => !v)} className="rounded-lg p-2 text-ink-400 hover:text-ink-700" aria-label={show ? 'Hide' : 'Show'}><Icon name={show ? 'eyeOff' : 'eye'} className="h-4 w-4" /></button>}
            />
          </>
        )}
        <ErrorBox error={error} />
        <div className="flex flex-col-reverse items-stretch gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
          {mfa ? (
            <button type="button" className="text-sm text-ink-500 hover:underline" onClick={() => { setMfa(null); setCode(''); }}>Back</button>
          ) : (
            <Link to="/forgot-password" className="text-sm text-brand-700 hover:underline dark:text-brand-200">Forgot your password?</Link>
          )}
          <Button type="submit" loading={busy} size="lg" className="rounded-full px-10">{mfa ? 'Verify' : 'Sign in'}</Button>
        </div>
      </form>
    </Shell>
  );
}

export function RegisterPage({ setup }: { setup?: boolean }) {
  const cfg = usePublicConfig();
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['business-types'], queryFn: () => api<{ data: { type: string; name: string; description: string; modules: string[] }[] }>('/public/business-types') });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api<{ data: { code: string; name: string; priceMonthlyCents: number; trialDays: number }[] }>('/public/plans'), enabled: !setup });
  const [form, setForm] = useState({ businessName: '', businessType: '', subdomain: '', ownerName: '', email: '', password: '', phone: '', planCode: 'starter' });
  const [slugStatus, setSlugStatus] = useState<{ available: boolean; reason?: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ url: string } | null>(null);
  const cloud = cfg.data?.deploymentMode === 'cloud';
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (!cloud || form.subdomain.length < 3) return setSlugStatus(null);
    const t = setTimeout(() => api('/public/subdomain-check', { query: { slug: form.subdomain } }).then(setSlugStatus).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [form.subdomain, cloud]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>('/public/register', { body: { ...form, subdomain: cloud ? form.subdomain : undefined, phone: form.phone || undefined } });
      await qc.invalidateQueries({ queryKey: ['public-config'] });
      setDone(r);
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
        {cloud ? <a href={`${done.url}/login`}><Button size="lg" className="w-full rounded-full">Go to {done.url.replace(/^https?:\/\//, '')}</Button></a> : <Link to="/login"><Button size="lg" className="w-full rounded-full">Sign in</Button></Link>}
      </Shell>
    );
  }

  return (
    <Shell title={setup ? 'Set up this installation' : 'Create your business'} subtitle={setup ? 'Choose your business type and create the owner account.' : undefined} wide tab={setup ? undefined : 'signup'}>
      <form onSubmit={submit} className="space-y-6">
        <div>
          <div className="label">What kind of business is this?</div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {types.data?.data.map((t) => (
              <button type="button" key={t.type} onClick={() => setForm((f) => ({ ...f, businessType: t.type }))} aria-pressed={form.businessType === t.type}
                className={cx('rounded-xl border p-3 text-left transition', form.businessType === t.type ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600 dark:border-brand-200 dark:bg-white/10 dark:ring-brand-200' : 'border-ink-200 hover:border-ink-400 dark:border-ink-700')}>
                <div className="font-medium">{t.name}</div>
                <div className="mt-0.5 text-xs text-ink-500">{t.description}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-500">Afey POS configures menus, product fields, checkout and reports for this type. You can enable more modules later.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name"><Input required value={form.businessName} onChange={set('businessName')} /></Field>
          {cloud && (
            <Field label="Business address" error={slugStatus && !slugStatus.available ? slugStatus.reason : undefined} hint={slugStatus?.available ? 'Available' : undefined}>
              <div className="flex items-center gap-1"><Input required value={form.subdomain} onChange={(e) => setForm((f) => ({ ...f, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} placeholder="yourshop" /><span className="whitespace-nowrap text-sm text-ink-500">.{cfg.data?.baseDomain}</span></div>
            </Field>
          )}
          <Field label="Your name"><Input required value={form.ownerName} onChange={set('ownerName')} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={set('phone')} placeholder="0712 345 678" /></Field>
          <Field label="Email"><Input type="email" required value={form.email} onChange={set('email')} /></Field>
          <Field label="Password" hint="At least 8 characters with letters and numbers"><Input type="password" required minLength={8} value={form.password} onChange={set('password')} /></Field>
          {cloud && plans.data && (
            <Field label="Plan"><select className="input" value={form.planCode} onChange={set('planCode')}>{plans.data.data.map((p) => <option key={p.code} value={p.code}>{p.name} · {p.trialDays}-day free trial</option>)}</select></Field>
          )}
        </div>
        <ErrorBox error={error} />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          {!setup ? <Link to="/login" className="text-sm text-brand-700 hover:underline dark:text-brand-200">I already have an account</Link> : <span />}
          <Button type="submit" size="lg" className="rounded-full px-10" loading={busy} disabled={!form.businessType}>{setup ? 'Finish setup' : 'Create business'}</Button>
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
