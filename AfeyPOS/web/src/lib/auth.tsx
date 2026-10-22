import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Capabilities, ModuleKey, NavItem, Permission } from '@afeypos/shared';
import { api, onExpired, setAccessToken, tryRestoreSession } from './api';
import { configureFormat } from './format';

export interface Me {
  user: { id: string; name: string; email: string; roles: string[]; branchIds: string[]; kind: string; twoFactorEnabled?: boolean; hasPin?: boolean; emailVerified?: boolean };
  tenant: { id: string; name: string; slug: string; businessType: string; status: string; planCode: string; trialEndsAt?: string; settings: any; enabledModules: ModuleKey[]; disabledModules: ModuleKey[] };
  deploymentMode: 'local' | 'cloud';
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
