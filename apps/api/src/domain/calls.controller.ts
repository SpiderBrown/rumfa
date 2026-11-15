import { BadRequestException, Body, Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { ProvidersService } from '../common/providers.service';
import { FIELD, ROOM } from './roles';
import { requireCallMode } from '../common/tenant-settings';

class PrepareDto {
  @ApiProperty({ enum: ['volunteer', 'contact'] }) @IsIn(['volunteer', 'contact']) target: string;
  @ApiProperty() @IsUUID() id: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() caseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class BridgeDto {
  @ApiProperty() @IsUUID() volunteerId: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() caseId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@ApiTags('Calls')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(private readonly db: Db, private readonly providers: ProvidersService) {}

  @Post('token') @HttpCode(200)
  @ApiOperation({ summary: 'Internet calling token (dashboard headset calls; agent app when the organisation allows it)' })
  async token(@CurrentUser() u: AuthUser) {
    if (FIELD.includes(u.role)) await requireCallMode(this.db, u.tid, 'webrtc');
    return this.providers.atCapabilityToken(`v${u.mid.replaceAll('-', '').slice(0, 20)}`);
  }

  /** Registers an outgoing call to someone the caller can see; the voice webhook only dials registered numbers. */
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
    const sessionId = await this.providers.atMakeCall(me.phone, call.id);
    await this.db.system(`update public.calls set provider_session_id = $2, status = 'ringing' where id = $1`, [call.id, sessionId]);
    return { callId: call.id, bridged: true };
  }
}
