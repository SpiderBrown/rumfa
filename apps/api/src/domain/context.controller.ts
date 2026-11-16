import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { callFn, elections } from '../common/fn';
import { ROOM } from './roles';
import { callSettings, ownParty, tenantSettings } from '../common/tenant-settings';

class OnboardingDto {
  @ApiProperty({ enum: ['mtn', 'airtel', 'glo', '9mobile'] }) @IsIn(['mtn', 'airtel', 'glo', '9mobile']) network: string;
  @ApiProperty() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(5, { each: true }) languages: string[];
}
class DeviceTokenDto {
  @ApiProperty() @IsString() @MaxLength(400) token: string;
  @ApiProperty({ enum: ['android', 'ios', 'web'] }) @IsIn(['android', 'ios', 'web']) platform: string;
}
class StatusDto {
  @ApiProperty({ enum: ['available', 'busy', 'away', 'offline'] }) @IsIn(['available', 'busy', 'away', 'offline']) status: string;
}

@ApiTags('Me')
@ApiBearerAuth()
@Controller('me')
export class ContextController {
  constructor(private readonly db: Db) {}

  @Get('context')
  @ApiOperation({ summary: 'Everything the apps need after sign-in: profile, brand, elections, ballot parties, categories' })
  context(@CurrentUser() user: AuthUser) {
    return this.db.asUser(user, async (q) => {
      const [me] = await q(
        `select v.id, v.tenant_id, v.full_name, v.phone, v.email, v.role, v.level, v.area_code, v.agent_code, v.languages,
                v.network, v.onboarded_at, v.deputy_of, coalesce(t.settings->>'brand', t.name) as brand
           from public.volunteers v join public.tenants t on t.id = v.tenant_id where v.id = $1`, [user.mid]);
      const el = await elections(q, user.tid);
      const parties = el.live ? (await q(`select party from public.election_parties where election_id = $1 order by ballot_order`, [el.live])).map((p) => p.party) : [];
      const categories = await q(`select code, sms, label, severity, queue_kind, related, is_alert from public.incident_categories order by label`);
      const [status] = ROOM.includes(user.role) ? await q(`select status from public.staff_status where volunteer_id = $1`, [user.mid]) : [];
      return { me, elections: el, parties, categories, staffStatus: status?.status ?? null };
    }).then(async (ctx) => {
      const settings = await tenantSettings(this.db, user.tid);
      const own = ownParty(settings);
      return { ...ctx, calls: callSettings(settings), ownParty: own && ctx.parties.includes(own) ? own : null };
    });
  }

  @Post('onboarding') @HttpCode(204)
  async onboarding(@CurrentUser() user: AuthUser, @Body() dto: OnboardingDto) {
    await this.db.asUser(user, (q) => callFn(q, 'complete_onboarding', { p_network: dto.network, p_languages: dto.languages }));
  }

  @Post('device-tokens') @HttpCode(204)
  @ApiOperation({ summary: 'Register this phone for push notifications' })
  async deviceToken(@CurrentUser() user: AuthUser, @Body() dto: DeviceTokenDto) {
    await this.db.asUser(user, (q) => callFn(q, 'register_device', { p_token: dto.token, p_platform: dto.platform }));
  }

  @Put('status') @HttpCode(204) @Roles(...ROOM)
  async status(@CurrentUser() user: AuthUser, @Body() dto: StatusDto) {
    await this.db.asUser(user, (q) => callFn(q, 'set_my_status', { p_status: dto.status }));
  }
}
