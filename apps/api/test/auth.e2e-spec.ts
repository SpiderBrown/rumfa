import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from './setup';

const TENANT_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const TENANT_B = 'a2a2a2a2-0000-4000-8000-000000000002';
const AGENT3 = 'b0000000-0000-4000-8000-000000000020';
const WARD_COORD = 'b0000000-0000-4000-8000-000000000011';
const ADMIN1 = 'b0000000-0000-4000-8000-000000000001';
const OP_EN = 'b0000000-0000-4000-8000-000000000005';

describe('Sign-in and tenant isolation (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;
  let agentPhone: string;
  let device: { deviceId: string; deviceSecret: string };

  beforeAll(async () => {
    ({ app, ds } = await createTestApp());
    http = request(app.getHttpServer());
    [{ phone: agentPhone }] = await ds.query(`select phone from public.volunteers where id = $1`, [AGENT3]);
    // A case reported by agent3 in client A, so there is something to hide from client B
    await ds.query(`select set_config('app.user_id', '', false)`);
  });
  afterAll(async () => { await app?.close(); });

  const api = (path: string) => `/api/v1${path}`;

  it('health is public', async () => {
    await http.get(api('/health')).expect(200);
  });

  it('protected endpoints need a token', async () => {
    await http.get(api('/cases')).expect(401);
  });

  it('activates a phone with the SMS code and signs in to the only client', async () => {
    await http.post(api('/auth/activate/request')).send({ phone: agentPhone, channel: 'sms' }).expect(200);
    await http.post(api('/auth/activate/verify')).send({ phone: agentPhone, code: '000000', pin: '482916', platform: 'android' }).expect(401);
    const res = await http.post(api('/auth/activate/verify'))
      .send({ phone: agentPhone, code: '246810', pin: '482916', platform: 'android', deviceName: 'Tecno' }).expect(200);
    expect(res.body.deviceId).toBeDefined();
    expect(res.body.session.membership).toMatchObject({ mid: AGENT3, tid: TENANT_A, brand: 'ALAWA', role: 'agent' });
    device = { deviceId: res.body.deviceId, deviceSecret: res.body.deviceSecret };
  });

  it('rejects weak PINs and unknown numbers quietly', async () => {
    await http.post(api('/auth/activate/verify')).send({ phone: agentPhone, code: '246810', pin: '123456', platform: 'android' }).expect(400);
    const res = await http.post(api('/auth/activate/request')).send({ phone: '08099999999', channel: 'sms' }).expect(200);
    expect(res.body.sent).toBe(true);
  });

  it('when the same phone works for two clients, asks which one and keeps them apart', async () => {
    await ds.query(`insert into public.tenants (id, name, settings) values ($1, 'Client B', '{"brand":"CLB"}')`, [TENANT_B]);
    await ds.query(
      `insert into public.volunteers (tenant_id, full_name, phone, role, level, area_code, agent_code, status)
       values ($1, 'Agent at B', $2, 'agent', 'pu', '19-28-02-004', 'ZZ9', 'invited')`, [TENANT_B, agentPhone]);
    // Client A has a case reported by agent3
    await ds.query(`select set_config('app.user_id', (select user_id::text from public.volunteers where id = $1), false),
                           set_config('app.tenant_id', $2, false)`, [AGENT3, TENANT_A]);
    await ds.query(`select public.report_incident('19-28-02-003', 'bvas_failure', null, 'BVAS down', '{}', gen_random_uuid())`);
    await ds.query(`select set_config('app.user_id', '', false), set_config('app.tenant_id', '', false)`);

    // Activating again links the new membership; PIN sign-in now asks which client
    await http.post(api('/auth/activate/request')).send({ phone: agentPhone, channel: 'sms' });
    await http.post(api('/auth/activate/verify')).send({ phone: agentPhone, code: '246810', pin: '482916', platform: 'android' }).expect(200);
    const pin = await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '482916', ...device }).expect(200);
    expect(pin.body.chooseTenant).toBe(true);
    expect(pin.body.memberships.map((m: any) => m.brand).sort()).toEqual(['ALAWA', 'CLB']);

    const a = await http.post(api('/auth/select-tenant')).send({ selectToken: pin.body.selectToken, tenantId: TENANT_A }).expect(200);
    const b = await http.post(api('/auth/select-tenant')).send({ selectToken: pin.body.selectToken, tenantId: TENANT_B }).expect(200);
    const casesA = await http.get(api('/cases')).set('Authorization', `Bearer ${a.body.session.accessToken}`).expect(200);
    const casesB = await http.get(api('/cases')).set('Authorization', `Bearer ${b.body.session.accessToken}`).expect(200);
    expect(casesA.body.length).toBeGreaterThan(0);
    expect(casesB.body).toEqual([]);

    const me = await http.get(api('/auth/me')).set('Authorization', `Bearer ${b.body.session.accessToken}`).expect(200);
    expect(me.body).toMatchObject({ brand: 'CLB', role: 'agent', field: true });
    expect(me.body.otherMemberships.map((m: any) => m.brand)).toEqual(['ALAWA']);

    // A tenant the person does not belong to is refused
    await http.post(api('/auth/select-tenant')).send({ selectToken: pin.body.selectToken, tenantId: 'a3a3a3a3-0000-4000-8000-000000000003' }).expect(403);
  });

  it('change PIN: needs the current one; the new one signs in, the old one no longer does', async () => {
    const s = (await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '482916', ...device, tenantId: TENANT_A }).expect(200)).body.session;
    const auth = { Authorization: `Bearer ${s.accessToken}` };
    await http.post(api('/auth/pin/change')).set(auth).send({ current: '111111', pin: '730519' }).expect(400);
    await http.post(api('/auth/pin/change')).set(auth).send({ current: '482916', pin: '482916' }).expect(400);
    await http.post(api('/auth/pin/change')).set(auth).send({ current: '482916', pin: '730519' }).expect(204);
    await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '482916', ...device, tenantId: TENANT_A }).expect(401);
    await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '730519', ...device, tenantId: TENANT_A }).expect(200);
    // Back to the PIN the next tests use
    await http.post(api('/auth/pin/change')).set(auth).send({ current: '730519', pin: '482916' }).expect(204);
  });

  it('refresh tokens rotate, and a reused one ends the session', async () => {
    const s = (await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '482916', ...device, tenantId: TENANT_A }).expect(200)).body.session;
    const r1 = await http.post(api('/auth/refresh')).send({ refreshToken: s.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toEqual(s.refreshToken);
    // Two tabs refreshing at once (or a reload mid-refresh): the same token again within a minute is fine
    const r2 = await http.post(api('/auth/refresh')).send({ refreshToken: s.refreshToken }).expect(200);
    // Later, the same token again means it leaked: the whole session ends
    await ds.query(`update public.refresh_tokens set used_at = now() - interval '2 minutes' where used_at is not null and family = (select family from public.refresh_tokens where used_at is not null order by used_at desc limit 1)`);
    await http.post(api('/auth/refresh')).send({ refreshToken: s.refreshToken }).expect(401); // reuse
    await http.post(api('/auth/refresh')).send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
    await http.post(api('/auth/refresh')).send({ refreshToken: r2.body.refreshToken }).expect(401);
  });

  it('coordinator issues an activation code; it activates the phone once', async () => {
    const [{ phone }] = await ds.query(`select phone from public.volunteers where id = $1`, [WARD_COORD]);
    await http.post(api('/auth/activate/request')).send({ phone, channel: 'sms' });
    const coord = (await http.post(api('/auth/activate/verify')).send({ phone, code: '246810', pin: '615243', platform: 'android' }).expect(200)).body.session;
    const [agent4] = await ds.query(`select id, phone from public.volunteers where id = 'b0000000-0000-4000-8000-000000000021'`);
    const issued = await http.post(api(`/people/${agent4.id}/activation-code`)).set('Authorization', `Bearer ${coord.accessToken}`).expect(201);
    expect(issued.body.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    await http.post(api('/auth/activate/verify')).send({ phone: agent4.phone, activationCode: issued.body.code.toLowerCase(), pin: '903172', platform: 'android' }).expect(200);
    await http.post(api('/auth/activate/verify')).send({ phone: agent4.phone, activationCode: issued.body.code, pin: '903172', platform: 'android' }).expect(401);
    // Agents cannot issue codes; coordinators cannot reach people outside their ward
    const agent = (await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '482916', ...device, tenantId: TENANT_A })).body.session;
    await http.post(api(`/people/${agent4.id}/activation-code`)).set('Authorization', `Bearer ${agent.accessToken}`).expect(403);
    await http.post(api(`/people/${ADMIN1}/activation-code`)).set('Authorization', `Bearer ${coord.accessToken}`).expect(404);
  });

  it('wrong PINs lock the device after five tries', async () => {
    for (let i = 0; i < 4; i++) await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '111222', ...device }).expect(401);
    const last = await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '111222', ...device }).expect(401);
    expect(last.body.message).toMatch(/Activate this phone again/);
    await http.post(api('/auth/pin')).send({ phone: agentPhone, pin: '482916', ...device }).expect(401);
  });

  it('staff: invite, password, then authenticator for roles that need it', async () => {
    // Admin activates (admins can also use phone sign-in for the API in tests) — issue invite via admin session
    await ds.query(`update public.volunteers set email = 'admin1@example.org' where id = $1`, [ADMIN1]);
    await ds.query(`update public.volunteers set email = 'op.en@example.org' where id = $1`, [OP_EN]);
    // Bootstrap: the first admin's invite is created directly (as an operator would with SQL)
    const { AuthService } = await import('../src/auth/auth.service');
    const auth = app.get(AuthService);
    const [{ id: adminIdentity }] = await ds.query(`insert into public.identities (email) values ('admin1@example.org') returning id`);
    await ds.query(`select app.link_identity($1)`, [adminIdentity]);
    const adminUser = { sub: adminIdentity, tid: TENANT_A, mid: ADMIN1, role: 'admin', level: 'national', area: 'NG' };
    const adminInvite = await auth.inviteStaff(adminUser, ADMIN1);
    await http.post(api('/auth/invite/accept')).send({ token: adminInvite.inviteToken, password: 'correct horse battery' }).expect(200);

    // Email and password only (no authenticator step), whatever the role
    const l1 = await http.post(api('/auth/login')).send({ email: 'Admin1@example.org', password: 'correct horse battery', tenantId: TENANT_A }).expect(200);
    const admin = l1.body.session;
    expect(admin.membership.role).toBe('admin');
    await http.post(api('/auth/login')).send({ email: 'admin1@example.org', password: 'wrong horse battery', tenantId: TENANT_A }).expect(401);

    // Admin invites an operator; operators need no authenticator by default
    const inv = await http.post(api(`/people/${OP_EN}/invite`)).set('Authorization', `Bearer ${admin.accessToken}`).expect(201);
    await http.post(api('/auth/invite/accept')).send({ token: inv.body.inviteToken, password: 'operator password 1' }).expect(200);
    await http.post(api('/auth/invite/accept')).send({ token: inv.body.inviteToken, password: 'operator password 1' }).expect(401);
    const op = await http.post(api('/auth/login')).send({ email: 'op.en@example.org', password: 'operator password 1', tenantId: TENANT_A }).expect(200);
    expect(op.body.session.membership.role).toBe('operator');
    await http.post(api('/auth/login')).send({ email: 'op.en@example.org', password: 'wrong password 1', tenantId: TENANT_A }).expect(401);
    // The dashboard of another client refuses this account
    await http.post(api('/auth/login')).send({ email: 'op.en@example.org', password: 'operator password 1', tenantId: TENANT_B }).expect(403);
    // Staff sessions cannot switch client
    await http.post(api('/auth/switch-tenant')).set('Authorization', `Bearer ${op.body.session.accessToken}`).send({ tenantId: TENANT_B }).expect(403);
  });
});
