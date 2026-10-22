import { Logo } from '../components/Logo';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Field, Input, Card, cx } from '../components/ui';

function Shell({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink-950 p-4">
      <div aria-hidden="true" className="auth-wallpaper absolute inset-0" />
      {/* Darkens the photo just enough for the white heading and the card to stay readable. */}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/20 to-black/55" />
      <div className={cx('relative w-full', wide ? 'max-w-4xl' : 'max-w-md')}>
        <div className="mb-6 text-center text-white [text-shadow:0_1px_8px_rgba(0,0,0,.6)]">
          <Logo className="mx-auto mb-3 h-20 w-auto drop-shadow-lg" />
          <h1 className="text-2xl font-semibold">Afey POS</h1>
          <p className="text-sm text-white/80">{title}</p>
        </div>
        <div className="card border-white/20 bg-white/95 p-6 shadow-2xl backdrop-blur-sm dark:border-ink-700/60 dark:bg-ink-900/90">{children}</div>
      </div>
    </div>
  );
}

export function usePublicConfig() {
  return useQuery({ queryKey: ['public-config'], queryFn: () => api<{ deploymentMode: 'local' | 'cloud'; baseDomain: string; setupRequired: boolean; tenant: { name: string } | null }>('/public/config') });
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
      <Shell title="Point of sale for every kind of shop">
        <p className="mb-4 text-sm text-ink-600">Open your business address (for example <strong>yourshop.{cfg.data.baseDomain}</strong>) to sign in, or create a new business.</p>
        <Link to="/register"><Button className="w-full">Create a business</Button></Link>
      </Shell>
    );
  }

  return (
    <Shell title={cfg.data?.tenant?.name ?? 'Sign in'}>
      <form onSubmit={submit} className="space-y-4">
        {!mfa && (
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink-100 p-1 text-sm dark:bg-ink-800">
            {(['password', 'pin'] as const).map((m) => <button key={m} type="button" onClick={() => setMode(m)} className={cx('rounded-md py-1.5', mode === m && 'bg-white font-medium shadow dark:bg-ink-900')}>{m === 'pin' ? 'Cashier PIN' : 'Password'}</button>)}
          </div>
        )}
        {mfa ? (
          <Field label="Authenticator code"><Input autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" /></Field>
        ) : (
          <>
            <Field label="Email"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label={mode === 'pin' ? 'PIN' : 'Password'}><Input type="password" autoComplete="current-password" inputMode={mode === 'pin' ? 'numeric' : undefined} required value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
          </>
        )}
        <ErrorBox error={error} />
        <Button type="submit" loading={busy} className="w-full" size="lg">{mfa ? 'Verify' : 'Sign in'}</Button>
        <div className="flex justify-between text-sm">
          <Link to="/forgot-password" className="text-brand-700 hover:underline">Forgot password?</Link>
          {cfg.data?.deploymentMode === 'cloud' && <Link to="/register" className="text-brand-700 hover:underline">New business</Link>}
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
      <Shell title="Your business is ready">
        <p className="mb-4 text-sm">Sign in with the email and password you just created.</p>
        {cloud ? <a href={`${done.url}/login`}><Button className="w-full">Go to {done.url.replace(/^https?:\/\//, '')}</Button></a> : <Link to="/login"><Button className="w-full">Sign in</Button></Link>}
      </Shell>
    );
  }

  return (
    <Shell title={setup ? 'Set up this installation' : 'Create your business'} wide>
      <form onSubmit={submit} className="space-y-6">
        <div>
          <div className="label">What kind of business is this?</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {types.data?.data.map((t) => (
              <button type="button" key={t.type} onClick={() => setForm((f) => ({ ...f, businessType: t.type }))} aria-pressed={form.businessType === t.type}
                className={cx('rounded-lg border p-3 text-left transition', form.businessType === t.type ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600 dark:bg-brand-900/30' : 'border-ink-200 hover:border-ink-400 dark:border-ink-700')}>
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
        <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!form.businessType}>{setup ? 'Finish setup' : 'Create business'}</Button>
        {!setup && <p className="text-center text-sm"><Link to="/login" className="text-brand-700 hover:underline">I already have an account</Link></p>}
      </form>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Shell title="Reset your password">
      {sent ? <p className="text-sm">If an account exists for {email}, we have emailed a reset link. It expires in 30 minutes.</p> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); try { await api('/auth/password/forgot', { body: { email } }); setSent(true); } catch (err) { setError(err); } }}>
          <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <ErrorBox error={error} />
          <Button type="submit" className="w-full">Send reset link</Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm"><Link to="/login" className="text-brand-700">Back to sign in</Link></p>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <Shell title="Choose a new password">
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); try { await api('/auth/password/reset', { body: { token: params.get('token'), password } }); nav('/login'); } catch (err) { setError(err); } }}>
        <Field label="New password" hint="At least 8 characters with letters and numbers"><Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <Button type="submit" className="w-full">Save password</Button>
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
      <p className="mt-4 text-center text-sm"><Link to="/" className="text-brand-700">Continue</Link></p>
    </Shell>
  );
}

export { Card };
