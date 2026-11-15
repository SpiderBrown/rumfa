import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { callFn, selectFn } from '../common/fn';
import { ROOM, SUPERVISORS } from './roles';

class TextDto { @ApiProperty() @IsString() @MinLength(1) @MaxLength(4000) text: string; }
class SeverityDto {
  @ApiProperty({ enum: ['critical', 'high', 'medium', 'low'] }) @IsIn(['critical', 'high', 'medium', 'low']) severity: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(1000) reason: string;
}
class ToDto { @ApiProperty() @IsUUID() to: string; }
class TaskDto { @ApiProperty() @IsUUID() to: string; @ApiProperty() @IsString() @MinLength(1) @MaxLength(1000) text: string; }
class MergeDto { @ApiProperty({ description: 'The case this one is merged into' }) @IsUUID() target: string; }
class NextDto { @ApiPropertyOptional() @IsOptional() @IsUUID() queueId?: string; }
class DecideDto { @ApiProperty() @IsBoolean() accept: boolean; }
class LiveViewDto { @ApiProperty() @IsUUID() agentId: string; }

@ApiTags('Cases')
@ApiBearerAuth()
@Controller()
export class CasesController {
  constructor(private readonly db: Db) {}

  /** Cases the caller may see (the database decides by role and area). */
  @Get('cases')
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string, @Query('queue') queue?: string, @Query('mine') mine?: string) {
    return this.db.asUser(user, (q) => q(
      `select * from public.cases
        where tenant_id = $1
          and ($2::text is null or status = any(string_to_array($2, ',')))
          and ($3::uuid is null or queue_id = $3)
          and ($4::boolean is not true or assigned_to = $5)
        order by created_at desc limit 500`,
      [user.tid, status || null, queue || null, mine === 'true', user.mid]));
  }

  @Get('queues/counts') @Roles(...ROOM)
  counts(@CurrentUser() user: AuthUser) {
    return this.db.asUser(user, (q) => selectFn(q, 'queue_counts'));
  }

  @Post('cases/next') @HttpCode(200) @Roles(...ROOM)
  @ApiOperation({ summary: 'Take the next case from a queue (or your own queues)' })
  async next(@CurrentUser() user: AuthUser, @Body() dto: NextDto) {
    return { caseId: await this.db.asUser(user, (q) => callFn(q, 'take_next_case', { p_queue: dto.queueId ?? null })) };
  }

  @Get('cases/:id')
  @ApiOperation({ summary: 'Case with its reports, alerts, timeline, people to call and contacts' })
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(user, async (q) => {
      const [c] = await q(`select * from public.cases where id = $1 and tenant_id = $2`, [id, user.tid]);
      if (!c) throw new NotFoundException('Case not found');
      // One connection per transaction: queries run one after another
      const incidents = await q(
        `select i.*, json_build_object('id', v.id, 'full_name', v.full_name, 'phone', v.phone, 'role', v.role, 'level', v.level, 'area_code', v.area_code) as volunteer
           from public.incidents i left join public.volunteers v on v.id = i.volunteer_id where i.case_id = $1 order by i.reported_at`, [id]);
      const alerts = await q(`select * from public.alerts where case_id = $1 order by created_at`, [id]);
      const events = await q(`select * from public.case_events where case_id = $1 order by at desc`, [id]);
      const suggestions = await q(
        `select s.*, r.title as related_title from public.case_suggestions s left join public.cases r on r.id = s.related_case_id where s.case_id = $1`, [id]);
      const [channel] = await q(`select id from public.channels where case_id = $1`, [id]);
      const [liveView] = await q(`select * from public.live_view_requests where case_id = $1 order by created_at desc limit 1`, [id]);
      const [result] = c.pu_code
        ? await q(`select id, version from public.result_submissions where pu_code = $1 and tenant_id = $2 order by version desc limit 1`, [c.pu_code, user.tid])
        : [];
      const messages = channel ? await q(`select * from public.messages where channel_id = $1 order by created_at`, [channel.id]) : [];
      // Coordinator chain above the unit (ward, LGA, state), people at the unit, and contacts for the area
      const chain = chainOf(c.area_code);
      const people = await q(
        `select id, full_name, phone, role, level, area_code, deputy_of from public.volunteers
          where tenant_id = $1 and status = 'active'
            and ((role = 'coordinator' and area_code = any($2)) or ($3::text is not null and area_code = $3))`,
        [user.tid, chain, c.pu_code ?? null]);
      const contacts = await q(
        `select id, agency, title, person_name, level, area_code, status, source_type, last_call_ok_at from public.authority_contacts
          where tenant_id = $1 and area_code = any($2) and status <> 'rejected'`, [user.tid, [...chain, 'NG']]);
      const mergeTargets = ROOM.includes(user.role) ? await q(
        `select id, title, status, severity, pu_code, area_code, created_at from public.cases
          where tenant_id = $1 and category = $2 and id <> $3 and status in ('queued','assigned','in_progress','escalated')
            and area_code like $4 || '%' order by created_at desc limit 20`,
        [user.tid, c.category, id, c.area_code.slice(0, 8)]) : [];
      return { case: c, incidents, alerts, events, suggestions, channelId: channel?.id ?? null, messages, liveView: liveView ?? null,
               latestResult: result ?? null, people, contacts, mergeTargets };
    });
  }

  private act(user: AuthUser, fn: string, args: Record<string, unknown>) {
    return this.db.asUser(user, (q) => callFn(q, fn, args));
  }

  @Post('cases/:id/acknowledge') @HttpCode(204) @Roles(...ROOM)
  async ack(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { await this.act(u, 'acknowledge_case', { p_case: id }); }

  @Post('cases/:id/notes') @HttpCode(204)
  async note(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: TextDto) { await this.act(u, 'add_case_note', { p_case: id, p_body: b.text }); }

  @Post('cases/:id/resolve') @HttpCode(204) @Roles(...ROOM)
  async resolve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: TextDto) { await this.act(u, 'resolve_case', { p_case: id, p_outcome: b.text }); }

  @Post('cases/:id/close') @HttpCode(204) @Roles(...SUPERVISORS)
  async close(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { await this.act(u, 'close_case', { p_case: id }); }

  @Post('cases/:id/reopen') @HttpCode(204) @Roles(...ROOM)
  async reopen(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: TextDto) { await this.act(u, 'reopen_case', { p_case: id, p_reason: b.text }); }

  @Post('cases/:id/escalate') @HttpCode(204) @Roles(...ROOM)
  async escalate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: TextDto) { await this.act(u, 'escalate_case', { p_case: id, p_reason: b.text }); }

  @Post('cases/:id/severity') @HttpCode(204) @Roles(...ROOM)
  async severity(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: SeverityDto) {
    await this.act(u, 'change_case_severity', { p_case: id, p_severity: b.severity, p_reason: b.reason });
  }

  @Post('cases/:id/reassign') @HttpCode(204) @Roles(...SUPERVISORS)
  async reassign(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: ToDto) { await this.act(u, 'reassign_case', { p_case: id, p_to: b.to }); }

  @Post('cases/:id/tasks') @HttpCode(204) @Roles(...ROOM)
  @ApiOperation({ summary: 'Send a task to someone in the field (app and SMS)' })
  async task(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: TaskDto) { await this.act(u, 'send_case_task', { p_case: id, p_to: b.to, p_body: b.text }); }

  @Post('cases/:id/merge') @HttpCode(204) @Roles(...SUPERVISORS)
  async merge(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: MergeDto) { await this.act(u, 'merge_cases', { p_source: id, p_target: b.target }); }

  @Post('case-merges/:id/undo') @HttpCode(204) @Roles(...SUPERVISORS)
  async undo(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { await this.act(u, 'undo_merge', { p_merge: id }); }

  @Post('case-suggestions/:id/decide') @HttpCode(204) @Roles(...SUPERVISORS)
  async decide(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: DecideDto) { await this.act(u, 'decide_suggestion', { p_suggestion: id, p_accept: b.accept }); }

  @Post('cases/:id/live-view') @Roles(...ROOM)
  @ApiOperation({ summary: 'Ask the agent at the unit to show it on video' })
  async liveView(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() b: LiveViewDto) {
    return { requestId: await this.act(u, 'request_live_view', { p_case: id, p_agent: b.agentId }) };
  }
}

/** '19-28-02-003' → ['19-28-02', '19-28', '19'] (the coordinator levels above a unit, nearest first). */
export function chainOf(area: string): string[] {
  const parts = area.split('-');
  const out: string[] = [];
  for (let n = Math.min(parts.length, 3); n >= 1; n--) out.push(parts.slice(0, n).join('-'));
  return out;
}
