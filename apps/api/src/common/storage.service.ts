import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import type { AppConfig } from '../config/configuration';
import { safeEqual } from '../auth/crypto';

export const BUCKETS = ['ec8a', 'incident-media', 'voice-notes', 'chat-media', 'live-clips', 'irev', 'voice-recordings', 'contact-imports'] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * Private file storage. Only this API holds the keys; apps get a short-lived link for one file.
 * supabase: Supabase Storage signed upload / download URLs. local: files on disk behind HMAC-signed API routes.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger('Storage');
  private readonly cfg: AppConfig['storage'];
  private readonly secret: string;
  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    this.cfg = config.get('storage')!;
    this.secret = config.get<AppConfig['auth']>('auth')!.jwtSecret;
    this.publicUrl = config.get('publicUrl')!;
    if (this.cfg.driver === 'supabase' && !this.cfg.serviceKey) {
      this.log.error('STORAGE_DRIVER=supabase but SUPABASE_SERVICE_ROLE_KEY is empty: every upload will be refused');
    }
    if (this.cfg.driver === 'local' && this.cfg.supabaseUrl && !this.cfg.serviceKey) {
      this.log.warn(`SUPABASE_SERVICE_ROLE_KEY is not set, so files are stored on this server under ${this.cfg.localDir}`);
    }
  }

  /** Files of this bucket live on local disk (the local driver, or a bucket listed in STORAGE_LOCAL_BUCKETS). */
  private local(bucket: string): boolean {
    return this.cfg.driver === 'local' || this.cfg.localBuckets.includes(bucket);
  }

  private check(bucket: string, path: string) {
    if (!BUCKETS.includes(bucket as Bucket)) throw new BadRequestException('Unknown bucket');
    if (!/^[A-Za-z0-9/_.-]+$/.test(path) || path.includes('..')) throw new BadRequestException('Bad file path');
  }

  async uploadUrl(bucket: Bucket, path: string): Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }> {
    this.check(bucket, path);
    if (this.local(bucket)) {
      return { url: this.localUrl('put', bucket, path, this.cfg.uploadTtlSeconds), method: 'PUT', headers: {} };
    }
    const j = await this.supabase(`/storage/v1/object/upload/sign/${bucket}/${path}`, {});
    return { url: `${this.cfg.supabaseUrl}/storage/v1${j.url}`, method: 'PUT', headers: {} };
  }

  async viewUrl(bucket: Bucket, path: string, ttl = this.cfg.viewTtlSeconds): Promise<string> {
    this.check(bucket, path);
    if (this.local(bucket)) return this.localUrl('get', bucket, path, ttl);
    const j = await this.supabase(`/storage/v1/object/sign/${bucket}/${path}`, { expiresIn: ttl });
    return `${this.cfg.supabaseUrl}/storage/v1${j.signedURL ?? j.signedUrl}`;
  }

  /** Server-side download (worker: OCR of stored sheets and photos). */
  async get(bucket: Bucket, path: string): Promise<{ bytes: Buffer; contentType: string }> {
    this.check(bucket, path);
    if (this.local(bucket)) {
      const bytes = await this.readLocal(bucket, path);
      return { bytes, contentType: path.endsWith('.pdf') ? 'application/pdf' : path.endsWith('.png') ? 'image/png' : 'image/jpeg' };
    }
    const res = await fetch(`${this.cfg.supabaseUrl}/storage/v1/object/${bucket}/${path}`, { headers: { Authorization: `Bearer ${this.cfg.serviceKey}` } });
    if (res.status === 404 || res.status === 400) throw new NotFoundException('File not found');
    if (!res.ok) throw new ServiceUnavailableException(`Storage download failed (${res.status})`);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }

  /** Server-side upload (worker, IReV sheets, imports). */
  async put(bucket: Bucket, path: string, body: Buffer, contentType: string): Promise<void> {
    this.check(bucket, path);
    if (this.local(bucket)) {
      const file = this.localFile(bucket, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
      return;
    }
    const res = await fetch(`${this.cfg.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.cfg.serviceKey}`, 'Content-Type': contentType, 'x-upsert': 'true' }, body: new Uint8Array(body),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Storage upload failed (${res.status})`);
  }

  private async supabase(path: string, body: object): Promise<any> {
    const res = await fetch(`${this.cfg.supabaseUrl}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.cfg.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Supabase reports refused keys as 400 with an inner 401/403: that is our setup, not a missing file
      const body = await res.json().catch(() => ({})) as { statusCode?: string; message?: string };
      const inner = Number(body.statusCode ?? res.status);
      if (inner === 401 || inner === 403) {
        this.log.error(`Storage refused the service key on ${path}: ${body.message ?? res.status}`);
        throw new ServiceUnavailableException('File storage is not set up on the server. Your file is kept on the phone and will be sent later.');
      }
      if (res.status === 404 || res.status === 400) throw new NotFoundException('File not found');
      this.log.error(`Storage ${res.status} on ${path}`); throw new ServiceUnavailableException('File storage unavailable');
    }
    return res.json();
  }

  // ---- local driver ----
  private sign(op: string, bucket: string, path: string, exp: number) {
    return createHmac('sha256', this.secret).update(`${op}:${bucket}/${path}:${exp}`).digest('base64url');
  }
  private localUrl(op: 'get' | 'put', bucket: string, path: string, ttl: number) {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return `${this.publicUrl}/api/v1/files/${bucket}/${path}?op=${op}&exp=${exp}&sig=${this.sign(op, bucket, path, exp)}`;
  }
  private localFile(bucket: string, path: string) {
    const root = resolve(this.cfg.localDir);
    const file = normalize(join(root, bucket, path));
    if (!file.startsWith(root)) throw new BadRequestException('Bad file path');
    return file;
  }
  verifyLocal(op: string, bucket: string, path: string, exp: string, sig: string) {
    this.check(bucket, path);
    if (!this.local(bucket) || Number(exp) < Date.now() / 1000 || !safeEqual(sig ?? '', this.sign(op, bucket, path, Number(exp)))) {
      throw new NotFoundException();
    }
  }
  async readLocal(bucket: string, path: string): Promise<Buffer> {
    try { return await readFile(this.localFile(bucket, path)); } catch { throw new NotFoundException(); }
  }
  async writeLocal(bucket: string, path: string, body: Buffer) {
    if (body.length > this.cfg.maxUploadBytes) throw new BadRequestException('File too large');
    const file = this.localFile(bucket, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
}
