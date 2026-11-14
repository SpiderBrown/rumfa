import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { normaliseNgPhone } from '../shared';
import { Db } from '../database/db.service';
import type { AppConfig } from '../config/configuration';
import { FIELD_ROLES, STAFF_ROLES, tenantAuthSettings, type AuthUser, type Membership } from './auth.types';
import { activationCode, keyedHash, newTotpSecret, normaliseActivationCode, numericCode, randomToken, safeEqual, verifyTotp, weakPin } from './crypto';
import { OtpSender } from './otp-sender.service';
import { MEMBERSHIP_SQL, TokensService, type Session } from './tokens.service';

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

  // ---- Dashboard staff: email + password (+ authenticator) ----------------------------------------

  async staffLogin(dto: { email: string; password: string; tenantId: string }, ip: string) {
    const email = dto.email.trim().toLowerCase();
    await this.limit(`login:ip:${ip}`, 60, '1 hour');
    await this.limit(`login:email:${email}`, 10, '15 minutes');
    const [idn] = await this.db.system(
      `select id, password_hash, status, totp_enabled_at from public.identities where lower(email) = $1`, [email]);
    const ok = await bcrypt.compare(dto.password, idn?.password_hash ?? DUMMY_HASH);
    if (!idn?.password_hash || !ok || idn.status !== 'active') throw new UnauthorizedException('Wrong email or password');
    const [m] = await this.db.system<Membership & { settings: any }>(
      MEMBERSHIP_SQL.replace('v.area_code as area', 'v.area_code as area, t.settings') + ` and v.tenant_id = $2`, [idn.id, dto.tenantId]);
    if (!m || !STAFF_ROLES.includes(m.role)) throw new ForbiddenException('You do not have access to this dashboard');
    const required = tenantAuthSettings(m.settings).mfaRoles.includes(m.role);
    if (idn.totp_enabled_at) return { mfaRequired: true, mfaToken: this.tokens.signStep('mfa', { sub: idn.id, mid: m.mid }) };
    if (required) return { mfaSetupRequired: true, setupToken: this.tokens.signStep('mfa_setup', { sub: idn.id, mid: m.mid }) };
    return { session: await this.tokens.issue(idn.id, strip(m), null) };
  }

  async mfa(mfaToken: string, code: string) {
    const { sub, mid } = this.tokens.verifyStep(mfaToken, 'mfa');
    await this.limit(`mfa:${sub}`, 10, '15 minutes');
    const [idn] = await this.db.system(`select totp_secret from public.identities where id = $1 and totp_enabled_at is not null`, [sub]);
    if (!idn || !verifyTotp(idn.totp_secret, code)) throw new UnauthorizedException('Wrong authenticator code');
    return { session: await this.issueFor(sub, mid) };
  }

  async totpSetup(identityId: string) {
    const [idn] = await this.db.system(`select email, totp_enabled_at from public.identities where id = $1`, [identityId]);
    if (!idn) throw new NotFoundException();
    if (idn.totp_enabled_at) throw new ConflictException('An authenticator is already set up');
    const secret = newTotpSecret();
    await this.db.system(`update public.identities set totp_secret = $2 where id = $1`, [identityId, secret]);
    const label = encodeURIComponent(`${this.cfg.totpIssuer}:${idn.email ?? 'account'}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(this.cfg.totpIssuer)}&digits=6&period=30` };
  }

  async totpEnable(identityId: string, code: string) {
    await this.limit(`mfa:${identityId}`, 10, '15 minutes');
    const [idn] = await this.db.system(`select totp_secret, totp_enabled_at from public.identities where id = $1`, [identityId]);
    if (!idn?.totp_secret || idn.totp_enabled_at) throw new BadRequestException('Start the authenticator set-up first');
    if (!verifyTotp(idn.totp_secret, code)) throw new UnauthorizedException('Wrong authenticator code');
    await this.db.system(`update public.identities set totp_enabled_at = now() where id = $1`, [identityId]);
  }

  async totpSetupWithToken(setupToken: string) {
    return this.totpSetup(this.tokens.verifyStep(setupToken, 'mfa_setup').sub);
  }

  async totpEnableWithToken(setupToken: string, code: string) {
    const { sub, mid } = this.tokens.verifyStep(setupToken, 'mfa_setup');
    await this.totpEnable(sub, code);
    return { session: await this.issueFor(sub, mid) };
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
