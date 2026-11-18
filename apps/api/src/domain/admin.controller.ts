import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Addon, CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { callFn } from '../common/fn';
import { ROOM } from './roles';

// ---- Queues and shifts -----------------------------------------------------------------------------
class ShiftDto {
  @ApiProperty() @IsUUID() volunteerId: string;
  @ApiProperty() @IsUUID() queueId: string;
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiProperty() @IsDateString() endsAt: string;
  @ApiProperty({ enum: ['operator', 'supervisor', 'overflow'] }) @IsIn(['operator', 'supervisor', 'overflow']) role: string;
}
class QueueDto { @ApiProperty() @IsInt() @Min(0) @Max(10000) overflowLimit: number; }

@ApiTags('Queues and shifts')
@ApiBearerAuth()
@Controller()
@Roles(...ROOM)
export class ShiftsController {
  constructor(private readonly db: Db) {}

  @Get('queues')
  queues(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(`select * from public.queues where tenant_id = $1 order by kind, name`, [u.tid]));
  }

  @Patch('queues/:id') @Roles('supervisor', 'admin')
  async queue(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: QueueDto) {
    const [row] = await this.db.asUser(u, (q) => q(`update public.queues set overflow_limit = $2 where id = $1 and tenant_id = $3 returning *`, [id, d.overflowLimit, u.tid]));
    if (!row) throw new BadRequestException('Queue not found');
    return row;
  }

  @Get('shifts')
  shifts(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(
      `select s.*, v.full_name, qu.name as queue_name from public.shifts s
         join public.volunteers v on v.id = s.volunteer_id join public.queues qu on qu.id = s.queue_id
        where s.tenant_id = $1 and s.ends_at >= now() order by s.starts_at limit 2000`, [u.tid]));
  }

  @Post('shifts') @Roles('supervisor', 'admin')
  async addShift(@CurrentUser() u: AuthUser, @Body() d: ShiftDto) {
    const [row] = await this.db.asUser(u, (q) => q(
      `insert into public.shifts (tenant_id, volunteer_id, queue_id, starts_at, ends_at, role) values ($1, $2, $3, $4, $5, $6) returning *`,
      [u.tid, d.volunteerId, d.queueId, d.startsAt, d.endsAt, d.role]));
    return row;
  }

  @Delete('shifts/:id') @HttpCode(204) @Roles('supervisor', 'admin')
  async removeShift(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.asUser(u, (q) => q(`delete from public.shifts where id = $1 and tenant_id = $2`, [id, u.tid]));
  }
}

// ---- Airtime and data top-ups (admins; a second admin approves) ------------------------------------
class PlanDto {
  @ApiProperty() @IsString() @MaxLength(120) name: string;
  @ApiProperty({ enum: ['airtime', 'data'] }) @IsIn(['airtime', 'data']) kind: string;
  @ApiProperty({ description: 'Naira per person, chosen by the admin' }) @IsInt() @Min(50) @Max(1_000_000) amountNgn: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) dataPlanCode?: string;
  @ApiProperty() @IsArray() @ArrayMaxSize(10) @IsIn(['agent', 'volunteer', 'coordinator', 'operator', 'supervisor', 'analyst', 'legal', 'security', 'voice_ops', 'admin'], { each: true }) targetRoles: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) targetAreaCodes?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() onboardedOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsDateString() scheduledFor?: string;
}
class BatchDto { @ApiProperty() @IsUUID() planId: string; }
class ApproveDto { @ApiProperty() @IsBoolean() approve: boolean; }

@ApiTags('Top-ups')
@ApiBearerAuth()
@Controller('topups')
@Roles('admin')
@Addon('airtime')
export class TopupsController {
  constructor(private readonly db: Db) {}

  @Get('plans')
  plans(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(`select * from public.topup_plans where tenant_id = $1 order by created_at desc`, [u.tid]));
  }

  @Post('plans')
  async addPlan(@CurrentUser() u: AuthUser, @Body() d: PlanDto) {
    const [row] = await this.db.asUser(u, (q) => q(
      `insert into public.topup_plans (tenant_id, name, kind, amount_ngn, data_plan_code, target_roles, target_area_codes, onboarded_only, scheduled_for, created_by)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::text[], '{}'), coalesce($8::boolean, true), $9, $10) returning *`,
      [u.tid, d.name, d.kind, d.amountNgn, d.dataPlanCode ?? null, d.targetRoles, d.targetAreaCodes ?? null, d.onboardedOnly ?? null, d.scheduledFor ?? null, u.mid]));
    return row;
  }

  @Get('batches')
  batches(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(
      `select b.*, p.name as plan_name,
              (select json_object_agg(status, n) from (select status, count(*) n from public.topups t where t.batch_id = b.id group by status) s) as counts
         from public.topup_batches b join public.topup_plans p on p.id = b.plan_id
        where b.tenant_id = $1 order by b.created_at desc`, [u.tid]));
  }

  @Post('batches')
  async createBatch(@CurrentUser() u: AuthUser, @Body() d: BatchDto) {
    return { batchId: await this.db.asUser(u, (q) => callFn(q, 'create_topup_batch', { p_plan: d.planId })) };
  }

  @Post('batches/:id/approve') @HttpCode(204)
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ApproveDto) {
    await this.db.asUser(u, (q) => callFn(q, 'approve_topup_batch', { p_batch: id, p_approve: d.approve }));
  }
}

