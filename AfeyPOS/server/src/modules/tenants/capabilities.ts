import { BUSINESS_TYPES, resolveCapabilities, type BusinessType, type Capabilities, type ModuleKey } from '@afeypos/shared';
import type { TenantDoc } from '../../models/index.js';

/** Installations set up with a business type that no longer exists run as a supermarket. */
export function effectiveBusinessType(type: string | undefined | null): BusinessType {
  return (BUSINESS_TYPES as readonly string[]).includes(type ?? '') ? (type as BusinessType) : 'supermarket';
}

export function capabilitiesFor(tenant: Pick<TenantDoc, 'businessType' | 'enabledModules' | 'disabledModules'>): Capabilities {
  return resolveCapabilities({
    businessType: effectiveBusinessType(tenant.businessType),
    enabledModules: tenant.enabledModules as ModuleKey[],
    disabledModules: tenant.disabledModules as ModuleKey[],
  });
}
