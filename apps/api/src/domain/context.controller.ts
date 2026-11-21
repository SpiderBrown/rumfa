import { Body, Controller, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Length, MaxLength, ValidateIf } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { rulesOf } from '../common/rules';
import { Db } from '../database/db.service';
import { callFn, elections } from '../common/fn';
import { ROOM } from './roles';
import { addonSettings, callSettings, ownParty, tenantSettings } from '../common/tenant-settings';

class OnboardingDto {
  @ApiProperty({ enum: ['mtn', 'airtel', 'glo', '9mobile'] }) @IsIn(['mtn', 'airtel', 'glo', '9mobile']) network: string;
  @ApiProperty() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(5, { each: true }) languages: string[];
}
class ProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 80) fullName?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsEmail() @MaxLength(120) email?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) @MaxLength(5, { each: true }) languages?: string[];
  @ApiPropertyOptional({ enum: ['mtn', 'airtel', 'glo', '9mobile'] }) @IsOptional() @IsIn(['mtn', 'airtel', 'glo', '9mobile']) network?: string;
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

  /**
   * The coordinator closest to me: the one whose area is the longest part of mine (ward, then LGA, then state).
   * Shown pinned at the top of the agent's chats with Message and Call.
   */
  @Get('coordinator')
  @ApiOperation({ summary: 'My nearest coordinator (ward, else LGA, else state)' })
  async coordinator(@CurrentUser() user: AuthUser) {
    const [c] = await this.db.system(
      `select v.id, v.full_name, v.level, v.area_code from public.volunteers v
        where v.tenant_id = $1 and v.role = 'coordinator' and v.status = 'active' and v.id <> $2
          and $3 like v.area_code || '%' and v.deputy_of is null
        order by length(v.area_code) desc, v.full_name limit 1`, [user.tid, user.mid, user.area ?? '']);
    return c ?? null;
  }

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
      // Colours set on Rumfa Console's Parties page (others get an automatic colour)
      const colours = await q(`select acronym, colour from public.parties where colour is not null`);
      const partyColours = Object.fromEntries(colours.map((c) => [c.acronym, c.colour]));
      return { me, elections: el, parties, partyColours, categories, staffStatus: status?.status ?? null };
    }).then(async (ctx) => {
      const settings = await tenantSettings(this.db, user.tid);
      const own = ownParty(settings);
      const rules = rulesOf(settings);
      // The client's own routing: where each report goes and how urgent it starts
      const categories = ctx.categories.map((c: any) => ({ ...c, severity: rules.routing[c.code]?.severity ?? c.severity, queue_kind: rules.routing[c.code]?.queue ?? c.queue_kind }));
      return { ...ctx, categories, rules, calls: callSettings(settings), addons: addonSettings(settings), ownParty: own && ctx.parties.includes(own) ? own : null };
    });
  }

  @Post('onboarding') @HttpCode(204)
  async onboarding(@CurrentUser() user: AuthUser, @Body() dto: OnboardingDto) {
    await this.db.asUser(user, (q) => callFn(q, 'complete_onboarding', { p_network: dto.network, p_languages: dto.languages }));
  }

  /**
   * The person's own details: name, email, languages, mobile network. Field roles only (room staff sign in
   * with their email, which their admins manage). The phone number is the sign-in and is changed by a coordinator.
   */
  @Patch('profile') @Roles('agent', 'volunteer', 'coordinator')
  @ApiOperation({ summary: 'Update my own profile' })
  async profile(@CurrentUser() user: AuthUser, @Body() d: ProfileDto) {
    const sets: string[] = [];
    const vals: unknown[] = [user.mid, user.tid];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (d.fullName !== undefined) add('full_name', d.fullName.trim().split(/\s+/).join(' '));
    if (d.email !== undefined) add('email', d.email ? d.email.trim().toLowerCase() : null);
    if (d.languages !== undefined) add('languages', d.languages);
    if (d.network !== undefined) { add('network', d.network); sets.push('network_confirmed_at = now()'); }
    if (sets.length) {
      await this.db.system(`update public.volunteers set ${sets.join(', ')}, updated_at = now() where id = $1 and tenant_id = $2`, vals);
    }
    const [me] = await this.db.system(`select full_name, email, languages, network from public.volunteers where id = $1`, [user.mid]);
    return me;
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
