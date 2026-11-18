import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { keyedHash } from '../src/auth/crypto';
import { createTestApp, sessionFor } from './setup';

const api = (p: string) => `/api/v1${p}`;
const SECRET = 'e2e-secret-that-is-long-enough-for-tests';
const ADMIN = 'b0000000-0000-4000-8000-000000000001';
const LIVE = '2027a000-0000-4000-8000-000000000001';
const BASE = '2023b000-0000-4000-8000-000000000001';
// A 2 x 2 red PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

describe('Rumfa Console (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;
  let owner = '';
  let clientAdmin = '';

  /** A Rumfa staff member with a one-time link, as `platform:owner` or an owner's invite makes. */
  async function inviteLink(email: string, role = 'owner') {
    const [s] = await ds.query(
      `insert into public.platform_staff (email, full_name, role) values ($1, 'Test Staff', $2)
       on conflict (email) do update set role = excluded.role returning id`, [email, role]);
    const token = 'tok-' + email;
    await ds.query(`insert into public.platform_invites (staff_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`,
      [s.id, keyedHash(SECRET, `pinvite:${token}`)]);
    return token;
  }

  /** Sets the password and signs in: a console token. */
  async function signUp(email: string, role = 'owner') {
    const password = 'a long password for tests';
    await http.post(api('/platform/auth/invite/accept')).send({ token: await inviteLink(email, role), password }).expect(200);
    const s = await http.post(api('/platform/auth/login')).send({ email, password }).expect(200);
    return { access: s.body.session.accessToken as string, refresh: s.body.session.refreshToken as string, password };
  }
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    ({ app, ds } = await createTestApp());
    http = request(app.getHttpServer());
    clientAdmin = await sessionFor(app, ADMIN);
  });
  afterAll(async () => { await app.close(); });

  it('sign-in: email and password; links work once; wrong passwords refused; sessions rotate', async () => {
    const o = await signUp('owner@rumfa.test');
    owner = o.access;
    expect((await http.get(api('/platform/auth/me')).set(as(owner)).expect(200)).body).toMatchObject({ email: 'owner@rumfa.test', role: 'owner' });
    // The link is used up
    await http.post(api('/platform/auth/invite/accept')).send({ token: 'tok-owner@rumfa.test', password: 'another long password' }).expect(401);
    await http.post(api('/platform/auth/login')).send({ email: 'owner@rumfa.test', password: 'wrong password!!' }).expect(401);
    const s = await http.post(api('/platform/auth/login')).send({ email: 'owner@rumfa.test', password: o.password }).expect(200);
    // Refresh rotates; using an old refresh token again ends the session family
    const r = await http.post(api('/platform/auth/refresh')).send({ refreshToken: s.body.session.refreshToken }).expect(200);
    await http.post(api('/platform/auth/refresh')).send({ refreshToken: s.body.session.refreshToken }).expect(401);
    await http.post(api('/platform/auth/refresh')).send({ refreshToken: r.body.refreshToken }).expect(401);
  });

  it('console and client tokens never open each other\'s endpoints', async () => {
    await http.get(api('/platform/clients')).set(as(clientAdmin)).expect(401);
    await http.get(api('/platform/clients')).expect(401);
    await http.get(api('/settings')).set(as(owner)).expect(401);
    await http.get(api('/platform/clients')).set(as(owner)).expect(200);
  });

  it('parties: add, colour, logo (resized, served publicly with a changing address)', async () => {
    await http.post(api('/platform/parties')).set(as(owner)).send({ acronym: 'TST', name: 'Test Party', colour: '#123456' }).expect(201);
    await http.post(api('/platform/parties')).set(as(owner)).send({ acronym: 'TST', name: 'Again' }).expect(409);
    await http.patch(api('/platform/parties/APC')).set(as(owner)).send({ colour: '#1b7a3a' }).expect(200);
    const up = await http.put(api('/platform/parties/APC/logo')).set(as(owner)).send({ dataUrl: PNG }).expect(200);
    expect(up.body.logoUrl).toBe('/api/v1/parties/APC/logo?v=1');
    const img = await http.get(up.body.logoUrl).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toContain('immutable');
    await http.put(api('/platform/parties/APC/logo')).set(as(owner)).send({ dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' }).expect(400);
    const list = (await http.get(api('/platform/parties')).set(as(owner)).expect(200)).body;
    expect(list.find((p: any) => p.acronym === 'APC')).toMatchObject({ colour: '#1b7a3a', logoUrl: '/api/v1/parties/APC/logo?v=1' });
    await http.get(api('/parties/PDP/logo')).expect(404);
  });

  it('elections: add one and set its ballot in order', async () => {
    const e = await http.post(api('/platform/elections')).set(as(owner))
      .send({ name: 'Kano Governorship 2027', electionType: 'governorship', electionDate: '2027-03-06', scopeStateCode: '19' }).expect(201);
    await http.put(api(`/platform/elections/${e.body.id}/parties`)).set(as(owner)).send({ parties: ['NNPP', 'APC', 'XYZ'] }).expect(400);
    await http.put(api(`/platform/elections/${e.body.id}/parties`)).set(as(owner)).send({ parties: ['NNPP', 'APC', 'TST'] }).expect(200);
    const all = (await http.get(api('/platform/elections')).set(as(owner)).expect(200)).body;
    expect(all.find((x: any) => x.id === e.body.id)).toMatchObject({ status: 'upcoming', parties: ['NNPP', 'APC', 'TST'] });
    // The ballot can be given with the new election; an unknown party refuses the whole thing
    await http.post(api('/platform/elections')).set(as(owner))
      .send({ name: 'Bad ballot', electionType: 'governorship', electionDate: '2027-03-06', scopeStateCode: '20', parties: ['APC', 'NOPE'] }).expect(400);
    expect(await ds.query(`select 1 from public.elections where name = 'Bad ballot'`)).toHaveLength(0);
    const k = await http.post(api('/platform/elections')).set(as(owner))
      .send({ name: 'Katsina Governorship 2027', electionType: 'governorship', electionDate: '2027-03-06', scopeStateCode: '20', parties: ['APC', 'PDP'] }).expect(201);
    const kat = (await http.get(api('/platform/elections')).set(as(owner)).expect(200)).body.find((x: any) => x.id === k.body.id);
    expect(kat).toMatchObject({ parties: ['APC', 'PDP'], election_date: '2027-03-06' });
  });

  it('onboarding: a governorship client gets its state, elections, desks, an admin who can sign in, and coordinators', async () => {
    const body = {
      name: 'Test for Kano 2027', brand: 'TESTKANO', candidateName: 'A. Candidate', party: 'NNPP', seat: 'governorship', seatArea: '19',
      liveElectionId: LIVE, baselineElectionId: BASE, domains: ['kano.test.example'],
      admins: [{ fullName: 'Client Admin', email: 'Admin@Client.test', phone: '08031110001' }],
      coordinators: [{ fullName: 'State Coordinator', phone: '0803 111 2233', level: 'state', areaCode: '19' },
                     { fullName: 'LGA Coordinator', phone: '08031112234', level: 'lga', areaCode: '19-28' }],
    };
    // Outside the seat, or at a level the seat does not use: refused, and nothing is saved
    await http.post(api('/platform/clients')).set(as(owner))
      .send({ ...body, coordinators: [{ fullName: 'Elsewhere', phone: '08031112235', level: 'state', areaCode: '20' }] }).expect(400);
    await http.post(api('/platform/clients')).set(as(owner))
      .send({ ...body, coordinators: [{ fullName: 'Too high', phone: '08031112235', level: 'national', areaCode: 'NG' }] }).expect(400);
    await http.post(api('/platform/clients')).set(as(owner)).send({ ...body, seat: 'reps' }).expect(400); // a Reps seat needs a constituency, not a state
    expect(await ds.query(`select 1 from public.tenants where name = $1`, [body.name])).toHaveLength(0);

    const r = await http.post(api('/platform/clients')).set(as(owner)).send(body).expect(201);
    expect(r.body.invites).toHaveLength(1);
    expect(r.body.coordinators.map((c: any) => c.phone)).toEqual(['+2348031112233', '+2348031112234']);
    const d = (await http.get(api(`/platform/clients/${r.body.id}`)).set(as(owner)).expect(200)).body;
    expect(d).toMatchObject({ brand: 'TESTKANO', party: 'NNPP', seat: 'governorship', seatArea: '19', seatAreaName: 'Kano', domains: ['kano.test.example'] });
    expect(d.coverage).toEqual([{ level: 'state', area_code: '19', name: 'Kano' }]);
    expect(d.elections.map((e: any) => e.purpose).sort()).toEqual(['baseline', 'live']);
    expect(d.limits.topup_daily_cap_ngn).toBe(50000000);
    const queues = await ds.query(`select kind, state_code, name from public.queues where tenant_id = $1 order by kind`, [r.body.id]);
    expect(queues.map((q: any) => q.kind)).toEqual(['helpdesk', 'legal', 'security', 'state']);
    expect(queues.find((q: any) => q.kind === 'state')).toMatchObject({ state_code: '19', name: 'Kano room' });

    // The admin's invite link works on the client's dashboard sign-in
    const accepted = await http.post(api('/auth/invite/accept')).send({ token: r.body.invites[0].inviteToken, password: 'client admin password' }).expect(200);
    expect(accepted.body.email).toBe('admin@client.test');
    const login = await http.post(api('/auth/login')).send({ email: 'admin@client.test', password: 'client admin password', tenantId: r.body.id }).expect(200);
    expect(login.body.session.membership.role).toBe('admin');

    // A domain belongs to one client
    const other = await http.post(api('/platform/clients')).set(as(owner))
      .send({ ...body, name: 'Other', admins: [{ fullName: 'Other Admin', email: 'other@client.test', phone: '08031110002' }], coordinators: [] }).expect(409);
    expect(other.body.message).toContain('kano.test.example');

    // Changes and suspension are logged against the client
    await http.patch(api(`/platform/clients/${r.body.id}`)).set(as(owner)).send({ limits: { topup_daily_cap_ngn: 1000000 } }).expect(200);
    await http.patch(api(`/platform/clients/${r.body.id}`)).set(as(owner)).send({ status: 'suspended' }).expect(200);
    const log = (await http.get(api('/platform/audit')).set(as(owner)).query({ client: r.body.id }).expect(200)).body.map((a: any) => a.action);
    expect(log).toEqual(['client.suspended', 'client.update', 'client.onboard']);
    const [t] = await ds.query(`select settings->>'topup_daily_cap_ngn' as cap, settings->>'brand' as brand from public.tenants where id = $1`, [r.body.id]);
    expect(t).toEqual({ cap: '1000000', brand: 'TESTKANO' });
  });

  it('a senate client covers its district\'s LGAs and takes LGA coordinators there only', async () => {
    await ds.query(`insert into public.senatorial_districts (code, state_code, name) values ('19-SD1', '19', 'Kano Central') on conflict do nothing`);
    await ds.query(`update public.lgas set senatorial_code = '19-SD1' where code = '19-28'`);
    const base = {
      name: 'Senate client', brand: 'SEN', candidateName: 'B. Candidate', party: 'APC', seat: 'senate', seatArea: '19-SD1', liveElectionId: LIVE,
      admins: [{ fullName: 'Sen Admin', email: 'sen@client.test', phone: '08031110003' }],
    };
    await http.post(api('/platform/clients')).set(as(owner))
      .send({ ...base, coordinators: [{ fullName: 'Wrong LGA', phone: '08031112240', level: 'lga', areaCode: '19-29' }] }).expect(400);
    const r = await http.post(api('/platform/clients')).set(as(owner))
      .send({ ...base, coordinators: [{ fullName: 'Right LGA', phone: '08031112240', level: 'lga', areaCode: '19-28' }] }).expect(201);
    const d = (await http.get(api(`/platform/clients/${r.body.id}`)).set(as(owner)).expect(200)).body;
    expect(d.coverage.map((c: any) => c.area_code)).toEqual(['19-28']);
    expect(d.people.find((p: any) => p.role === 'admin')).toMatchObject({ level: 'state', area_code: '19' });
  });

  it('support access: on a client\'s dashboard, or from the console\'s one-time link; an admin there, hidden and logged', async () => {
    const o = await signUp('owner2@rumfa.test');
    const ALAWA = 'a1a1a1a1-0000-4000-8000-000000000001';
    // On a client's own dashboard (it sends its client id): straight in as that client's admin
    await http.post(api('/auth/login')).send({ email: 'owner2@rumfa.test', password: 'wrong password', tenantId: ALAWA }).expect(401);
    const l = await http.post(api('/auth/login')).send({ email: 'owner2@rumfa.test', password: o.password, tenantId: ALAWA }).expect(200);
    const tok = l.body.session.accessToken;
    expect(l.body.session.membership).toMatchObject({ tid: ALAWA, role: 'admin', level: 'national', area: 'NG' });
    await http.get(api('/settings')).set(as(tok)).expect(200);
    // Hidden from the client's people; logged in the console
    const people = (await http.get(api('/people')).set(as(tok)).expect(200)).body;
    expect(people.some((p: any) => p.full_name.startsWith('Rumfa support'))).toBe(false);
    const log = (await http.get(api('/platform/audit')).set(as(owner)).query({ client: ALAWA }).expect(200)).body;
    expect(log[0]).toMatchObject({ action: 'support.enter', client: 'ALAWA (dev)', details: { via: 'dashboard sign-in' } });

    // From the console: a one-time ticket for any client, used once on its dashboard
    const op = await http.post(api(`/platform/clients/${ALAWA}/open`)).set(as(o.access)).expect(201);
    expect(op.body.ticket).toBeTruthy();
    const t = await http.post(api('/auth/support/ticket')).send({ ticket: op.body.ticket }).expect(200);
    expect(t.body.session.membership).toMatchObject({ tid: ALAWA, role: 'admin' });
    await http.post(api('/auth/support/ticket')).send({ ticket: op.body.ticket }).expect(401); // works once
    const old = await http.post(api(`/platform/clients/${ALAWA}/open`)).set(as(o.access)).expect(201);
    await ds.query(`update public.platform_support_tickets set expires_at = now() - interval '1 second' where used_at is null`);
    await http.post(api('/auth/support/ticket')).send({ ticket: old.body.ticket }).expect(401); // expired
    // Always the same support membership
    const [{ n }] = await ds.query(`select count(*)::int as n from public.volunteers where tenant_id = $1 and platform_staff_id is not null`, [ALAWA]);
    expect(n).toBe(1);

    // Support-role staff can neither open clients nor sign in on a client's dashboard
    const sp = await signUp('support2@rumfa.test', 'support');
    await http.post(api(`/platform/clients/${ALAWA}/open`)).set(as(sp.access)).expect(403);
    await http.post(api('/auth/login')).send({ email: 'support2@rumfa.test', password: sp.password, tenantId: ALAWA }).expect(403);
  });

  it('places: browse with counts, correct names, registered voters from a CSV, IReV import in the background', async () => {
    const ng = (await http.get(api('/platform/places/browse')).set(as(owner)).expect(200)).body;
    const kano = ng.items.find((x: any) => x.code === '19');
    expect(kano).toMatchObject({ name: 'Kano', zone: 'NW' });
    expect(kano.units).toBeGreaterThan(0);
    const st = (await http.get(api('/platform/places/browse')).set(as(owner)).query({ parent: '19' }).expect(200)).body;
    expect(st.breadcrumb.map((b: any) => b.name)).toEqual(['Nigeria', 'Kano']);
    const [w] = await ds.query(`select code from public.wards where lga_code = '19-28' order by code limit 1`);
    const units = (await http.get(api('/platform/places/browse')).set(as(owner)).query({ parent: w.code }).expect(200)).body.items;
    expect(units.length).toBeGreaterThan(0);

    // Names: corrected and logged; a state's zone and IReV number too
    await http.patch(api(`/platform/places/${w.code}`)).set(as(owner)).send({ name: 'Renamed Ward' }).expect(200);
    expect((await ds.query(`select name from public.wards where code = $1`, [w.code]))[0].name).toBe('Renamed Ward');
    await http.patch(api(`/platform/places/${w.code}`)).set(as(owner)).send({ zone: 'NW' }).expect(400);
    await http.patch(api('/platform/places/19')).set(as(owner)).send({ irevStateNo: 20 }).expect(200);

    // Registered voters: codes in either form; unknown codes and bad lines are reported, not saved
    const [u1, u2] = units;
    const csv = `pu_code,registered_voters\n${u1.code},812\n${u2.code.replace(/-/g, '/')},"1,204"\n99-99-99-999,10\n${u1.code},lots\n`;
    const v = (await http.post(api('/platform/places/registered-voters')).set(as(owner)).send({ csv }).expect(201)).body;
    expect(v).toMatchObject({ updated: 2, unknownCount: 1, badCount: 1 });
    const saved = await ds.query(`select code, registered_voters from public.polling_units where code = any($1) order by code`, [[u1.code, u2.code]]);
    expect(saved.map((x: any) => x.registered_voters).sort()).toEqual([1204, 812].sort());
    await http.post(api('/platform/places/registered-voters')).set(as(owner)).send({ csv: 'a,b\n1,2\n' }).expect(400);

    // IReV import runs in the background (IReV stubbed: it knows no LGAs for this state)
    const realFetch = global.fetch;
    global.fetch = (async (url: any, init: any) => String(url).includes('/lga/state/')
      ? new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : realFetch(url, init)) as any;
    try {
      const j = (await http.post(api('/platform/jobs/geography')).set(as(owner)).send({ states: ['19'], noUnits: true }).expect(201)).body;
      let job: any;
      for (let i = 0; i < 40; i++) {
        job = (await http.get(api(`/platform/jobs/${j.id}`)).set(as(owner)).expect(200)).body;
        if (job.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(job).toMatchObject({ status: 'done', kind: 'geography' });
      expect(job.log.join(' ')).toContain('No LGAs for Kano');
    } finally { global.fetch = realFetch; }
  });

  it('seat change: preview first; then the area follows, admins move, a room desk is added, others are only counted', async () => {
    await ds.query(`insert into public.senatorial_districts (code, state_code, name) values ('19-SD1', '19', 'Kano Central') on conflict do nothing`);
    await ds.query(`update public.lgas set senatorial_code = '19-SD1' where code = '19-28'`);
    const r = await http.post(api('/platform/clients')).set(as(owner)).send({
      name: 'Seat change client', brand: 'SEATCH', candidateName: 'C. Candidate', party: 'APC', seat: 'governorship', seatArea: '19', liveElectionId: LIVE,
      admins: [{ fullName: 'Seat Admin', email: 'seat@client.test', phone: '08031110009' }],
      coordinators: [{ fullName: 'Other LGA', phone: '08031110010', level: 'lga', areaCode: '19-29' }],
    }).expect(201);
    const id = r.body.id;
    const pv = (await http.post(api(`/platform/clients/${id}/seat`)).set(as(owner)).send({ seat: 'senate', seatArea: '19-SD1' }).expect(201)).body;
    expect(pv.changed).toBeUndefined();
    expect(pv.preview).toMatchObject({ adminsMoved: 1, outside: { n: 1, coordinators: 1 } });
    expect((await http.get(api(`/platform/clients/${id}`)).set(as(owner)).expect(200)).body.seat).toBe('governorship'); // nothing changed yet
    await http.post(api(`/platform/clients/${id}/seat`)).set(as(owner)).send({ seat: 'senate', seatArea: '19-28' }).expect(400);
    await http.post(api(`/platform/clients/${id}/seat`)).set(as(owner)).send({ seat: 'senate', seatArea: '19-SD1', confirm: true }).expect(201);
    const d = (await http.get(api(`/platform/clients/${id}`)).set(as(owner)).expect(200)).body;
    expect(d).toMatchObject({ seat: 'senate', seatArea: '19-SD1' });
    expect(d.coverage.map((c: any) => c.area_code)).toEqual(['19-28']);
    expect(d.people.find((p: any) => p.role === 'coordinator')).toMatchObject({ area_code: '19-29' }); // left where they were
    // Back to President: a national room is added once, admins move to Nigeria
    await http.post(api(`/platform/clients/${id}/seat`)).set(as(owner)).send({ seat: 'presidential', seatArea: 'NG', confirm: true }).expect(201);
    await http.post(api(`/platform/clients/${id}/seat`)).set(as(owner)).send({ seat: 'presidential', seatArea: 'NG', confirm: true }).expect(201);
    const queues = await ds.query(`select kind from public.queues where tenant_id = $1 and kind in ('national', 'state') order by kind`, [id]);
    expect(queues.map((q: any) => q.kind)).toEqual(['national', 'state']);
    const [admin] = await ds.query(`select level, area_code from public.volunteers where tenant_id = $1 and role = 'admin'`, [id]);
    expect(admin).toEqual({ level: 'national', area_code: 'NG' });
    const log = (await http.get(api('/platform/audit')).set(as(owner)).query({ client: id }).expect(200)).body.map((a: any) => a.action);
    expect(log.filter((x: string) => x === 'client.seat')).toHaveLength(3);
  });

  it('constituencies: loaded from IReV state by state; a House of Reps client covers its wards\' LGAs', async () => {
    // Kano's wards in 19-28 belong to IReV federal constituency 164 and state constituency 489
    await ds.query(`update public.wards set federal_constituency = '164', state_constituency = '489' where lga_code = '19-28'`);
    await ds.query(`update public.states set irev_state_no = 20 where code = '19'`);
    const realFetch = global.fetch;
    global.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (!u.includes('/elections?election_type=')) return realFetch(url, init);
      const reps = u.includes('5f129a04df41d910dcdc1d53');
      const data = u.includes('state_id=20') ? [{ state: { code: '19' }, domain: reps
        ? { name: 'BEBEJI/KIRU', code: 'fc/168/kn', federal_constituency_id: 164 }
        : { name: 'SHANONO/BAGWAI', code: 'SC/486/KN', state_constituency_id: 489 } }] : [];
      return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    try {
      const j = (await http.post(api('/platform/jobs/constituencies')).set(as(owner)).send({ states: ['19'] }).expect(201)).body;
      let job: any;
      for (let i = 0; i < 40; i++) {
        job = (await http.get(api(`/platform/jobs/${j.id}`)).set(as(owner)).expect(200)).body;
        if (job.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(job).toMatchObject({ status: 'done', progress: { federal: 1, assembly: 1 } });
    } finally { global.fetch = realFetch; }
    const places = (await http.get(api('/platform/places')).set(as(owner)).query({ parent: '19' }).expect(200)).body;
    expect(places.constituencies).toEqual([
      { code: '19-FC164', name: 'Bebeji/Kiru', kind: 'federal', lgas: ['19-28'] },
      { code: '19-SC489', name: 'Shanono/Bagwai', kind: 'state', lgas: ['19-28'] },
    ]);
    const base = { name: 'Reps client', brand: 'REPS', candidateName: 'D. Candidate', party: 'NNPP', liveElectionId: LIVE,
      admins: [{ fullName: 'Reps Admin', email: 'reps@client.test', phone: '08031110011' }] };
    await http.post(api('/platform/clients')).set(as(owner)).send({ ...base, seat: 'reps', seatArea: '19-SC489', coordinators: [] }).expect(400);
    await http.post(api('/platform/clients')).set(as(owner))
      .send({ ...base, seat: 'reps', seatArea: '19-FC164', coordinators: [{ fullName: 'Outside', phone: '08031110012', level: 'lga', areaCode: '19-29' }] }).expect(400);
    const r = await http.post(api('/platform/clients')).set(as(owner))
      .send({ ...base, seat: 'reps', seatArea: '19-FC164', coordinators: [{ fullName: 'Inside', phone: '08031110012', level: 'lga', areaCode: '19-28' }] }).expect(201);
    const d = (await http.get(api(`/platform/clients/${r.body.id}`)).set(as(owner)).expect(200)).body;
    expect(d).toMatchObject({ seat: 'reps', seatArea: '19-FC164', seatAreaName: 'Bebeji/Kiru' });
    expect(d.coverage.map((c: any) => c.area_code)).toEqual(['19-28']);
  });

  it('name matches: added for outline files (used by import:boundaries), refused when the names already match', async () => {
    await http.post(api('/platform/places/aliases')).set(as(owner)).send({ level: 'lga', fromName: 'Mopa Moro', toName: 'Mopa-Muro' }).expect(201);
    await http.post(api('/platform/places/aliases')).set(as(owner)).send({ level: 'lga', fromName: 'Dev-LGA-B', toName: 'dev lga b' }).expect(400);
    const al = (await http.get(api('/platform/places/aliases')).set(as(owner)).expect(200)).body;
    // The seeded matches are in the database (32 northern, 41 southern), so this one replaced the seeded "Mopa Moro"
    expect(al.added.length).toBe(73);
    expect(al.added.find((a: any) => a.from_key === 'mopamoro')).toMatchObject({ to_key: 'mopamuro', to_name: 'Mopa-Muro' });
    expect(al.added.find((a: any) => a.from_key === 'kogikk')).toMatchObject({ level: 'lga', to_key: 'kogi' });
    await http.delete(api('/platform/places/aliases/lga/mopamoro')).set(as(owner)).expect(204);
    expect((await http.get(api('/platform/places/aliases')).set(as(owner)).expect(200)).body.added).toHaveLength(72);
  });

  it('refresh outlines: from the files kept with the API, for one state (no state outline or zones then)', async () => {
    const before = await ds.query(`select code, updated_at from public.area_shapes where code in ('19', 'Z-NW')`);
    const j = (await http.post(api('/platform/jobs/outlines')).set(as(owner)).send({ state: '19' }).expect(201)).body;
    let job: any;
    for (let i = 0; i < 120; i++) {
      job = (await http.get(api(`/platform/jobs/${j.id}`)).set(as(owner)).expect(200)).body;
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(job.status).toBe('done');
    expect(Object.keys(job.progress.done).sort()).toEqual(['lga', 'linked', 'senatorial', 'ward']);
    expect(job.progress.done.senatorial).toBe(3); // Kano's three districts, and no other state's
    const districts = await ds.query(`select code from public.senatorial_districts where code like '19-%' order by code`);
    expect(districts.map((d: any) => d.code)).toEqual(['19-SD1', '19-SD2', '19-SD3']);
    const after = await ds.query(`select code, updated_at from public.area_shapes where code in ('19', 'Z-NW')`);
    expect(after).toEqual(before); // the state's outline and the zones are left alone
    await http.post(api('/platform/jobs/outlines')).set(as(owner)).send({ state: 'KN' }).expect(400);
  }, 60_000);

  it('load state: places from IReV, constituencies and outlines in one go, and the state ends up ready', async () => {
    const [kat] = await ds.query(`select irev_state_no from public.states where code = '20'`);
    await ds.query(`update public.states set lga_count = 1 where code = '20'`); // the stubbed IReV below has one LGA
    const before = (await http.get(api('/platform/places/browse')).set(as(owner)).expect(200)).body.items.find((x: any) => x.code === '20');
    expect(before).toMatchObject({ status: 'not_loaded', lgas: 0 });
    const realFetch = global.fetch;
    let irevCalls = 0;
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    global.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes(`/lga/state/${kat.irev_state_no}`)) irevCalls++;
      if (u.includes(`/lga/state/${kat.irev_state_no}`)) return json({ data: [{ lga: { _id: 'lga-bakori', name: 'BAKORI', code: '3' },
        wards: [{ _id: 'ward-1', name: 'BAKORI A', code: '1', federal_constituency_id: 500, state_constituency_id: 900 }] }] });
      if (u.includes('/pus?ward=ward-1')) return json({ data: [{ _id: 'pu-1', pu_code: '20/03/01/001', name: 'UNIT ONE' }, { _id: 'pu-2', pu_code: '20/03/01/002', name: 'UNIT TWO' }] });
      if (u.includes('/elections?election_type=') && u.includes(`state_id=${kat.irev_state_no}`)) {
        return json({ data: [u.includes('5f129a04df41d910dcdc1d53')
          ? { state: { code: '20' }, domain: { name: 'BAKORI/FUNTUA', code: 'fc/1/kt', federal_constituency_id: 500 } }
          : { state: { code: '20' }, domain: { name: 'BAKORI', code: 'SC/1/KT', state_constituency_id: 900 } }] });
      }
      return realFetch(url, init);
    }) as any;
    try {
      const j = (await http.post(api('/platform/jobs/states')).set(as(owner)).send({ states: ['20'] }).expect(201)).body;
      expect(j.states).toEqual(['Katsina']);
      await http.post(api('/platform/jobs/states')).set(as(owner)).send({ states: ['21'] }).expect(409); // one load at a time
      let job: any;
      for (let i = 0; i < 160; i++) {
        job = (await http.get(api(`/platform/jobs/${j.id}`)).set(as(owner)).expect(200)).body;
        if (job.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(job).toMatchObject({ status: 'done', progress: { statesDone: 1, ready: 1, failed: [] } });
      expect(job.log.at(-1)).toContain('Katsina: 1 LGAs, 1 wards, 2 units · 1 Reps, 1 Assembly · outlines 1/1 · ready');
      // A state with fewer LGAs than it has (a load cut short) needs attention, and "only what's missing" loads its places again
      await ds.query(`update public.states set lga_count = 2 where code = '20'`);
      const partial = (await http.get(api('/platform/places/browse')).set(as(owner)).expect(200)).body.items.find((x: any) => x.code === '20');
      expect(partial).toMatchObject({ status: 'attention', issues: ['Only 1 of 2 LGAs loaded (load cut short)'] });
      const before = irevCalls;
      const m = (await http.post(api('/platform/jobs/states')).set(as(owner)).send({ states: ['20'], mode: 'missing' }).expect(201)).body;
      for (let i = 0; i < 160; i++) {
        job = (await http.get(api(`/platform/jobs/${m.id}`)).set(as(owner)).expect(200)).body;
        if (job.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(job.status).toBe('done');
      expect(irevCalls).toBeGreaterThan(before);
      expect(job.log.at(-1)).not.toContain('skipped (already loaded): places');
      await ds.query(`update public.states set lga_count = 1 where code = '20'`);
    } finally { global.fetch = realFetch; }
    const after = (await http.get(api('/platform/places/browse')).set(as(owner)).expect(200)).body.items.find((x: any) => x.code === '20');
    expect(after).toMatchObject({ status: 'ready', issues: [], lgas: 1, units: 2, federal: 1, assembly: 1, lga_outlines: 1, outline: true });
    // Again, skipping what is loaded: nothing is fetched (fetch is real again, so IReV would be called if it were)
    const k = (await http.post(api('/platform/jobs/states')).set(as(owner)).send({ states: ['20'], mode: 'missing' }).expect(201)).body;
    let again: any;
    for (let i = 0; i < 80; i++) {
      again = (await http.get(api(`/platform/jobs/${k.id}`)).set(as(owner)).expect(200)).body;
      if (again.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(again).toMatchObject({ status: 'done', params: { mode: 'missing' }, progress: { ready: 1 } });
    expect(again.log.at(-1)).toContain('ready · skipped (already loaded): places, constituencies, outlines');
    // Saved data only: no IReV, outlines rebuilt from the files for the saved places
    const l = (await http.post(api('/platform/jobs/states')).set(as(owner)).send({ states: ['20'], mode: 'local' }).expect(201)).body;
    for (let i = 0; i < 80; i++) {
      again = (await http.get(api(`/platform/jobs/${l.id}`)).set(as(owner)).expect(200)).body;
      if (again.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(again).toMatchObject({ status: 'done', params: { mode: 'local' }, progress: { ready: 1, failed: [] } });
    expect(again.log.at(-1)).toContain('outlines 1/1 · ready · from saved data, no IReV');
    await http.post(api('/platform/jobs/states')).set(as(owner)).send({ states: ['21'], mode: 'local' }).expect(201); // no places: it reports, not downloads
  }, 60_000);

  it('import history: cleared by staff, finished loads only', async () => {
    for (let i = 0; i < 80; i++) { // let a load started by an earlier test finish first
      if (!(await http.get(api('/platform/jobs')).set(as(owner)).expect(200)).body.some((j: any) => j.status === 'running')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await http.get(api('/platform/jobs')).set(as(owner)).expect(200)).body.length).toBeGreaterThan(0);
    const r = (await http.delete(api('/platform/jobs')).set(as(owner)).expect(200)).body;
    expect(r.removed).toBeGreaterThan(0);
    const left = (await http.get(api('/platform/jobs')).set(as(owner)).expect(200)).body;
    expect(left.every((j: any) => j.status === 'running')).toBe(true);
  });

  it('add-ons: voice outreach and airtime are off until switched on in the console, per client', async () => {
    const [{ tenant_id: tid }] = await ds.query(`select tenant_id from public.volunteers where id = $1`, [ADMIN]);
    await ds.query(`update public.tenants set settings = settings - 'addons' where id = $1`, [tid]);
    await http.get(api('/voice/campaigns')).set(as(clientAdmin)).expect(403);
    await http.get(api('/topups/plans')).set(as(clientAdmin)).expect(403);
    await http.patch(api(`/platform/clients/${tid}`)).set(as(owner)).send({ addons: { voice: true } }).expect(200);
    expect((await http.get(api(`/platform/clients/${tid}`)).set(as(owner)).expect(200)).body.addons).toEqual({ voice: true, airtime: false });
    expect((await http.get(api('/me/context')).set(as(clientAdmin)).expect(200)).body.addons).toEqual({ voice: true, airtime: false });
    await http.get(api('/voice/campaigns')).set(as(clientAdmin)).expect(200);
    await http.get(api('/topups/plans')).set(as(clientAdmin)).expect(403);
    await http.patch(api(`/platform/clients/${tid}`)).set(as(owner)).send({ addons: { airtime: true } }).expect(200);
    await http.get(api('/topups/plans')).set(as(clientAdmin)).expect(200);
    expect((await http.get(api('/platform/clients')).set(as(owner)).expect(200)).body.find((c: any) => c.id === tid).addons).toEqual({ voice: true, airtime: true });
    await http.patch(api(`/platform/clients/${tid}`)).set(as(owner)).send({ addons: { voice: false } }).expect(200);
    await http.get(api('/voice/campaigns')).set(as(clientAdmin)).expect(403);
  });

  it('authority contacts: official ones added once in the console show on every client\'s dashboard', async () => {
    const r = (await http.get(api('/platform/contacts')).set(as(owner)).expect(200)).body;
    expect(r.agencies).toContain('INEC');
    await http.post(api('/platform/contacts')).set(as(owner)).send({ agency: 'Police', title: 'State Command', level: 'state', areaCode: '19-28' }).expect(400); // not a state
    await http.post(api('/platform/contacts')).set(as(owner)).send({ agency: 'Police', title: 'State Command', level: 'state', areaCode: '19' }).expect(400); // no way to reach them
    await http.post(api('/platform/contacts')).set(as(owner)).send({ agency: 'Police', title: 'State Command', level: 'state', areaCode: '19', phone: '12' }).expect(400);
    const c = (await http.post(api('/platform/contacts')).set(as(owner))
      .send({ agency: 'Police', title: 'Kano State Command', phone: '0803 222 3344', level: 'state', areaCode: '19' }).expect(201)).body;
    const kano = (await http.get(api('/platform/contacts')).set(as(owner)).query({ state: '19' }).expect(200)).body.items;
    expect(kano.find((k: any) => k.id === c.id)).toMatchObject({ phone: '+2348032223344', status: 'verified', area_name: 'Kano', source_type: 'official' });
    expect((await http.get(api('/platform/contacts')).set(as(owner)).query({ state: '20' }).expect(200)).body.items.some((k: any) => k.id === c.id)).toBe(false);
    // On the client's dashboard, as an official one
    expect((await http.get(api('/contacts')).set(as(clientAdmin)).expect(200)).body.find((k: any) => k.id === c.id)).toMatchObject({ tenant_id: null, agency: 'Police' });
    await http.patch(api(`/platform/contacts/${c.id}`)).set(as(owner)).send({ title: 'Kano Police Command', status: 'pending', email: 'pr@police.test' }).expect(200);
    expect((await http.get(api('/platform/contacts')).set(as(owner)).expect(200)).body.items.find((k: any) => k.id === c.id))
      .toMatchObject({ title: 'Kano Police Command', status: 'pending', email: 'pr@police.test', phone: '+2348032223344' });
    // A client's own contact is not the console's to change
    const [own] = await ds.query(`insert into public.authority_contacts (tenant_id, agency, title, phone, level, area_code, source_type)
      select tenant_id, 'Police', 'DPO', '+2348000000001', 'lga', '19-28', 'coordinator' from public.volunteers where id = $1 returning id`, [ADMIN]);
    await http.patch(api(`/platform/contacts/${own.id}`)).set(as(owner)).send({ title: 'Changed' }).expect(404);
    await http.delete(api(`/platform/contacts/${c.id}`)).set(as(owner)).expect(204);
    expect((await http.get(api('/contacts')).set(as(clientAdmin)).expect(200)).body.some((k: any) => k.id === c.id)).toBe(false);
  });

  it('staff: owners invite and manage staff; support cannot change clients; suspended staff lose their session', async () => {
    const inv = await http.post(api('/platform/staff')).set(as(owner)).send({ email: 'helper@rumfa.test', fullName: 'Helper', role: 'support' }).expect(201);
    expect(inv.body.inviteToken).toBeTruthy();
    const sup = await signUp('support@rumfa.test', 'support');
    await http.get(api('/platform/clients')).set(as(sup.access)).expect(200);
    await http.post(api('/platform/parties')).set(as(sup.access)).send({ acronym: 'NOPE', name: 'Nope' }).expect(403);
    await http.post(api('/platform/staff')).set(as(sup.access)).send({ email: 'x@rumfa.test', fullName: 'X', role: 'owner' }).expect(403);
    const [me] = (await http.get(api('/platform/staff')).set(as(owner)).expect(200)).body.filter((s: any) => s.email === 'owner@rumfa.test');
    await http.patch(api(`/platform/staff/${me.id}`)).set(as(owner)).send({ role: 'staff' }).expect(403); // not your own owner access
    const [s] = (await http.get(api('/platform/staff')).set(as(owner)).expect(200)).body.filter((x: any) => x.email === 'support@rumfa.test');
    await http.patch(api(`/platform/staff/${s.id}`)).set(as(owner)).send({ status: 'suspended' }).expect(200);
    await http.post(api('/platform/auth/refresh')).send({ refreshToken: sup.refresh }).expect(401);
    await http.post(api('/platform/auth/login')).send({ email: 'support@rumfa.test', password: sup.password }).expect(401);
  });
});
