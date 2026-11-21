// My field team: who in an area needs following up right now (not checked in, silent, no turnout update, asked
// for a call, phone trouble), the sub-areas with their coordinators, and announcements to the team. For
// coordinators and room staff, within their own area.
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { elections } from '../common/fn';
import { tenantSettings } from '../common/tenant-settings';
import { rulesOf } from '../common/rules';
import { ROOM } from './roles';
import { childLength, inScope, mapScope } from './map.controller';

export const NEEDS = ['callback', 'notin', 'silent', 'trouble', 'turnout'] as const;
type Need = (typeof NEEDS)[number];
// How long before someone counts as silent, between turnout updates, how long a follow-up hides them, and
// when announcements fall back to SMS: each client's own rules (Settings → Field team).

class DoneDto {
  @ApiProperty() @IsUUID() volunteerId: string;
  @ApiProperty({ enum: NEEDS }) @IsIn(NEEDS as unknown as string[]) need: Need;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class UndoDto { @ApiProperty() @IsUUID() volunteerId: string; }
class AnnounceDto {
  @ApiProperty({ description: 'The area: NG, a state, an LGA or a ward code' }) @IsString() @Length(2, 12) area: string;
  @ApiProperty({ enum: ['all', 'coordinators', 'list'] }) @IsIn(['all', 'coordinators', 'list']) audience: 'all' | 'coordinators' | 'list';
  @ApiPropertyOptional({ type: [String], description: 'For audience "list": who exactly' }) @IsOptional() @IsArray() @ArrayMaxSize(2000) @IsUUID('4', { each: true }) ids?: string[];
  @ApiProperty() @IsString() @Length(2, 480) text: string;
}

const FIELD = ['agent', 'volunteer', 'coordinator'];

@ApiTags('My field team')
@ApiBearerAuth()
@Controller('team')
@Roles(...ROOM, 'coordinator')
export class TeamController {
  constructor(private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'People in an area who need following up, and its sub-areas with their coordinators' })
  async team(@CurrentUser() u: AuthUser, @Query('area') areaQ?: string) {
    const scope = mapScope(u);
    const area = (areaQ || scope).trim();
    this.check(scope, area);
    const el = await this.db.asUser(u, (q) => elections(q, u.tid));
    const { team: { silentMin: SILENT_MIN, turnoutMin: TURNOUT_MIN, snoozeMin: SNOOZE_MIN } } = await this.rules(u);
    const prefix = area === 'NG' ? '%' : `${area}-%`;
    const rows = await this.db.system(
      `select v.id, v.full_name, v.phone, v.network, v.role, v.level, v.area_code, v.status,
              pu.name as unit_name, w.name as ward_name,
              ck.at as checked_in_at, fig.last_accr, open_cb.id as callback_id, trouble.id as trouble_id,
              greatest(dev.seen, ck.last_at, fig.last_any, inc.last_at, msg.last_at) as last_heard,
              (select jsonb_object_agg(f.need, f.done_at) from (
                 select distinct on (need) need, done_at from public.follow_ups
                  where tenant_id = $1 and volunteer_id = v.id and done_at > now() - make_interval(mins => $4)
                  order by need, done_at desc) f) as snoozed
         from public.volunteers v
         left join public.polling_units pu on v.level = 'pu' and pu.code = v.area_code
         left join public.wards w on w.code = case when v.level = 'pu' then left(v.area_code, 8) when v.level = 'ward' then v.area_code end
         left join lateral (select max(d.last_seen_at) as seen from public.auth_devices d where v.user_id is not null and d.identity_id = v.user_id) dev on true
         left join lateral (select min(c.at) as at, max(c.at) as last_at from public.checkins c
                             where c.tenant_id = $1 and c.volunteer_id = v.id and c.election_id is not distinct from $3) ck on true
         left join lateral (select max(f.created_at) as last_any,
                                   max(f.created_at) filter (where f.figures ? 'accredited') as last_accr
                              from public.unit_figure_updates f where f.tenant_id = $1 and f.volunteer_id = v.id and f.election_id is not distinct from $3) fig on true
         left join lateral (select max(i.reported_at) as last_at from public.incidents i where i.tenant_id = $1 and i.volunteer_id = v.id) inc on true
         left join lateral (select max(m.created_at) as last_at from public.messages m where m.tenant_id = $1 and m.sender_id = v.id) msg on true
         left join lateral (select r.id from public.callback_requests r where r.tenant_id = $1 and r.requester_id = v.id
                              and r.status in ('waiting', 'calling', 'no_answer', 'escalated') limit 1) open_cb on true
         left join lateral (select i.id from public.incidents i join public.cases c on c.id = i.case_id
                             where i.tenant_id = $1 and i.volunteer_id = v.id and i.category = 'app_problem'
                               and c.status in ('queued', 'assigned', 'in_progress', 'escalated') limit 1) trouble on true
        where v.tenant_id = $1 and v.status in ('active', 'invited') and v.role = any($5)
          and (v.area_code like $2 or v.area_code = $6) and v.id <> $7
        order by v.full_name`,
      [u.tid, prefix, el.live, SNOOZE_MIN, FIELD, area, u.mid]);

    const now = Date.now();
    const ago = (t: string | null) => (t ? (now - new Date(t).getTime()) / 60_000 : Infinity);
    const people = rows.map((r) => {
      // Field people at a unit check in; coordinators do not, so they are only checked for silence and calls
      const atUnit = r.level === 'pu';
      const needs: Need[] = [];
      if (r.callback_id) needs.push('callback');
      if (atUnit && !r.checked_in_at) needs.push('notin');
      if ((r.checked_in_at || !atUnit) && ago(r.last_heard) > SILENT_MIN && r.status === 'active') needs.push('silent');
      if (r.trouble_id) needs.push('trouble');
      if (atUnit && r.checked_in_at && ago(r.checked_in_at) > TURNOUT_MIN && ago(r.last_accr) > TURNOUT_MIN) needs.push('turnout');
      const snoozed = r.snoozed ?? {};
      const open = needs.filter((n) => !snoozed[n]);
      return {
        id: r.id, full_name: r.full_name, phone: r.phone, network: r.network, role: r.role, level: r.level, area_code: r.area_code,
        place: [r.unit_name, r.ward_name ? `${r.ward_name} ward` : null].filter(Boolean).join(' · ') || r.area_code,
        checked_in_at: r.checked_in_at, last_heard: r.last_heard, needs: open, followed: needs.filter((n) => snoozed[n]).map((n) => ({ need: n, at: snoozed[n] })),
      };
    });

    // Sub-areas: each with its coordinator, agents in place and people to follow up
    const len = childLength(area);
    const kids = len ? await this.db.system(
      len === 2
        ? `select s.code, s.name from public.states s where exists (select 1 from public.tenant_coverage c where c.tenant_id = $1
             and (c.level = 'national' or c.area_code = s.code or c.area_code like s.code || '-%')) order by s.name`
        : `select code, name from public.${({ 5: 'lgas', 8: 'wards', 12: 'polling_units' } as Record<number, string>)[len]}
            where code like $1 order by name`, len === 2 ? [u.tid] : [prefix]) : [];
    const children = kids.map((k) => {
      const inside = people.filter((p) => p.area_code === k.code || p.area_code.startsWith(k.code + '-'));
      const units = inside.filter((p) => p.level === 'pu');
      const coord = inside.find((p) => p.role === 'coordinator' && p.area_code === k.code);
      return { code: k.code, name: k.name, coordinator: coord ? { id: coord.id, full_name: coord.full_name } : null,
        agents: units.length, inPlace: units.filter((p) => p.checked_in_at).length, todo: inside.filter((p) => p.needs.length).length };
    }).filter((c) => c.agents || c.coordinator || c.todo);

    const [place] = area === 'NG' ? [{ name: 'Nigeria' }] : await this.db.system(
      `select coalesce((select name from public.states where code = $1), (select name from public.lgas where code = $1),
                       (select name from public.wards where code = $1)) as name`, [area]);
    const counts = Object.fromEntries(NEEDS.map((n) => [n, people.filter((p) => p.needs.includes(n)).length]));
    return {
      area, name: place?.name ?? area, scope, childLevel: len === 2 ? 'state' : len === 5 ? 'lga' : len === 8 ? 'ward' : 'pu',
      counts: { ...counts, any: people.filter((p) => p.needs.length).length, people: people.length },
      children, people: people.filter((p) => p.needs.length || p.followed.length),
      rules: { silentMinutes: SILENT_MIN, turnoutMinutes: TURNOUT_MIN, snoozeMinutes: SNOOZE_MIN },
    };
  }

