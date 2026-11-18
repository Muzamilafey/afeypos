/**
 * Scannable barcode images (SVG) for printed labels, sized in real millimetres with proper quiet zones so a
 * scanner can read them. An EAN-13 / EAN-8 / UPC code is drawn as its real retail symbol; anything else
 * (internal codes, SKUs, letters) is drawn as Code 128. The bars are never stretched to the label width.
 */
import { detectBarcode } from './barcodeEngine.js';
import { ean13CheckDigit } from './barcode.js';
import { code128Svg } from './code128.js';

// EAN/UPC digit encodings (7 modules each). L = left odd, G = left even, R = right.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
// Which of the first six digits use L vs G, chosen by the first digit (EAN-13 number system).
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** The on/off module string (1 = bar) for an EAN-13 code (13 digits). */
function ean13Bits(code: string): string {
  const d = code.split('').map(Number);
  let s = '101'; // left guard
  const parity = PARITY[d[0]!]!;
  for (let i = 1; i <= 6; i++) s += (parity[i - 1] === 'L' ? L : G)[d[i]!];
  s += '01010'; // centre guard
  for (let i = 7; i <= 12; i++) s += R[d[i]!];
  s += '101'; // right guard
  return s;
}

/** The on/off module string for an EAN-8 code (8 digits): 4 L digits, centre, 4 R digits. */
function ean8Bits(code: string): string {
  const d = code.split('').map(Number);
  let s = '101';
  for (let i = 0; i < 4; i++) s += L[d[i]!];
  s += '01010';
  for (let i = 4; i < 8; i++) s += R[d[i]!];
  s += '101';
  return s;
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/** Draws bars from a module bit-string at a given module width and height (mm). Guard bars run a little taller. */
function barsSvg(bits: string, opts: { moduleMm: number; heightMm: number; quietLeft: number; quietRight: number; guards?: number[] }): string {
  const { moduleMm, heightMm } = opts;
  const guardSet = new Set<number>();
  // Guard bars (start/centre/end) extend below the digits area.
  (opts.guards ?? []).forEach((g) => guardSet.add(g));
  const totalModules = opts.quietLeft + bits.length + opts.quietRight;
  const width = mm(totalModules * moduleMm);
  const height = mm(heightMm);
  let x = opts.quietLeft * moduleMm;
  const rects: string[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') rects.push(`<rect x="${mm(x)}" y="0" width="${mm(moduleMm)}" height="${height}"/>`);
    x += moduleMm;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}mm" height="${height}mm" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"><rect width="${width}" height="${height}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}

export interface LabelBarcodeOptions {
  /** Barcode height in mm (default 10). */
  heightMm?: number;
  /** Target width of one narrow bar in mm (default 0.33; never drawn thinner than 0.254 mm = scannable minimum). */
  moduleMm?: number;
  /** If set, shrink the module (down to the minimum) so the whole symbol fits this width in mm. */
  maxWidthMm?: number;
}

/**
 * A scannable barcode SVG for a printed label. Uses the real EAN/UPC symbol for GTIN codes, Code 128 otherwise.
 * The SVG carries its size in millimetres, so print CSS must NOT stretch it (no width/height override).
 */
export function labelBarcodeSvg(raw: string, options: LabelBarcodeOptions = {}): string {
  const heightMm = options.heightMm ?? 10;
  const MIN_MODULE = 0.254; // ~10 mil: the smallest bar most scanners read reliably
  let moduleMm = options.moduleMm ?? 0.33;
  const info = detectBarcode(raw);

  // Turn UPC-A / UPC-E into their EAN-13 form so they print as a standard retail symbol.
  let ean: string | null = null;
  if (info.format === 'EAN-13' && info.checkDigitValid) ean = info.code;
  else if (info.format === 'UPC-A' && info.checkDigitValid) ean = `0${info.code}`;
  else if (info.format === 'UPC-E' && info.gtin13) ean = info.gtin13;

  if (ean && ean.length === 13 && String(ean13CheckDigit(ean.slice(0, 12))) === ean[12]) {
    const bits = ean13Bits(ean);
    const quietLeft = 11; const quietRight = 7; // EAN-13 quiet zones
    if (options.maxWidthMm) moduleMm = Math.max(MIN_MODULE, Math.min(moduleMm, options.maxWidthMm / (bits.length + quietLeft + quietRight)));
    return barsSvg(bits, { moduleMm, heightMm, quietLeft, quietRight });
  }
  if (info.format === 'EAN-8' && info.checkDigitValid) {
    const bits = ean8Bits(info.code);
    const quietLeft = 7; const quietRight = 7;
    if (options.maxWidthMm) moduleMm = Math.max(MIN_MODULE, Math.min(moduleMm, options.maxWidthMm / (bits.length + quietLeft + quietRight)));
    return barsSvg(bits, { moduleMm, heightMm, quietLeft, quietRight });
  }

  // Everything else: Code 128. code128Svg draws in pixels, so scale 1 module = moduleMm and add a quiet zone.
  // Recompute module to fit when asked (Code 128 has 11 modules per character plus start/check/stop and quiet zones).
  if (options.maxWidthMm) {
    const approxModules = 35 + raw.length * 11; // start+check+stop+quiet ≈ 35, 11 per data char
    moduleMm = Math.max(MIN_MODULE, Math.min(moduleMm, options.maxWidthMm / approxModules));
  }
  // Render at a high pixel density (10 px per module) then declare the real mm width so it prints crisp.
  const pxPerModule = 10;
  const svgPx = code128Svg(raw, Math.round(heightMm * pxPerModule / moduleMm), pxPerModule);
  const vbWidth = Number(/viewBox="0 0 ([0-9.]+)/.exec(svgPx)?.[1] ?? 0);
  const widthMm = mm((vbWidth / pxPerModule) * moduleMm);
  const hMm = mm(heightMm);
  return svgPx.replace(/width="[0-9.]+" height="[0-9.]+"/, `width="${widthMm}mm" height="${hMm}mm" preserveAspectRatio="xMidYMid meet"`);
}
