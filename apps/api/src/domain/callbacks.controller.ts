import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { ProvidersService } from '../common/providers.service';
import { callFn } from '../common/fn';
import { ROOM } from './roles';

class RequestDto {
  @ApiProperty({ enum: ['form', 'unit', 'app', 'other'] }) @IsIn(['form', 'unit', 'app', 'other']) reason: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) voiceNotePath?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class CompleteDto {
  @ApiProperty() @IsBoolean() answered: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) outcome?: string;
}
class ConvertDto {
  @ApiProperty() @IsString() @MaxLength(40) category: string;
  @ApiProperty() @IsString() @MaxLength(2000) note: string;
}

@ApiTags('Callbacks')
@ApiBearerAuth()
@Controller('callbacks')
export class CallbacksController {
  constructor(private readonly db: Db, private readonly providers: ProvidersService) {}

  @Post() @Roles('agent', 'volunteer', 'coordinator')
  @ApiOperation({ summary: 'Ask my coordinator to call me back on my phone line' })
  request(@CurrentUser() u: AuthUser, @Body() d: RequestDto) {
    if (d.voiceNotePath && !d.voiceNotePath.startsWith(`${u.tid}/`)) throw new BadRequestException('Unknown file');
    return this.db.asUser(u, async (q) => {
      const r = await callFn<any>(q, 'request_callback', { p_reason: d.reason, p_voice_note: d.voiceNotePath ?? null });
      const id = r?.id ?? r?.callback_id;
      if (d.note?.trim() && id) await this.db.system(`update public.callback_requests set note = $3 where id = $1 and requester_id = $2`, [id, u.mid, d.note.trim()]);
      return r;
    });
  }

  @Get('mine')
  async mine(@CurrentUser() u: AuthUser) {
    const [row] = await this.db.asUser(u, (q) => q(
      `select * from public.callback_requests where requester_id = $1 and status in ('waiting','calling','no_answer','escalated')
        order by created_at desc limit 1`, [u.mid]));
    return row ?? null;
  }

  /** Requests the caller handles: coordinators their area, room staff escalated ones (the database decides). */
  @Get() @Roles('coordinator', ...ROOM)
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('mine') mine?: string, @Query('sinceHours') sinceHours?: string) {
    return this.db.asUser(u, (q) => q(
      `select c.*, json_build_object('id', v.id, 'full_name', v.full_name, 'phone', v.phone, 'area_code', v.area_code) as requester
         from public.callback_requests c join public.volunteers v on v.id = c.requester_id
        where c.tenant_id = $1 and ($2::text is null or c.status = any(string_to_array($2, ',')))
          and ($3::boolean is not true or c.assigned_to = $4)
          and ($5::int is null or c.updated_at >= now() - make_interval(hours => $5))
        order by c.due_at nulls last, c.created_at limit 300`,
      [u.tid, status || null, mine === 'true', u.mid, sinceHours ? Number(sinceHours) : null]));
  }

  @Post(':id/cancel') @HttpCode(204)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.asUser(u, (q) => callFn(q, 'cancel_callback', { p_id: id }));
  }

  @Post(':id/complete') @HttpCode(204) @Roles('coordinator', ...ROOM)
  async complete(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: CompleteDto) {
    await this.db.asUser(u, (q) => callFn(q, 'complete_callback', { p_id: id, p_answered: d.answered, p_outcome: d.outcome ?? null }));
  }

  @Post(':id/convert') @Roles(...ROOM)
  async convert(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ConvertDto) {
    return { caseId: await this.db.asUser(u, (q) => callFn(q, 'convert_callback_to_case', { p_id: id, p_category: d.category, p_note: d.note })) };
  }

  /** Marks a request as being called (one more try), whatever kind of call the caller then places. */
  @Post(':id/start') @HttpCode(204) @Roles('coordinator', ...ROOM)
  async start(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.asUser(u, (q) => callFn(q, 'start_callback', { p_id: id }));
  }

  /**
   * Bridged GSM call: our number rings the coordinator first, then connects the agent. If the provider
   * cannot place the call, the request goes back to waiting and the number is returned for a direct call.
   */
  @Post(':id/call') @HttpCode(200) @Roles('coordinator', ...ROOM)
  async call(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const info = await this.db.asUser(u, (q) => callFn(q, 'start_callback', { p_id: id }));
    const [call] = await this.db.system(
      `insert into public.calls (tenant_id, callback_id, caller_id, callee_id, to_phone, route, reason)
       values ($1, $2, $3, $4, $5, 'bridged', 'callback') returning id`,
      [info.tenant_id, id, info.caller_id, info.callee_id, info.callee_phone]);
    try {
      const sessionId = await this.providers.atMakeCall(info.caller_phone, call.id);
      await this.db.system(`update public.calls set provider_session_id = $2, status = 'ringing' where id = $1`, [call.id, sessionId]);
      return { callId: call.id, bridged: true };
    } catch (e) {
      await this.db.system(`update public.calls set status = 'failed' where id = $1`, [call.id]);
      await this.db.system(`update public.callback_requests set status = 'waiting' where id = $1`, [id]);
      return { callId: call.id, bridged: false, dialDirect: info.callee_phone, error: (e as Error).message };
    }
  }
}
