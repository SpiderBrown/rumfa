// Field tasks for coordinators: from the room, or made by Rumfa from what the team reports (an agent not checked
// in once voting starts, a problem at one of their units). They clear by themselves when the right thing happens;
// the coordinator says where they are with it (on my way, arrived, done) and can add notes. The room sees it all.
import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { ROOM } from './roles';

const STEPS = ['open', 'on_way', 'arrived', 'done'] as const;
const STEP_TEXT: Record<string, string> = { open: 'Back to open', on_way: 'On my way', arrived: 'Arrived', done: 'Done' };

class StatusDto {
  @ApiProperty({ enum: STEPS }) @IsIn(STEPS as unknown as string[]) status: (typeof STEPS)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class NoteDto { @ApiProperty() @IsString() @Length(1, 1000) body: string; }

const COLS = `t.id, t.kind, t.title, t.body, t.priority, t.status, t.pu_code, t.case_id, t.created_at, t.seen_at, t.on_way_at, t.arrived_at,
  t.done_at, t.cleared_at, t.cleared_reason, t.assignee_id,
  pu.name as pu_name, pu.lat as pu_lat, pu.lng as pu_lng,
  case when a.id is null then null else json_build_object('id', a.id, 'full_name', a.full_name, 'phone', a.phone, 'role', a.role, 'area_code', a.area_code) end as about,
  (select v.full_name from public.volunteers v where v.id = t.created_by) as created_by_name,
  (select c.status from public.cases c where c.id = t.case_id) as case_status,
  (select n.body from public.field_task_notes n where n.task_id = t.id order by n.at desc limit 1) as last_note`;
const FROM = `from public.field_tasks t left join public.volunteers a on a.id = t.about_id left join public.polling_units pu on pu.code = t.pu_code`;

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private readonly db: Db) {}

  @Get('mine') @Roles('coordinator', 'agent', 'volunteer')
  @ApiOperation({ summary: 'My tasks: open ones first (urgent first), then the latest finished or cleared' })
  mine(@CurrentUser() u: AuthUser, @Query('all') all?: string) {
    return this.db.system(
      `select ${COLS} ${FROM}
        where t.tenant_id = $1 and t.assignee_id = $2 and (t.status not in ('done', 'cleared') or ($3 and t.created_at > now() - interval '2 days'))
        order by (t.status in ('done', 'cleared')), case t.priority when 'urgent' then 0 when 'high' then 1 else 2 end, t.created_at desc limit 100`,
      [u.tid, u.mid, all === '1' || all === 'true']);
  }

  @Get('about/:volunteerId') @Roles('coordinator', ...ROOM)
  @ApiOperation({ summary: 'Tasks about one person (for their profile page)' })
  about(@CurrentUser() u: AuthUser, @Param('volunteerId', ParseUUIDPipe) id: string) {
    return this.db.system(
      `select ${COLS} ${FROM} where t.tenant_id = $1 and t.about_id = $2 and (t.assignee_id = $3 or $4) order by t.created_at desc limit 30`,
      [u.tid, id, u.mid, ROOM.includes(u.role as never)]);
  }

  @Get(':id') @Roles('coordinator', 'agent', 'volunteer', ...ROOM)
  @ApiOperation({ summary: 'One task with its notes; opening it as the assignee marks it seen' })
  async one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const t = await this.find(u, id);
    if (t.assignee_id === u.mid && !t.seen_at) {
      await this.db.system(`update public.field_tasks set seen_at = now() where id = $1 and seen_at is null`, [id]);
      t.seen_at = new Date().toISOString();
    }
    const notes = await this.db.system(
      `select n.id, n.kind, n.body, n.at, v.full_name as author from public.field_task_notes n left join public.volunteers v on v.id = n.author_id
        where n.task_id = $1 order by n.at`, [id]);
    return { ...t, notes };
  }

  @Post(':id/status') @HttpCode(200) @Roles('coordinator', 'agent', 'volunteer')
  @ApiOperation({ summary: 'Where I am with it: on my way, arrived, done (or back to open)' })
  async status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: StatusDto) {
    const t = await this.find(u, id);
    if (t.assignee_id !== u.mid) throw new ForbiddenException('Not your task');
    const col = ({ on_way: 'on_way_at', arrived: 'arrived_at', done: 'done_at' } as Record<string, string>)[d.status];
    await this.db.system(
      `update public.field_tasks set status = $2, seen_at = coalesce(seen_at, now())${col ? `, ${col} = coalesce(${col}, now())` : ''},
              cleared_at = null, cleared_reason = null where id = $1`, [id, d.status]);
    await this.note(u, id, `${STEP_TEXT[d.status]}${d.note?.trim() ? `: ${d.note.trim()}` : ''}`, 'status');
    // Tell the room on the case when there is one
    if (t.case_id) {
      await this.db.system(
        `insert into public.case_events (tenant_id, case_id, kind, actor_id, body, data) values ($1, $2, 'note', $3, $4, $5)`,
        [u.tid, t.case_id, u.mid, `Task: ${STEP_TEXT[d.status]}${d.note?.trim() ? ` (${d.note.trim()})` : ''}`, JSON.stringify({ task_id: id, status: d.status })]);
    }
    return this.one(u, id);
  }

  @Post(':id/notes') @HttpCode(200) @Roles('coordinator', 'agent', 'volunteer', ...ROOM)
  @ApiOperation({ summary: 'Add a note, e.g. "agent not reachable", "I am going to the PU"' })
  async addNote(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto) {
    const t = await this.find(u, id);
    await this.note(u, id, d.body.trim(), 'note');
    if (t.case_id) {
      await this.db.system(`insert into public.case_events (tenant_id, case_id, kind, actor_id, body, data) values ($1, $2, 'note', $3, $4, $5)`,
        [u.tid, t.case_id, u.mid, `Task note: ${d.body.trim()}`, JSON.stringify({ task_id: id })]);
    }
    return this.one(u, id);
  }

  private async note(u: AuthUser, id: string, body: string, kind: 'note' | 'status') {
    await this.db.system(`insert into public.field_task_notes (tenant_id, task_id, author_id, kind, body) values ($1, $2, $3, $4, $5)`,
      [u.tid, id, u.mid, kind, body]);
  }

  private async find(u: AuthUser, id: string) {
    const [t] = await this.db.system(`select ${COLS} ${FROM} where t.id = $1 and t.tenant_id = $2`, [id, u.tid]);
    if (!t) throw new NotFoundException();
    if (t.assignee_id !== u.mid && !ROOM.includes(u.role as never)) throw new NotFoundException();
    return t;
  }
}