  @Post('follow-ups') @HttpCode(204)
  @ApiOperation({ summary: 'Mark that you followed someone up about a need (they leave the list for an hour)' })
  async done(@CurrentUser() u: AuthUser, @Body() d: DoneDto) {
    await this.mustBeInArea(u, d.volunteerId);
    await this.db.system(`insert into public.follow_ups (tenant_id, volunteer_id, need, done_by, note) values ($1, $2, $3, $4, $5)`,
      [u.tid, d.volunteerId, d.need, u.mid, d.note ?? null]);
  }

  @Post('follow-ups/undo') @HttpCode(204)
  @ApiOperation({ summary: 'Undo your recent follow-ups of someone (they come back on the list)' })
  async undo(@CurrentUser() u: AuthUser, @Body() d: UndoDto) {
    await this.mustBeInArea(u, d.volunteerId);
    const SNOOZE_MIN = (await this.rules(u)).team.snoozeMin;
    await this.db.system(`delete from public.follow_ups where tenant_id = $1 and volunteer_id = $2 and done_at > now() - make_interval(mins => $3)`,
      [u.tid, d.volunteerId, SNOOZE_MIN]);
  }

  @Post('announce') @HttpCode(200)
  @ApiOperation({ summary: 'One message to the team: in the app, and by SMS to those not seen in the app for a while (Settings)' })
  async announce(@CurrentUser() u: AuthUser, @Body() d: AnnounceDto) {
    const scope = mapScope(u);
    this.check(scope, d.area);
    if (d.audience === 'list' && !d.ids?.length) throw new BadRequestException('Pick who it goes to');
    const prefix = d.area === 'NG' ? '%' : `${d.area}-%`;
    const people = await this.db.system(
      `select v.id, v.phone, (select max(dv.last_seen_at) from public.auth_devices dv where v.user_id is not null and dv.identity_id = v.user_id) as seen
         from public.volunteers v
        where v.tenant_id = $1 and v.status in ('active', 'invited') and v.role = any($2) and (v.area_code like $3 or v.area_code = $4)
          and v.id <> $5 and ($6::text <> 'coordinators' or v.role = 'coordinator') and ($7::uuid[] is null or v.id = any($7))`,
      [u.tid, FIELD, prefix, d.area, u.mid, d.audience, d.audience === 'list' ? d.ids : null]);
    if (!people.length) throw new BadRequestException('Nobody to send to in that area');
    const [me] = await this.db.system(`select full_name, role from public.volunteers where id = $1`, [u.mid]);
    const text = `${me?.full_name ?? 'Your coordinator'}: ${d.text.trim()}`;
    const smsAfter = (await this.rules(u)).alerts.smsAfterMin;
    const stale = (p: any) => !p.seen || Date.now() - new Date(p.seen).getTime() > smsAfter * 60_000;
    const sms = people.filter(stale);
    await this.db.system(
      `insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
       select $1, ch, x.id, 'raw', jsonb_build_object('text', $2::text)
         from unnest($3::uuid[], $4::text[]) as x(id, ch)`,
      [u.tid, text, [...people.map((p) => p.id), ...sms.map((p) => p.id)], [...people.map(() => 'push'), ...sms.map(() => 'sms')]]);
    // Also in the area's chat, so it stays where the team talks
    const [ch] = await this.db.system(`select id from public.channels where tenant_id = $1 and area_code = $2 and kind in ('ward', 'lga', 'state')`, [u.tid, d.area]);
    if (ch) await this.db.system(`insert into public.messages (tenant_id, channel_id, sender_id, kind, body) values ($1, $2, $3, 'text', $4)`,
      [u.tid, ch.id, u.mid, d.text.trim()]);
    return { sent: people.length, sms: sms.length, chat: !!ch };
  }

