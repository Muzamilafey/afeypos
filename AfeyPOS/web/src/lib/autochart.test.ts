import { describe, expect, it } from 'vitest';
import { findDatasets, measureLabel } from '../components/AutoChart';

describe('report graph view', () => {
  it('finds the table and its measures in a sales report', () => {
    const { sets } = findDatasets({ data: [{ _id: '2026-11-01', count: 3, grossCents: 30000, grossProfitCents: 9000 }, { _id: '2026-11-02', count: 1, grossCents: 5000, grossProfitCents: 1000 }] });
    expect(sets).toHaveLength(1);
    expect(sets[0]!.measures[0]).toBe('grossCents');
    expect(sets[0]!.labelOf(sets[0]!.rows[0]!)).toBe('2026-11-01');
    expect(measureLabel('grossProfitCents')).toBe('Gross profit');
  });

  it('uses names inside objects, picks nested tables and turns a one-row summary into figures', () => {
    const r = findDatasets({ purchases: [{ supplier: { name: 'Bidco' }, totalCents: 100 }, { supplier: { name: 'Kapa' }, totalCents: 50 }], payables: { totalCents: 70, data: [{ supplier: { name: 'Bidco' }, total: 70 }] } });
    const purchases = r.sets.find((s) => s.key === 'purchases')!;
    expect(purchases.labelOf(purchases.rows[1]!)).toBe('Kapa');
    expect(r.figures.map((f) => f.key)).toContain('totalCents');
    const profit = findDatasets({ data: [{ grossSalesCents: 1000, cogsCents: 600, salesCount: 2 }] });
    expect(profit.sets).toHaveLength(0);
    expect(profit.figures.map((f) => f.key)).toEqual(['grossSalesCents', 'cogsCents']);
  });
});