// ---- Voice outreach (consented real recordings only) ----------------------------------------------
class RecordingDto {
  @ApiProperty() @IsString() @MaxLength(120) speaker: string;
  @ApiProperty() @IsString() @MaxLength(200) title: string;
  @ApiProperty() @IsString() @MaxLength(5) language: string;
  @ApiProperty({ description: 'Path from POST /media/upload-url (kind voice_recording)' }) @IsString() @MaxLength(300) storagePath: string;
  @ApiProperty({ description: 'Signed release form, same way' }) @IsString() @MaxLength(300) consentDocPath: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(600) durationS?: number;
}
class CampaignDto {
  @ApiProperty() @IsString() @MaxLength(200) name: string;
  @ApiProperty({ description: 'language → recording id' }) @IsObject() recordings: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsObject() audience?: Record<string, unknown>;
  @ApiProperty() @IsDateString() startsOn: string;
  @ApiProperty() @IsDateString() endsOn: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{2}:\d{2}$/) dailyStart?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{2}:\d{2}$/) dailyEnd?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(5) maxAttempts?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(600) callsPerMinute?: number;
}
class CampaignStatusDto { @ApiProperty({ enum: ['approved', 'running', 'paused', 'done'] }) @IsIn(['approved', 'running', 'paused', 'done']) status: string; }

@ApiTags('Voice outreach')
@ApiBearerAuth()
@Controller('voice')
@Roles('voice_ops', 'admin')
@Addon('voice')
export class VoiceController {
  constructor(private readonly db: Db) {}

  @Get('recordings')
  recordings(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(`select * from public.voice_recordings where tenant_id = $1 order by created_at desc`, [u.tid]));
  }

  @Post('recordings')
  async addRecording(@CurrentUser() u: AuthUser, @Body() d: RecordingDto) {
    if (![d.storagePath, d.consentDocPath].every((p) => p.startsWith(`${u.tid}/`))) throw new BadRequestException('Unknown file');
    const [row] = await this.db.asUser(u, (q) => q(
      `insert into public.voice_recordings (tenant_id, speaker, title, language, storage_path, consent_doc_path, duration_s)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [u.tid, d.speaker, d.title, d.language, d.storagePath, d.consentDocPath, d.durationS ?? null]));
    return row;
  }

  @Post('recordings/:id/approve') @Roles('admin')
  async approveRecording(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db.asUser(u, (q) => q(
      `update public.voice_recordings set status = 'approved', approved_by = $2, approved_at = now() where id = $1 and tenant_id = $3 returning *`, [id, u.mid, u.tid]));
    if (!row) throw new BadRequestException('Recording not found');
    return row;
  }

  @Get('campaigns')
  campaigns(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(
      `select c.*, (select json_object_agg(status, n) from (select status, count(*) n from public.voice_call_attempts a where a.campaign_id = c.id group by status) s) as counts
         from public.voice_campaigns c where c.tenant_id = $1 order by c.created_at desc`, [u.tid]));
  }

  @Post('campaigns')
  async addCampaign(@CurrentUser() u: AuthUser, @Body() d: CampaignDto) {
    const [row] = await this.db.asUser(u, (q) => q(
      `insert into public.voice_campaigns (tenant_id, name, recordings, audience, starts_on, ends_on, daily_start, daily_end, max_attempts, calls_per_minute, created_by)
       values ($1, $2, $3, coalesce($4, '{}'), $5, $6, coalesce($7::time, '09:00'), coalesce($8::time, '19:00'), coalesce($9, 2), coalesce($10, 60), $11) returning *`,
      [u.tid, d.name, JSON.stringify(d.recordings), d.audience ? JSON.stringify(d.audience) : null, d.startsOn, d.endsOn,
       d.dailyStart ?? null, d.dailyEnd ?? null, d.maxAttempts ?? null, d.callsPerMinute ?? null, u.mid]));
    return row;
  }

  /** Approving needs a second admin and running needs approval (enforced by the database). */
  @Post('campaigns/:id/status')
  async campaignStatus(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: CampaignStatusDto) {
    const [row] = await this.db.asUser(u, (q) => q(
      `update public.voice_campaigns set status = $2, approved_by = case when $2 = 'approved' then $3 else approved_by end
        where id = $1 and tenant_id = $4 returning *`, [id, d.status, u.mid, u.tid]));
    if (!row) throw new BadRequestException('Not allowed, or campaign not found');
    return row;
  }
}
