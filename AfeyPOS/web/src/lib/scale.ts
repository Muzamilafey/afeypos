/** Reading the counter scale on this till through the Afey device bridge (and parsing keyboard-wedge input). */
import { roundKg, type ScaleReading } from '@afeypos/shared';
import { bridge } from './bridge';

/** One reading from the bridge. Older bridges send only { weightKg, stable }: gross = net, no tare. */
export async function readBridgeScale(signal?: AbortSignal): Promise<ScaleReading> {
  const r = await bridge<{ weightKg: number; stable: boolean; grossKg?: number; tareKg?: number; netKg?: number; raw?: string }>('/scale/weight', undefined, 4000, signal);
  const net = roundKg(r.netKg ?? r.weightKg);
  return { grossKg: roundKg(r.grossKg ?? net), tareKg: roundKg(r.tareKg ?? 0), netKg: net, stable: Boolean(r.stable), raw: r.raw };
}

export const tareBridgeScale = (zero = false) => bridge('/scale/tare', { zero }, 4000);

/**
 * Weight typed by a keyboard-wedge scale, e.g. "1.250", "1,250 kg" or "1250 g". Treated as stable (the scale
 * sends only when the cashier presses its send key on a settled weight). Null when not a weight.
 */
export function parseTypedWeight(text: string): ScaleReading | null {
  const m = /^\s*([+]?\d+(?:[.,]\d+)?)\s*(kg|g)?\s*$/i.exec(text);
  if (!m) return null;
  let kg = Number(m[1].replace(',', '.'));
  if ((m[2] ?? '').toLowerCase() === 'g') kg /= 1000;
  if (!Number.isFinite(kg)) return null;
  const net = roundKg(kg);
  return { grossKg: net, tareKg: 0, netKg: net, stable: true, raw: text.trim() };
}
