import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env.js';

const scrypt = promisify(crypto.scrypt) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Password hashing with scrypt (memory-hard, built into Node). Format: scrypt$N$r$p$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  if (!stored) {
    // Spend comparable time to avoid user enumeration through timing.
    await scrypt(password, crypto.randomBytes(16), 64, SCRYPT);
    return false;
  }
  const [alg, N, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function hmacSha256(key: string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function key(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, 'base64');
}

/** AES-256-GCM encryption for secrets at rest (integration credentials, 2FA secrets, biometric templates). */
export function encrypt(plaintext: string | Buffer, aad = ''): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptBuffer(payload: string, aad = ''): Buffer {
  const [v, ivB64, tagB64, dataB64] = payload.split(':');
  if (v !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
}

export function decrypt(payload: string, aad = ''): string {
  return decryptBuffer(payload, aad).toString('utf8');
}

// ---- TOTP (RFC 6238) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totp(secretB32: string, timeMs = Date.now(), step = 30, digits = 6, algorithm = 'sha1'): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algorithm, base32Decode(secretB32)).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export function verifyTotp(secretB32: string, code: string, window = 1, timeMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (let w = -window; w <= window; w++) if (safeEqual(totp(secretB32, timeMs + w * 30000), code)) return true;
  return false;
}
