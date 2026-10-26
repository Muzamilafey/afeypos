import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import './http/types.js';
import { env } from './config/env.js';
import { errorHandler } from './http/errorHandler.js';
import { requireTenant } from './http/tenant.js';
import { authenticate, requireAnyModule, requireModule } from './http/auth.js';
import { dbStatus, pingDatabase } from './db/connection.js';
import { publicRoutes } from './modules/public/routes.js';
import { authRoutes, recoveryRoutes } from './modules/auth/routes.js';
import { salesRoutes } from './modules/sales/routes.js';
import { documentRoutes } from './modules/sales/documents.js';
import { documentPdfRoutes } from './modules/documents/routes.js';
import { hideCostsUnlessPermitted } from './http/costVisibility.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { partyRoutes } from './modules/parties/routes.js';
import { purchasingRoutes } from './modules/purchasing/routes.js';
import { mpesaCallbackRoutes, mpesaRoutes } from './modules/payments/mpesa.js';
import { gatewayCallbackRoutes, gatewayRoutes } from './modules/payments/gateways.js';
import { payoutRoutes } from './modules/payments/payouts.js';
import { etimsRoutes } from './modules/etims/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { hardwareRoutes } from './modules/hardware/routes.js';
import { biometricBridgeRoutes, biometricRoutes } from './modules/biometrics/routes.js';
import { staffCardRoutes } from './modules/staff/cards.js';
import { hrRoutes } from './modules/hr/routes.js';
import { accountingRoutes } from './modules/accounting/routes.js';
import { crmRoutes } from './modules/crm/routes.js';
import { loyaltyRoutes } from './modules/loyalty/routes.js';
import { onlineOrderRoutes, storefrontRoutes } from './modules/store/routes.js';
import { backupRoutes } from './modules/backups/routes.js';
import { syncSettingsRoutes } from './modules/sync/routes.js';
import { hqSyncRoutes } from './modules/sync/hq.js';
import { branchReadOnly } from './modules/sync/guards.js';
import { fileRoutes } from './modules/files/routes.js';
import { terminalHookRoutes, terminalRoutes } from './modules/terminals/routes.js';
import './modules/notifications/service.js';
import './jobs/scheduler.js';

