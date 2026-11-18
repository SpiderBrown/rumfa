import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { Db } from '../database/db.service';
import type { AppConfig } from '../config/configuration';
import type { AuthUser, Membership, PlatformUser, TokenType } from './auth.types';
import { keyedHash, randomToken } from './crypto';

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  membership: Membership;
}

@Injectable()
export class TokensService {
  private readonly cfg: AppConfig['auth'];

  constructor(private readonly jwt: JwtService, private readonly db: Db, config: ConfigService) {
    this.cfg = config.get('auth')!;
  }

  private sign(typ: TokenType, payload: object, expiresIn: number): string {
    return this.jwt.sign({ ...payload, typ }, { secret: this.cfg.jwtSecret, expiresIn });
  }

  private verify(token: string, typ: TokenType): any {
    let p: any;
    try {
      p = this.jwt.verify(token, { secret: this.cfg.jwtSecret });
    } catch {
      throw new UnauthorizedException('Session expired; sign in again');
    }
    if (p.typ !== typ) throw new UnauthorizedException('Wrong kind of token');
    return p;
  }

  verifyAccess(token: string): AuthUser {
    const { sub, tid, mid, role, level, area, dev } = this.verify(token, 'access');
    return { sub, tid, mid, role, level, area, dev };
  }

  verifyPlatform(token: string): PlatformUser {
    const { sub, sid, role } = this.verify(token, 'platform');
    return { sub, sid, role };
  }

  /** A Rumfa Console session: short access token, rotating refresh token (same rules as client sessions). */
  async issuePlatform(u: PlatformUser, family = randomUUID()): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const refresh = randomToken();
    await this.db.system(
      `insert into public.platform_refresh_tokens (family, staff_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '12 hours')`,
      [family, u.sid, keyedHash(this.cfg.jwtSecret, `platform:${refresh}`)]);
    await this.db.system(`update public.identities set last_login_at = now() where id = $1`, [u.sub]);
    return { accessToken: this.sign('platform', u, this.cfg.accessTtlSeconds), refreshToken: refresh, expiresIn: this.cfg.accessTtlSeconds };
  }

  async refreshPlatform(refreshToken: string) {
    const hash = keyedHash(this.cfg.jwtSecret, `platform:${refreshToken}`);
    const r = await this.db.systemTx(async (q) => {
      const [rt] = await q(
        `select r.*, s.identity_id, s.role, s.status from public.platform_refresh_tokens r join public.platform_staff s on s.id = r.staff_id
          where r.token_hash = $1 for update of r`, [hash]);
      if (!rt) throw new UnauthorizedException('Session expired; sign in again');
      if (rt.used_at) {
        await q(`update public.platform_refresh_tokens set revoked_at = now() where family = $1 and revoked_at is null`, [rt.family]);
        return { reused: true } as const;
      }
      if (rt.revoked_at || new Date(rt.expires_at) < new Date() || rt.status !== 'active') throw new UnauthorizedException('Session expired; sign in again');
      await q(`update public.platform_refresh_tokens set used_at = now() where id = $1`, [rt.id]);
      return { rt };
    });
    if ('reused' in r) throw new UnauthorizedException('Session ended for safety; sign in again');
    return this.issuePlatform({ sub: r.rt.identity_id, sid: r.rt.staff_id, role: r.rt.role }, r.rt.family);
  }

  async revokePlatform(refreshToken: string) {
    await this.db.system(
      `update public.platform_refresh_tokens set revoked_at = now()
        where family = (select family from public.platform_refresh_tokens where token_hash = $1) and revoked_at is null`,
      [keyedHash(this.cfg.jwtSecret, `platform:${refreshToken}`)]);
  }

  /** Expiry (seconds since epoch) of a token that has already been verified. */
  expiryOf(token: string): number | undefined {
    return (this.jwt.decode(token) as any)?.exp;
  }

  /** Short-lived token for a step between sign-in and a session: choosing a client, or the authenticator code. */
  signStep(typ: Exclude<TokenType, 'access'>, payload: object): string {
    return this.sign(typ, payload, 300);
  }
  /** The kind of a step token, read without checking it (it is checked when used). */
  stepType(token: string): string | undefined {
    return (this.jwt.decode(token) as any)?.typ;
  }
  verifyStep(token: string, typ: Exclude<TokenType, 'access'>): any {
    return this.verify(token, typ);
  }

  async issue(identityId: string, m: Membership, deviceId: string | null, family = randomUUID()): Promise<Session> {
    const user: AuthUser = { sub: identityId, tid: m.tid, mid: m.mid, role: m.role, level: m.level, area: m.area, ...(deviceId ? { dev: deviceId } : {}) };
    const refresh = randomToken();
    await this.db.system(
      `insert into public.refresh_tokens (family, identity_id, device_id, tenant_id, volunteer_id, token_hash, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))`,
      [family, identityId, deviceId, m.tid, m.mid, keyedHash(this.cfg.jwtSecret, refresh), this.cfg.refreshTtlDays],
    );
    await this.db.system(`update public.identities set last_login_at = now() where id = $1`, [identityId]);
    return { accessToken: this.sign('access', user, this.cfg.accessTtlSeconds), refreshToken: refresh, expiresIn: this.cfg.accessTtlSeconds, membership: m };
  }

  /** One use per refresh token. Using a replaced token again means it leaked: the whole family is revoked. */
  async refresh(refreshToken: string): Promise<Session> {
    const hash = keyedHash(this.cfg.jwtSecret, refreshToken);
    const r = await this.db.systemTx(async (q) => {
      const [rt] = await q(
        `select r.*, d.revoked_at as device_revoked, d.locked_at as device_locked, i.status as identity_status
           from public.refresh_tokens r
           join public.identities i on i.id = r.identity_id
           left join public.auth_devices d on d.id = r.device_id
          where r.token_hash = $1 for update of r`,
        [hash],
      );
      if (!rt) throw new UnauthorizedException('Session expired; sign in again');
      if (rt.used_at) {
        // Commit the revocation, then refuse (throwing here would roll it back)
        await q(`update public.refresh_tokens set revoked_at = now() where family = $1 and revoked_at is null`, [rt.family]);
        return { reused: true } as const;
      }
      if (rt.revoked_at || new Date(rt.expires_at) < new Date() || rt.device_revoked || rt.device_locked || rt.identity_status !== 'active') {
        throw new UnauthorizedException('Session expired; sign in again');
      }
      await q(`update public.refresh_tokens set used_at = now() where id = $1`, [rt.id]);
      const [m] = await q<Membership>(MEMBERSHIP_SQL + ` and v.id = $2`, [rt.identity_id, rt.volunteer_id]);
      if (!m) throw new UnauthorizedException('You no longer have access to this organisation');
      return { rt, m };
    });
    if ('reused' in r) throw new UnauthorizedException('Session ended for safety; sign in again');
    return this.issue(r.rt.identity_id, r.m, r.rt.device_id, r.rt.family);
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db.system(
      `update public.refresh_tokens set revoked_at = now()
        where family = (select family from public.refresh_tokens where token_hash = $1) and revoked_at is null`,
      [keyedHash(this.cfg.jwtSecret, refreshToken)],
    );
  }
}

/** Active memberships of an identity in active tenants. $1 = identity id. */
export const MEMBERSHIP_SQL = `
  select v.id as mid, v.tenant_id as tid, coalesce(t.settings->>'brand', t.name) as brand, v.full_name as name,
         v.role, v.level, v.area_code as area
    from public.volunteers v join public.tenants t on t.id = v.tenant_id
   where v.user_id = $1 and v.status = 'active' and t.status = 'active'`;
