import { describe, expect, it } from 'vitest';
import { withFieldDetails } from './api';

describe('error messages', () => {
  it('name the fields instead of only "Validation failed"', () => {
    expect(withFieldDetails('Validation failed', [{ path: 'barcodes.0.code', message: 'String must contain at least 3 character(s)' }]))
      .toBe('Please check — Barcode › code: String must contain at least 3 character(s)');
    expect(withFieldDetails('Validation failed', [{ path: 'settings.tagline', message: 'Too long' }])).toBe('Please check — Settings › Tagline: Too long');
    expect(withFieldDetails('Not found', undefined)).toBe('Not found');
  });
});
