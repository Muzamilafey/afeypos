import { DEFAULT_PLANS, type ModuleKey, type PlanDefinition, resolveCapabilities, type Capabilities } from '@afeypos/shared';
import { Plan, type TenantDoc } from '../../models/index.js';
import { env } from '../../config/env.js';

let cache: { at: number; plans: Map<string, PlanDefinition> } | null = null;

export async function ensureDefaultPlans() {
  for (const p of DEFAULT_PLANS) {
    await Plan.updateOne({ code: p.code }, { $setOnInsert: p }, { upsert: true });
  }
  cache = null;
}

export async function getPlan(code: string): Promise<PlanDefinition | null> {
  if (!cache || Date.now() - cache.at > 60_000) {
    const rows = await Plan.find({ active: true }).lean();
    cache = { at: Date.now(), plans: new Map(rows.map((r) => [r.code, r as unknown as PlanDefinition])) };
  }
  return cache.plans.get(code) ?? DEFAULT_PLANS.find((p) => p.code === code) ?? null;
}

export function invalidatePlanCache() {
  cache = null;
}

export async function capabilitiesFor(tenant: Pick<TenantDoc, 'businessType' | 'enabledModules' | 'disabledModules' | 'planCode'>): Promise<Capabilities> {
  let entitledModules: ModuleKey[] | undefined;
  if (env().DEPLOYMENT_MODE === 'cloud') {
    const plan = await getPlan(tenant.planCode);
    entitledModules = plan?.modules && plan.modules.length ? (plan.modules as ModuleKey[]) : undefined;
  }
  return resolveCapabilities({
    businessType: tenant.businessType as Capabilities['businessType'],
    enabledModules: tenant.enabledModules as ModuleKey[],
    disabledModules: tenant.disabledModules as ModuleKey[],
    entitledModules,
  });
}
