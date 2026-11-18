import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser, PlatformUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';
/** No access token needed (sign-in endpoints, webhooks, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** Only these membership roles may call the endpoint. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);

export const PLATFORM = 'platform';
/** Rumfa Console only: needs a console (staff) token, never a client's. With no roles, any Rumfa staff role. */
export const Platform = (...roles: ('owner' | 'staff' | 'support')[]) => SetMetadata(PLATFORM, roles.length ? roles : ['owner', 'staff', 'support']);
export const CurrentStaff = createParamDecorator((_: unknown, ctx: ExecutionContext): PlatformUser => ctx.switchToHttp().getRequest().staff);

export const ADDON = 'addon';
/** A premium add-on the client must have switched on (Rumfa Console → client → Add-ons). */
export const Addon = (addon: 'voice' | 'airtime') => SetMetadata(ADDON, addon);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
