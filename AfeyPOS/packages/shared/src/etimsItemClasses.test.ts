import { describe, it, expect } from 'vitest';
import { ETIMS_ITEM_CLASSES, etimsItemClass, searchEtimsItemClasses } from './etimsItemClasses.js';

describe('eTIMS item classes', () => {
  it('every built-in code is 8–10 digits (KRA itemClsCd shape)', () => {
    for (const c of ETIMS_ITEM_CLASSES) expect(c.code).toMatch(/^\d{8,10}$/);
  });

  it('has no duplicate codes', () => {
    const codes = ETIMS_ITEM_CLASSES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('looks up a known code', () => {
    expect(etimsItemClass('50200000')?.group).toBe('Food & groceries');
    expect(etimsItemClass('00000000')).toBeUndefined();
    expect(etimsItemClass('')).toBeUndefined();
  });

  it('searches by name, keyword and code', () => {
    expect(searchEtimsItemClasses('soda').some((c) => c.code === '50200000')).toBe(true);
    expect(searchEtimsItemClasses('dawa').some((c) => c.code === '51100000')).toBe(true);
    expect(searchEtimsItemClasses('cement').some((c) => c.code === '30100000')).toBe(true);
    expect(searchEtimsItemClasses('')).toHaveLength(ETIMS_ITEM_CLASSES.length);
  });
});
