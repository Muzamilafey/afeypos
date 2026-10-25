import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Capabilities, ModuleKey, NavItem, Permission } from '@afeypos/shared';
import { api, onExpired, setAccessToken, tryRestoreSession } from './api';
import { configureFormat } from './format';

export interface Me {
  user: { id: string; name: string; email: string; roles: string[]; branchIds: string[]; kind: string; twoFactorEnabled?: boolean; hasPin?: boolean; emailVerified?: boolean };
  tenant: { id: string; name: string; slug: string; businessType: string; status: string; settings: any; enabledModules: ModuleKey[]; disabledModules: ModuleKey[] };
  deploymentMode: 'standalone' | 'hq' | 'branch';
  capabilities: Capabilities;
  permissions: Permission[];
  navigation: NavItem[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login(email: string, password: string): Promise<{ mfaRequired?: boolean; mfaToken?: string }>;
  completeMfa(mfaToken: string, code: string): Promise<void>;
  pinLogin(email: string, pin: string): Promise<void>;
  /** Staff card (+ PIN): returns PIN_REQUIRED when the PIN is missing. */
  cardLogin(code: string, pin?: string): Promise<void>;
  /** Exchanges a fingerprint login token from the device bridge for a session. */
  fingerprintLogin(loginToken: string): Promise<void>;
  logout(): Promise<void>;
  reload(): Promise<void>;
  can(p: Permission): boolean;
  has(m: ModuleKey): boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const m = await api<Me>('/auth/me');
    configureFormat({ currency: m.tenant.settings?.currency, locale: m.tenant.settings?.locale, timezone: m.tenant.settings?.timezone });
    setMe(m);
  }, []);

  useEffect(() => {
    onExpired((scope) => scope === 'tenant' && setMe(null));
    (async () => {
      try {
        if (await tryRestoreSession()) await reload();
      } catch {
        /* not signed in */
      } finally {
        setLoading(false);
      }
    })();
  }, [reload]);

  const finish = useCallback(async (accessToken: string) => {
    setAccessToken(accessToken);
    await reload();
  }, [reload]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      async login(email, password) {
        const r = await api<any>('/auth/login', { body: { email, password } });
        if (r.mfaRequired) return { mfaRequired: true, mfaToken: r.mfaToken };
        await finish(r.accessToken);
        return {};
      },
      async completeMfa(mfaToken, code) {
        const r = await api<any>('/auth/mfa', { body: { mfaToken, code } });
        await finish(r.accessToken);
      },
      async pinLogin(email, pin) {
        const r = await api<any>('/auth/pin-login', { body: { email, pin } });
        await finish(r.accessToken);
      },
      async cardLogin(code, pin) {
        const r = await api<any>('/auth/card-login', { body: { code, pin: pin || undefined } });
        await finish(r.accessToken);
      },
      async fingerprintLogin(loginToken) {
        const r = await api<any>('/auth/biometric-login', { body: { loginToken } });
        await finish(r.accessToken);
      },
      async logout() {
        await api('/auth/logout', { body: {} }).catch(() => undefined);
        setAccessToken(null);
        setMe(null);
      },
      reload,
      can: (p) => Boolean(me?.permissions.includes(p)),
      has: (m) => Boolean(me?.capabilities.modules.includes(m)),
    }),
    [me, loading, reload, finish],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
