import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Keyed hash for codes and tokens stored in the database (never stored in clear). */
export const keyedHash = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const numericCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');

/** Easy to read aloud and copy from paper: no 0/O, 1/I/L. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function activationCode(length = 8): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return s;
}
export const normaliseActivationCode = (c: string) => c.toUpperCase().replace(/[^0-9A-Z]/g, '');

/** PINs that are too easy to guess: one repeated digit, or a straight run up or down. */
export function weakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const up = d.every((n, i) => i === 0 || n === (d[i - 1] + 1) % 10);
  const down = d.every((n, i) => i === 0 || n === (d[i - 1] + 9) % 10);
  return up || down;
}

// ---- TOTP (RFC 6238, SHA-1, 30 s, 6 digits): works with Google Authenticator, Authy, Microsoft Authenticator
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret: string, timeMs: number, step = 30): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const c = code.replace(/\s/g, '');
  return [-1, 0, 1].some((w) => safeEqual(totpAt(secret, now + w * 30_000), c));
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
