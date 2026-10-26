import type { StoreStudio } from '@afeypos/shared';

/** The shop talks only to the public store API of the head-office server. */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}` : '';
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1/store${path}${qs}`, {
      method: opts.body === undefined ? 'GET' : 'POST',
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the shop right now. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'Something went wrong', data?.error?.details);
  return data as T;
}

/** Image and logo paths from the API are relative to the API server. */
export const asset = (src?: string | null) => (src ? (src.startsWith('http') ? src : `${BASE}${src}`) : '');

export interface StoreConfig {
  name: string; tagline: string; currency: string; logoUrl: string | null; announcement: string; contactPhone: string; hours: string;
  pickup: boolean; delivery: boolean; deliveryAreas: { name: string; feeCents: number }[]; deliveryFeeCents: number; freeDeliveryAboveCents: number;
  minOrderCents: number; payOnDelivery: boolean; mpesa: boolean; card: boolean; studio: StoreStudio; branches: { id: string; name: string; address: string; phone: string }[]; categories: { id: string; name: string; color?: string }[];
}

export interface StoreProduct {
  id: string; name: string; sku: string; unit: string; priceCents: number; categoryId?: string; images: string[]; description: string; featured: boolean;
  allowFractional: boolean; inStock: boolean; available: number | null; ageRestricted: boolean;
  /** "Was" price when the product is on offer. */
  compareAtCents: number | null; badge: string | null; isNew: boolean;
}

export type ProductQuery = { q?: string; categoryId?: string; featured?: boolean; deals?: boolean; sort?: 'default' | 'new' | 'best' | 'price_asc' | 'price_desc' | 'name'; page?: number; limit?: number };
export const listProducts = (query: ProductQuery) =>
  api<{ data: StoreProduct[]; total: number }>('/products', { query: { ...query, featured: query.featured ? 1 : undefined, deals: query.deals ? 1 : undefined } });

export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
