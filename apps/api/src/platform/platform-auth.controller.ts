import {
  Body, Controller, Get, HttpCode, HttpException, HttpStatus, Ip, Post, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { Db } from '../database/db.service';
import type { AppConfig } from '../config/configuration';
import { CurrentStaff, Platform, Public } from '../auth/decorators';
import type { PlatformUser } from '../auth/auth.types';
import { keyedHash } from '../auth/crypto';
import { TokensService } from '../auth/tokens.service';
import { audit } from './audit';

class LoginDto {
  @ApiProperty() @IsEmail() @MaxLength(120) email: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}
class RefreshDto { @ApiProperty() @IsString() @MaxLength(200) refreshToken: string }
class AcceptDto {
  @ApiProperty() @IsString() @MaxLength(200) token: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) @MaxLength(200) password: string;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/**
 * Rumfa Console sign-in: email and password.
 * Separate from client sign-in: a console token opens only console endpoints, and a client token never does.
 */
@ApiTags('Rumfa Console: sign-in')
@Controller('platform/auth')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class PlatformAuthController {
  private readonly cfg: AppConfig['auth'];
  constructor(private readonly db: Db, private readonly tokens: TokensService, config: ConfigService) {
    this.cfg = config.get('auth')!;
  }

  private async limit(key: string, max: number, window: string) {
    const [{ ok }] = await this.db.system<{ ok: boolean }>(`select app.rate_hit($1, $2, $3::interval) as ok`, [key, max, window]);
    if (!ok) throw new HttpException('Too many attempts. Wait a few minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);
  }

  @Public() @Post('login') @HttpCode(200)
  @ApiOperation({ summary: 'Email and password; answers with a console session' })
  async login(@Body() d: LoginDto, @Ip() ip: string) {
    const email = d.email.trim().toLowerCase();
    await this.limit(`plogin:ip:${ip}`, 30, '1 hour');
    await this.limit(`plogin:email:${email}`, 8, '15 minutes');
    const [s] = await this.db.system(
      `select s.id as sid, s.role, s.status, i.id as sub, i.password_hash, i.status as identity_status
         from public.platform_staff s join public.identities i on i.id = s.identity_id where s.email = $1`, [email]);
    const ok = await bcrypt.compare(d.password, s?.password_hash ?? DUMMY_HASH);
    if (!s?.password_hash || !ok || s.status !== 'active' || s.identity_status !== 'active') throw new UnauthorizedException('Wrong email or password');
    return this.session(s.sub, s.sid);
  }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() d: RefreshDto) { return this.tokens.refreshPlatform(d.refreshToken); }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Body() d: RefreshDto) { await this.tokens.revokePlatform(d.refreshToken); }

  @Public() @Post('invite/accept') @HttpCode(200)
  @ApiOperation({ summary: 'Set the password from a console invite link (new staff, or a reset)' })
  async accept(@Body() d: AcceptDto, @Ip() ip: string) {
    await this.limit(`pinvite:ip:${ip}`, 20, '1 hour');
    const hash = await bcrypt.hash(d.password, 10);
    return this.db.systemTx(async (q) => {
      const [inv] = await q(
        `select i.id, s.id as sid, s.email, s.identity_id from public.platform_invites i join public.platform_staff s on s.id = i.staff_id
          where i.token_hash = $1 and i.used_at is null and i.expires_at > now() and s.status <> 'suspended' for update of i`,
        [keyedHash(this.cfg.jwtSecret, `pinvite:${d.token}`)]);
      if (!inv) throw new UnauthorizedException('This link has expired. Ask a Rumfa owner for a new one.');
      let identity = inv.identity_id;
      if (!identity) {
        // The same email may already sign in to a client's dashboard: one identity, one password
        const [existing] = await q(`select id from public.identities where lower(email) = $1`, [inv.email]);
        identity = existing?.id ?? (await q(`insert into public.identities (email) values ($1) returning id`, [inv.email]))[0].id;
      }
      await q(`update public.identities set password_hash = $2, status = 'active' where id = $1`, [identity, hash]);
      await q(`update public.platform_staff set identity_id = $2, status = 'active' where id = $1`, [inv.sid, identity]);
      await q(`update public.platform_invites set used_at = now() where id = $1`, [inv.id]);
      await audit(q, { sid: inv.sid }, 'staff.password_set', 'staff', inv.sid);
      return { email: inv.email };
    });
  }

  @ApiBearerAuth() @Platform() @Get('me')
  async me(@CurrentStaff() s: PlatformUser) {
    const [me] = await this.db.system(`select id, email, full_name, role from public.platform_staff where id = $1`, [s.sid]);
    return me;
  }

  private async session(sub: string, sid: string) {
    const [s] = await this.db.system(`select role, status from public.platform_staff where id = $1 and identity_id = $2`, [sid, sub]);
    if (s?.status !== 'active') throw new UnauthorizedException('Your console access has been removed');
    const session = await this.tokens.issuePlatform({ sub, sid, role: s.role });
    await audit((sql, p) => this.db.system(sql, p), { sid }, 'staff.sign_in', 'staff', sid);
    return { session };
  }
}
