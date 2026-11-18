import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TokensService } from './tokens.service';
import { ADDON, IS_PUBLIC, PLATFORM, ROLES } from './decorators';
import { Db } from '../database/db.service';
import { ADDONS, addonSettings, tenantSettings, type Addon } from '../common/tenant-settings';

/** Global: every endpoint needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokensService) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true; // live updates authenticate on connect (LiveGateway)
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('Sign in first');
    // Rumfa Console endpoints take only console tokens; every other endpoint only client tokens
    const platform = this.reflector.getAllAndOverride<string[]>(PLATFORM, [ctx.getHandler(), ctx.getClass()]);
    if (platform) {
      req.staff = this.tokens.verifyPlatform(token);
      if (!platform.includes(req.staff.role)) throw new ForbiddenException('Your Rumfa role cannot do this');
      return true;
    }
    req.user = this.tokens.verifyAccess(token);
    return true;
  }
}

/** Global: enforces @Roles(...) where present. Tenant and area are enforced per query (and by the database). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<string[]>(PLATFORM, [ctx.getHandler(), ctx.getClass()])) return true; // checked above
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException('Your role cannot do this');
    return true;
  }
}

/** Global: endpoints of a premium add-on (@Addon) work only for clients that have it switched on. */
@Injectable()
export class AddonGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const addon = this.reflector.getAllAndOverride<Addon>(ADDON, [ctx.getHandler(), ctx.getClass()]);
    if (!addon) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user?.tid || !addonSettings(await tenantSettings(this.db, user.tid))[addon]) {
      throw new ForbiddenException(`${ADDONS[addon]} is not part of your plan. Ask Rumfa to switch it on.`);
    }
    return true;
  }
}

/** Rate limits for HTTP requests only. */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    return ctx.getType() !== 'http' ? true : super.canActivate(ctx);
  }
}
