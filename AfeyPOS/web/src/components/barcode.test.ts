import { describe, expect, it } from 'vitest';
import { code128Svg } from './barcode';
import { toCentsInput } from '../lib/format';

describe('code128Svg', () => {
  it('renders start, data, checksum and stop symbols', () => {
    const svg = code128Svg('MILK500');
    // 1 start + 7 data + 1 checksum = 9 symbols of 3 bars, stop has 4 bars
    expect((svg.match(/<rect x=/g) ?? []).length).toBe(9 * 3 + 4);
    expect(svg.startsWith('<svg')).toBe(true);
  });
  it('rejects characters outside Code 128B', () => {
    expect(() => code128Svg('é')).toThrow();
  });
});

describe('toCentsInput', () => {
  it('parses typed amounts', () => {
    expect(toCentsInput('1,250.50')).toBe(125050);
    expect(toCentsInput('abc')).toBe(0);
  });
});
