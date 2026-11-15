import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { tenantAuthSettings } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { CALL_MODES, callSettings, tenantCallSettings } from '../common/tenant-settings';

class CallSettingsDto {
  @ApiPropertyOptional({ description: 'Phone call on the caller\'s own airtime' }) @IsOptional() @IsBoolean() phone?: boolean;
  @ApiPropertyOptional({ description: 'Rumfa call: the platform rings both people' }) @IsOptional() @IsBoolean() bridged?: boolean;
  @ApiPropertyOptional({ description: 'Internet call over mobile data' }) @IsOptional() @IsBoolean() webrtc?: boolean;
  @ApiPropertyOptional({ description: 'Free app-to-app call over the internet (LiveKit)' }) @IsOptional() @IsBoolean() inapp?: boolean;
}

/** The organisation's own settings, changed by its admins. */
@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
@Roles('admin')
export class SettingsController {
  constructor(private readonly db: Db) {}

  @Get()
  async get(@CurrentUser() u: AuthUser) {
    const [t] = await this.db.system<{ name: string; settings: any }>(`select name, settings from public.tenants where id = $1`, [u.tid]);
    return { name: t.name, brand: t.settings?.brand ?? t.name, calls: callSettings(t.settings), auth: tenantAuthSettings(t.settings) };
  }

  @Patch('calls')
  @ApiOperation({ summary: 'Turn the agent app\'s calling options on or off' })
  async calls(@CurrentUser() u: AuthUser, @Body() d: CallSettingsDto) {
    const next = { ...(await tenantCallSettings(this.db, u.tid)) };
    for (const k of CALL_MODES) if (d[k] !== undefined) next[k] = d[k];
    await this.db.system(
      `update public.tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{calls}', $2::jsonb) where id = $1`,
      [u.tid, JSON.stringify(next)]);
    return next;
  }
}
