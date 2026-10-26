import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { GUARD } from '../src/http/auth.js';

/**
 * Deny by default: every route a signed-in user can reach must declare who may use it
 * (requirePermission, requireAnyPermission, requireRole, signedIn(reason) or another markGuard check).
 * A new route without one fails here.
 */
interface RouteInfo { method: string; path: string; signedIn: boolean; guards: string[] }

function walk(stack: any[], prefix: string, inherited: string[], afterAuth: boolean, out: RouteInfo[]) {
  let guards = [...inherited];
  let auth = afterAuth;
  for (const layer of stack) {
    const h = layer.handle;
    const path = typeof layer.path === 'string' ? layer.path : '';
    if (layer.route) {
      const own = layer.route.stack.map((l: any) => l.handle?.[GUARD]).filter(Boolean);
      const routeAuth = auth || layer.route.stack.some((l: any) => l.handle?.name === 'authenticate');
      for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path, signedIn: routeAuth, guards: [...guards, ...own] });
    } else if (h?.stack) {
      walk(h.stack, prefix + path, guards, auth, out);
    } else if (h?.name === 'authenticate') {
      auth = true;
    } else if (h?.[GUARD] && (!path || path === '/')) {
      guards = [...guards, h[GUARD]];
    }
  }
}

describe('route access rules', () => {
  Object.assign(process.env, { NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x'.repeat(64), ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), MONGODB_URI: 'mongodb://127.0.0.1/route-audit' });
  const routes: RouteInfo[] = [];
  walk((createApp() as any).router.stack, '', [], false, routes);
  const signedInRoutes = routes.filter((r) => r.signedIn);

  it('finds the signed-in API', () => {
    expect(signedInRoutes.length).toBeGreaterThan(250);
  });

  it('every signed-in route declares who may use it', () => {
    const open = signedInRoutes.filter((r) => !r.guards.length).map((r) => `${r.method} ${r.path}`);
    expect(open).toEqual([]);
  });

  it('only a short, reviewed list is open to every signed-in user', () => {
    const anyone = signedInRoutes.filter((r) => r.guards.every((g) => g.startsWith('signed-in:'))).map((r) => `${r.method} ${r.path}`).sort();
    expect(anyone).toEqual([
      'DELETE /sessions/:id', 'GET /files/:id', 'GET /me', 'GET /sessions', 'GET /settings/locations',
      'POST /2fa/disable', 'POST /2fa/enable', 'POST /2fa/setup', 'POST /email/resend', 'POST /logout-all', 'POST /override', 'POST /password/change', 'POST /pin',
    ]);
  });
});
