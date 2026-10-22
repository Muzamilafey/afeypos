import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { Types } from 'mongoose';
import { Tenant } from '../models/index.js';
import { resolveAuth } from '../http/auth.js';
import { findTenantForRequest } from '../http/tenant.js';
import { logger } from '../lib/logger.js';

let io: Server | null = null;

/**
 * Realtime events are tenant-scoped: a socket authenticates with its access token, the tenant is
 * resolved from the connection's host exactly like HTTP requests, and the socket only joins rooms
 * for that tenant (and its user/branches). Events are only ever emitted to tenant rooms.
 */
export function attachRealtime(server: HttpServer, corsOrigins: string[]) {
  io = new Server(server, { path: '/socket.io', cors: { origin: corsOrigins, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      const req = socket.request as any;
      req.get = (h: string) => req.headers[h.toLowerCase()];
      req.hostname = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0];
      const tenant = await findTenantForRequest(req);
      if (!tenant || ['suspended', 'cancelled'].includes(tenant.status)) return next(new Error('tenant unavailable'));
      const { runInTenant } = await import('../lib/context.js');
      const auth = await runInTenant(tenant._id, () => resolveAuth(token, tenant._id));
      socket.data.tenantId = String(tenant._id);
      socket.data.userId = String(auth.userId);
      socket.join(`t:${tenant._id}`);
      socket.join(`t:${tenant._id}:u:${auth.userId}`);
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    socket.on('till:join', (tillId: string) => {
      if (typeof tillId === 'string' && /^[a-f0-9]{24}$/.test(tillId)) socket.join(`t:${socket.data.tenantId}:till:${tillId}`);
    });
  });
  logger.info('realtime attached');
  return io;
}

export function emitToTenant(tenantId: Types.ObjectId | string, event: string, data: unknown) {
  io?.to(`t:${tenantId}`).emit(event, data);
}

export function emitToTill(tenantId: Types.ObjectId | string, tillId: Types.ObjectId | string, event: string, data: unknown) {
  io?.to(`t:${tenantId}:till:${tillId}`).emit(event, data);
}

export function closeRealtime() {
  io?.close();
  io = null;
}

export { Tenant };
