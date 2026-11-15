import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { DataSource } from 'typeorm';
import { createTestApp, sessionFor } from './setup';

const P = (n: string) => `b0000000-0000-4000-8000-0000000000${n}`;
const SUP = P('03'), AGENT3 = P('20'), AGENT4 = P('21');
const T_B = 'a2a2a2a2-0000-4000-8000-000000000002';

describe('Live updates (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let url: string;
  const sockets: Socket[] = [];
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, ds } = await createTestApp());
    await app.listen(0);
    url = await app.getUrl();
    for (const id of [SUP, AGENT3, AGENT4]) tok[id] = await sessionFor(app, id);
    await ds.query(`insert into public.tenants (id, name) values ($1, 'Client B')`, [T_B]);
    await ds.query(`insert into public.volunteers (id, tenant_id, full_name, phone, role, level, area_code, status)
                    values ('c0000000-0000-4000-8000-000000000003', $1, 'Supervisor B', '+2348000000903', 'supervisor', 'national', 'NG', 'active')`, [T_B]);
    tok.supB = await sessionFor(app, 'c0000000-0000-4000-8000-000000000003');
  });
  afterAll(async () => { sockets.forEach((s) => s.close()); await app?.close(); });

  const connect = (token: string) => new Promise<Socket>((resolve, reject) => {
    const s = io(url, { path: '/live', auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const collect = (s: Socket) => { const got: any[] = []; s.on('change', (e) => got.push(e)); return got; };
  const settle = () => new Promise((r) => setTimeout(r, 600));

  it('refuses connections without a valid token', async () => {
    const s = io(url, { path: '/live', auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    await new Promise<void>((resolve) => s.on('disconnect', () => resolve()));
  });

  it('a new case reaches room staff of that client only; case events only to subscribers', async () => {
    const sup = await connect(tok[SUP]);
    const supB = await connect(tok.supB);
    const agent4 = await connect(tok[AGENT4]);
    const gotSup = collect(sup), gotB = collect(supB), gotAgent4 = collect(agent4);

    const rep = await request(app.getHttpServer()).post('/api/v1/incidents').set('Authorization', `Bearer ${tok[AGENT3]}`)
      .send({ pu: '19-28-02-003', category: 'materials_late', clientId: crypto.randomUUID() }).expect(200);
    const caseId = rep.body.case_id;
    await settle();
    expect(gotSup.some((e) => e.t === 'cases' && e.id === caseId)).toBe(true);
    expect(gotB).toEqual([]);
    expect(gotAgent4.some((e) => e.t === 'cases')).toBe(false);
    // Events carry ids and status only
    const ev = gotSup.find((e) => e.t === 'cases');
    expect(Object.keys(ev).sort()).toEqual(['id', 'op', 'status', 't']);

    // Case timeline events: only after subscribing, and only if allowed
    expect(await sup.emitWithAck('subscribe', { case: caseId })).toEqual({ ok: true });
    expect(await supB.emitWithAck('subscribe', { case: caseId })).toEqual({ ok: false });
    await request(app.getHttpServer()).post(`/api/v1/cases/${caseId}/notes`).set('Authorization', `Bearer ${tok[SUP]}`).send({ text: 'On it' }).expect(204);
    await settle();
    expect(gotSup.some((e) => e.t === 'case_events' && e.case_id === caseId)).toBe(true);
    expect(gotB).toEqual([]);
  });
});
