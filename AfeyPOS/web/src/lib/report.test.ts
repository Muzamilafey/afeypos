import { describe, expect, it } from 'vitest';
import { cellValue } from './report';

describe('report export cells', () => {
  it('turns money, counts and percentages into numbers and leaves text alone', () => {
    expect(cellValue('Ksh 1,200.00')).toBe(1200);
    expect(cellValue('KES 45')).toBe(45);
    expect(cellValue('−Ksh 30.50')).toBe(-30.5);
    expect(cellValue('1,250')).toBe(1250);
    expect(cellValue('12.5%')).toBe(0.125);
    expect(cellValue('Milk 500ml')).toBe('Milk 500ml');
    expect(cellValue('RCP-000001')).toBe('RCP-000001');
    expect(cellValue('—')).toBe('—');
  });
});
