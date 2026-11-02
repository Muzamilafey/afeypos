import { describe, expect, it } from 'vitest';
import {
  detectBarcode, decodeScaleBarcode, ean13CheckDigit, expandUpcE, effectiveScaleFormats, gs1CheckDigit, gtinAliases, internalEan13,
  isValidCode39, isValidGtin, nextFreePlu, scaleFormatsFromLegacy, skuPrefix, validateScaleFormats, DEFAULT_VARIABLE_WEIGHT_CONFIG,
  SCALE_FORMAT_PRESETS, type ScaleBarcodeFormat,
} from './index.js';

const withCheck = (body: string) => body + ean13CheckDigit(body);
const fmt = (over: Partial<ScaleBarcodeFormat> = {}): ScaleBarcodeFormat => ({ id: 'a', ...SCALE_FORMAT_PRESETS[0], ...over });

describe('check digits and symbologies', () => {
  it('validates GTIN-8/12/13/14', () => {
    expect(isValidGtin('5901234123457')).toBe(true);
    expect(isValidGtin('5901234123458')).toBe(false);
    expect(isValidGtin('036000291452')).toBe(true);
    expect(isValidGtin('96385074')).toBe(true);
    expect(isValidGtin('00012345678905')).toBe(true);
    expect(gs1CheckDigit('03600029145')).toBe(2);
  });

  it('expands UPC-E to UPC-A', () => {
    expect(expandUpcE('04252614')).toBe('042100005264');
    expect(expandUpcE('04252615')).toBeNull();
    expect(expandUpcE('34252614')).toBeNull();
  });

  it('checks Code 39 with and without mod 43', () => {
    expect(isValidCode39('CODE39')).toBe(true);
    expect(isValidCode39('CODE39W', true)).toBe(true);
    expect(isValidCode39('CODE39X', true)).toBe(false);
    expect(isValidCode39('lower')).toBe(false);
  });

  it('detects formats and flags wrong check digits and in-store numbers', () => {
    expect(detectBarcode('5901234123457')).toMatchObject({ format: 'EAN-13', checkDigitValid: true, restricted: false });
    expect(detectBarcode('5901234123458')).toMatchObject({ format: 'EAN-13', checkDigitValid: false });
    expect(detectBarcode('5901234123458').warnings[0]).toMatch(/Check digit/);
    expect(detectBarcode('036000291452')).toMatchObject({ format: 'UPC-A', gtin13: '0036000291452' });
    expect(detectBarcode('04252614')).toMatchObject({ format: 'UPC-E', gtin13: '0042100005264' });
    expect(detectBarcode('96385074')).toMatchObject({ format: 'EAN-8', checkDigitValid: true });
    expect(detectBarcode('ABC-123')).toMatchObject({ format: 'Code 39', checkDigitValid: null });
    expect(detectBarcode('abc#1')).toMatchObject({ format: 'Code 128' });
    expect(detectBarcode(withCheck('041234567890'))).toMatchObject({ restricted: true });
    expect(detectBarcode('978-0-306-40615-7').isbn).toBe('9780306406157');
  });

  it('matches UPC-A with or without the leading zero', () => {
    expect(gtinAliases('036000291452')).toEqual(['0036000291452']);
    expect(gtinAliases('0036000291452')).toEqual(['036000291452']);
    expect(gtinAliases('04252614')).toEqual(['042100005264', '0042100005264']);
  });
});

describe('scale barcode formats', () => {
  it('decodes weight and price labels exactly', () => {
    const formats = [fmt(), fmt({ id: 'b', ...SCALE_FORMAT_PRESETS[1] })];
    expect(decodeScaleBarcode(withCheck('210012301255'), formats)).toMatchObject({ formatId: 'a', itemCode: '00123', weight: 1.255 });
    expect(decodeScaleBarcode(withCheck('220012300450'), formats)).toMatchObject({ formatId: 'b', itemCode: '00123', priceCents: 450 });
    // Wrong check digit or an unknown prefix: not a scale label.
    expect(decodeScaleBarcode('2100123012550', formats)).toBeNull();
    expect(decodeScaleBarcode(withCheck('250012301255'), formats)).toBeNull();
    // Whole-shilling price labels (0 decimals).
    expect(decodeScaleBarcode(withCheck('230012000450'), [fmt({ ...SCALE_FORMAT_PRESETS[2], valueDecimals: 0 })])).toMatchObject({ priceCents: 45000 });
  });

  it('rejects layouts that overlap, overrun or clash', () => {
    expect(validateScaleFormats([fmt()])).toEqual([]);
    expect(validateScaleFormats([fmt({ valueStart: 5 })])[0]).toMatch(/overlap/);
    expect(validateScaleFormats([fmt({ valueLength: 6 })])[0]).toMatch(/past the end/);
    expect(validateScaleFormats([fmt({ name: 'A' }), fmt({ id: 'b', name: 'B', prefix: '2' })])[0]).toMatch(/clashes/);
  });

  it('keeps the old single layout working', () => {
    const legacy = scaleFormatsFromLegacy({ ...DEFAULT_VARIABLE_WEIGHT_CONFIG, enabled: true });
    expect(legacy).toHaveLength(10);
    expect(decodeScaleBarcode(withCheck('270012301255'), legacy)).toMatchObject({ itemCode: '00123', weight: 1.255 });
    expect(effectiveScaleFormats([], { ...DEFAULT_VARIABLE_WEIGHT_CONFIG, enabled: false })).toEqual([]);
    expect(effectiveScaleFormats([fmt()], { ...DEFAULT_VARIABLE_WEIGHT_CONFIG, enabled: true })).toHaveLength(1);
  });
});

describe('internal codes', () => {
  it('makes restricted-circulation EAN-13s that never collide with scale labels', () => {
    const c = internalEan13(42);
    expect(c).toBe(withCheck('040000000042'));
    expect(detectBarcode(c).restricted).toBe(true);
    expect(() => internalEan13(1, '59')).toThrow(/restricted/);
    expect(() => internalEan13(1, '21', [fmt()])).toThrow(/scale/);
  });

  it('finds the next PLU and a SKU prefix', () => {
    expect(nextFreePlu(['1', '002', '4'])).toBe('3');
    expect(skuPrefix('Fresh Produce')).toBe('FP');
    expect(skuPrefix('Dairy')).toBe('DAI');
    expect(skuPrefix('')).toBe('ITM');
  });
});
