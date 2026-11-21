import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/common/storage.service';
import { Db } from '../src/database/db.service';
import { setWorkerContext } from '../src/worker/context';
import { processUnit, type Job } from '../src/worker/irev/jobs';
import { drainOutbox } from '../src/worker/notify/outbox';
import { processTopups } from '../src/worker/topups/send';
import request from 'supertest';
import { createTestApp, sessionFor } from './setup';

const T_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const LIVE = '2027a000-0000-4000-8000-000000000001';
const SAMPLES = resolve(__dirname, '../../../samples');
const realFetch = global.fetch;

describe('Worker jobs on the database (e2e, providers faked)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_DIR = `${process.env.TMPDIR ?? '/tmp'}/rumfa-e2e-worker-storage`;
    ({ app, ds } = await createTestApp());
    setWorkerContext({ db: app.get(Db), storage: app.get(StorageService) });
  });
  afterAll(async () => { global.fetch = realFetch; await app?.close(); });

  it('outbox: SMS goes out in the client\'s name and is marked sent; failures retry then stop', async () => {
    await ds.query(`insert into public.outbox (tenant_id, channel, to_phone, template, data) values ($1, 'sms', '+2348000000020', 'raw', '{"text":"hello"}')`, [T_A]);
    await ds.query(`insert into public.outbox (tenant_id, channel, to_phone, template, data) values ($1, 'sms', '+2348000000021', 'raw', '{"text":"boom"}')`, [T_A]);
    const sent: string[] = [];
    const senders = { push: async () => { throw new Error('no token'); }, whatsapp: async () => undefined,
      sms: async (to: string, text: string) => { if (text.includes('boom')) throw new Error('network down'); sent.push(`${to} ${text}`); } };
    expect(await drainOutbox(50, senders as any)).toBe(1);
    expect(sent).toEqual(['+2348000000020 ALAWA: hello']);
    const [bad] = await ds.query(`select status, attempts, last_error from public.outbox where data->>'text' = 'boom'`);
    expect(bad).toEqual({ status: 'queued', attempts: 1, last_error: 'network down' });
  });

  it('IReV: downloads a sheet, stores it, and flags the same photo used for another unit', async () => {
    const job: Job = { id: '00000000-0000-4000-8000-000000000000', tenant_id: T_A, election_id: LIVE, job_type: 'baseline',
      area_level: 'ward', area_code: '19-28-02', auto_recheck: false, interval_min: 10, status: 'running', counts: {} };
    const files: Record<string, string> = { 'https://cdn.test/003_thumb.jpg': 'ec8a_19-28-02-003_thumb.jpg', 'https://cdn.test/005_thumb.jpg': 'ec8a_19-28-02-005_thumb.jpg' };
    global.fetch = (async (url: any) => {
      const f = files[String(url)];
      if (!f) return new Response('no', { status: 404 });
      const r = new Response(readFileSync(resolve(SAMPLES, f)), { headers: { 'content-type': 'image/jpeg' } });
      Object.defineProperty(r, 'url', { value: String(url) });
      return r;
    }) as any;
    expect(await processUnit(job, { _id: 'u3', pu_code: '19/28/02/003', name: 'Unit 3', document: { _id: 'd3', url: 'https://cdn.test/003_thumb.jpg' } })).toBe('downloaded');
    expect(await processUnit(job, { _id: 'u5', pu_code: '19/28/02/005', name: 'Unit 5', document: { _id: 'd5', url: 'https://cdn.test/005_thumb.jpg' } })).toBe('downloaded');
    expect(await processUnit(job, { _id: 'u1', pu_code: '19/28/02/001', name: 'Unit 1', document: null })).toBe('not_on_irev');
    // Seen again with the same document: no new download
    expect(await processUnit(job, { _id: 'u3', pu_code: '19/28/02/003', name: 'Unit 3', document: { _id: 'd3', url: 'https://cdn.test/003_thumb.jpg' } })).toBe('downloaded');

    const av = await ds.query(`select pu_code, status, storage_path, seen_doc_ids from public.irev_availability where election_id = $1 order by pu_code`, [LIVE]);
    expect(av.map((r: any) => [r.pu_code, r.status])).toEqual([['19-28-02-001', 'not_on_irev'], ['19-28-02-003', 'downloaded'], ['19-28-02-005', 'downloaded']]);
    expect(av[1].seen_doc_ids).toEqual(['d3']);
    const stored = await app.get(StorageService).get('irev', av[1].storage_path);
    expect(stored.bytes.length).toBeGreaterThan(1000);
    const [alert] = await ds.query(`select rule, details from public.alerts where tenant_id = $1 and pu_code = '19-28-02-005'`, [T_A]);
    expect(alert).toMatchObject({ rule: 'duplicate_sheet', details: { same_as: ['19-28-02-003'] } });
  });

  it('IReV links only: saves INEC\'s link instead of the file, reads it from the link, shows it through the API', async () => {
    const job: Job = { id: '00000000-0000-4000-8000-000000000000', tenant_id: T_A, election_id: LIVE, job_type: 'baseline',
      area_level: 'ward', area_code: '19-28-02', auto_recheck: false, interval_min: 10, status: 'running', counts: {}, keep: 'link' };
    let fetched = 0;
    global.fetch = (async (url: any) => {
      if (!String(url).startsWith('https://cdn.test/004')) return new Response('no', { status: 404 });
      fetched++;
      const r = new Response(readFileSync(resolve(SAMPLES, 'ec8a_19-28-02-003_thumb.jpg')), { headers: { 'content-type': 'image/jpeg' } });
      Object.defineProperty(r, 'url', { value: String(url) });
      return r;
    }) as any;
    const doc = (id: string, url: string) => ({ _id: 'u4', pu_code: '19/28/02/004', name: 'Unit 4', document: { _id: id, url } });
    expect(await processUnit(job, doc('d4', 'https://cdn.test/004_thumb.jpg'))).toBe('linked');
    expect(fetched).toBe(0);                                                    // nothing downloaded
    expect(await processUnit(job, doc('d4', 'https://cdn.test/004_thumb.jpg'))).toBe('linked');
    let [av] = await ds.query(`select status, storage_path, sheet_url, seen_doc_ids from public.irev_availability where election_id = $1 and pu_code = '19-28-02-004'`, [LIVE]);
    expect(av).toEqual({ status: 'on_irev', storage_path: null, sheet_url: 'https://cdn.test/004_thumb.jpg', seen_doc_ids: ['d4'] });
    // INEC replaces the sheet: the new link is kept and the unit marked replaced
    expect(await processUnit(job, doc('d4b', 'https://cdn.test/004b_thumb.jpg'))).toBe('replaced');
    [av] = await ds.query(`select status, storage_path, sheet_url, replaced_count from public.irev_availability where election_id = $1 and pu_code = '19-28-02-004'`, [LIVE]);
    expect(av).toEqual({ status: 'replaced', storage_path: null, sheet_url: 'https://cdn.test/004b_thumb.jpg', replaced_count: 1 });

    // Figures are read by streaming the sheet from the link; still nothing stored
    const { ocrIrevSheet } = await import('../src/worker/ocr/pipeline');
    expect(['read', 'needs_review']).toContain(await ocrIrevSheet(LIVE, '19-28-02-004'));
    expect(fetched).toBe(1);
    expect((await ds.query(`select storage_path from public.irev_availability where election_id = $1 and pu_code = '19-28-02-004'`, [LIVE]))[0].storage_path).toBeNull();

    // Review shows it through the API: a signed link that passes the sheet through from INEC
    const http = request(app.getHttpServer());
    const tok = await sessionFor(app, 'b0000000-0000-4000-8000-000000000001');
    const v = (await http.post('/api/v1/media/view-url').set({ Authorization: `Bearer ${tok}` }).send({ kind: 'irev', electionId: LIVE, pu: '19-28-02-004' }).expect(200)).body;
    expect(v.source).toBe('inec');
    const path = new URL(v.url).pathname + new URL(v.url).search;
    const img = await http.get(path).expect(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect(img.body.length).toBeGreaterThan(1000);
    await http.get(path.replace(/sig=[^&]+/, 'sig=forged')).expect(404);

    for (const t of ['irev_sheet_results', 'ocr_extractions', 'irev_check_log', 'irev_availability']) {
      await ds.query(`delete from public.${t} where election_id = $1 and pu_code = '19-28-02-004'`, [LIVE]);
    }
  });

  it('top-ups: an approved batch is sent once, confirmed people get an SMS', async () => {
    await ds.query(`update public.tenants set settings = coalesce(settings, '{}') || '{"addons":{"airtime":true}}' where id = $1`, [T_A]);
    const [plan] = await ds.query(`insert into public.topup_plans (tenant_id, name, kind, amount_ngn, target_roles, created_by)
                                   values ($1, 'Day airtime', 'airtime', 200, '{agent}', 'b0000000-0000-4000-8000-000000000001') returning id`, [T_A]);
    const [b] = await ds.query(`insert into public.topup_batches (tenant_id, plan_id, status, created_by) values ($1, $2, 'approved', 'b0000000-0000-4000-8000-000000000001') returning id`, [T_A, plan.id]);
    await ds.query(`insert into public.topups (tenant_id, batch_id, plan_id, volunteer_id, phone, network, kind, amount_ngn, idempotency_key)
                    select tenant_id, $2, $3, id, phone, network, 'airtime', 200, 'tu-' || id from public.volunteers where tenant_id = $1 and role = 'agent' and status = 'active'`,
      [T_A, b.id, plan.id]);
    const calls: any[] = [];
    global.fetch = (async (url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ code: '000', content: { transactions: { status: 'delivered' } } }));
    }) as any;
    const n = await processTopups();
    expect(n).toBe(2);
    expect(await processTopups()).toBe(0); // nothing sent twice
    expect(calls.map((c) => c.phone).sort()).toEqual(['08000000020', '08000000021']);
    const rows = await ds.query(`select status from public.topups where batch_id = $1`, [b.id]);
    expect(rows.every((r: any) => r.status === 'success')).toBe(true);
    expect((await ds.query(`select status from public.topup_batches where id = $1`, [b.id]))[0].status).toBe('done');
    expect((await ds.query(`select count(*)::int as n from public.outbox where template = 'topup_sent'`))[0].n).toBe(2);
  });
});
