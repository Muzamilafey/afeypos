import type { Types } from 'mongoose';
import type { Permission, Role, Capabilities } from '@afeypos/shared';
import type { TenantDoc } from '../models/index.js';

export interface AuthInfo {
  kind: 'tenant' | 'platform' | 'support';
  userId: Types.ObjectId;
  name: string;
  email: string;
  roles: Role[];
  permissions: Set<Permission>;
  sessionId: Types.ObjectId;
  tenantId?: Types.ObjectId;
  branchIds: Types.ObjectId[];
  supportGrantId?: Types.ObjectId;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
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
