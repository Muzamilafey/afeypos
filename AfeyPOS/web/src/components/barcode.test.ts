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

describe('newRequestId', () => {
  it('produces v4 UUIDs even without crypto.randomUUID (plain-HTTP LAN tills)', async () => {
    const { newRequestId } = await import('../lib/api');
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
