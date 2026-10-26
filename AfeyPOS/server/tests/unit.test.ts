import { beforeAll, describe, expect, it } from 'vitest';
import { loadEnv, resetEnv } from '../src/config/env.js';
import { base32Encode, decrypt, encrypt, hashPassword, totp, verifyPassword, verifyTotp } from '../src/lib/crypto.js';
import { parseCsv, toCsv } from '../src/lib/csv.js';
import { EscPosBuilder } from '../src/modules/hardware/escpos.js';
import { renderReceiptText } from '../src/modules/hardware/receipt.js';

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = 'unit-test-secret-unit-test-secret-unit-test';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  resetEnv();
  loadEnv();
});

describe('crypto', () => {
  it('matches RFC 6238 TOTP test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totp(secret, 59_000, 30, 8)).toBe('94287082');
    expect(totp(secret, 1111111109_000, 30, 8)).toBe('07081804');
    expect(totp(secret, 2000000000_000, 30, 8)).toBe('69279037');
    const code = totp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000000', 0, 59_000)).toBe(false);
  });
  it('hashes passwords with scrypt and verifies them', async () => {
    const h = await hashPassword('S3cret!pass');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('S3cret!pass', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
  });
  it('encrypts with AES-256-GCM and binds associated data', () => {
    const c = encrypt('consumer-secret', 'cfg-1');
    expect(c).not.toContain('consumer-secret');
    expect(decrypt(c, 'cfg-1')).toBe('consumer-secret');
    expect(() => decrypt(c, 'cfg-2')).toThrow();
    const tampered = c.slice(0, -4) + (c.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decrypt(tampered, 'cfg-1')).toThrow();
  });
  it('refuses weak or invalid configuration', () => {
    resetEnv();
    expect(() => loadEnv({ ...process.env, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(() => loadEnv({ ...process.env, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv({ ...process.env, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change-me-to-a-long-random-secret-at-least-32-chars' })).toThrow(/placeholder/);
    resetEnv();
    loadEnv();
  });
});

describe('csv', () => {
  it('parses quoted fields and protects exports against formula injection', () => {
    const rows = parseCsv('a,b\n"x, y","he said ""hi"""\r\n1,2\n');
    expect(rows).toEqual([{ a: 'x, y', b: 'he said "hi"' }, { a: '1', b: '2' }]);
    const out = toCsv([{ name: '=HYPERLINK("evil")', n: -5 }]);
    expect(out).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(out).toContain(',-5');
  });
});

describe('receipts', () => {
  it('builds ESC/POS with init, cut and drawer kick', () => {
    const b = new EscPosBuilder().line('Hello').cut().openDrawer().build();
    expect([...b.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(b.includes(Buffer.from([0x1d, 0x56]))).toBe(true);
    expect(b.includes(Buffer.from([0x1b, 0x70]))).toBe(true);
  });
  it('renders a text receipt with totals and payments', () => {
    const text = renderReceiptText(
      { name: 'Duka', settings: { currency: 'KES', receiptFooter: 'Asante' } },
      { number: 'RCP-000001', completedAt: new Date(), lines: [{ name: 'Sugar', qty: 2, unitCode: 'pc', unitPriceCents: 14500, totalCents: 29000 }], totalCents: 29000, taxCents: 4000, payments: [{ method: 'mpesa', amountCents: 29000, reference: 'QWE123' }] },
    );
    expect(text).toContain('RCP-000001');
    expect(text).toContain('M-Pesa QWE123');
    expect(text).toContain('Asante');
  });
});
