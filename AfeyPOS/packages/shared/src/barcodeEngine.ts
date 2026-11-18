/**
 * Barcode engine: symbology detection and check digits (EAN-13, EAN-8, UPC-A, UPC-E, GTIN-14, Code 39, Code 128),
 * configurable scale (variable-weight / variable-price) barcode formats, and internal in-store barcodes.
 *
 * Internal barcodes use GS1 restricted-circulation prefixes. They are valid only inside this business and are never
 * GS1-registered GTINs: a product sold elsewhere needs a GTIN from GS1 Kenya (or its manufacturer).
 */
import { ean13CheckDigit, isValidEan13, normalizeIsbn, type VariableWeightConfig } from './barcode.js';

/** GS1 mod-10 check digit for a GTIN body of any length (the rightmost body digit is weighted 3). */
export function gs1CheckDigit(body: string): number {
  if (!/^\d+$/.test(body)) throw new Error('GTIN body must be digits');
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

/** True when an 8, 12, 13 or 14 digit code has a correct GS1 check digit. */
export function isValidGtin(code: string): boolean {
  return /^(\d{8}|\d{12,14})$/.test(code) && gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

/** Expands an 8-digit UPC-E (number system 0 or 1, with check digit) to its 12-digit UPC-A. Null when not a UPC-E. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const last = d[5];
  let body: string;
  if (last <= '2') body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  else if (last === '3') body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (last === '4') body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  const upcA = `${ns}${body}${check}`;
  return isValidGtin(upcA) ? upcA : null;
}

const CODE39_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

/** Code 39 data (without the * start/stop). With `mod43`, the last character is the check character. */
export function isValidCode39(code: string, mod43 = false): boolean {
  const s = code.replace(/^\*|\*$/g, '');
  if (!s.length || [...s].some((c) => !CODE39_CHARS.includes(c))) return false;
  if (!mod43) return true;
  const body = s.slice(0, -1);
  const sum = [...body].reduce((a, c) => a + CODE39_CHARS.indexOf(c), 0);
  return CODE39_CHARS[sum % 43] === s[s.length - 1];
}

/** Code 128 (subset B as printed by Afey): printable ASCII. The scanner already verified the symbol check. */
export function isValidCode128(code: string): boolean {
  return code.length > 0 && code.length <= 48 && /^[\x20-\x7e]+$/.test(code);
}

export type BarcodeFormat = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'UPC-E' | 'GTIN-14' | 'Code 39' | 'Code 128' | 'Numeric';

export interface BarcodeInfo {
  code: string;
  format: BarcodeFormat;
  /** null when the symbology has no check digit we can verify. */
  checkDigitValid: boolean | null;
  /** GS1 restricted-circulation number (in-store / company internal / scale): not a global GTIN. */
  restricted: boolean;
  /** ISBN-13 when the code is a book barcode (or ISBN-10 typed in). */
  isbn: string | null;
  /** The same item as 13 digits (UPC-A gets a leading 0, UPC-E is expanded) for matching across scanners. */
  gtin13: string | null;
  warnings: string[];
}

/** GS1 restricted circulation: 02, 04 and 20-29 (as EAN-13), i.e. UPC-A number systems 2 and 4. */
export function isRestrictedGtin13(code13: string): boolean {
  return /^(02|04|2\d)/.test(code13);
}

/** Works out what kind of barcode a scanned or typed code is and whether its check digit is right. */
export function detectBarcode(raw: string): BarcodeInfo {
  const code = raw.trim();
  const warnings: string[] = [];
  const isbn = normalizeIsbn(code);
  const digits = /^\d+$/.test(code);
  let format: BarcodeFormat;
  let checkDigitValid: boolean | null = null;
  let gtin13: string | null = null;
  if (digits && code.length === 13) {
    format = 'EAN-13';
    checkDigitValid = isValidEan13(code);
    gtin13 = code;
  } else if (digits && code.length === 12) {
    format = 'UPC-A';
    checkDigitValid = isValidGtin(code);
    gtin13 = `0${code}`;
  } else if (digits && code.length === 14) {
    format = 'GTIN-14';
    checkDigitValid = isValidGtin(code);
    gtin13 = code[0] === '0' ? code.slice(1) : null;
  } else if (digits && code.length === 8) {
    // EAN-8 and UPC-E are both 8 digits: a valid EAN-8 check wins, else try UPC-E.
    if (isValidGtin(code)) { format = 'EAN-8'; checkDigitValid = true; }
    else {
      const upcA = expandUpcE(code);
      if (upcA) { format = 'UPC-E'; checkDigitValid = true; gtin13 = `0${upcA}`; }
      else { format = 'EAN-8'; checkDigitValid = false; }
    }
  } else if (digits) {
    format = 'Numeric';
  } else if (/^[0-9A-Z\-. $/+%]+$/.test(code)) {
    format = 'Code 39';
  } else {
    format = 'Code 128';
    if (!isValidCode128(code)) warnings.push('Contains characters a barcode label cannot print');
  }
  if (checkDigitValid === false) warnings.push('Check digit is wrong: the code was mistyped or misread');
  const restricted = Boolean(gtin13 && checkDigitValid && isRestrictedGtin13(gtin13)) || (format === 'EAN-8' && checkDigitValid === true && /^[02]/.test(code));
  if (restricted) warnings.push('In-store (restricted circulation) number: valid only inside this business, not a registered GTIN');
  return { code, format, checkDigitValid, restricted, isbn: isbn && isbn !== code ? isbn : null, gtin13, warnings };
}

/** Other spellings of the same GTIN a scanner may send (UPC-A with or without the leading 0, UPC-E expanded). */
export function gtinAliases(code: string): string[] {
  const out = new Set<string>();
  if (/^\d{12}$/.test(code) && isValidGtin(code)) out.add(`0${code}`);
  if (/^0\d{12}$/.test(code) && isValidEan13(code)) out.add(code.slice(1));
  if (/^\d{8}$/.test(code)) {
    const upcA = expandUpcE(code);
    if (upcA && !isValidGtin(code)) { out.add(upcA); out.add(`0${upcA}`); }
  }
  if (/^0\d{13}$/.test(code) && isValidGtin(code)) out.add(code.slice(1));
  out.delete(code);
  return [...out];
}

// ---- scale barcodes ----

/**
 * A scale label layout. Positions are 0-based character offsets in the scanned code.
 * EAN-13 example (GS1 Kenya style): prefix 2 digits "21", item 5 digits from 2, value 5 digits from 7, check digit at 12.
 */
export interface ScaleBarcodeFormat {
  id: string;
  name: string;
  enabled: boolean;
  /** Digits the code starts with (e.g. "20" or "2"). */
  prefix: string;
  /** Total length of the scanned code (13 for EAN-13, 12 for UPC-A). */
  length: 12 | 13;
  itemStart: number;
  itemLength: number;
  valueStart: number;
  valueLength: number;
  valueType: 'weight' | 'price';
  /** Weight: decimals of kg (3 = grams). Price: decimals of the currency (2 = cents). */
  valueDecimals: number;
  /** Verify the code's final GS1 check digit. Some scales also print a price check digit, which we skip. */
  verifyCheckDigit: boolean;
}

export interface DecodedScaleBarcode {
  formatId: string;
  formatName: string;
  itemCode: string;
  /** kg, for weight labels (exact decimal from the label, rounded to the label's precision). */
  weight?: number;
  /** cents, for price labels. */
  priceCents?: number;
}

/** Problems with a set of formats (empty when fine): positions outside the code, overlaps, duplicated prefixes. */
export function validateScaleFormats(formats: ScaleBarcodeFormat[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const f of formats) {
    const label = f.name || f.id;
    if (!/^\d{1,3}$/.test(f.prefix)) errors.push(`${label}: prefix must be 1-3 digits`);
    const end = f.length - (f.verifyCheckDigit ? 1 : 0);
    const item: [number, number] = [f.itemStart, f.itemStart + f.itemLength];
    const value: [number, number] = [f.valueStart, f.valueStart + f.valueLength];
    if (f.itemLength < 1 || f.valueLength < 1) errors.push(`${label}: item and value need at least one digit`);
    if (item[0] < f.prefix.length || value[0] < f.prefix.length) errors.push(`${label}: item and value must come after the prefix`);
    if (item[1] > end || value[1] > end) errors.push(`${label}: item or value runs past the end of the code${f.verifyCheckDigit ? ' (the last digit is the check digit)' : ''}`);
    if (item[0] < value[1] && value[0] < item[1]) errors.push(`${label}: item and value positions overlap`);
    if (f.valueDecimals < 0 || f.valueDecimals > 3) errors.push(`${label}: decimals must be 0-3`);
    if (f.enabled) {
      for (const [p, other] of seen) {
        if ((p.startsWith(f.prefix) || f.prefix.startsWith(p)) && other !== label) errors.push(`${label}: prefix ${f.prefix} clashes with ${other} (${p})`);
      }
      seen.set(f.prefix, label);
    }
  }
  return errors;
}

/** Decodes a scanned scale label with the first enabled format that matches. Null when none does. */
export function decodeScaleBarcode(raw: string, formats: ScaleBarcodeFormat[]): DecodedScaleBarcode | null {
  const code = raw.trim();
  if (!/^\d+$/.test(code)) return null;
  for (const f of formats) {
    if (!f.enabled || code.length !== f.length || !code.startsWith(f.prefix)) continue;
    if (f.verifyCheckDigit && !isValidGtin(code)) continue;
    const itemCode = code.slice(f.itemStart, f.itemStart + f.itemLength);
    const rawValue = code.slice(f.valueStart, f.valueStart + f.valueLength);
    if (itemCode.length !== f.itemLength || rawValue.length !== f.valueLength) continue;
    const n = Number(rawValue);
    const base = { formatId: f.id, formatName: f.name, itemCode };
    if (f.valueType === 'weight') {
      // Integer arithmetic then one division keeps 1.255 kg exactly 1.255 (no float drift from repeated maths).
      return { ...base, weight: Number((n / 10 ** f.valueDecimals).toFixed(f.valueDecimals)) };
    }
    // Price: scale the integer to cents without going through floats (2 decimals = already cents).
    const priceCents = f.valueDecimals <= 2 ? n * 10 ** (2 - f.valueDecimals) : Math.round(n / 10 ** (f.valueDecimals - 2));
    return { ...base, priceCents };
  }
  return null;
}

/** The single-layout setting (Settings > Scale barcodes) as formats, one per prefix. */
export function scaleFormatsFromLegacy(cfg: VariableWeightConfig | undefined | null): ScaleBarcodeFormat[] {
  if (!cfg?.enabled) return [];
  if (2 + cfg.itemCodeLength + cfg.valueLength !== 12) return [];
  return cfg.prefixes.map((prefix) => ({
    id: `legacy-${prefix}`, name: `Scale barcode ${prefix}`, enabled: true, prefix, length: 13,
    itemStart: 2, itemLength: cfg.itemCodeLength, valueStart: 2 + cfg.itemCodeLength, valueLength: cfg.valueLength,
    valueType: cfg.valueType, valueDecimals: cfg.valueDecimals, verifyCheckDigit: true,
  }));
}

/** Formats in force: the configured list when there is one, else the legacy single layout. */
export function effectiveScaleFormats(formats: ScaleBarcodeFormat[] | undefined | null, legacy: VariableWeightConfig | undefined | null): ScaleBarcodeFormat[] {
  return formats?.length ? formats : scaleFormatsFromLegacy(legacy);
}

/** Ready-made layouts the admin can start from (common EAN-13 scale label layouts; check against the scale's own settings). */
export const SCALE_FORMAT_PRESETS: Omit<ScaleBarcodeFormat, 'id'>[] = [
  { name: 'Weight: 2 + item 5 + weight 5 (g)', enabled: true, prefix: '21', length: 13, itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, valueType: 'weight', valueDecimals: 3, verifyCheckDigit: true },
  { name: 'Price: 2 + item 5 + price 5 (cents)', enabled: true, prefix: '22', length: 13, itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, valueType: 'price', valueDecimals: 2, verifyCheckDigit: true },
  { name: 'Price: 2 + item 4 + price 6 (cents)', enabled: true, prefix: '23', length: 13, itemStart: 2, itemLength: 4, valueStart: 6, valueLength: 6, valueType: 'price', valueDecimals: 2, verifyCheckDigit: true },
  { name: 'Weight: 2 + item 6 + weight 4 (g)', enabled: true, prefix: '24', length: 13, itemStart: 2, itemLength: 6, valueStart: 8, valueLength: 4, valueType: 'weight', valueDecimals: 3, verifyCheckDigit: true },
];

// ---- internal barcodes ----

/** Default prefix for Afey internal EAN-13 codes: GS1 "04", restricted to use inside one company. */
export const INTERNAL_BARCODE_PREFIX = '04';

/**
 * Internal EAN-13 from a sequence number: prefix (2 digits) + 10-digit sequence + check digit.
 * Refuses a prefix a scale format reads, so an internal code is never decoded as a weighed label.
 */
export function internalEan13(seq: number, prefix = INTERNAL_BARCODE_PREFIX, scaleFormats: ScaleBarcodeFormat[] = []): string {
  if (!/^(02|04|2\d)$/.test(prefix)) throw new Error('Internal barcodes must use a GS1 restricted-circulation prefix (02, 04 or 20-29)');
  if (scaleFormats.some((f) => f.enabled && (f.prefix.startsWith(prefix) || prefix.startsWith(f.prefix)))) throw new Error(`Prefix ${prefix} is used by a scale barcode format`);
  if (!Number.isInteger(seq) || seq < 1 || seq > 9_999_999_999) throw new Error('Sequence out of range');
  const body = `${prefix}${String(seq).padStart(10, '0')}`;
  return body + ean13CheckDigit(body);
}

/** Next free PLU (1..max) not in `used`. PLUs are compared as numbers, so "0012" and "12" are the same PLU. */
export function nextFreePlu(used: Iterable<string>, max = 99999): string | null {
  const taken = new Set<number>();
  for (const u of used) if (/^\d+$/.test(u)) taken.add(Number(u));
  for (let n = 1; n <= max; n++) if (!taken.has(n)) return String(n);
  return null;
}

/** SKU prefix from a category or product name: first letters, upper case (e.g. "Fresh Produce" -> "FP", "Dairy" -> "DAI"). */
export function skuPrefix(name: string | undefined | null, fallback = 'ITM'): string {
  const words = (name ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return fallback;
  const p = words.length === 1 ? words[0].slice(0, 3) : words.slice(0, 3).map((w) => w[0]).join('');
  return p.length >= 2 ? p : fallback;
}
