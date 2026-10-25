import type { Types } from 'mongoose';
import type { Permission, Role, Capabilities } from '@afeypos/shared';
import type { TenantDoc } from '../models/index.js';

export interface AuthInfo {
  kind: 'tenant';
  userId: Types.ObjectId;
  name: string;
  email: string;
  roles: Role[];
  permissions: Set<Permission>;
  sessionId: Types.ObjectId;
  tenantId?: Types.ObjectId;
  branchIds: Types.ObjectId[];
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
