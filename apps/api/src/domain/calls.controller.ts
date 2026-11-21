import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { ProvidersService } from '../common/providers.service';
import { FIELD, ROOM } from './roles';
import { AppCallsService } from './app-calls.service';
import { requireCallMode } from '../common/tenant-settings';

class PrepareDto {
  @ApiProperty({ enum: ['volunteer', 'contact'] }) @IsIn(['volunteer', 'contact']) target: string;
  @ApiProperty() @IsUUID() id: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() caseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class AppCallDto {
  @ApiProperty() @IsUUID() volunteerId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() caseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class EndDto { @ApiPropertyOptional({ enum: ['hangup', 'declined', 'timeout'] }) @IsOptional() @IsIn(['hangup', 'declined', 'timeout']) reason?: 'hangup' | 'declined' | 'timeout'; }
class BridgeDto {
  @ApiProperty() @IsUUID() volunteerId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() caseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@ApiTags('Calls')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(private readonly db: Db, private readonly providers: ProvidersService, private readonly appCalls: AppCallsService) {}

  @Post('token') @HttpCode(200)
  @ApiOperation({ summary: 'Internet calling token (dashboard headset calls; agent app when the organisation allows it)' })
  async token(@CurrentUser() u: AuthUser) {
    if (FIELD.includes(u.role)) await requireCallMode(this.db, u.tid, 'webrtc');
    return this.providers.atCapabilityToken(`v${u.mid.replaceAll('-', '').slice(0, 20)}`);
  }

  /** Registers an outgoing call to someone the caller can see; the voice webhook only dials registered numbers. */
  /** Recent calls for the call log in Messages: Room staff see all of the client's calls. */
  @Get('log') @Roles(...ROOM)
  log(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(
      `select c.id, c.caller_id, c.callee_id, c.route, c.status, c.duration_s, c.reason, c.case_id, c.callback_id, c.started_at, c.contact_id,
              a.full_name as caller_name, a.role as caller_role, b.full_name as callee_name, b.role as callee_role,
              k.agency as contact_agency, k.title as contact_title
         from public.calls c left join public.volunteers a on a.id = c.caller_id left join public.volunteers b on b.id = c.callee_id
         left join public.authority_contacts k on k.id = c.contact_id
        where c.tenant_id = $1 order by c.started_at desc limit 150`, [u.tid]));
  }

  @Post('prepare') @HttpCode(200) @Roles(...ROOM, 'coordinator')
  async prepare(@CurrentUser() u: AuthUser, @Body() d: PrepareDto) {
    const target = await this.db.asUser(u, async (q) => {
      if (d.caseId && !(await q(`select 1 from public.cases where id = $1`, [d.caseId])).length) throw new NotFoundException('Case not found');
      const sql = d.target === 'volunteer'
        ? `select id, phone from public.volunteers where id = $1 and tenant_id = $2`
        : `select id, phone from public.authority_contacts where id = $1 and tenant_id = $2 and status <> 'rejected'`;
      return (await q(sql, [d.id, u.tid]))[0];
    });
    if (!target?.phone) throw new NotFoundException('Not found');
    const [call] = await this.db.system(
      `insert into public.calls (tenant_id, case_id, contact_id, caller_id, callee_id, to_phone, route, reason)
       values ($1, $2, $3, $4, $5, $6, 'webrtc_pstn', $7) returning id`,
      [u.tid, d.caseId ?? null, d.target === 'contact' ? target.id : null, u.mid, d.target === 'volunteer' ? target.id : null, target.phone, d.reason ?? null]);
    if (d.caseId) {
      await this.db.system(`select public.svc_case_event($1, 'call', $2, $3, $4)`,
        [d.caseId, d.reason ?? null, JSON.stringify({ call_id: call.id, to: target.id }), u.mid]);
    }
    return { callId: call.id, phone: target.phone };
  }

  /** Bridged call between two app users over the phone network (when data is too poor for an in-app call). */
  @Post('bridge') @HttpCode(200)
  async bridge(@CurrentUser() u: AuthUser, @Body() d: BridgeDto) {
    if (FIELD.includes(u.role)) await requireCallMode(this.db, u.tid, 'bridged');
    const [other] = await this.db.asUser(u, (q) => q(`select id, phone from public.volunteers where id = $1 and tenant_id = $2`, [d.volunteerId, u.tid]));
    if (!other) throw new NotFoundException('Person not found');
    const [me] = await this.db.system(`select phone from public.volunteers where id = $1`, [u.mid]);
    if (!me) throw new BadRequestException();
    const [call] = await this.db.system(
      `insert into public.calls (tenant_id, case_id, caller_id, callee_id, to_phone, route, reason)
       values ($1, $2, $3, $4, $5, 'bridged', $6) returning id`,
      [u.tid, d.caseId ?? null, u.mid, other.id, other.phone, d.reason ?? 'in-app fallback']);
    try {
      const sessionId = await this.providers.atMakeCall(me.phone, call.id);
      await this.db.system(`update public.calls set provider_session_id = $2, status = 'ringing' where id = $1`, [call.id, sessionId]);
    } catch (e) {
      await this.db.system(`update public.calls set status = 'failed', ended_at = now() where id = $1`, [call.id]);
      throw e;
    }
    return { callId: call.id, bridged: true };
  }

  // ---- App calls (free, over the internet through LiveKit) -------------------------------------------
  /** Rings someone the caller can see. From a chat, use POST /channels/:id/call with mode 'inapp'. */
  @Post('app') @HttpCode(200)
  @ApiOperation({ summary: 'Start a free app call to someone you can see' })
  async startApp(@CurrentUser() u: AuthUser, @Body() d: AppCallDto) {
    const [v] = await this.db.asUser(u, async (q) => {
      if (d.caseId && !(await q(`select 1 from public.cases where id = $1`, [d.caseId])).length) throw new NotFoundException('Case not found');
      return q(`select id from public.volunteers where id = $1 and tenant_id = $2`, [d.volunteerId, u.tid]);
    });
    if (!v) throw new NotFoundException('Person not found');
    return this.appCalls.start(u, v.id, { caseId: d.caseId, reason: d.reason });
  }

  @Get('app/incoming')
  incoming(@CurrentUser() u: AuthUser) { return this.appCalls.incoming(u); }

  @Get('app/:id')
  getApp(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.appCalls.get(u, id); }

  @Post('app/:id/answer') @HttpCode(200)
  answer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.appCalls.answer(u, id); }

  @Post('app/:id/end') @HttpCode(200)
  end(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: EndDto) { return this.appCalls.end(u, id, d.reason); }
}
