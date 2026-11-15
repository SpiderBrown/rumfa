import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { encodeResultSms } from '../src/shared';
import { createTestApp, sessionFor } from './setup';

const T_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const T_B = 'a2a2a2a2-0000-4000-8000-000000000002';
const P = (n: string) => `b0000000-0000-4000-8000-0000000000${n}`;
const ADMIN = P('01'), SUP = P('03'), OP_HA = P('04'), OP_EN = P('05'), WARD = P('11'), AGENT3 = P('20'), AGENT4 = P('21');
const LIVE = '2027a000-0000-4000-8000-000000000001';
const KEY = 'e2e-webhook-key-long-enough';
const uuid = () => crypto.randomUUID();

describe('API endpoints and webhooks (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;
  const tok: Record<string, string> = {};
  const api = (p: string) => `/api/v1${p}`;
  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });

  beforeAll(async () => {
    process.env.WEBHOOK_KEY = KEY;
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_DIR = `${process.env.TMPDIR ?? '/tmp'}/rumfa-e2e-storage`;
    ({ app, ds } = await createTestApp());
    http = request(app.getHttpServer());
    for (const id of [ADMIN, SUP, OP_HA, OP_EN, WARD, AGENT3, AGENT4]) tok[id] = await sessionFor(app, id);
    // Client B with its own admin, and the agent3 phone also working there (agent code ZZ9)
    await ds.query(`insert into public.tenants (id, name, settings) values ($1, 'Client B', '{"brand":"CLB"}')`, [T_B]);
    await ds.query(`insert into public.tenant_elections values ($1, $2, 'live')`, [T_B, LIVE]);
    await ds.query(
      `insert into public.volunteers (id, tenant_id, full_name, phone, role, level, area_code, agent_code, status) values
         ('c0000000-0000-4000-8000-000000000001', $1, 'Admin B', '+2348000000901', 'admin', 'national', 'NG', null, 'active'),
         ('c0000000-0000-4000-8000-000000000020', $1, 'Agent at B', '+2348000000020', 'agent', 'pu', '19-28-02-004', 'ZZ9', 'active')`, [T_B]);
    tok.adminB = await sessionFor(app, 'c0000000-0000-4000-8000-000000000001');
  });
  afterAll(async () => { await app?.close(); });

  it('context: brand, elections, parties and categories for the signed-in client', async () => {
    const r = await http.get(api('/me/context')).set(as(AGENT3)).expect(200);
    expect(r.body.me).toMatchObject({ id: AGENT3, brand: 'ALAWA', role: 'agent' });
    expect(r.body.elections.live).toBe(LIVE);
    expect(r.body.parties).toContain('APC');
    expect(r.body.categories.length).toBeGreaterThan(5);
  });

  let caseId: string;
  it('agent reports an incident; room works the case through to close', async () => {
    const rep = await http.post(api('/incidents')).set(as(AGENT3))
      .send({ pu: '19-28-02-003', category: 'bvas_failure', description: 'BVAS will not start', clientId: uuid() }).expect(200);
    caseId = rep.body.case_id;
    expect(caseId).toBeDefined();
    // Agents cannot act on cases
    await http.post(api(`/cases/${caseId}/resolve`)).set(as(AGENT3)).send({ text: 'x' }).expect(403);

    const d = await http.get(api(`/cases/${caseId}`)).set(as(SUP)).expect(200);
    expect(d.body.incidents[0].volunteer.id).toBe(AGENT3);
    expect(d.body.people.some((p: any) => p.id === WARD)).toBe(true);
    const assignee = d.body.case.assigned_to;
    expect([OP_HA, OP_EN]).toContain(assignee);
    const ack = await http.post(api(`/cases/${caseId}/acknowledge`)).set(as(assignee));
    expect([ack.status, ack.body.message]).toEqual([204, undefined]);
    await http.post(api(`/cases/${caseId}/notes`)).set(as(assignee)).send({ text: 'Called the ward coordinator' }).expect(204);
    await http.post(api(`/cases/${caseId}/resolve`)).set(as(assignee)).send({ text: 'INEC replaced the BVAS' }).expect(204);
    // A non-critical case closes when resolved; only critical ones wait for a supervisor
    const after = await http.get(api(`/cases/${caseId}`)).set(as(SUP)).expect(200);
    expect(after.body.case.status).toBe('closed');
    await http.post(api(`/cases/${caseId}/close`)).set(as(assignee)).expect(403);
    // A business-rule error from the database comes back as 400 with its message
    const bad = await http.post(api(`/cases/${caseId}/close`)).set(as(SUP)).expect(400);
    expect(bad.body.message).toBe('Case must be resolved first');

    // Critical: SOS waits for the supervisor's confirmation
    const sos = await http.post(api('/incidents')).set(as(AGENT4)).send({ pu: '19-28-02-004', category: 'violence', sos: true, clientId: uuid() }).expect(200);
    const sc = (await http.get(api(`/cases/${sos.body.case_id}`)).set(as(SUP)).expect(200)).body.case;
    expect(sc.severity).toBe('critical');
    await http.post(api(`/cases/${sc.id}/reassign`)).set(as(SUP)).send({ to: OP_EN }).expect(204);
    await http.post(api(`/cases/${sc.id}/acknowledge`)).set(as(OP_EN)).expect(204);
    await http.post(api(`/cases/${sc.id}/resolve`)).set(as(OP_EN)).send({ text: 'Police on site' }).expect(204);
    expect((await http.get(api(`/cases/${sc.id}`)).set(as(SUP))).body.case.status).toBe('resolved');
    await http.post(api(`/cases/${sc.id}/close`)).set(as(SUP)).expect(204);
  });

  it('client B cannot see or touch client A records', async () => {
    await http.get(api(`/cases/${caseId}`)).set(as('adminB')).expect(404);
    expect((await http.get(api('/cases')).set(as('adminB')).expect(200)).body).toEqual([]);
    const people = (await http.get(api('/people')).set(as('adminB')).expect(200)).body;
    expect(people.map((p: any) => p.full_name).sort()).toEqual(['Admin B', 'Agent at B']);
    await http.post(api(`/cases/${caseId}/notes`)).set(as('adminB')).send({ text: 'x' }).expect(400);
  });

  it('EC8A photo: upload link, result with photo, view link for the room', async () => {
    const up = await http.post(api('/media/upload-url')).set(as(AGENT3)).send({ kind: 'ec8a', ext: 'jpg', pu: '19-28-02-003' }).expect(200);
    expect(up.body.path.startsWith(`${T_A}/ec8a/19-28-02-003/`)).toBe(true);
    const url = new URL(up.body.url);
    await http.put(url.pathname + url.search).send(Buffer.from('fake-jpeg')).set('Content-Type', 'application/octet-stream').expect(200);
    // A tampered link is refused
    await http.put(url.pathname + url.search.replace(/sig=[^&]+/, 'sig=AAAA')).send(Buffer.from('x')).expect(404);

    const res = await http.post(api('/results')).set(as(AGENT3)).send({
      pu: '19-28-02-003', registered: 500, accredited: 300, rejected: 5, totalValid: 290,
      votes: { APC: 150, PDP: 100, LP: 40 }, photoPath: up.body.path, clientId: uuid() }).expect(200);
    expect(res.body.version).toBe(1);
    // Another client's file path is refused
    await http.post(api('/results')).set(as(AGENT3)).send({ pu: '19-28-02-003', registered: 1, accredited: 1, rejected: 0, totalValid: 1,
      votes: { APC: 1 }, photoPath: `${T_B}/ec8a/x.jpg`, clientId: uuid() }).expect(400);
    // Agents may not upload what only voice staff upload
    await http.post(api('/media/upload-url')).set(as(AGENT3)).send({ kind: 'voice_recording', ext: 'mp3' }).expect(403);

    const view = await http.post(api('/media/view-url')).set(as(SUP)).send({ kind: 'ec8a', id: res.body.submission_id }).expect(200);
    const v = new URL(view.body.url);
    const file = await http.get(v.pathname + v.search).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(Buffer.from(file.body).toString()).toBe('fake-jpeg');
    await http.post(api('/media/view-url')).set(as('adminB')).send({ kind: 'ec8a', id: res.body.submission_id }).expect(404);
  });

  it('results overview for room staff only', async () => {
    const r = await http.get(api(`/results/overview?election=${LIVE}`)).set(as(SUP)).expect(200);
    expect(r.body.find((x: any) => x.area_code === '19').ec8a_reported).toBeGreaterThan(0);
    await http.get(api(`/results/overview?election=${LIVE}`)).set(as(AGENT3)).expect(403);
  });

  it('callback: agent asks, ward coordinator sees and completes it', async () => {
    await http.post(api('/callbacks')).set(as(AGENT4)).send({ reason: 'form' }).expect(201);
    const mine = await http.get(api('/callbacks/mine')).set(as(AGENT4)).expect(200);
    expect(mine.body.status).toBe('waiting');
    const list = await http.get(api('/callbacks?status=waiting')).set(as(WARD)).expect(200);
    const req = list.body.find((c: any) => c.id === mine.body.id);
    expect(req.requester.full_name).toBe('Agent 004');
    await http.post(api(`/callbacks/${req.id}/complete`)).set(as(WARD)).send({ answered: true, outcome: 'Explained the form' }).expect(204);
    expect((await http.get(api('/callbacks/mine')).set(as(AGENT4)).expect(200)).body).toEqual({});
  });

  it('coordinator adds an agent in their ward (with a fresh agent code), not elsewhere', async () => {
    const r = await http.post(api('/people')).set(as(WARD)).send({ fullName: 'New Agent', phone: '0803 000 0055', role: 'agent', level: 'pu', areaCode: '19-28-02-005' }).expect(201);
    expect(r.body.agent_code).toMatch(/^[2-9A-Z]{4}$/);
    expect(r.body.phone).toBe('+2348030000055');
    await http.post(api('/people')).set(as(WARD)).send({ fullName: 'Elsewhere', phone: '08030000056', role: 'agent', level: 'pu', areaCode: '19-29-01-001' }).expect(403);
    await http.post(api('/people')).set(as(WARD)).send({ fullName: 'Admin?', phone: '08030000057', role: 'admin', level: 'national', areaCode: 'NG' }).expect(400);
  });

  it('coded SMS: key required, the agent code picks the client, retries are ignored', async () => {
    const body = encodeResultSms({ puCode: '19-28-02-004', version: 1, agentCode: 'ZZ9', registered: 400, accredited: 200, rejected: 2, totalValid: 190, votes: { APC: 100, PDP: 90 } });
    await http.post(api('/webhooks/at/sms?key=wrong')).type('form').send({ from: '+2348000000020', text: body, id: 'sms-1' }).expect(401);
    await http.post(api(`/webhooks/at/sms?key=${KEY}`)).type('form').send({ from: '+2348000000020', text: body, id: 'sms-1' }).expect(200);
    const dup = await http.post(api(`/webhooks/at/sms?key=${KEY}`)).type('form').send({ from: '+2348000000020', text: body, id: 'sms-1' }).expect(200);
    expect(dup.body.duplicate).toBe(true);
    const [sub] = await ds.query(`select tenant_id, source from public.result_submissions where pu_code = '19-28-02-004'`);
    expect(sub).toMatchObject({ tenant_id: T_B, source: 'sms' });
    const [reply] = await ds.query(`select tenant_id, data from public.outbox where to_phone = '+2348000000020' order by id desc limit 1`);
    expect(reply.tenant_id).toBe(T_B);
    // Same phone, wrong code: stored as an error, nothing ingested
    await http.post(api(`/webhooks/at/sms?key=${KEY}`)).type('form').send({ from: '+2348000000020', text: body.replace('ZZ9', 'QQ1'), id: 'sms-2' }).expect(200);
    const [log] = await ds.query(`select error from public.sms_inbound where provider_id = 'sms-2'`);
    expect(log.error).toBeTruthy();
  });

  it('voice webhook connects a bridged call to the second person', async () => {
    const [call] = await ds.query(
      `insert into public.calls (tenant_id, caller_id, callee_id, to_phone, route) values ($1, $2, $3, '+2348000000020', 'bridged') returning id`, [T_A, WARD, AGENT3]);
    const r = await http.post(api(`/webhooks/at/voice?key=${KEY}`)).type('form').send({ sessionId: 'ATVid_1', isActive: '1', clientRequestId: call.id }).expect(200);
    expect(r.headers['content-type']).toMatch(/xml/);
    expect(r.text).toContain('<Dial phoneNumbers="+2348000000020"');
    await http.post(api(`/webhooks/at/voice?key=${KEY}`)).type('form').send({ sessionId: 'ATVid_1', isActive: '0', durationInSeconds: '42', status: 'Success' }).expect(200);
    const [done] = await ds.query(`select status, duration_s from public.calls where id = $1`, [call.id]);
    expect(done).toEqual({ status: 'completed', duration_s: 42 });
    // Unknown callers get a polite message, not a call
    const other = await http.post(api(`/webhooks/at/voice?key=${KEY}`)).type('form').send({ sessionId: 'ATVid_2', isActive: '1', callerNumber: '+2348099999999' }).expect(200);
    expect(other.text).toContain('<Say>');
  });

  it('messages on the case channel', async () => {
    const d = await http.get(api(`/cases/${caseId}`)).set(as(SUP)).expect(200);
    const ch = d.body.channelId;
    expect(ch).toBeTruthy();
    await http.post(api(`/channels/${ch}/messages`)).set(as(SUP)).send({ body: 'Is the BVAS working now?', clientId: uuid() }).expect(201);
    const seen = await http.get(api(`/channels/${ch}`)).set(as(AGENT3)).expect(200);
    expect(seen.body.messages.some((m: any) => m.body === 'Is the BVAS working now?' && m.sender_name === 'Supervisor Kano')).toBe(true);
    await http.get(api(`/channels/${ch}`)).set(as('adminB')).expect(404);

    // Call from the chat: the agent sees the supervisor who wrote, gets the number, and the call is logged
    const people = await http.get(api(`/channels/${ch}/people`)).set(as(AGENT3)).expect(200);
    const sup = people.body.find((p: any) => p.full_name === 'Supervisor Kano');
    expect(sup).toBeTruthy();
    expect(sup.phone).toBeUndefined();
    const c = await http.post(api(`/channels/${ch}/call`)).set(as(AGENT3)).send({ personId: sup.id }).expect(200);
    expect(c.body.phone).toMatch(/^\+234/);
    await http.get(api(`/channels/${ch}/people`)).set(as('adminB')).expect(404);
    await http.post(api(`/channels/${ch}/call`)).set(as('adminB')).send({ personId: sup.id }).expect(404);

    // Each organisation switches the calling options on or off; the API enforces them
    const ctx = await http.get(api('/me/context')).set(as(AGENT3)).expect(200);
    expect(ctx.body.calls).toEqual({ phone: true, bridged: true, webrtc: false, inapp: false });
    await http.patch(api('/settings/calls')).set(as(SUP)).send({ phone: false }).expect(403);
    const off = await http.patch(api('/settings/calls')).set(as(ADMIN)).send({ phone: false, bridged: false }).expect(200);
    expect(off.body).toEqual({ phone: false, bridged: false, webrtc: false, inapp: false });
    await http.post(api(`/channels/${ch}/call`)).set(as(AGENT3)).send({ personId: sup.id, mode: 'phone' }).expect(403);
    await http.post(api(`/channels/${ch}/call`)).set(as(AGENT3)).send({ personId: sup.id, mode: 'bridged' }).expect(403);
    await http.post(api(`/channels/${ch}/call`)).set(as(AGENT3)).send({ personId: sup.id, mode: 'webrtc' }).expect(403);
    await http.post(api('/calls/token')).set(as(AGENT3)).expect(403);
    await http.post(api('/calls/bridge')).set(as(AGENT3)).send({ volunteerId: sup.id }).expect(403);
    await http.patch(api('/settings/calls')).set(as(ADMIN)).send({ webrtc: true }).expect(200);
    const w = await http.post(api(`/channels/${ch}/call`)).set(as(AGENT3)).send({ personId: sup.id, mode: 'webrtc' }).expect(200);
    expect(w.body.phone).toMatch(/^\+234/);
    expect((await http.get(api('/settings')).set(as(ADMIN)).expect(200)).body.calls).toEqual({ phone: false, bridged: false, webrtc: true, inapp: false });
    await http.patch(api('/settings/calls')).set(as(ADMIN)).send({ phone: true, bridged: true, webrtc: false }).expect(200);
  });

  it('app calls: ring, answer, hang up; busy, decline and the on/off switch', async () => {
    const d = await http.get(api(`/cases/${caseId}`)).set(as(SUP)).expect(200);
    const ch = d.body.channelId;
    // Off by default
    expect((await http.get(api('/me/context')).set(as(AGENT3)).expect(200)).body.calls.inapp).toBe(false);
    await http.post(api('/calls/app')).set(as(SUP)).send({ volunteerId: AGENT3 }).expect(403);
    await http.patch(api('/settings/calls')).set(as(ADMIN)).send({ inapp: true }).expect(200);

    // Supervisor rings the agent from the dashboard
    const start = await http.post(api('/calls/app')).set(as(SUP)).send({ volunteerId: AGENT3, caseId }).expect(200);
    expect(start.body).toMatchObject({ url: 'wss://livekit.test', callee: { id: AGENT3 } });
    expect(start.body.token.split('.')).toHaveLength(3);
    const id = start.body.callId;
    const inc = await http.get(api('/calls/app/incoming')).set(as(AGENT3)).expect(200);
    expect(inc.body.map((c: any) => c.id)).toContain(id);
    expect((await http.get(api(`/calls/app/${id}`)).set(as(AGENT3)).expect(200)).body).toMatchObject({ status: 'ringing', me: 'callee', caller: { id: SUP } });
    await http.get(api(`/calls/app/${id}`)).set(as(AGENT4)).expect(404);
    const [push] = await ds.query(`select template, data from public.outbox where to_volunteer = $1 and template = 'app_call' order by id desc limit 1`, [AGENT3]);
    expect(push.data.call_id).toBe(id);

    // Busy while ringing; only the callee can answer, once
    await http.post(api('/calls/app')).set(as(ADMIN)).send({ volunteerId: AGENT3 }).expect(409);
    await http.post(api(`/calls/app/${id}/answer`)).set(as(SUP)).expect(409);
    const ans = await http.post(api(`/calls/app/${id}/answer`)).set(as(AGENT3)).expect(200);
    expect(ans.body.token).toBeTruthy();
    await http.post(api(`/calls/app/${id}/answer`)).set(as(AGENT3)).expect(409);
    const end = await http.post(api(`/calls/app/${id}/end`)).set(as(SUP)).send({}).expect(200);
    expect(end.body.status).toBe('completed');
    expect((await http.post(api(`/calls/app/${id}/end`)).set(as(AGENT3)).send({}).expect(200)).body.status).toBe('ended');

    // From the case chat: the agent rings the supervisor, who declines
    const chat = await http.post(api(`/channels/${ch}/call`)).set(as(AGENT3)).send({ personId: SUP, mode: 'inapp' }).expect(200);
    expect(chat.body.mode).toBe('inapp');
    expect(chat.body.phone).toBeUndefined();
    const dec = await http.post(api(`/calls/app/${chat.body.callId}/end`)).set(as(SUP)).send({ reason: 'declined' }).expect(200);
    expect(dec.body.status).toBe('busy');

    await http.patch(api('/settings/calls')).set(as(ADMIN)).send({ inapp: false }).expect(200);
  });

  it('map: sub-areas with votes and issues, scoped to the person\'s area and organisation', async () => {
    await http.post(api('/incidents')).set(as(AGENT3)).send({ pu: '19-28-02-003', category: 'materials_late', clientId: uuid() }).expect(200);

    // State supervisor: defaults to their state, children are its LGAs with outlines
    const st = await http.get(api('/map')).set(as(SUP)).expect(200);
    expect(st.body).toMatchObject({ scope: '19', parent: '19', level: 'state', childLevel: 'lga' });
    expect(st.body.breadcrumb.map((b: any) => b.code)).toEqual(['19']);
    const lgaA = st.body.children.find((c: any) => c.code === '19-28');
    expect(lgaA.shape.type).toBe('Polygon');
    expect(lgaA).toMatchObject({ units: 12, reported: 1, ec8a: 1, votes: { APC: 150, PDP: 100, LP: 40 } });
    expect(lgaA.leader).toMatchObject({ party: 'APC', votes: 150 });
    expect(lgaA.open).toBeGreaterThanOrEqual(1);
    expect(st.body.children.find((c: any) => c.code === '19-29')).toMatchObject({ reported: 0, open: 0, leader: null });

    // Drill down to a ward's polling units: points, the agent count, the coordinator of the ward shows on the ward
    const lga = await http.get(api('/map')).set(as(SUP)).query({ parent: '19-28' }).expect(200);
    expect(lga.body.children.find((c: any) => c.code === '19-28-02').coordinator).toMatchObject({ full_name: 'Ward Coordinator' });
    const ward = await http.get(api('/map')).set(as(SUP)).query({ parent: '19-28-02' }).expect(200);
    expect(ward.body.childLevel).toBe('pu');
    const pu = ward.body.children.find((c: any) => c.code === '19-28-02-003');
    expect(pu).toMatchObject({ agents: 1, reported: 1 });
    expect(typeof pu.lat).toBe('number');
    await http.get(api('/map')).set(as(SUP)).query({ parent: '19-28-02-003' }).expect(400);

    // Ward coordinator: only their ward and below; national admin starts at Nigeria
    const wc = await http.get(api('/map')).set(as(WARD)).expect(200);
    expect(wc.body).toMatchObject({ scope: '19-28-02', parent: '19-28-02', childLevel: 'pu' });
    await http.get(api('/map')).set(as(WARD)).query({ parent: '19-28' }).expect(403);
    await http.get(api('/map')).set(as(SUP)).query({ parent: '20' }).expect(403);
    const nat = await http.get(api('/map')).set(as(ADMIN)).expect(200);
    expect(nat.body).toMatchObject({ parent: 'NG', childLevel: 'state' });
    expect(nat.body.children.find((c: any) => c.code === '19').reported).toBe(1);

    // Agents have no map; another organisation sees none of client A's numbers
    await http.get(api('/map')).set(as(AGENT3)).expect(403);
    const b = await http.get(api('/map')).set(as('adminB')).query({ parent: '19' }).expect(200);
    // (its own data counts; client A's results and cases never do)
    const [own] = await ds.query(
      `select (select count(*) from public.cases where tenant_id = $1 and area_code like '19-28%' and status not in ('resolved','closed','merged'))::int as open,
              (select count(distinct pu_code) from public.result_submissions where tenant_id = $1 and pu_code like '19-28%')::int as ec8a`, [T_B]);
    expect(b.body.children.find((c: any) => c.code === '19-28')).toMatchObject({ open: own.open, ec8a: own.ec8a });
    expect(lgaA.open).toBeGreaterThan(0);
  });

  it('live count: running totals while sorting, never double-counted, summed for any area', async () => {
    const send = (seq: number, counts: Record<string, number>, invalid = 0, done?: boolean) =>
      http.post(api('/live-counts')).set(as(AGENT3)).send({ pu: '19-28-02-003', seq, counts, invalid, done });
    expect((await send(1, { APC: 3, PDP: 1 }, 1).expect(200)).body).toMatchObject({ seq: 1, status: 'counting' });
    // Repeats and late messages change nothing
    expect((await send(1, { APC: 99 }).expect(200)).body).toMatchObject({ seq: 1, stale: true });
    await send(3, { APC: 5, PDP: 2, LP: 1 }, 1).expect(200);
    expect((await send(2, { APC: 4, PDP: 2 }, 1).expect(200)).body).toMatchObject({ seq: 3, stale: true });
    expect((await http.get(api('/live-counts/mine')).set(as(AGENT3)).expect(200)).body).toMatchObject({ seq: 3, total: 9, counts: { APC: 5, PDP: 2, LP: 1 } });

    // Only the agent at that unit, only parties on the ballot
    await send(4, { XYZ: 1 }).expect(400);
    await http.post(api('/live-counts')).set(as(AGENT3)).send({ pu: '19-28-02-004', seq: 1, counts: { APC: 1 }, invalid: 0 }).expect(403);
    await http.post(api('/live-counts')).set(as(SUP)).send({ pu: '19-28-02-003', seq: 9, counts: { APC: 1 }, invalid: 0 }).expect(403);

    // The room sees it summed at state level and per LGA; the ward coordinator at ward level; agents see no summary
    const st = await http.get(api('/live-counts/summary')).set(as(SUP)).expect(200);
    expect(st.body).toMatchObject({ area: '19', units: 1, counting: 1, done: 0, ballots: 9, invalid: 1, votes: { APC: 5, PDP: 2, LP: 1 }, childLevel: 'lga' });
    expect(st.body.children.find((c: any) => c.code === '19-28')).toMatchObject({ units: 1, votes: { APC: 5 } });
    const wc = await http.get(api('/live-counts/summary')).set(as(WARD)).expect(200);
    expect(wc.body.children.find((c: any) => c.code === '19-28-02-003')).toMatchObject({ counting: 1, ballots: 9 });
    await http.get(api('/live-counts/summary')).set(as(WARD)).query({ area: '19' }).expect(403);
    await http.get(api('/live-counts/summary')).set(as(AGENT3)).expect(403);
    expect((await http.get(api('/live-counts/summary')).set(as('adminB')).query({ area: '19' }).expect(200)).body.votes).toEqual({});

    // Finishing also stores the unit's quick count for the sample estimate
    expect((await send(5, { APC: 6, PDP: 2, LP: 1 }, 1, true).expect(200)).body.status).toBe('done');
    const [qt] = await ds.query(`select votes from public.quick_tallies where pu_code = '19-28-02-003' and tenant_id = $1 order by at desc limit 1`, [T_A]);
    expect(qt.votes).toEqual({ APC: 6, PDP: 2, LP: 1 });
    expect((await http.get(api('/live-counts/summary')).set(as(SUP)).expect(200)).body).toMatchObject({ done: 1, counting: 0 });
  });

  it('two admins are needed for a top-up batch', async () => {
    const plan = await http.post(api('/topups/plans')).set(as(ADMIN)).send({ name: 'Election day airtime', kind: 'airtime', amountNgn: 500, targetRoles: ['agent'] }).expect(201);
    const b = await http.post(api('/topups/batches')).set(as(ADMIN)).send({ planId: plan.body.id }).expect(201);
    await http.post(api(`/topups/batches/${b.body.batchId}/approve`)).set(as(ADMIN)).send({ approve: true }).expect(400);
    await http.get(api('/topups/plans')).set(as(SUP)).expect(403);
  });
});
