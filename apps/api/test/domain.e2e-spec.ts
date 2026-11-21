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

  it('my profile: field people update their own details; room staff cannot', async () => {
    const r = await http.patch(api('/me/profile')).set(as(AGENT4))
      .send({ fullName: '  Musa   Ibrahim ', email: 'Musa@Example.com', languages: ['ha', 'en'], network: 'mtn' }).expect(200);
    expect(r.body).toMatchObject({ full_name: 'Musa Ibrahim', email: 'musa@example.com', languages: ['ha', 'en'], network: 'mtn' });
    expect((await http.get(api('/me/context')).set(as(AGENT4)).expect(200)).body.me).toMatchObject({ full_name: 'Musa Ibrahim', email: 'musa@example.com' });
    // Cleared, and refused when invalid
    expect((await http.patch(api('/me/profile')).set(as(AGENT4)).send({ email: null }).expect(200)).body).toMatchObject({ email: null });
    await http.patch(api('/me/profile')).set(as(AGENT4)).send({ email: 'not an email' }).expect(400);
    await http.patch(api('/me/profile')).set(as(AGENT4)).send({ network: 'etisalat' }).expect(400);
    await http.patch(api('/me/profile')).set(as(AGENT4)).send({ fullName: 'A' }).expect(400);
    await http.patch(api('/me/profile')).set(as(SUP)).send({ fullName: 'Someone Else' }).expect(403);
    await http.patch(api('/me/profile')).set(as(AGENT4)).send({ fullName: 'Agent 004' }).expect(200); // as the other tests expect
  });

  it('my coordinator: the nearest one above my area', async () => {
    const c = (await http.get(api('/me/coordinator')).set(as(AGENT3)).expect(200)).body;
    expect(c).toMatchObject({ id: WARD, level: 'ward' });
    expect('19-28-02-003'.startsWith(c.area_code)).toBe(true);
  });

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
    // Shown by problem and place name (the stored title keeps the code)
    const [pl] = await ds.query(`select p.name as pu, w.name as ward, l.name as lga, s.name as state from public.polling_units p
      join public.wards w on w.code = p.ward_code join public.lgas l on l.code = w.lga_code join public.states s on s.code = l.state_code
      where p.code = '19-28-02-003'`);
    expect(d.body.case).toMatchObject({ what: 'BVAS not working',
      where: { name: pl.pu, parents: [pl.ward, `${pl.lga} LGA`, pl.state], code: '19-28-02-003', level: 'pu' } });
    const listed = (await http.get(api('/cases')).set(as(SUP)).expect(200)).body.find((c: any) => c.id === caseId);
    expect(listed).toMatchObject({ what: 'BVAS not working', where: { code: '19-28-02-003' }, report_count: 1, reporter_count: 1, alert_count: 0 });
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

  it('SOS sends first: an emergency with no type, then what is happening, a note; or "sent by mistake"', async () => {
    const id = uuid();
    const sos = (await http.post(api('/incidents')).set(as(AGENT4)).send({ pu: '19-28-02-004', category: 'sos', sos: true, clientId: id }).expect(200)).body;
    let d = (await http.get(api(`/cases/${sos.case_id}`)).set(as(SUP)).expect(200)).body;
    expect(d.case).toMatchObject({ category: 'sos', severity: 'critical' });
    await http.post(api('/incidents/details')).set(as(AGENT4)).send({ clientId: id, category: 'thugs', note: 'Five men with sticks' }).expect(200);
    d = (await http.get(api(`/cases/${sos.case_id}`)).set(as(SUP)).expect(200)).body;
    expect(d.case).toMatchObject({ category: 'thugs', severity: 'critical', title: 'Thugs or intimidation at 19-28-02-004' });
    expect(d.incidents.find((i: any) => i.client_id === id)).toMatchObject({ category: 'thugs', is_sos: true, description: 'Five men with sticks' });
    expect(d.events.some((e: any) => e.body === 'The agent added: Thugs or intimidation · Five men with sticks')).toBe(true);
    // A photo on its own (this once failed with "malformed array literal")
    const [{ tenant_id: tid }] = await ds.query(`select tenant_id from public.volunteers where id = $1`, [AGENT4]);
    const photo = `${tid}/incident/19-28-02-004/sos-photo.jpg`;
    await http.post(api('/incidents/details')).set(as(AGENT4)).send({ clientId: id, mediaPaths: [photo] }).expect(200);
    d = (await http.get(api(`/cases/${sos.case_id}`)).set(as(SUP)).expect(200)).body;
    expect(d.incidents.find((i: any) => i.client_id === id).media_paths).toEqual([photo]);
    expect(d.events.some((e: any) => e.body === 'The agent added: a photo')).toBe(true);
    // Only the reporter can add to their report
    await http.post(api('/incidents/details')).set(as(AGENT3)).send({ clientId: id, note: 'x' }).expect(400);

    // Sent by mistake: the case closes (nobody has taken it yet), and the room can see why
    const oops = uuid();
    const m = (await http.post(api('/incidents')).set(as(AGENT3)).send({ pu: '19-28-02-003', category: 'sos', sos: true, clientId: oops }).expect(200)).body;
    await http.post(api('/incidents/details')).set(as(AGENT3)).send({ clientId: oops, mistake: true }).expect(200);
    d = (await http.get(api(`/cases/${m.case_id}`)).set(as(SUP)).expect(200)).body;
    expect(d.case).toMatchObject({ status: 'closed', severity: 'low', outcome: 'Sent by mistake (the reporter cancelled it)' });
    expect(d.incidents.find((i: any) => i.client_id === oops)).toMatchObject({ is_sos: false, severity: 'low' });
  });

  it('election day figures on the map: check-ins, turnout, confirmed and counted votes, and an estimate', async () => {
    const pu = '19-28-02-005';
    await http.post(api('/quick-tallies')).set(as(AGENT3)).send({ pu: '19-28-02-003', votes: { APC: 40, PDP: 20 }, clientId: uuid() });
    const [ck] = await ds.query(`insert into public.checkins (tenant_id, election_id, volunteer_id, pu_code) select tenant_id, $2, id, area_code from public.volunteers where id = $1 returning id`, [AGENT3, LIVE]);
    const d = (await http.get(api('/map')).set(as(SUP)).query({ parent: '19-28-02' }).expect(200)).body;
    const t = d.totals;
    expect(t.units).toBe(d.children.reduce((a: number, c: any) => a + c.units, 0));
    for (const c of d.children) {
      // A unit counts once: confirmed (EC8A/IReV) or counted (agents' counts), never both
      expect(Object.keys(c.votes).every((p) => (c.confirmed[p] ?? 0) + (c.counted[p] ?? 0) === c.votes[p])).toBe(true);
      expect(c.checked_in).toBeGreaterThanOrEqual(0);
    }
    const party = Object.keys(t.estimate)[0];
    if (party) expect(t.estimate[party]).toBeGreaterThanOrEqual((t.confirmed[party] ?? 0) + (t.counted[party] ?? 0));
    expect(t.checked_in).toBeGreaterThan(0);
    expect(d.children.find((c: any) => c.code === pu)).toBeDefined();
    await ds.query(`delete from public.checkins where id = $1`, [ck.id]); // later tests start without check-ins
  });

  it('my field team: who needs following up in an area, Done hides them for an hour, and an announcement', async () => {
    const t = (await http.get(api('/team')).set(as(SUP)).query({ area: '19-28-02' }).expect(200)).body;
    expect(t).toMatchObject({ area: '19-28-02', childLevel: 'pu' });
    const a4 = t.people.find((p: any) => p.id === AGENT4);
    expect(a4.needs).toContain('notin'); // no check-in for the live election yet
    expect(t.counts.notin).toBeGreaterThan(0);
    // Done: off the list (shown as followed up) until the hour is over; undo brings them back
    await http.post(api('/team/follow-ups')).set(as(SUP)).send({ volunteerId: AGENT4, need: 'notin' }).expect(204);
    let again = (await http.get(api('/team')).set(as(SUP)).query({ area: '19-28-02' }).expect(200)).body;
    expect(again.people.find((p: any) => p.id === AGENT4)).toMatchObject({ followed: [{ need: 'notin' }] });
    expect(again.people.find((p: any) => p.id === AGENT4).needs).not.toContain('notin');
    await http.post(api('/team/follow-ups/undo')).set(as(SUP)).send({ volunteerId: AGENT4 }).expect(204);
    again = (await http.get(api('/team')).set(as(SUP)).query({ area: '19-28-02' }).expect(200)).body;
    expect(again.people.find((p: any) => p.id === AGENT4).needs).toContain('notin');
    // Only within your own area
    await http.get(api('/team')).set(as(WARD)).query({ area: '20' }).expect(403);
    await http.post(api('/team/follow-ups')).set(as('adminB')).send({ volunteerId: AGENT4, need: 'notin' }).expect(403);
    // Announcement: in the app for everyone picked, by SMS for those not seen in the app lately
    const r = (await http.post(api('/team/announce')).set(as(SUP)).send({ area: '19-28-02', audience: 'list', ids: [AGENT3, AGENT4], text: 'Test announcement: send turnout now' }).expect(200)).body;
    expect(r.sent).toBe(2);
    const out = await ds.query(`select channel, count(*)::int n from public.outbox where data->>'text' like '%Test announcement%' group by 1 order by 1`);
    expect(out.find((o: any) => o.channel === 'push').n).toBe(2);
    await ds.query(`delete from public.outbox where data->>'text' like '%Test announcement%'`); // the worker tests count the outbox
    await http.post(api('/team/announce')).set(as(SUP)).send({ area: '19-28-02', audience: 'list', text: 'x y' }).expect(400);
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
    // Shown in the browser and loadable from the dashboard's origin (PDF sheets are drawn there with pdf.js)
    expect(file.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(file.headers['content-disposition']).toBe('inline');
    expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
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

    // The list names conversations by place, problem or person (not codes), with the last message and unread count
    const before = (await http.get(api('/channels')).set(as(AGENT3)).expect(200)).body.find((c: any) => c.id === ch);
    expect(before).toMatchObject({ label: { caseStatus: 'closed', code: expect.stringMatching(/^19-28-02-/) },
      last: { body: 'Is the BVAS working now?', sender: 'Supervisor Kano', mine: false }, unread: 1 });
    expect(before.label.category).not.toMatch(/\d{2}-\d{2}/);
    const teams = (await http.get(api('/channels/area')).set(as(AGENT3)).expect(200)).body;
    const ward = teams.find((c: any) => c.kind === 'ward');
    const [nm] = await ds.query(`select w.name as ward, l.name as lga, s.name as state from public.wards w join public.lgas l on l.code = w.lga_code
                                join public.states s on s.code = l.state_code where w.code = $1`, [ward.area_code]);
    expect(ward.label).toEqual({ place: nm.ward, parents: [`${nm.lga} LGA`, nm.state], code: ward.area_code });
    expect(teams.find((c: any) => c.kind === 'state').label).toMatchObject({ place: nm.state, parents: [] });

    const seen = await http.get(api(`/channels/${ch}`)).set(as(AGENT3)).expect(200);
    expect(seen.body.channel.label.caseStatus).toBe('closed'); // the case was closed in the test above
    // Opening it marks it read
    expect((await http.get(api('/channels')).set(as(AGENT3)).expect(200)).body.find((c: any) => c.id === ch).unread).toBe(0);
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

  it('map by senatorial district: a state by district, a district by its LGAs, district kept in the path', async () => {
    await ds.query(`insert into public.senatorial_districts (code, state_code, name) values ('19-SD1', '19', 'Kano Central'), ('19-SD2', '19', 'Kano North')
                    on conflict do nothing`);
    await ds.query(`update public.lgas set senatorial_code = case code when '19-28' then '19-SD1' else '19-SD2' end where code in ('19-28', '19-29')`);
    const [u] = await ds.query(`select count(*)::int as n from public.polling_units where code like '19-28-%'`);

    const st = (await http.get(api('/map')).set(as(SUP)).query({ group: 'senatorial' }).expect(200)).body;
    expect(st).toMatchObject({ parent: '19', childLevel: 'senatorial', group: 'senatorial' });
    expect(st.children.map((c: any) => c.code)).toEqual(['19-SD1', '19-SD2']);
    expect(st.children[0]).toMatchObject({ name: 'Kano Central', units: u.n, coordinator: null });

    const d = (await http.get(api('/map')).set(as(SUP)).query({ parent: '19-SD1' }).expect(200)).body;
    expect(d).toMatchObject({ parent: '19-SD1', level: 'senatorial', childLevel: 'lga' });
    expect(d.children.map((c: any) => c.code)).toEqual(['19-28']);
    expect(d.breadcrumb.map((b: any) => b.name)).toEqual(['Kano', 'Kano Central']);

    const lga = (await http.get(api('/map')).set(as(SUP)).query({ parent: '19-28', group: 'senatorial' }).expect(200)).body;
    expect(lga.breadcrumb.map((b: any) => b.code)).toEqual(['19', '19-SD1', '19-28']);
    // Outside the person's area: refused
    await http.get(api('/map')).set(as(WARD)).query({ parent: '19-SD2' }).expect(403);
  });

  it('map by geopolitical zone: the country by zone, a zone by its states, zone kept in the path (national staff only)', async () => {
    const [u] = await ds.query(`select count(*)::int as n from public.polling_units where code like '19-%'`);
    const ng = (await http.get(api('/map')).set(as(ADMIN)).query({ group: 'zone' }).expect(200)).body;
    expect(ng).toMatchObject({ parent: 'NG', childLevel: 'zone', group: 'zone' });
    const nw = ng.children.find((c: any) => c.code === 'Z-NW');
    expect(nw).toMatchObject({ name: 'North West', coordinator: null });
    expect(nw.units).toBeGreaterThanOrEqual(u.n);

    const z = (await http.get(api('/map')).set(as(ADMIN)).query({ parent: 'Z-NW', group: 'zone' }).expect(200)).body;
    expect(z).toMatchObject({ parent: 'Z-NW', level: 'zone', childLevel: 'state' });
    expect(z.children.map((c: any) => c.code)).toContain('19');
    expect(z.children.every((c: any) => ['17', '18', '19', '20', '21', '33', '36'].includes(c.code))).toBe(true);
    expect(z.breadcrumb.map((b: any) => b.name)).toEqual(['Nigeria', 'North West']);

    const lga = (await http.get(api('/map')).set(as(ADMIN)).query({ parent: '19-28', group: 'zone,senatorial' }).expect(200)).body;
    expect(lga.breadcrumb.map((b: any) => b.code).slice(0, 3)).toEqual(['NG', 'Z-NW', '19']);
    // Not for people with a smaller area: no zones, and the path never shows one
    await http.get(api('/map')).set(as(SUP)).query({ parent: 'Z-NW' }).expect(403);
    const sup = (await http.get(api('/map')).set(as(SUP)).query({ group: 'zone' }).expect(200)).body;
    expect(sup).toMatchObject({ parent: '19', childLevel: 'lga' });
    expect(sup.breadcrumb.map((b: any) => b.code)).toEqual(['19']);
  });

  it('map: wards and units with no outline or location get rough places inside their parent', async () => {
    const [w] = await ds.query(`select code from public.wards where lga_code = '19-29' order by code limit 1`);
    const saved = await ds.query(`select * from public.area_shapes where code = $1`, [w.code]);
    await ds.query(`delete from public.area_shapes where code = $1`, [w.code]);
    const unitsSaved = await ds.query(`select code, lat, lng from public.polling_units where ward_code = $1`, [w.code]);
    await ds.query(`update public.polling_units set lat = null, lng = null where ward_code = $1`, [w.code]);
    try {
      const lga = (await http.get(api('/map')).set(as(SUP)).query({ parent: '19-29' }).expect(200)).body;
      const ward = lga.children.find((c: any) => c.code === w.code);
      expect(ward).toMatchObject({ shape: null, approx: true });
      expect(typeof ward.lat).toBe('number');
      expect(ward.radius_m).toBeGreaterThan(0);

      // Opening it: the ward sits at the same rough place, its units around it, so the map can zoom there
      const units = (await http.get(api('/map')).set(as(SUP)).query({ parent: w.code }).expect(200)).body;
      expect(units.approxArea).toMatchObject({ lat: ward.lat, lng: ward.lng });
      expect(units.center).toMatchObject({ lat: ward.lat, lng: ward.lng });
      expect(units.children.length).toBe(unitsSaved.length);
      expect(units.children.every((c: any) => typeof c.lat === 'number' && typeof c.lng === 'number')).toBe(true);
      expect(units.children.some((c: any) => c.approx)).toBe(true);
    } finally {
      for (const s of saved) await ds.query(`insert into public.area_shapes (code, level, geometry, center_lat, center_lng, source) values ($1, $2, $3, $4, $5, $6)`,
        [s.code, s.level, s.geometry, s.center_lat, s.center_lng, s.source]);
      for (const u of unitsSaved) await ds.query(`update public.polling_units set lat = $2, lng = $3 where code = $1`, [u.code, u.lat, u.lng]);
    }
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

  it('check-in: only on election day (or practice), first one is the arrival time, own unit only', async () => {
    const pu = '19-28-02-003';
    // The live election is in January 2027: too early, so refused with the opening time
    const early = await http.post(api('/checkins')).set(as(AGENT3)).send({ pu, clientId: uuid() }).expect(400);
    expect(early.body.message).toMatch(/opens at 6:00.*16 January/);
    expect((await http.get(api('/checkins/mine')).set(as(AGENT3)).expect(200)).body)
      .toMatchObject({ first: null, count: 0, window: { open: false, anyDay: false, electionDate: '2027-01-16', opensAt: '2027-01-16T05:00:00.000Z' } });

    // Practice mode (admins only) allows any day; the phone's tap time counts when it arrives late
    await http.patch(api('/settings/checkin')).set(as(SUP)).send({ anyDay: true }).expect(403);
    await http.patch(api('/settings/checkin')).set(as(ADMIN)).send({ anyDay: true, opens: '25:00' }).expect(400);
    expect((await http.patch(api('/settings/checkin')).set(as(ADMIN)).send({ anyDay: true }).expect(200)).body).toEqual({ opens: '06:00', anyDay: true });
    const tapped = new Date(Date.now() - 3600_000).toISOString();
    await http.post(api('/checkins')).set(as(AGENT3)).send({ pu, at: tapped, clientId: uuid() }).expect(204);
    await http.post(api('/checkins')).set(as(AGENT3)).send({ pu, at: '2030-01-01T00:00:00Z', clientId: uuid() }).expect(204); // future: server time
    await http.post(api('/checkins')).set(as(AGENT3)).send({ pu: '19-28-02-004', clientId: uuid() }).expect(400);
    const mine = (await http.get(api('/checkins/mine')).set(as(AGENT3)).expect(200)).body;
    expect(mine).toMatchObject({ first: tapped, count: 2, window: { open: true, anyDay: true } });
    expect(Date.parse(mine.last)).toBeLessThanOrEqual(Date.now());

    // Checked against the ward outline; outside is accepted with a note and shown to the room
    const [a4] = await ds.query(`select area_code from public.volunteers where id = $1`, [AGENT4]);
    expect((await http.get(api('/checkins/mine')).set(as(AGENT4)).expect(200)).body.fence).toMatchObject({ level: 'ward', code: a4.area_code.slice(0, 8) });
    await http.post(api('/checkins')).set(as(AGENT4)).send({ pu: a4.area_code, lat: 0, lng: 0, note: 'Unit moved to the school', clientId: uuid() }).expect(204);
    expect((await http.get(api('/checkins/mine')).set(as(AGENT4)).expect(200)).body).toMatchObject({ count: 1, arrival: null, lastInside: false });
    const outside = (await http.get(api('/checkins/summary')).set(as(SUP)).expect(200)).body;
    expect(outside.people.find((p: any) => p.id === AGENT4)).toMatchObject({ outside: true, note: 'Unit moved to the school', against: 'ward' });
    expect(outside.people.find((p: any) => p.id === AGENT4).distance).toBeGreaterThan(1000_000);
    // Checking in again from inside the ward corrects it; both are kept
    await http.post(api('/checkins')).set(as(AGENT4)).send({ pu: a4.area_code, lat: 12.1, lng: 8.3, clientId: uuid() }).expect(204);
    expect((await http.get(api('/checkins/mine')).set(as(AGENT4)).expect(200)).body).toMatchObject({ count: 2, lastInside: true });
    const sum = (await http.get(api('/checkins/summary')).set(as(SUP)).expect(200)).body;
    expect(sum).toMatchObject({ area: '19', childLevel: 'lga', onTimeBy: '07:30', window: { open: true } });
    expect(sum.checkedIn).toBe(sum.onTime + sum.late);
    expect(sum.agents).toBe(sum.checkedIn + sum.notYet);
    const p3 = sum.people.find((p: any) => p.id === AGENT3);
    expect(p3).toMatchObject({ pu, count: 2, first: tapped });
    expect(sum.people.find((p: any) => p.id === AGENT4)).toMatchObject({ count: 2, outside: false, unverified: false });
    expect(p3).toMatchObject({ unverified: true }); // checked in without a location
    expect(sum.outside).toBe(0);
    const lga = sum.children.find((c: any) => c.code === '19-28');
    expect(lga.checkedIn).toBeGreaterThanOrEqual(1);
    // Ward coordinator: own ward only; agents: none; another organisation: none of these people
    const ward = (await http.get(api('/checkins/summary')).set(as(WARD)).expect(200)).body;
    expect(ward.people.every((p: any) => p.pu.startsWith(ward.area))).toBe(true);
    await http.get(api('/checkins/summary')).set(as(WARD)).query({ area: '19' }).expect(403);
    await http.get(api('/checkins/summary')).set(as(AGENT3)).expect(403);
    const b = (await http.get(api('/checkins/summary')).set(as('adminB')).query({ area: '19' }).expect(200)).body;
    expect(b.people.some((p: any) => p.id === AGENT3)).toBe(false);
    await http.patch(api('/settings/checkin')).set(as(ADMIN)).send({ anyDay: false }).expect(200);
  });

  it('checklist answers come back after a reinstall; own party set by admins', async () => {
    await http.put(api('/checklist')).set(as(AGENT3)).send({ pu: '19-28-02-003', item: 'bvas_working', answer: { value: 'no' }, clientId: uuid() }).expect(204);
    expect((await http.get(api('/checklist/mine')).set(as(AGENT3)).expect(200)).body).toMatchObject({ bvas_working: 'no' });
    expect((await http.get(api('/checklist/mine')).set(as(AGENT4)).expect(200)).body.bvas_working).toBeUndefined();

    await http.patch(api('/settings/party')).set(as(ADMIN)).send({ party: 'apc' }).expect(400);
    await http.patch(api('/settings/party')).set(as(ADMIN)).send({ party: 'PDP' }).expect(200);
    expect((await http.get(api('/me/context')).set(as(AGENT3)).expect(200)).body.ownParty).toBe('PDP');
    expect((await http.get(api('/settings')).set(as(ADMIN)).expect(200)).body).toMatchObject({ party: 'PDP', checkin: { opens: '06:00' } });
    expect((await http.get(api('/me/context')).set(as('adminB')).expect(200)).body.ownParty).toBeNull();
    await http.patch(api('/settings/party')).set(as(ADMIN)).send({ party: 'XYZ' }).expect(200); // not on the ballot: ignored
    expect((await http.get(api('/me/context')).set(as(AGENT3)).expect(200)).body.ownParty).toBeNull();
    await http.patch(api('/settings/party')).set(as(ADMIN)).send({ party: null }).expect(200);
  });

  it('polling-day figures: sent stage by stage, flagged to the right desk, summed for the room', async () => {
    const pu = '19-28-02-003';
    const send = (stage: string, figures: Record<string, number>, clientId = uuid()) =>
      http.post(api('/unit-figures')).set(as(AGENT3)).send({ pu, stage, figures, clientId });
    expect((await send('setup', { registered: 650, ballots_received: 650 }).expect(200)).body).toMatchObject({ flags: [], final: false });
    await send('accreditation', { accredited: 180 }).expect(200);
    // A figure going down is flagged (and the same message resent changes nothing)
    const again = uuid();
    expect((await send('accreditation', { accredited: 150 }, again).expect(200)).body.flags.map((f: any) => f.flag)).toEqual(['accreditation_dropped']);
    expect((await send('accreditation', { accredited: 150 }, again).expect(200)).body.flags).toEqual([]);
    // Impossible figure: more accredited than the register -> a critical case on the legal desk
    expect((await send('accreditation', { accredited: 700 }).expect(200)).body.flags.map((f: any) => f.flag)).toContain('over_registered');
    const [cs] = await ds.query(`select c.severity, q.kind from public.cases c join public.queues q on q.id = c.queue_id
                                  where c.tenant_id = $1 and c.category = 'over_registered' and c.pu_code = $2`, [T_A, pu]);
    expect(cs).toMatchObject({ severity: 'critical', kind: 'legal' });
    // Close of poll and result: ballots balance (650 = 2 + 8 + 290 used + 350 unused)
    expect((await send('close', { accredited: 300, unused: 350, spoiled: 2 }).expect(200)).body.final).toBe(true);
    const res = (await send('result', { rejected: 8, total_valid: 290 }).expect(200)).body;
    expect(res.latest).toEqual({ registered: 650, ballots_received: 650, accredited: 300, unused: 350, spoiled: 2, rejected: 8, total_valid: 290 });
    expect(res.flags.map((f: any) => f.flag)).not.toContain('ballots_unbalanced');
    // Announced item 8 differing from 5 + 6 + 7 is flagged
    expect((await send('result', { used: 310 }).expect(200)).body.flags.map((f: any) => f.flag)).toContain('used_mismatch');

    // Only the agent at the unit; unknown figures refused
    await http.post(api('/unit-figures')).set(as(AGENT4)).send({ pu, stage: 'setup', figures: { registered: 1 }, clientId: uuid() }).expect(403);
    await send('setup', { voters: 5 }).expect(400);
    expect((await http.get(api('/unit-figures/mine')).set(as(AGENT3)).expect(200)).body).toMatchObject({ final: true, latest: { accredited: 300 } });

    // The room: turnout for the state and per LGA, and the feed with the flags; the ward coordinator for the ward
    const sum = (await http.get(api('/unit-figures/summary')).set(as(SUP)).expect(200)).body;
    expect(sum).toMatchObject({ area: '19', unitsReporting: 1, unitsClosed: 1, registered: 650, accredited: 300, childLevel: 'lga' });
    expect(sum.turnout).toBeCloseTo(300 / 650);
    expect(sum.flags).toBeGreaterThanOrEqual(2);
    const feed = (await http.get(api('/unit-figures/feed')).set(as(SUP)).expect(200)).body;
    expect(feed.updates[0]).toMatchObject({ pu_code: pu, stage: 'result', registered: 650 });
    expect(feed.flags.map((f: any) => f.rule)).toEqual(expect.arrayContaining(['over_registered', 'used_mismatch', 'accreditation_dropped']));
    expect((await http.get(api('/unit-figures/summary')).set(as(WARD)).expect(200)).body.unitsReporting).toBe(1);
    await http.get(api('/unit-figures/summary')).set(as(WARD)).query({ area: '19' }).expect(403);
    await http.get(api('/unit-figures/feed')).set(as(AGENT3)).expect(403);
    expect((await http.get(api('/unit-figures/feed')).set(as('adminB')).query({ area: '19' }).expect(200)).body.updates).toEqual([]);
  });

  it('two admins are needed for a top-up batch', async () => {
    // A premium add-on: refused until Rumfa switches it on for the client
    await http.get(api('/topups/plans')).set(as(ADMIN)).expect(403);
    await http.get(api('/voice/campaigns')).set(as(ADMIN)).expect(403);
    const ctx = (await http.get(api('/me/context')).set(as(ADMIN)).expect(200)).body;
    expect(ctx.addons).toEqual({ voice: false, airtime: false });
    await ds.query(`update public.tenants set settings = settings || '{"addons":{"airtime":true}}' where id = (select tenant_id from public.volunteers where id = $1)`, [ADMIN]);
    const plan = await http.post(api('/topups/plans')).set(as(ADMIN)).send({ name: 'Election day airtime', kind: 'airtime', amountNgn: 500, targetRoles: ['agent'] }).expect(201);
    const b = await http.post(api('/topups/batches')).set(as(ADMIN)).send({ planId: plan.body.id }).expect(201);
    await http.post(api(`/topups/batches/${b.body.batchId}/approve`)).set(as(ADMIN)).send({ approve: true }).expect(400);
    await http.get(api('/topups/plans')).set(as(SUP)).expect(403);
  });

  it('operating rules: admins set case timings and routing; new cases follow them; "stay" keeps an overdue case', async () => {
    const s = (await http.get(api('/settings')).set(as(ADMIN)).expect(200)).body;
    expect(s.rules).toEqual(s.defaults);
    expect(s.categories.some((c: any) => c.code === 'sos')).toBe(false);     // SOS can't be re-routed
    const rules = structuredClone(s.rules);
    rules.cases.high = { take: 4, resolve: 17, onMiss: 'up' };
    rules.cases.medium = { take: 9, resolve: 33, onMiss: 'stay' };
    rules.routing = { vote_buying: { queue: 'state', severity: 'high' } };
    rules.team.silentMin = 45;

    await http.put(api('/settings/rules')).set(as(SUP)).send(rules).expect(403);
    const bad = await http.put(api('/settings/rules')).set(as(ADMIN)).send({ ...rules, cases: { ...rules.cases, low: { take: 50, resolve: 20, onMiss: 'national' } } }).expect(400);
    expect(bad.body.message).toContain("Low: resolve time can't be shorter than take time");
    await http.put(api('/settings/rules')).set(as(ADMIN)).send({ ...rules, routing: { sos: { severity: 'low' } } }).expect(400);
    expect((await http.put(api('/settings/rules')).set(as(ADMIN)).send(rules).expect(200)).body).toEqual(rules);
    const hist = (await http.get(api('/settings/rules/history')).set(as(ADMIN)).expect(200)).body;
    expect(hist[0].changes).toEqual(expect.arrayContaining(['cases.high.take: 5 → 4', 'routing.vote_buying.severity: default → high', 'team.silentMin: 60 → 45']));

    // The app is told: vote buying now starts as high, in the state room
    const ctx = (await http.get(api('/me/context')).set(as(AGENT3)).expect(200)).body;
    expect(ctx.categories.find((c: any) => c.code === 'vote_buying')).toMatchObject({ severity: 'high', queue_kind: 'state' });

    const vb = (await http.post(api('/incidents')).set(as(AGENT3)).send({ pu: '19-28-02-003', category: 'vote_buying', clientId: uuid() }).expect(200)).body.case_id;
    const [c1] = await ds.query(`select c.severity, q.kind, round(extract(epoch from c.due_at - c.created_at) / 60) as resolve
      from public.cases c join public.queues q on q.id = c.queue_id where c.id = $1`, [vb]);
    expect(c1).toEqual({ severity: 'high', kind: 'state', resolve: '17' });

    // Medium with "stay": past its deadline it stays put, supervisors are told once
    const ml = (await http.post(api('/incidents')).set(as(AGENT4)).send({ pu: '19-28-02-004', category: 'materials_late', clientId: uuid() }).expect(200)).body.case_id;
    const [c2] = await ds.query(`select severity, round(extract(epoch from due_at - created_at) / 60) as resolve from public.cases where id = $1`, [ml]);
    expect(c2).toEqual({ severity: 'medium', resolve: '33' });
    await ds.query(`update public.cases set due_at = now() - interval '1 minute' where id = $1`, [ml]);
    await ds.query(`select app.tick_cases()`);
    await ds.query(`select app.tick_cases()`);
    const [after] = await ds.query(`select status, overdue_at is not null as flagged,
      (select count(*)::int from public.case_events e where e.case_id = c.id and e.kind = 'overdue') as events from public.cases c where c.id = $1`, [ml]);
    expect(after.status).not.toBe('escalated');
    expect(after).toMatchObject({ flagged: true, events: 1 });

    // Back to the defaults, and the two cases out of the way of other tests
    await http.put(api('/settings/rules')).set(as(ADMIN)).send(s.defaults).expect(200);
    await ds.query(`update public.cases set status = 'closed', closed_at = now() where id = any($1)`, [[vb, ml]]);
  });

  it('chat alerts: direct messages buzz the other person (SMS when away), coordinators reach the ward, agents only raise the badge', async () => {
    const alerts = async () => ds.query(`select to_volunteer, channel, template, data from public.outbox where template in ('new_message', 'new_message_sms') order by created_at`);
    await ds.query(`delete from public.outbox where template in ('new_message', 'new_message_sms')`);
    // Room staff write to an agent directly; the agent's app hasn't been seen, so an SMS goes too
    const { channelId } = (await http.post(api('/channels/direct')).set(as(ADMIN)).send({ otherId: AGENT3 }).expect(201)).body;
    const cid = uuid();
    await http.post(api(`/channels/${channelId}/messages`)).set(as(ADMIN)).send({ body: 'Please send the EC8A photo', clientId: cid }).expect(201);
    await http.post(api(`/channels/${channelId}/messages`)).set(as(ADMIN)).send({ body: 'Please send the EC8A photo', clientId: cid }).expect(201);   // app resend
    await http.post(api(`/channels/${channelId}/messages`)).set(as(ADMIN)).send({ body: 'Thanks', clientId: uuid() }).expect(201);                  // within 2 min
    let a = await alerts();
    expect(a.map((x: any) => [x.to_volunteer, x.channel, x.template])).toEqual([[AGENT3, 'push', 'new_message'], [AGENT3, 'sms', 'new_message_sms']]);
    expect(a[0].data).toMatchObject({ channel_id: channelId, text: 'Please send the EC8A photo', kind: 'direct' });
    // Room staff aren't pushed (they see it live in the Room's Messages page)
    await http.post(api(`/channels/${channelId}/messages`)).set(as(AGENT3)).send({ body: 'Sending now', clientId: uuid() }).expect(201);
    expect((await alerts()).length).toBe(2);

    // Ward chat: an agent's message only raises badges; the ward coordinator's reaches everyone in the ward
    const ward = (await http.get(api('/channels/area')).set(as(WARD)).expect(200)).body.find((c: any) => c.kind === 'ward');
    await http.post(api(`/channels/${ward.id}/messages`)).set(as(AGENT4)).send({ body: 'Anyone have spare forms?', clientId: uuid() }).expect(201);
    expect((await alerts()).length).toBe(2);
    await http.post(api(`/channels/${ward.id}/messages`)).set(as(WARD)).send({ body: 'Check in by 8:30 please', clientId: uuid() }).expect(201);
    a = (await alerts()).filter((x: any) => x.data.channel_id === ward.id);
    expect(a.map((x: any) => x.to_volunteer)).toEqual(expect.arrayContaining([AGENT3, AGENT4]));
    expect(a.every((x: any) => x.channel === 'push' && x.to_volunteer !== WARD)).toBe(true);
    await ds.query(`delete from public.outbox where template in ('new_message', 'new_message_sms')`);
  });

  it('messages and calls: a direct chat carries the person, their call requests and calls; the room sees the call log', async () => {
    await http.post(api('/callbacks')).set(as(AGENT3)).send({ reason: 'unit' }).expect(201);
    const req = (await http.get(api('/callbacks/mine')).set(as(AGENT3)).expect(200)).body;
    // Room staff take it from Messages: start (whatever kind of call follows), then record the outcome
    await http.post(api(`/callbacks/${req.id}/start`)).set(as(ADMIN)).expect(204);
    await http.post(api(`/callbacks/${req.id}/start`)).set(as(AGENT4)).expect(403);
    await ds.query(`insert into public.calls (tenant_id, caller_id, callee_id, to_phone, route, status, duration_s, reason, callback_id)
                    values ($1, $2, $3, '+2348000000020', 'inapp', 'completed', 95, 'callback', $4)`, [T_A, ADMIN, AGENT3, req.id]);
    const { channelId } = (await http.post(api('/channels/direct')).set(as(ADMIN)).send({ otherId: AGENT3 }).expect(201)).body;
    const d = (await http.get(api(`/channels/${channelId}`)).set(as(ADMIN)).expect(200)).body;
    expect(d.person).toMatchObject({ id: AGENT3, full_name: 'Agent 003', role: 'agent' });
    expect(d.requests[0]).toMatchObject({ id: req.id, reason: 'unit', status: 'calling', attempts: 1 });
    expect(d.calls[0]).toMatchObject({ caller_id: ADMIN, callee_id: AGENT3, status: 'completed', duration_s: 95, callee_name: 'Agent 003' });
    // Area and case chats have no person
    const ward = (await http.get(api('/channels/area')).set(as(WARD)).expect(200)).body.find((c: any) => c.kind === 'ward');
    expect((await http.get(api(`/channels/${ward.id}`)).set(as(WARD)).expect(200)).body).toMatchObject({ person: null, calls: [], requests: [] });

    const log = (await http.get(api('/calls/log')).set(as(ADMIN)).expect(200)).body;
    expect(log[0]).toMatchObject({ caller_name: expect.any(String), callee_name: 'Agent 003', status: 'completed' });
    await http.get(api('/calls/log')).set(as(AGENT3)).expect(403);

    await http.post(api(`/callbacks/${req.id}/complete`)).set(as(ADMIN)).send({ answered: true, outcome: 'Sorted' }).expect(204);
    await ds.query(`delete from public.calls where callback_id = $1`, [req.id]);
    await ds.query(`delete from public.outbox where template in ('new_message', 'new_message_sms', 'callback_request', 'callback_request_sms')`);
  });

  it('sheet review: confirming saves the ballot papers (items 3, 4, 5, 8) when given, and checks them', async () => {
    const pu = '19-28-02-002', v = 7;
    await ds.query(`insert into public.irev_sheet_results (election_id, pu_code, sheet_version, registered, accredited, rejected, total_valid, votes, ocr_status)
                    values ($1, $2, $3, 0, 0, 0, 0, '{}', 'needs_review')`, [LIVE, pu, v]);
    const base = { electionId: LIVE, pu, version: v, registered: 500, accredited: 300, rejected: 5, totalValid: 280, votes: { APC: 200, PDP: 80 } };
    // Issued 300 but used (2 + 5 + 280 = 287) + unused 20 = 307; and item 8 written as 290
    await http.post(api('/irev/sheets/confirm')).set(as(ADMIN)).send({ ...base, ballotsReceived: 300, unused: 20, spoiled: 2, used: 290 }).expect(204);
    let [r] = await ds.query(`select ballots_received, unused, spoiled, used, ocr_status, check_issues from public.irev_sheet_results where election_id = $1 and pu_code = $2 and sheet_version = $3`, [LIVE, pu, v]);
    expect(r).toMatchObject({ ballots_received: 300, unused: 20, spoiled: 2, used: 290, ocr_status: 'confirmed' });
    expect(r.check_issues.map((i: any) => i.code).sort()).toEqual(['ballots_unbalanced', 'used_mismatch']);
    // Without them (unreadable on the sheet): stored empty, no ballot checks
    await http.post(api('/irev/sheets/confirm')).set(as(ADMIN)).send(base).expect(204);
    [r] = await ds.query(`select ballots_received, used, check_issues from public.irev_sheet_results where election_id = $1 and pu_code = $2 and sheet_version = $3`, [LIVE, pu, v]);
    expect(r).toEqual({ ballots_received: null, used: null, check_issues: [] });
    await http.post(api('/irev/sheets/confirm')).set(as(ADMIN)).send({ ...base, unused: -1 }).expect(400);
    await ds.query(`delete from public.irev_sheet_results where election_id = $1 and pu_code = $2 and sheet_version = $3`, [LIVE, pu, v]);
  });

  it('the seat caps the hierarchy: a governor\'s cases move up only to the state room; an LGA chairman has no state chat', async () => {
    await ds.query(`update public.tenants set seat = 'governorship', seat_area = '19' where id = $1`, [T_A]);
    const [lvl] = await ds.query(`select app.seat_level($1) as level, (select kind from public.queues where id = app.top_queue($1, '19-28-02-003')) as top`, [T_A]);
    expect(lvl).toEqual({ level: 'state', top: 'state' });
    expect((await http.get(api('/settings')).set(as(ADMIN)).expect(200)).body.hierarchy).toMatchObject({ level: 'state', seat: 'governorship', topRoom: expect.any(String) });

    // A security case escalated by a supervisor goes to the state room, not the national room
    const id = (await http.post(api('/incidents')).set(as(AGENT3)).send({ pu: '19-28-02-003', category: 'thugs', clientId: uuid() }).expect(200)).body.case_id;
    await http.post(api(`/cases/${id}/escalate`)).set(as(SUP)).send({ text: 'Needs the state room' }).expect(204);
    let [c] = await ds.query(`select c.status, q.kind from public.cases c join public.queues q on q.id = c.queue_id where c.id = $1`, [id]);
    expect(c).toEqual({ status: 'escalated', kind: 'state' });
    // Already in the top room and out of time: it stays there and its supervisors are told (never national)
    await ds.query(`update public.cases set status = 'queued', due_at = now() - interval '1 minute' where id = $1`, [id]);
    await ds.query(`select app.tick_cases()`);
    [c] = await ds.query(`select c.status, q.kind, c.overdue_at is not null as flagged from public.cases c join public.queues q on q.id = c.queue_id where c.id = $1`, [id]);
    expect(c.kind).toBe('state');
    expect(c.flagged).toBe(true);
    // A report routed to "national" goes to the client's own room instead
    await ds.query(`update public.tenants set settings = jsonb_set(settings, '{rules}', '{"routing":{"thugs":{"queue":"national"}}}') where id = $1`, [T_A]);
    const [r] = await ds.query(`select kind from public.queues where id = app.route_queue($1, 'thugs', '19-28-02-003')`, [T_A]);
    expect(r.kind).toBe('state');
    await ds.query(`update public.tenants set settings = settings - 'rules' where id = $1`, [T_A]);

    // LGA chairman: team chats stop at the LGA
    await ds.query(`update public.tenants set seat = 'chairman', seat_area = '19-28' where id = $1`, [T_A]);
    const kinds = (await http.get(api('/channels/area')).set(as(AGENT3)).expect(200)).body.map((x: any) => x.kind).sort();
    expect(kinds).toEqual(['lga', 'ward']);

    await ds.query(`update public.tenants set seat = null, seat_area = null where id = $1`, [T_A]);
    await ds.query(`update public.cases set status = 'closed', closed_at = now() where id = $1`, [id]);
    expect((await http.get(api('/channels/area')).set(as(AGENT3)).expect(200)).body.map((x: any) => x.kind).sort()).toEqual(['lga', 'state', 'ward']);
  });
});
