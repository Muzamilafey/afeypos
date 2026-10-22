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
import { authenticate, denySupportWrites, requireAnyModule, requireModule } from './http/auth.js';
import { dbStatus, pingDatabase } from './db/connection.js';
import { audit } from './lib/audit.js';
import { runAsPlatform } from './lib/context.js';
import { publicRoutes } from './modules/public/routes.js';
import { authRoutes, recoveryRoutes } from './modules/auth/routes.js';
import { salesRoutes } from './modules/sales/routes.js';
import { documentRoutes } from './modules/sales/documents.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { partyRoutes } from './modules/parties/routes.js';
import { purchasingRoutes } from './modules/purchasing/routes.js';
import { mpesaCallbackRoutes, mpesaRoutes } from './modules/payments/mpesa.js';
import { gatewayCallbackRoutes, gatewayRoutes } from './modules/payments/gateways.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { hardwareRoutes } from './modules/hardware/routes.js';
import { biometricBridgeRoutes, biometricRoutes } from './modules/biometrics/routes.js';
import { backupRoutes } from './modules/backups/routes.js';
import { platformRoutes } from './modules/platform/routes.js';
import { syncIngestRoutes, syncSettingsRoutes } from './modules/sync/routes.js';
import { fileRoutes } from './modules/files/routes.js';
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
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'script-src': ["'self'"],
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
  const origins = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      credentials: true,
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        try {
          const host = new URL(origin).hostname;
          const ok = origins.includes(origin) || host === e.BASE_DOMAIN || host.endsWith('.' + e.BASE_DOMAIN);
          cb(null, ok);
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
  v1.use('/platform', (req, _res, next) => runAsPlatform(() => next()), platformRoutes);

  const tenant = Router();
  tenant.use(requireTenant);
  // Module gates by path: disabled modules are rejected server-side even if the UI hides them.
  tenant.use(['/sales', '/shifts'], requireModule('pos'));
  tenant.use('/inventory', requireModule('inventory'));
  tenant.use(['/purchase-orders', '/goods-receipts', '/supplier-returns'], requireModule('purchasing'));
  tenant.use('/payments/mpesa', requireModule('mpesa'));
  tenant.use(['/payments/gateways', '/payments/online'], requireModule('payments'));
  tenant.use('/payments/intents', requireAnyModule('mpesa', 'payments'));
  tenant.use('/reports', requireModule('reports'));
  tenant.use(['/biometrics', '/attendance'], requireModule('biometrics'));
  tenant.use('/sync', syncIngestRoutes);
  tenant.use(biometricBridgeRoutes);
  tenant.use('/auth', recoveryRoutes);
  tenant.use('/auth', authRoutes);
  tenant.use(authenticate);
  tenant.use(async (req, _res, next) => {
    if (req.auth?.kind === 'support') await audit(req, { action: 'support.access', details: { method: req.method, path: req.path } });
    next();
  });
  tenant.use(denySupportWrites);
  for (const r of [salesRoutes, documentRoutes, catalogRoutes, inventoryRoutes, partyRoutes, purchasingRoutes, mpesaRoutes, gatewayRoutes, settingsRoutes, syncSettingsRoutes, reportRoutes, hardwareRoutes, biometricRoutes, backupRoutes, fileRoutes]) {
    tenant.use(r);
  }
  v1.use(tenant);
  app.use('/api/v1', v1);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  });

  // Local installations serve the built web app from the same server.
  if (e.WEB_DIST_DIR && fs.existsSync(e.WEB_DIST_DIR)) {
    const dist = path.resolve(e.WEB_DIST_DIR);
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
