import { describe, expect, it } from 'vitest';
import { labelBarcodeSvg } from './labelBarcode.js';

/** Count black bar rects in the SVG. */
const bars = (svg: string) => (svg.match(/<rect x=/g) ?? []).length;

describe('labelBarcodeSvg', () => {
  it('draws a real EAN-13 symbol for a valid GTIN, sized in millimetres', () => {
    const svg = labelBarcodeSvg('6161100100042', { heightMm: 10 });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toMatch(/width="[0-9.]+mm" height="10mm"/);
    // EAN-13 has guard + 6 L/G + centre + 6 R + guard; there must be many bars and a quiet zone (first rect not at x=0).
    expect(bars(svg)).toBeGreaterThan(25);
    expect(svg).not.toMatch(/<rect x="0"/); // the leading quiet zone pushes the first bar in
  });

  it('turns UPC-A into the same symbol as its EAN-13 form', () => {
    const upc = labelBarcodeSvg('036000291452');
    const ean = labelBarcodeSvg('0036000291452');
    expect(bars(upc)).toBe(bars(ean));
  });

  it('falls back to Code 128 for letters and in-store codes, still in mm', () => {
    const svg = labelBarcodeSvg('MILK500');
    expect(svg).toMatch(/width="[0-9.]+mm" height="[0-9.]+mm"/);
    expect(bars(svg)).toBeGreaterThan(10);
  });

  it('never prints the narrowest bar below the scannable minimum when fitting a width', () => {
    const svg = labelBarcodeSvg('6161100100042', { heightMm: 10, maxWidthMm: 20 });
    const w = Number(/width="([0-9.]+)mm"/.exec(svg)![1]);
    // 95 modules + 18 quiet at the 0.254 mm minimum ≈ 28.7 mm, so it is allowed to exceed the 20 mm cap rather than shrink unscannably.
    expect(w).toBeGreaterThan(25);
  });
});
