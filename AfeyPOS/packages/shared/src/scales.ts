/**
 * Weighing scales: brands, how Afey POS can work with each, and the adapters behind that.
 *
 * Honesty rules: Afey POS does not speak any manufacturer's proprietary PLU-programming protocol. Prices reach
 * label-printing scales through a file for the maker's own PLU software, confirmed by a person after import.
 * Live weight comes from the scale's serial (RS-232/USB-serial) output through the Afey device bridge; output
 * formats differ by model, so every scale must pass a real reading test before it is used at the till.
 */

export const SCALE_ADAPTERS = {
  simulator: {
    label: 'Simulator (testing only)',
    simulated: true,
    readWeight: true,
    tare: true,
    pluSync: 'direct',
    description: 'A pretend scale for training and automated tests. Never use it for real sales.',
  },
  'bridge-serial': {
    label: 'Serial / USB-serial through the device bridge',
    simulated: false,
    readWeight: true,
    tare: true,
    pluSync: 'none',
    description: 'The till PC reads the weight the scale sends on its RS-232 or USB-serial port. Set the scale to send continuous or on-request weight (see its manual).',
  },
  keyboard: {
    label: 'Keyboard output (types the weight)',
    simulated: false,
    readWeight: true,
    tare: false,
    pluSync: 'none',
    description: 'Scales that type the weight into the focused field like a keyboard. The cashier presses the scale\'s print/send key.',
  },
  'file-export': {
    label: 'Label-printing scale: file for the maker\'s software',
    simulated: false,
    readWeight: false,
    tare: false,
    pluSync: 'file',
    description: 'Afey POS prepares the PLU list (number, name, price, unit). You import it with the scale maker\'s PLU software, then confirm here.',
  },
} as const;

export type ScaleAdapterKey = keyof typeof SCALE_ADAPTERS;
export const SCALE_ADAPTER_KEYS = Object.keys(SCALE_ADAPTERS) as ScaleAdapterKey[];

export interface ScaleBrand {
  key: string;
  name: string;
  /** Adapters that can work with this brand's scales (model-dependent; verified per scale). */
  adapters: ScaleAdapterKey[];
  /** Makes label-printing (price computing) scales that hold a PLU list. */
  labelScales: boolean;
  note: string;
}

export const SCALE_BRANDS: ScaleBrand[] = [
  { key: 'cas', name: 'CAS', adapters: ['bridge-serial', 'keyboard', 'file-export'], labelScales: true, note: 'Counter models with RS-232 output can send weight to the till. Label scales: import the PLU file with CAS\'s PLU software.' },
  { key: 'digi', name: 'DIGI', adapters: ['bridge-serial', 'file-export'], labelScales: true, note: 'Label scales: import the PLU file with DIGI\'s PC software. Weight output depends on the model and interface option.' },
  { key: 'avery-berkel', name: 'Avery Berkel', adapters: ['bridge-serial', 'file-export'], labelScales: true, note: 'Retail label scales: import the PLU file with the maker\'s software. Check the model\'s serial output settings for live weight.' },
  { key: 'bizerba', name: 'Bizerba', adapters: ['bridge-serial', 'file-export'], labelScales: true, note: 'Label scales: import the PLU file with Bizerba\'s software. Live weight only where the model has a serial weight output.' },
  { key: 'mettler-toledo', name: 'Mettler Toledo', adapters: ['bridge-serial', 'file-export'], labelScales: true, note: 'Many models offer a serial weight output (set it to continuous or on request). Label scales: import the PLU file with the maker\'s software.' },
  { key: 'ishida', name: 'Ishida', adapters: ['bridge-serial', 'file-export'], labelScales: true, note: 'Label scales: import the PLU file with Ishida\'s software. Confirm serial output support for your model.' },
  { key: 'adam', name: 'Adam Equipment', adapters: ['bridge-serial', 'keyboard'], labelScales: false, note: 'Bench and counting scales with RS-232/USB output: weight to the till only (no PLU list).' },
  { key: 'ohaus', name: 'OHAUS', adapters: ['bridge-serial', 'keyboard'], labelScales: false, note: 'Bench scales with RS-232/USB output: weight to the till only (no PLU list).' },
  { key: 'other', name: 'Other / unbranded', adapters: ['bridge-serial', 'keyboard', 'file-export'], labelScales: true, note: 'Most counter scales with a serial port send a plain weight line. Test it here before use.' },
  { key: 'simulator', name: 'Simulator (testing)', adapters: ['simulator'], labelScales: true, note: 'For training and tests only.' },
];

/** A weight reading as the till sees it. Net = gross - tare. All kg, 3 decimals. */
export interface ScaleReading {
  grossKg: number;
  tareKg: number;
  netKg: number;
  stable: boolean;
  raw?: string;
}

/** Rounds kg to grams without float drift (1.0049999 -> 1.005). */
export function roundKg(kg: number): number {
  return Math.round((kg + Number.EPSILON) * 1000) / 1000;
}

/** Whether a reading may be sold: stable, positive net, within the scale's minimum and capacity. */
export function readingProblem(r: ScaleReading, opts: { minKg?: number; maxKg?: number } = {}): string | null {
  if (!r.stable) return 'Wait for the weight to settle';
  if (!(r.netKg > 0)) return 'Nothing on the scale';
  if (opts.minKg && r.netKg < opts.minKg) return `Below the scale's minimum (${opts.minKg} kg)`;
  if (opts.maxKg && r.grossKg > opts.maxKg) return `Over the scale's capacity (${opts.maxKg} kg)`;
  return null;
}

/** Line amount for a weighed item: price per kg x net kg, rounded to the cent once. */
export function weighedAmountCents(pricePerKgCents: number, netKg: number): number {
  return Math.round((pricePerKgCents * Math.round(netKg * 1000)) / 1000);
}

/** One PLU row sent to a label scale. */
export interface PluItem {
  plu: string;
  name: string;
  /** Price per kg (weighed) or per piece (counted), in cents. */
  priceCents: number;
  unit: 'kg' | 'pc';
  barcodePrefix?: string;
  productId?: string;
}

/** Stable fingerprint of a PLU list, to tell whether a scale's prices are up to date. */
export function pluListHash(items: PluItem[]): string {
  const s = [...items].sort((a, b) => Number(a.plu) - Number(b.plu)).map((i) => `${Number(i.plu)}|${i.name}|${i.priceCents}|${i.unit}`).join('\n');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
}

/** CSV for the scale maker's PLU software: one row per item, prices as decimals. Column names are generic; map them in the software's import screen. */
export function pluCsv(items: PluItem[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [...items].sort((a, b) => Number(a.plu) - Number(b.plu)).map((i) => [String(Number(i.plu)), esc(i.name.slice(0, 40)), (i.priceCents / 100).toFixed(2), i.unit === 'kg' ? 'Weighed' : 'Counted'].join(','));
  return ['PLU,Name,Unit price,Type', ...rows].join('\r\n') + '\r\n';
}