function trustProxy(v: string): boolean | number | string {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function createApp() {
  const e = env();
  const app = express();
  app.set('trust proxy', trustProxy(e.TRUST_PROXY));
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': ["'self'", 'data:', 'blob:'],
          // The Afey device bridge (printers, scale, fingerprint reader) listens on the till PC's loopback address.
          'connect-src': ["'self'", 'ws:', 'wss:', 'http://127.0.0.1:*', 'http://localhost:*'],
          'script-src': ["'self'"],
          // Store studio shows the shop website (any address the owner enters, often plain HTTP on the LAN) in a frame.
          'frame-src': ["'self'", 'https:', 'http:'],
          'style-src': ["'self'", "'unsafe-inline'"],
          // Only force HTTPS sub-resources when the site is served over HTTPS; local shop installations use plain HTTP on the LAN.
          'upgrade-insecure-requests': e.COOKIE_SECURE ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      // HSTS and COOP only make sense over HTTPS.
      strictTransportSecurity: e.COOKIE_SECURE,
      crossOriginOpenerPolicy: e.COOKIE_SECURE,
    }),
  );
  // The online shop is a separate website on its own domain: its public API takes any origin, without cookies.
  app.use('/api/v1/store', cors({ origin: true, credentials: false }));
  const origins = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      credentials: true,
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        try {
          cb(null, origins.includes(new URL(origin).origin));
        } catch {
          cb(null, false);
        }
      },
    }),
  );
  // Webhooks keep the exact raw body for provider signature checks (HMAC over the bytes received).
  const keepRaw = (req: express.Request, _res: express.Response, buf: Buffer) => {
    if (req.originalUrl.startsWith('/api/v1/hooks/')) (req as any).rawBody = buf;
  };
  app.use(express.json({ limit: '6mb', verify: keepRaw }));
  app.use('/api/v1/hooks', express.urlencoded({ extended: false, limit: '1mb', verify: keepRaw }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: e.NODE_ENV === 'test' ? 100000 : 1200, standardHeaders: 'draft-7', legacyHeaders: false }));

  const health = async (_req: express.Request, res: express.Response) => {
    const ok = await pingDatabase();
    const s = dbStatus();
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', service: 'afeypos', mode: e.DEPLOYMENT_MODE, database: { connected: ok, replicaSet: s.replicaSet, transactions: s.transactions, version: s.version }, time: new Date().toISOString() });
  };
  app.get('/health', health);

  const v1 = Router();
  v1.get('/health', health);
  v1.use('/public', publicRoutes);
  // Neutral path: Safaricom rejects callback URLs containing words such as "mpesa".
  v1.use('/hooks/pay', mpesaCallbackRoutes, gatewayCallbackRoutes);
  v1.use('/hooks/terminal', terminalHookRoutes);

  const tenant = Router();
  tenant.use(requireTenant);
  // Module gates by path: disabled modules are rejected server-side even if the UI hides them.
  tenant.use(['/sales', '/shifts'], requireModule('pos'));
  tenant.use('/inventory', requireModule('inventory'));
  tenant.use(['/purchase-orders', '/goods-receipts', '/supplier-returns'], requireModule('purchasing'));
  tenant.use(['/payments/mpesa', '/payments/payouts'], requireModule('mpesa'));
  tenant.use(['/payments/gateways', '/payments/online'], requireModule('payments'));
  tenant.use('/payments/intents', requireAnyModule('mpesa', 'payments'));
  tenant.use(['/payment-terminals', '/payment-terminals-transactions'], requireModule('pos'));
  tenant.use('/reports', requireModule('reports'));
  tenant.use('/etims', requireModule('etims'));
  tenant.use('/biometrics', requireModule('biometrics'));
  tenant.use('/attendance', requireAnyModule('biometrics', 'hr'));
  tenant.use('/hr', requireModule('hr'));
  tenant.use('/accounting', requireModule('accounting'));
  tenant.use('/crm', requireModule('crm'));
  tenant.use('/online-orders', requireModule('onlineStore'));
  tenant.use(branchReadOnly);
  tenant.use('/sync', hqSyncRoutes);
  tenant.use(biometricBridgeRoutes);
  tenant.use('/store', storefrontRoutes);
  tenant.use('/auth', recoveryRoutes);
  tenant.use('/auth', authRoutes);
  tenant.use(authenticate);
  tenant.use(hideCostsUnlessPermitted);
  for (const r of [salesRoutes, documentRoutes, catalogRoutes, inventoryRoutes, partyRoutes, purchasingRoutes, mpesaRoutes, payoutRoutes, gatewayRoutes, etimsRoutes, settingsRoutes, syncSettingsRoutes, reportRoutes, hardwareRoutes, biometricRoutes, staffCardRoutes, hrRoutes, accountingRoutes, crmRoutes, loyaltyRoutes, onlineOrderRoutes, terminalRoutes, backupRoutes, fileRoutes, documentPdfRoutes]) {
    tenant.use(r);
  }
  v1.use(tenant);
  app.use('/api/v1', v1);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  });

  // The online shop website, when this server also hosts it (its own domain name, same server).
  const shopHosts = e.SHOP_HOSTNAMES.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (e.SHOP_DIST_DIR && shopHosts.length && fs.existsSync(e.SHOP_DIST_DIR)) {
    const shopDist = path.resolve(e.SHOP_DIST_DIR);
    const shopStatic = express.static(shopDist, { index: false, maxAge: '1h' });
    const originOf = (u: string) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    // The POS shows the shop in a frame (Store studio preview); studio pictures may be on other https sites.
    const ancestors = [...new Set([...origins, ...e.SHOP_FRAME_ANCESTORS.split(','), e.API_PUBLIC_URL].map((o) => originOf(o.trim())).filter(Boolean))];
    const shopCsp = [
      "default-src 'self'", "base-uri 'self'", "object-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:",
      "img-src 'self' data: blob: https:", `connect-src 'self' ${originOf(e.API_PUBLIC_URL) ?? ''}`.trim(), "form-action 'self'", `frame-ancestors 'self' ${ancestors.join(' ')}`.trim(),
    ].join('; ');
    app.use((req, res, next) => {
      if (!shopHosts.includes(req.hostname.toLowerCase()) || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', shopCsp);
      shopStatic(req, res, () => (req.method === 'GET' ? res.sendFile(path.join(shopDist, 'index.html')) : next()));
    });
  }

  // Local installations serve the built web app from the same server.
  if (e.WEB_DIST_DIR && fs.existsSync(e.WEB_DIST_DIR)) {
    const dist = path.resolve(e.WEB_DIST_DIR);
    app.use(express.static(dist, {
      index: false,
      maxAge: '1h',
      setHeaders(res, file) {
        const name = path.basename(file);
        // The service worker and manifest must be re-checked on every load so updates arrive; hashed builds never change.
        if (name === 'sw.js' || name === 'manifest.webmanifest') res.setHeader('Cache-Control', 'no-cache');
        else if (file.startsWith(path.join(dist, 'assets'))) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (name.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
      },
    }));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
  }

  app.use(errorHandler);
  return app;
}
