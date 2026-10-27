import { describe, expect, it } from 'vitest';
import { maskPhone, mpesaPayer } from './format';

describe('M-Pesa payer on the till screen', () => {
  it('shows part of the number', () => {
    expect(maskPhone('254712345678')).toBe('0712 ••• 678');
    expect(maskPhone('0712345678')).toBe('0712 ••• 678');
  });
  it('keeps Safaricom masking and hides hashed numbers', () => {
    expect(maskPhone('2547****678')).toBe('07****678');
    expect(maskPhone('a'.repeat(64))).toBe('');
    expect(maskPhone('')).toBe('');
  });
  it('combines the M-Pesa name and the number', () => {
    expect(mpesaPayer({ payerName: 'JANE  WANJIKU', phone: '254712345678' })).toBe('JANE WANJIKU (0712 ••• 678)');
    expect(mpesaPayer({ payerName: 'JANE', phone: 'f'.repeat(64) })).toBe('JANE');
    expect(mpesaPayer({})).toBe('');
  });
});
