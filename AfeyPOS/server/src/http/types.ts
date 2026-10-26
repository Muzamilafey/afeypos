import type { Types } from 'mongoose';
import type { Permission, Capabilities } from '@afeypos/shared';
import type { TenantDoc } from '../models/index.js';

export interface AuthInfo {
  kind: 'tenant';
  userId: Types.ObjectId;
  name: string;
  email: string;
  /** Built-in role names and custom role keys. */
  roles: string[];
  permissions: Set<Permission>;
  sessionId: Types.ObjectId;
  tenantId?: Types.ObjectId;
  /** Branches the user may work in; empty = all. */
  branchIds: Types.ObjectId[];
  /** Warehouses of those branches (empty when not restricted). */
  warehouseIds: Types.ObjectId[];
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      tenant?: TenantDoc;
      capabilities?: Capabilities;
      auth?: AuthInfo;
    }
  }
}

export {};
