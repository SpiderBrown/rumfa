import { createHash } from 'node:crypto';
import sharp from 'sharp';

export interface StoredSheet { bytes: Buffer; contentType: string; ext: 'jpg' | 'pdf'; sha256: string; phash: string | null }

/**
 * Normalise a downloaded sheet: images are resized to at most `maxWidth` px and
 * saved as JPEG; PDFs are stored as-is (OCR providers read PDFs directly).
 */
export async function prepareSheet(bytes: Buffer, contentType: string, maxWidth: number): Promise<StoredSheet> {
  const isPdf = contentType.includes('pdf') || bytes.subarray(0, 4).toString() === '%PDF';
  if (isPdf) {
    return { bytes, contentType: 'application/pdf', ext: 'pdf', sha256: sha256(bytes), phash: null };
  }
  const out = await sharp(bytes).rotate().resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { bytes: out, contentType: 'image/jpeg', ext: 'jpg', sha256: sha256(out), phash: await dHash(out) };
}

export function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * 256-bit difference hash (16x16). On real 2023 sheets, the same photo
 * re-encoded differs by <= ~16 bits while different sheets of the same
 * printed form differ by >= ~70, so DUPLICATE_MAX_DISTANCE = 24 separates them.
 */
export async function dHash(img: Buffer): Promise<string> {
  const W = 16, H = 16;
  const { data } = await sharp(img).grayscale().normalise().resize(W + 1, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let hex = '';
  for (let i = 0; i < W * H; i += 4) {
    let nib = 0;
    for (let b = 0; b < 4; b++) {
      const k = i + b, y = Math.floor(k / W), x = k % W;
      nib = (nib << 1) | (data[y * (W + 1) + x] > data[y * (W + 1) + x + 1] ? 1 : 0);
    }
    hex += nib.toString(16);
  }
  return hex;
}

export const DUPLICATE_MAX_DISTANCE = 24;

export function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
