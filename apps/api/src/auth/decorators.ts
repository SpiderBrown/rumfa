import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser } from './auth.types';

export const IS_PUBLIC = 'isPublic';
/** No access token needed (sign-in endpoints, webhooks, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** Only these membership roles may call the endpoint. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
