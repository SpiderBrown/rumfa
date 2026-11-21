import { BadRequestException, Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, ValidateIf } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { tenantAuthSettings } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { CALL_MODES, callSettings, checkinSettings, ownParty, tenantCallSettings, tenantSettings } from '../common/tenant-settings';
import { elections } from '../common/fn';
import { DEFAULT_RULES, ROUTABLE, rulesChanges, rulesOf, rulesProblems } from '../common/rules';

class CallSettingsDto {
  @ApiPropertyOptional({ description: 'Phone call on the caller\'s own airtime' }) @IsOptional() @IsBoolean() phone?: boolean;
  @ApiPropertyOptional({ description: 'Rumfa call: the platform rings both people' }) @IsOptional() @IsBoolean() bridged?: boolean;
  @ApiPropertyOptional({ description: 'Internet call over mobile data' }) @IsOptional() @IsBoolean() webrtc?: boolean;
  @ApiPropertyOptional({ description: 'Free app-to-app call over the internet (LiveKit)' }) @IsOptional() @IsBoolean() inapp?: boolean;
}

class CheckinSettingsDto {
  @ApiPropertyOptional({ description: 'Opening time on election day, Lagos time (HH:MM)', example: '06:00' })
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) opens?: string;
  @ApiPropertyOptional({ description: 'Allow check-in on any day (training and mock drills)' }) @IsOptional() @IsBoolean() anyDay?: boolean;
}
class PartyDto {
  @ApiPropertyOptional({ description: 'Party code on the ballot, or null for none', nullable: true })
  @ValidateIf((_, v) => v !== null) @IsString() @Matches(/^[A-Z]{1,8}$/) party: string | null;
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
    const { live } = await this.db.asUser(u, (q) => elections(q, u.tid));
    const parties = live ? (await this.db.system(`select party from public.election_parties where election_id = $1 order by ballot_order`, [live])).map((p) => p.party) : [];
    return { name: t.name, brand: t.settings?.brand ?? t.name, calls: callSettings(t.settings), auth: tenantAuthSettings(t.settings),
      checkin: checkinSettings(t.settings), party: ownParty(t.settings), parties,
      rules: rulesOf(t.settings), defaults: DEFAULT_RULES, hierarchy: await this.hierarchy(u.tid),
      categories: ROUTABLE.map((c) => ({ code: c.code, label: c.label, severity: c.severity, queue: c.queue })) };
  }

  /** The seat's top level and room: where "move up" ends (cases never go past the seat) */
  private async hierarchy(tid: string) {
    const [h] = await this.db.system(
      `select app.seat_level($1) as level, t.seat,
              (select q.name from public.queues q where q.id = app.top_queue($1, coalesce(t.seat_area, (select c.area_code from public.tenant_coverage c where c.tenant_id = $1 limit 1), ''))) as top_room
         from public.tenants t where t.id = $1`, [tid]);
    return { level: h?.level ?? 'state', seat: h?.seat ?? null, topRoom: h?.top_room ?? null };
  }

  @Put('rules')
  @ApiOperation({ summary: 'Replace the operating rules: case timings, routing, field team, callbacks, alerts, results' })
  async rules(@CurrentUser() u: AuthUser, @Body() body: any) {
    const problems = rulesProblems(body);
    if (problems.length) throw new BadRequestException(problems.join('. '));
    const before = rulesOf(await tenantSettings(this.db, u.tid));
    const next = rulesOf({ rules: body });     // keeps only known fields
    const changes = rulesChanges(before, next);
    if (!changes.length) return next;
    await this.save(u.tid, 'rules', next);
    await this.db.system(
      `insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, data) values ($1, $2, 'rules_changed', 'tenant', $3, $4::jsonb)`,
      [u.tid, u.mid, u.tid, JSON.stringify({ changes })]);
    return next;
  }

  @Get('rules/history')
  @ApiOperation({ summary: 'Recent changes to the operating rules, newest first' })
  history(@CurrentUser() u: AuthUser) {
    return this.db.system(
      `select a.at, v.full_name as by, a.data->'changes' as changes
         from public.audit_log a left join public.volunteers v on v.id = a.actor_id
        where a.tenant_id = $1 and a.action = 'rules_changed' order by a.at desc limit 20`, [u.tid]);
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

  @Patch('checkin')
  @ApiOperation({ summary: 'When field people may check in' })
  async checkin(@CurrentUser() u: AuthUser, @Body() d: CheckinSettingsDto) {
    const next = { ...checkinSettings(await tenantSettings(this.db, u.tid)) };
    if (d.opens !== undefined) next.opens = d.opens;
    if (d.anyDay !== undefined) next.anyDay = d.anyDay;
    await this.save(u.tid, 'checkin', next);
    return next;
  }

  @Patch('party')
  @ApiOperation({ summary: 'The organisation\'s own party (first and largest on the live count)' })
  async party(@CurrentUser() u: AuthUser, @Body() d: PartyDto) {
    await this.save(u.tid, 'party', d.party);
    return { party: d.party };
  }

  private save(tenantId: string, key: string, value: unknown) {
    return this.db.system(
      `update public.tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), array[$2::text], $3::jsonb) where id = $1`,
      [tenantId, key, JSON.stringify(value)]);
  }
}
