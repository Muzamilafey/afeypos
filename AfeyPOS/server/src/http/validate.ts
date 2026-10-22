import { z, type ZodTypeAny } from 'zod';
import { Types } from 'mongoose';
import { badRequest } from '../lib/errors.js';

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const objectId = z
  .string()
  .refine((v) => Types.ObjectId.isValid(v) && /^[a-f0-9]{24}$/i.test(v), 'Invalid id')
  .transform((v) => new Types.ObjectId(v));

export const cents = z.number().int().safe();
export const positiveCents = z.number().int().nonnegative().safe();
export const qty = z.number().finite().positive().max(1e9);

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
});

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function idParam(value: unknown) {
  return parse(objectId, value);
}
