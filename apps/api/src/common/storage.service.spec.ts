import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageService } from './storage.service';

test('a bucket listed in STORAGE_LOCAL_BUCKETS stays on disk while others use Supabase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rumfa-storage-'));
  const cfg: Record<string, any> = {
    storage: { driver: 'supabase', supabaseUrl: 'https://example.supabase.co', serviceKey: 'k', localDir: dir, localBuckets: ['irev'],
      uploadTtlSeconds: 600, viewTtlSeconds: 300, maxUploadBytes: 1024 },
    auth: { jwtSecret: 'secret-for-tests-only' }, publicUrl: 'http://localhost:3000',
  };
  const s = new StorageService({ get: (k: string) => cfg[k] } as any);

  const real = global.fetch;
  const calls: string[] = [];
  global.fetch = (async (url: string) => { calls.push(url); return new Response('{"signedURL":"/object/sign/ec8a/x.jpg?token=t"}'); }) as any;
  try {
    await s.put('irev', 'e1/19-28-02-003/v1.pdf', Buffer.from('%PDF-1.7 test'), 'application/pdf');
    expect(existsSync(join(dir, 'irev', 'e1/19-28-02-003/v1.pdf'))).toBe(true);
    expect((await s.get('irev', 'e1/19-28-02-003/v1.pdf')).bytes.toString()).toBe('%PDF-1.7 test');
    expect(await s.viewUrl('irev', 'e1/19-28-02-003/v1.pdf')).toMatch(/^http:\/\/localhost:3000\/api\/v1\/files\/irev\//);
    expect(calls).toEqual([]); // nothing went to Supabase

    expect(await s.viewUrl('ec8a', 'x.jpg')).toMatch(/^https:\/\/example\.supabase\.co\/storage\/v1\/object\/sign\//);
    expect(calls).toHaveLength(1);
  } finally { global.fetch = real; rmSync(dir, { recursive: true, force: true }); }
});
