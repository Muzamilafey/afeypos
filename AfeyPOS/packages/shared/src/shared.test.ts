import { describe, expect, it } from 'vitest';
import {
  allocateProportionally, calculateTax, lineAmount, toCents, roundQty,
  ean13CheckDigit, isValidEan13, parseVariableWeightBarcode, DEFAULT_VARIABLE_WEIGHT_CONFIG, normalizeIsbn, isbn13To10,
  resolveCapabilities, BUSINESS_TYPES, BUSINESS_PROFILES, navigationFor, permissionsForRoles, hasPermission,
  subdomainFromHost, validateSubdomain,
} from './index.js';

describe('money', () => {
  it('converts major units to cents without float drift', () => {
    expect(toCents(1.005)).toBe(101);
    expect(toCents('12.50')).toBe(1250);
    expect(toCents(-3.333)).toBe(-333);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
  it('computes line amounts with fractional quantities', () => {
    expect(lineAmount(2.5, 33333)).toBe(83333);
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
  });
  it('computes inclusive and exclusive tax', () => {
    expect(calculateTax(11600, 1600, true)).toEqual({ net: 10000, tax: 1600, gross: 11600 });
    expect(calculateTax(10000, 1600, false)).toEqual({ net: 10000, tax: 1600, gross: 11600 });
  });
  it('allocates proportionally and sums exactly', () => {
    const parts = allocateProportionally(1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b)).toBe(1000);
    expect(parts).toEqual([334, 333, 333]);
  });
});

describe('barcodes', () => {
  it('validates EAN-13', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
  });
  it('parses variable-weight barcodes', () => {
    const body = '21' + '12345' + '01250';
    const code = body + ean13CheckDigit(body);
    expect(parseVariableWeightBarcode(code, { ...DEFAULT_VARIABLE_WEIGHT_CONFIG, enabled: true })).toEqual({ itemCode: '12345', weight: 1.25 });
    expect(parseVariableWeightBarcode(code, DEFAULT_VARIABLE_WEIGHT_CONFIG)).toBeNull();
    const priced = parseVariableWeightBarcode(code, { ...DEFAULT_VARIABLE_WEIGHT_CONFIG, enabled: true, valueType: 'price', valueDecimals: 2 });
    expect(priced).toEqual({ itemCode: '12345', priceCents: 1250 });
  });
});

describe('business profiles', () => {
  it('every business type has a profile with pos and inventory', () => {
    for (const t of BUSINESS_TYPES) {
      expect(BUSINESS_PROFILES[t].modules).toContain('pos');
      expect(BUSINESS_PROFILES[t].modules).toContain('inventory');
    }
  });
  it('bookshop gets book fields, school accounts and special orders', () => {
    const c = resolveCapabilities({ businessType: 'bookshop' });
    expect(c.productFields).toEqual(expect.arrayContaining(['isbn', 'author', 'publisher', 'edition', 'bookCondition', 'gradeLevel']));
    expect(c.modules).toEqual(expect.arrayContaining(['customerCredit', 'quotations', 'salesOrders', 'invoices', 'loyalty']));
    expect(c.priceLists).toContain('wholesale');
    expect(resolveCapabilities({ businessType: 'minimart' }).productFields).not.toContain('isbn');
  });
  it('normalises ISBN-10 and ISBN-13 and rejects bad check digits', () => {
    expect(normalizeIsbn('0-306-40615-2')).toBe('9780306406157');
    expect(normalizeIsbn('978-0-306-40615-7')).toBe('9780306406157');
    expect(normalizeIsbn('080442957X')).toBe('9780804429573');
    expect(normalizeIsbn('0-306-40615-3')).toBeNull();
    expect(normalizeIsbn('9780306406158')).toBeNull();
    expect(normalizeIsbn('6161100100011')).toBeNull(); // a valid EAN-13, but not an ISBN
    expect(isbn13To10('9780306406157')).toBe('0306406152');
    expect(isbn13To10('9780804429573')).toBe('080442957X');
  });
  it('hardware gets fractional quantities, unit conversions and contractor prices', () => {
    const c = resolveCapabilities({ businessType: 'hardware' });
    expect(c.modules).toEqual(expect.arrayContaining(['quotations', 'unitConversions', 'fractionalQuantities', 'deliveryNotes']));
    expect(c.priceLists).toContain('contractor');
    expect(c.checkout.allowFractionalQty).toBe(true);
    expect(c.productFields).toContain('dimensions');
  });
  it('minimart is touch friendly with expiry tracking and no quotations', () => {
    const c = resolveCapabilities({ businessType: 'minimart' });
    expect(c.checkout.touchMode).toBe(true);
    expect(c.modules).toContain('batchExpiry');
    expect(c.modules).not.toContain('quotations');
  });
  it('owners can enable extra modules, plans can restrict them, core cannot be disabled', () => {
    const c = resolveCapabilities({ businessType: 'minimart', enabledModules: ['quotations', 'serialNumbers'], disabledModules: ['pos'] });
    expect(c.modules).toContain('quotations');
    expect(c.productFields).toContain('serial');
    expect(c.modules).toContain('pos');
    const r = resolveCapabilities({ businessType: 'supermarket', entitledModules: ['pos', 'inventory'] });
    expect(r.modules).toEqual(['pos', 'inventory']);
  });
  it('navigation follows modules and permissions', () => {
    const caps = resolveCapabilities({ businessType: 'minimart' });
    const cashierNav = navigationFor(caps, permissionsForRoles(['cashier'])).map((n) => n.key);
    expect(cashierNav).toContain('pos');
    expect(cashierNav).not.toContain('settings');
    expect(cashierNav).not.toContain('quotations');
    const hw = navigationFor(resolveCapabilities({ businessType: 'hardware' }), permissionsForRoles(['tenant_owner'])).map((n) => n.key);
    expect(hw).toContain('quotations');
  });
});

describe('permissions', () => {
  it('cashiers cannot adjust stock or approve credit; owners cannot manage platform', () => {
    expect(hasPermission(['cashier'], 'inventory.adjust')).toBe(false);
    expect(hasPermission(['cashier'], 'credit.approve')).toBe(false);
    expect(hasPermission(['tenant_owner'], 'platform.tenants.manage')).toBe(false);
    expect(hasPermission(['platform_support'], 'platform.tenants.manage')).toBe(false);
  });
});

describe('tenancy helpers', () => {
  it('resolves subdomains', () => {
    expect(subdomainFromHost('mandera.afeypos.com', 'afeypos.com')).toBe('mandera');
    expect(subdomainFromHost('Mandera.AfeyPOS.com:443', 'afeypos.com')).toBe('mandera');
    expect(subdomainFromHost('afeypos.com', 'afeypos.com')).toBeNull();
    expect(subdomainFromHost('a.b.afeypos.com', 'afeypos.com')).toBeNull();
    expect(subdomainFromHost('evilafeypos.com', 'afeypos.com')).toBeNull();
  });
  it('validates subdomains', () => {
    expect(validateSubdomain('hardware')).toBeNull();
    expect(validateSubdomain('admin')).not.toBeNull();
    expect(validateSubdomain('-bad')).not.toBeNull();
    expect(validateSubdomain('a')).not.toBeNull();
  });
});