  /**
   * One person's work so far today, for their coordinator (or the room): where they are in the day, and a timeline of
   * what they did and reported (check-ins, checklist, figures, live count, result, IReV check, reports, call requests).
   */
  @Get('person/:id')
  @ApiOperation({ summary: "One person's day: stage reached, figures, reports, call requests and a timeline" })
  async person(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.mustBeInArea(u, id);
    const { live } = await this.db.asUser(u, (q) => elections(q, u.tid));
    const [p] = await this.db.system(
      `select v.id, v.full_name, v.phone, v.role, v.level, v.area_code, v.network, v.status, pu.name as unit_name, w.name as ward_name,
              greatest((select max(d.last_seen_at) from public.auth_devices d where d.identity_id = v.user_id),
                       (select st.updated_at from public.staff_status st where st.volunteer_id = v.id)) as last_seen
         from public.volunteers v left join public.polling_units pu on pu.code = v.area_code left join public.wards w on w.code = left(v.area_code, 8)
        where v.id = $1 and v.tenant_id = $2`, [id, u.tid]);
    if (!p) throw new NotFoundException();
    if (!live) return { person: p, day: null, timeline: [] };
    const args = [live, id];
    const [day] = await this.db.system(
      `select (select min(at) from public.checkins where election_id = $1 and volunteer_id = $2) as checked_in_at,
              (select count(*)::int from public.checklist_responses where election_id = $1 and volunteer_id = $2) as answers,
              (select max(reported_at) from public.unit_figure_updates where election_id = $1 and volunteer_id = $2 and figures ? 'accredited') as last_accreditation,
              (select (figures->>'accredited')::int from public.unit_figure_updates where election_id = $1 and volunteer_id = $2 and figures ? 'accredited' order by reported_at desc limit 1) as accredited,
              (select json_build_object('total', total, 'status', status, 'finished_at', finished_at) from public.live_counts where election_id = $1 and volunteer_id = $2 order by updated_at desc limit 1) as live_count,
              (select json_build_object('at', submitted_at, 'status', status, 'total_valid', total_valid) from public.result_submissions where election_id = $1 and volunteer_id = $2 order by version desc limit 1) as result,
              (select json_build_object('status', status, 'at', coalesce(answered_at, asked_at)) from public.irev_unit_checks where election_id = $1 and volunteer_id = $2 order by asked_at desc limit 1) as irev,
              (select count(*)::int from public.incidents where election_id = $1 and volunteer_id = $2) as reports`, args);
    const timeline = await this.db.system(
      `select * from (
         select at, 'checkin' as kind, case when inside is false then 'Checked in outside their area' else 'Checked in' end as text, null::text as detail from public.checkins where election_id = $1 and volunteer_id = $2
         union all select max(at), 'checklist', count(*) || ' checklist answers', null from public.checklist_responses where election_id = $1 and volunteer_id = $2 having count(*) > 0
         union all select reported_at, 'figures', case stage when 'accreditation' then 'Accredited so far: ' || (figures->>'accredited') else 'Sent ' || stage || ' figures' end, null
           from public.unit_figure_updates where election_id = $1 and volunteer_id = $2
         union all select coalesce(finished_at, started_at), 'count', case when finished_at is null then 'Started the live count' else 'Finished the live count: ' || total || ' ballots' end, null
           from public.live_counts where election_id = $1 and volunteer_id = $2
         union all select submitted_at, 'result', 'Sent the result' || case when version > 1 then ' (correction ' || version || ')' else '' end, status from public.result_submissions where election_id = $1 and volunteer_id = $2
         union all select answered_at, 'irev', case status when 'matches' then 'IReV matches their sheet' else 'IReV is different from their sheet' end, note
           from public.irev_unit_checks where election_id = $1 and volunteer_id = $2 and answered_at is not null
         union all select i.reported_at, case when i.is_sos then 'sos' else 'report' end, case when i.is_sos then 'SOS' else coalesce(c.label, i.category) end, i.description
           from public.incidents i left join public.incident_categories c on c.code = i.category where i.election_id = $1 and i.volunteer_id = $2
         union all select created_at, 'callback', 'Asked to be called', coalesce(note, reason) from public.callback_requests where election_id = $1 and requester_id = $2
       ) t where at is not null order by at desc limit 60`, args);
    return { person: p, day, timeline };
  }

  private check(scope: string, area: string) {
    if (!/^(NG|\d{2}(-\d{2}){0,2})$/.test(area)) throw new BadRequestException('Unknown area');
    if (!inScope(scope, area)) throw new ForbiddenException('That area is outside yours');
  }
  private async rules(u: AuthUser) { return rulesOf(await tenantSettings(this.db, u.tid)); }

  private async mustBeInArea(u: AuthUser, id: string) {
    const [v] = await this.db.system(`select area_code from public.volunteers where id = $1 and tenant_id = $2`, [id, u.tid]);
    if (!v || !inScope(mapScope(u), v.area_code)) throw new ForbiddenException('That person is outside your area');
  }
}
