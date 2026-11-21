import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { normaliseNgPhone } from '../shared';
import { Db } from '../database/db.service';
import type { AppConfig } from '../config/configuration';
import { FIELD_ROLES, STAFF_ROLES, tenantAuthSettings, type AuthUser, type Membership } from './auth.types';
import { activationCode, keyedHash, normaliseActivationCode, numericCode, randomToken, safeEqual, weakPin } from './crypto';
import { OtpSender } from './otp-sender.service';
import { MEMBERSHIP_SQL, TokensService, type Session } from './tokens.service';
import { staffArea } from '../platform/seats';

export type SignInResult =
  | { session: Session; memberships: Membership[] }
  | { chooseTenant: true; selectToken: string; memberships: Membership[] };

// Compared against when an email is unknown, so a wrong email takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class AuthService {
  private readonly cfg: AppConfig['auth'];

  constructor(private readonly db: Db, private readonly tokens: TokensService, private readonly otp: OtpSender, config: ConfigService) {
    this.cfg = config.get('auth')!;
  }

  private phone(raw: string): string {
    const p = normaliseNgPhone(raw);
    if (!p) throw new BadRequestException('Enter a Nigerian mobile number');
    return p;
  }

  private async limit(key: string, max: number, window: string, message = 'Too many attempts. Wait a few minutes and try again.') {
    const [{ ok }] = await this.db.system<{ ok: boolean }>(`select app.rate_hit($1, $2, $3::interval) as ok`, [key, max, window]);
    if (!ok) throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }

  // ---- Field users: activate a device, then phone + PIN --------------------------------------------

  async requestActivation(rawPhone: string, channel: 'sms' | 'whatsapp', ip: string) {
    const phone = this.phone(rawPhone);
    await this.limit(`otp:ip:${ip}`, 30, '1 hour');
    await this.limit(`otp:phone:${phone}`, 3, '10 minutes', 'A code was sent recently. Wait a few minutes before asking again.');
    const rows = await this.db.system<{ brand: string; settings: any }>(
      `select coalesce(t.settings->>'brand', t.name) as brand, t.settings
         from public.volunteers v join public.tenants t on t.id = v.tenant_id
        where v.phone = $1 and v.status in ('invited','active') and t.status = 'active'`,
      [phone],
    );
    const result = { sent: true, expiresInMinutes: this.cfg.otpTtlMinutes };
    if (!rows.length) return result; // same answer for unknown numbers
    if (!rows.some((r) => tenantAuthSettings(r.settings).activation.includes(channel))) {
      throw new BadRequestException(`Codes by ${channel === 'sms' ? 'SMS' : 'WhatsApp'} are not used by your organisation. Ask your coordinator for an activation code.`);
    }
    const code = this.cfg.otpMode === 'fixed' ? this.cfg.fixedOtp : numericCode(6);
    await this.db.system(
      `insert into public.otp_challenges (phone, channel, code_hash, expires_at, ip)
       values ($1, $2, $3, now() + make_interval(mins => $4), $5)`,
      [phone, channel, keyedHash(this.cfg.jwtSecret, `${phone}:${code}`), this.cfg.otpTtlMinutes, ip],
    );
    const brand = rows.length === 1 ? rows[0].brand : 'Rumfa';
    await this.otp.send(phone, channel, code, brand, this.cfg.otpTtlMinutes);
    return result;
  }

  async verifyActivation(dto: { phone: string; code?: string; activationCode?: string; pin: string; deviceName?: string; platform: string; tenantId?: string }, ip: string) {
    const phone = this.phone(dto.phone);
    if (!dto.code === !dto.activationCode) throw new BadRequestException('Enter either the code you received or an activation code');
    if (weakPin(dto.pin)) throw new BadRequestException('Choose a PIN that is harder to guess');
    await this.limit(`verify:ip:${ip}`, 60, '1 hour');
    await this.limit(`verify:phone:${phone}`, 10, '10 minutes');

    const { identityId, deviceId, deviceSecret } = await this.db.systemTx(async (q) => {
      if (dto.code) {
        const [c] = await q(
          `select * from public.otp_challenges
            where phone = $1 and consumed_at is null and expires_at > now()
            order by created_at desc limit 1 for update`,
          [phone],
        );
        if (!c || c.attempts >= 5) throw new UnauthorizedException('The code has expired. Ask for a new one.');
        if (!safeEqual(c.code_hash, keyedHash(this.cfg.jwtSecret, `${phone}:${dto.code}`))) {
          await q(`update public.otp_challenges set attempts = attempts + 1 where id = $1`, [c.id]);
          return { wrong: true } as any;
        }
        await q(`update public.otp_challenges set consumed_at = now() where id = $1`, [c.id]);
      } else {
        const [a] = await q(
          `select a.id, t.settings from public.activation_codes a
             join public.volunteers v on v.id = a.volunteer_id
             join public.tenants t on t.id = a.tenant_id
            where a.code_hash = $1 and a.used_at is null and a.expires_at > now() and v.phone = $2 and v.status in ('invited','active')
            for update of a`,
          [keyedHash(this.cfg.jwtSecret, `act:${normaliseActivationCode(dto.activationCode!)}`), phone],
        );
        if (!a || !tenantAuthSettings(a.settings).activation.includes('code')) throw new UnauthorizedException('That activation code is not valid for this number');
        await q(`update public.activation_codes set used_at = now() where id = $1`, [a.id]);
      }
      const [idn] = await q(
        `insert into public.identities (phone) values ($1)
         on conflict (phone) do update set phone = excluded.phone returning id, status`,
        [phone],
      );
      if (idn.status !== 'active') throw new ForbiddenException('This account is disabled');
      await q(`update public.identities set pin_hash = $2 where id = $1`, [idn.id, await bcrypt.hash(dto.pin, 10)]);
      await q(`select app.link_identity($1)`, [idn.id]);
      const secret = randomToken();
      const [dev] = await q(
        `insert into public.auth_devices (identity_id, secret_hash, name, platform) values ($1, $2, $3, $4) returning id`,
        [idn.id, keyedHash(this.cfg.jwtSecret, secret), dto.deviceName ?? null, dto.platform],
      );
      return { identityId: idn.id, deviceId: dev.id, deviceSecret: secret };
    });
    if (!identityId) throw new UnauthorizedException('Wrong code');
    return { deviceId, deviceSecret, ...(await this.signIn(identityId, deviceId, dto.tenantId)) };
  }

  async pinLogin(dto: { phone: string; pin: string; deviceId: string; deviceSecret: string; tenantId?: string }, ip: string): Promise<SignInResult> {
    const phone = this.phone(dto.phone);
    await this.limit(`pin:ip:${ip}`, 120, '1 hour');
    const [d] = await this.db.system(
      `select d.*, i.phone, i.pin_hash, i.status from public.auth_devices d join public.identities i on i.id = d.identity_id where d.id = $1`,
      [dto.deviceId],
    );
    if (!d || d.phone !== phone || !safeEqual(d.secret_hash, keyedHash(this.cfg.jwtSecret, dto.deviceSecret))) {
      throw new UnauthorizedException('This phone is not activated for that number. Activate it again.');
    }
    if (d.revoked_at) throw new UnauthorizedException('This phone was signed out. Activate it again.');
    if (d.locked_at) throw new UnauthorizedException('Too many wrong PINs. Activate this phone again.');
    if (d.status !== 'active') throw new ForbiddenException('This account is disabled');
    if (!d.pin_hash || !(await bcrypt.compare(dto.pin, d.pin_hash))) {
      const [u] = await this.db.system(
        `update public.auth_devices set pin_fails = pin_fails + 1,
                locked_at = case when pin_fails + 1 >= $2 then now() end
          where id = $1 returning pin_fails, locked_at`,
        [d.id, this.cfg.maxPinFails],
      );
      const left = this.cfg.maxPinFails - u.pin_fails;
      throw new UnauthorizedException(left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong PINs. Activate this phone again.');
    }
    await this.db.system(`update public.auth_devices set pin_fails = 0, last_seen_at = now() where id = $1`, [d.id]);
    return this.signIn(d.identity_id, d.id, dto.tenantId);
  }

  /** Issues a session straight away when the tenant is known or there is only one; otherwise asks which. */
  private async signIn(identityId: string, deviceId: string | null, tenantId?: string): Promise<SignInResult> {
    const memberships = await this.db.system<Membership>(MEMBERSHIP_SQL + ' order by brand', [identityId]);
    if (!memberships.length) throw new ForbiddenException('You are not active in any organisation. Contact your coordinator.');
    const m = tenantId ? memberships.find((x) => x.tid === tenantId) : memberships.length === 1 ? memberships[0] : undefined;
    if (tenantId && !m) throw new ForbiddenException('You do not work for that organisation');
    if (!m) return { chooseTenant: true, selectToken: this.tokens.signStep('select', { sub: identityId, dev: deviceId }), memberships };
    return { session: await this.tokens.issue(identityId, m, deviceId), memberships };
  }

  async selectTenant(selectToken: string, tenantId: string): Promise<SignInResult> {
    const { sub, dev } = this.tokens.verifyStep(selectToken, 'select');
    return this.signIn(sub, dev ?? null, tenantId);
  }

  async switchTenant(user: AuthUser, tenantId: string): Promise<SignInResult> {
    if (!user.dev) throw new ForbiddenException('Dashboard sign-ins belong to one organisation');
    return this.signIn(user.sub, user.dev, tenantId);
  }

  // ---- Dashboard staff: email + password ------------------------------------------------------------

  async staffLogin(dto: { email: string; password: string; tenantId: string }, ip: string) {
    const email = dto.email.trim().toLowerCase();
    await this.limit(`login:ip:${ip}`, 60, '1 hour');
    await this.limit(`login:email:${email}`, 10, '15 minutes');
    const [idn] = await this.db.system(`select id, password_hash, status from public.identities where lower(email) = $1`, [email]);
    const ok = await bcrypt.compare(dto.password, idn?.password_hash ?? DUMMY_HASH);
    if (!idn?.password_hash || !ok || idn.status !== 'active') throw new UnauthorizedException('Wrong email or password');
    // Rumfa owners and staff: on a client's dashboard their console account opens that client as an admin (support access)
    const [ps] = await this.db.system(`select id, role from public.platform_staff where identity_id = $1 and status = 'active'`, [idn.id]);
    if (ps && ['owner', 'staff'].includes(ps.role)) {
      const [own] = await this.db.system(`select 1 from public.volunteers where tenant_id = $1 and user_id = $2 and platform_staff_id is null and status = 'active'`, [dto.tenantId, idn.id]);
      if (!own) return { session: await this.enterAsSupport(idn.id, ps.id, dto.tenantId, 'dashboard sign-in') };
    }
    const [m] = await this.db.system<Membership>(MEMBERSHIP_SQL + ` and v.tenant_id = $2`, [idn.id, dto.tenantId]);
    if (!m || !STAFF_ROLES.includes(m.role)) throw new ForbiddenException('You do not have access to this dashboard');
    return { session: await this.tokens.issue(idn.id, strip(m), null) };
  }

  // ---- Rumfa support access: owners and staff open any client as an admin ----------------------------

  /** "Open dashboard as admin" from Rumfa Console: swaps a one-time ticket (2 minutes, single use) for a support session. */
  async supportTicket(ticket: string, ip: string) {
    await this.limit(`ticket:ip:${ip}`, 30, '15 minutes');
    const [t] = await this.db.system(
      `update public.platform_support_tickets k set used_at = now()
         from public.platform_staff s
        where k.token_hash = $1 and k.used_at is null and k.expires_at > now() and s.id = k.staff_id
        returning k.staff_id, k.tenant_id, s.identity_id`, [keyedHash(this.cfg.jwtSecret, `support:${ticket}`)]);
    if (!t?.identity_id) throw new UnauthorizedException('This link has expired. Open the client again from Rumfa Console.');
    return { session: await this.enterAsSupport(t.identity_id, t.staff_id, t.tenant_id, 'console') };
  }

  /** Opens a client as Rumfa support: an admin membership of their own there (created on first use), logged. */
  private async enterAsSupport(sub: string, sid: string, tenantId: string, via: string): Promise<Session> {
    const mid = await this.db.systemTx(async (q) => {
      const [s] = await q(`select full_name, role, status from public.platform_staff where id = $1 and identity_id = $2`, [sid, sub]);
      if (s?.status !== 'active' || !['owner', 'staff'].includes(s.role)) throw new ForbiddenException('Your Rumfa access has changed; sign in again');
      const [t] = await q(`select id, seat, seat_area, status from public.tenants where id = $1`, [tenantId]);
      if (t?.status !== 'active') throw new NotFoundException('That client is not active');
      // Where an admin of this client works: the seat's area, else the client's widest coverage
      const [cov] = await q(`select level, area_code from public.tenant_coverage where tenant_id = $1
                              order by case level when 'national' then 0 when 'state' then 1 else 2 end, area_code limit 1`, [tenantId]);
      const where = t.seat ? staffArea(t.seat, t.seat_area)
        : cov?.level === 'national' || !cov ? { level: 'national', area: 'NG' } : { level: cov.level, area: cov.area_code };
      // Already a real member of this client (the same email): use that membership as it is
      const [own] = await q(`select id from public.volunteers where tenant_id = $1 and user_id = $2 and platform_staff_id is null and status = 'active'`, [tenantId, sub]);
      let id = own?.id;
      if (!id) {
        [{ id }] = await q(
          `insert into public.volunteers (tenant_id, full_name, role, level, area_code, status, user_id, platform_staff_id, onboarded_at)
           values ($1, $2, 'admin', $3, $4, 'active', $5, $6, now())
           on conflict (tenant_id, platform_staff_id) where platform_staff_id is not null
             do update set status = 'active', role = 'admin', level = excluded.level, area_code = excluded.area_code, user_id = excluded.user_id
           returning id`,
          [tenantId, `Rumfa support · ${s.full_name}`, where.level, where.area, sub, sid]);
      }
      await q(`insert into public.platform_audit (staff_id, action, target_type, target_id, tenant_id, details) values ($1, 'support.enter', 'client', $2, $3, $4)`,
        [sid, tenantId, tenantId, JSON.stringify({ via })]);
      return id as string;
    });
    return this.issueFor(sub, mid);
  }

  private async issueFor(identityId: string, mid: string): Promise<Session> {
    const [m] = await this.db.system<Membership>(MEMBERSHIP_SQL + ` and v.id = $2`, [identityId, mid]);
    if (!m) throw new ForbiddenException('You no longer have access to this organisation');
    return this.tokens.issue(identityId, m, null);
  }

  async acceptInvite(token: string, password: string) {
    return this.db.systemTx(async (q) => {
      const [inv] = await q(
        `select s.id, v.email from public.staff_invites s join public.volunteers v on v.id = s.volunteer_id
          where s.token_hash = $1 and s.used_at is null and s.expires_at > now() for update of s`,
        [keyedHash(this.cfg.jwtSecret, `invite:${token}`)],
      );
      if (!inv?.email) throw new UnauthorizedException('This invite link has expired. Ask your admin for a new one.');
      const [existing] = await q(`select id, password_hash from public.identities where lower(email) = lower($1)`, [inv.email]);
      let id = existing?.id;
      if (!existing) {
        [{ id }] = await q(`insert into public.identities (email, password_hash) values ($1, $2) returning id`, [inv.email.toLowerCase(), await bcrypt.hash(password, 10)]);
      } else if (!existing.password_hash) {
        await q(`update public.identities set password_hash = $2 where id = $1`, [id, await bcrypt.hash(password, 10)]);
      }
      await q(`select app.link_identity($1)`, [id]);
      await q(`update public.staff_invites set used_at = now() where id = $1`, [inv.id]);
      // An existing account keeps its password; the new organisation is simply added to it
      return { email: inv.email, existingAccount: !!existing?.password_hash };
    });
  }

  async me(user: AuthUser) {
    const memberships = await this.db.system<Membership>(MEMBERSHIP_SQL + ' order by brand', [user.sub]);
    const current = memberships.find((m) => m.mid === user.mid);
    if (!current) throw new UnauthorizedException('You no longer have access to this organisation');
    return { ...current, field: FIELD_ROLES.includes(current.role), otherMemberships: user.dev ? memberships.filter((m) => m.mid !== user.mid) : [] };
  }

  // ---- Admins and coordinators --------------------------------------------------------------------

  /** Finds a membership the caller may manage: admins anyone in the tenant, coordinators people below them. */
  private async manageable(user: AuthUser, volunteerId: string) {
    const [v] = await this.db.asUser(user, (q) => q(
      `select id, tenant_id, phone, email, role from public.volunteers
        where id = $1 and (app.is_admin() or (app.my_role() = 'coordinator' and app.in_my_area(area_code) and id <> app.my_id()))`,
      [volunteerId]));
    if (!v) throw new NotFoundException('Person not found in your area');
    return v;
  }

  /** A new PIN for every phone this person uses (the current one is checked first) */
  async changePin(user: AuthUser, current: string, pin: string) {
    if (current === pin) throw new BadRequestException('The new PIN is the same as the old one');
    const [idn] = await this.db.system(`select pin_hash from public.identities where id = $1`, [user.sub]);
    if (!idn?.pin_hash || !(await bcrypt.compare(current, idn.pin_hash))) throw new BadRequestException('The current PIN is wrong');
    await this.db.system(`update public.identities set pin_hash = $2 where id = $1`, [user.sub, await bcrypt.hash(pin, 10)]);
  }

  async issueActivationCode(user: AuthUser, volunteerId: string) {
    const v = await this.manageable(user, volunteerId);
    if (!FIELD_ROLES.includes(v.role)) throw new BadRequestException('Dashboard staff sign in with email and password');
    const code = activationCode(8);
    const [row] = await this.db.system(
      `insert into public.activation_codes (tenant_id, volunteer_id, code_hash, expires_at, created_by)
       values ($1, $2, $3, now() + make_interval(hours => $4), $5) returning expires_at`,
      [v.tenant_id, v.id, keyedHash(this.cfg.jwtSecret, `act:${code}`), this.cfg.activationCodeTtlHours, user.mid],
    );
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: row.expires_at };
  }

  async inviteStaff(user: AuthUser, volunteerId: string) {
    const v = await this.manageable(user, volunteerId);
    if (!STAFF_ROLES.includes(v.role)) throw new BadRequestException('Field users activate their phone instead');
    if (!v.email) throw new BadRequestException('Add an email address to this person first');
    const token = randomToken();
    const [row] = await this.db.system(
      `insert into public.staff_invites (volunteer_id, token_hash, expires_at, created_by)
       values ($1, $2, now() + interval '7 days', $3) returning expires_at`,
      [v.id, keyedHash(this.cfg.jwtSecret, `invite:${token}`), user.mid],
    );
    return { inviteToken: token, email: v.email, expiresAt: row.expires_at };
  }

  /** Lost or stolen phone: signs the person's phones out everywhere; they activate again. */
  async revokeDevices(user: AuthUser, volunteerId: string) {
    await this.manageable(user, volunteerId);
    const rows = await this.db.system(
      `update public.auth_devices d set revoked_at = now(), revoked_by = $2
         from public.volunteers v
        where v.id = $1 and d.identity_id = v.user_id and d.revoked_at is null returning d.id`,
      [volunteerId, user.mid],
    );
    await this.db.system(
      `update public.refresh_tokens r set revoked_at = now() from public.volunteers v
        where v.id = $1 and r.identity_id = v.user_id and r.device_id is not null and r.revoked_at is null`, [volunteerId]);
    return { revoked: rows.length };
  }
}

function strip<T extends Membership>(m: T): Membership {
  const { mid, tid, brand, name, role, level, area } = m;
  return { mid, tid, brand, name, role, level, area };
}
