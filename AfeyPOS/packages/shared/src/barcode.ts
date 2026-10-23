/** EAN-13 / UPC check digit helpers and variable-weight (in-store) barcode parsing. */

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('EAN-13 body must be 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/**
 * Normalises an ISBN-10 or ISBN-13 (hyphens/spaces allowed) to ISBN-13 digits, the code printed as the
 * book's EAN-13 barcode. Returns null when the check digit is wrong.
 */
export function normalizeIsbn(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
    if (sum % 11 !== 0) return null;
    const body = `978${s.slice(0, 9)}`;
    return body + ean13CheckDigit(body);
  }
  if (/^97[89]\d{10}$/.test(s) && isValidEan13(s)) return s;
  return null;
}

/** ISBN-10 for a 978-prefixed ISBN-13 (979 ISBNs have no ISBN-10). */
export function isbn13To10(isbn13: string): string | null {
  if (!/^978\d{10}$/.test(isbn13)) return null;
  const body = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
  const c = (11 - (sum % 11)) % 11;
  return body + (c === 10 ? 'X' : String(c));
}

export interface VariableWeightConfig {
  enabled: boolean;
  /** Two-digit GS1 restricted-circulation prefixes, typically 20-29. */
  prefixes: string[];
  itemCodeLength: number;
  valueLength: number;
  /** Whether the embedded value is a weight or a price. */
  valueType: 'weight' | 'price';
  /** For weight: decimals of kg (3 = grams). For price: decimals of currency (2 = cents). */
  valueDecimals: number;
}

export const DEFAULT_VARIABLE_WEIGHT_CONFIG: VariableWeightConfig = {
  enabled: false,
  prefixes: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'],
  itemCodeLength: 5,
  valueLength: 5,
  valueType: 'weight',
  valueDecimals: 3,
};

export interface ParsedVariableBarcode {
  itemCode: string;
  /** weight in kg (valueType weight) */
  weight?: number;
  /** price in cents (valueType price) */
  priceCents?: number;
}

/**
 * Parses a scale-printed EAN-13 barcode: PP IIIII VVVVV C.
 * Returns null when the code is not a variable-weight code for the given config.
 */
export function parseVariableWeightBarcode(code: string, cfg: VariableWeightConfig): ParsedVariableBarcode | null {
  if (!cfg.enabled || !isValidEan13(code)) return null;
  const prefix = code.slice(0, 2);
  if (!cfg.prefixes.includes(prefix)) return null;
  if (2 + cfg.itemCodeLength + cfg.valueLength !== 12) return null;
  const itemCode = code.slice(2, 2 + cfg.itemCodeLength);
  const rawValue = Number(code.slice(2 + cfg.itemCodeLength, 12));
  if (cfg.valueType === 'weight') return { itemCode, weight: rawValue / 10 ** cfg.valueDecimals };
  const priceCents = Math.round((rawValue / 10 ** cfg.valueDecimals) * 100);
  return { itemCode, priceCents };
}
