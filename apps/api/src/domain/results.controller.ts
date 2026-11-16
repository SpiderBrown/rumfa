import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { callFn, selectFn } from '../common/fn';
import { ROOM } from './roles';

class JobDto {
  @ApiProperty() @IsUUID() electionId: string;
  @ApiProperty({ enum: ['baseline', 'live', 'ocr', 'recheck'] }) @IsIn(['baseline', 'live', 'ocr', 'recheck']) jobType: string;
  @ApiProperty({ enum: ['national', 'state', 'lga', 'ward'] }) @IsIn(['national', 'state', 'lga', 'ward']) areaLevel: string;
  @ApiProperty() @IsString() @MaxLength(20) areaCode: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoRecheck?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(2) @Max(240) intervalMin?: number;
}
class JobStatusDto { @ApiProperty({ enum: ['queued', 'paused', 'cancelled'] }) @IsIn(['queued', 'paused', 'cancelled']) status: string; }
class ConfirmSheetDto {
  @ApiProperty() @IsUUID() electionId: string;
  @ApiProperty() @Matches(/^\d{2}-\d{2}-\d{2}-\d{3}$/) pu: string;
  @ApiProperty() @IsInt() @Min(1) version: number;
  @ApiProperty() @IsInt() @Min(0) registered: number;
  @ApiProperty() @IsInt() @Min(0) accredited: number;
  @ApiProperty() @IsInt() @Min(0) rejected: number;
  @ApiProperty() @IsInt() @Min(0) totalValid: number;
  @ApiProperty() @IsObject() votes: Record<string, number>;
}

/** Results and IReV are visible to room staff; the election must be one the tenant follows. */
@ApiTags('Results and IReV')
@ApiBearerAuth()
@Controller()
@Roles(...ROOM)
export class ResultsController {
  constructor(private readonly db: Db) {}

  private async election(user: AuthUser, electionId: string) {
    const [ok] = await this.db.asUser(user, (q) => q(`select 1 from public.tenant_elections where tenant_id = $1 and election_id = $2`, [user.tid, electionId]));
    if (!ok) throw new BadRequestException('Unknown election');
  }

  @Get('results/overview')
  async overview(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string, @Query('state') state?: string) {
    await this.election(u, e);
    return this.db.asUser(u, (q) => selectFn(q, 'results_overview', { p_election: e, p_state: state || null }));
  }

  @Get('results/tallies')
  async tallies(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string, @Query('area') area?: string) {
    await this.election(u, e);
    return this.db.asUser(u, (q) => selectFn(q, 'live_tallies', { p_election: e, p_area: area || 'NG' }));
  }

  @Get('results/sample-estimate')
  async sample(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string) {
    await this.election(u, e);
    return this.db.asUser(u, (q) => selectFn(q, 'sample_estimate', { p_election: e }));
  }

  @Get('irev/summary')
  async irevSummary(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string, @Query('parent') parent = 'NG') {
    await this.election(u, e);
    return this.db.asUser(u, (q) => selectFn(q, 'irev_area_summary', { p_election: e, p_parent: parent }));
  }

  @Get('irev/units')
  async irevUnits(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string, @Query('area') area: string) {
    if (!/^\d{2}(-\d{2}){0,2}$/.test(area ?? '')) throw new BadRequestException('Give a state, LGA or ward code');
    await this.election(u, e);
    return this.db.asUser(u, (q) => q(
      `select pu_code, status, ocr_status, first_seen_at, irev_updated_at, replaced_count, last_checked_at
         from public.irev_availability where election_id = $1 and pu_code like $2 || '%' order by pu_code limit 20000`, [e, area]));
  }

  @Get('irev/units/:pu')
  async irevUnit(@CurrentUser() u: AuthUser, @Param('pu') pu: string, @Query('election', ParseUUIDPipe) e: string) {
    await this.election(u, e);
    return this.db.asUser(u, async (q) => ({
      availability: (await q(`select * from public.irev_availability where election_id = $1 and pu_code = $2`, [e, pu]))[0] ?? null,
      log: await q(`select * from public.irev_check_log where election_id = $1 and pu_code = $2 order by at desc limit 20`, [e, pu]),
      sheet: (await q(`select * from public.irev_sheet_results where election_id = $1 and pu_code = $2 order by sheet_version desc limit 1`, [e, pu]))[0] ?? null,
    }));
  }

  @Get('irev/jobs')
  jobs(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string) {
    return this.db.asUser(u, (q) => q(`select * from public.irev_fetch_jobs where tenant_id = $1 and election_id = $2 order by created_at desc limit 200`, [u.tid, e]));
  }

  @Post('irev/jobs') @Roles('analyst', 'supervisor', 'admin')
  async createJob(@CurrentUser() u: AuthUser, @Body() d: JobDto) {
    await this.election(u, d.electionId);
    const [row] = await this.db.asUser(u, (q) => q(
      `insert into public.irev_fetch_jobs (tenant_id, election_id, job_type, area_level, area_code, auto_recheck, interval_min, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [u.tid, d.electionId, d.jobType, d.areaLevel, d.areaCode, d.autoRecheck ?? false, d.intervalMin ?? 10, u.mid]));
    return row;
  }

  @Patch('irev/jobs/:id') @Roles('analyst', 'supervisor', 'admin')
  async jobStatus(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: JobStatusDto) {
    const [row] = await this.db.asUser(u, (q) => q(`update public.irev_fetch_jobs set status = $2, error = case when $2 = 'queued' then null else error end where id = $1 and tenant_id = $3 returning *`, [id, d.status, u.tid]));
    if (!row) throw new BadRequestException('Job not found');
    return row;
  }

  @Get('elections/:id/parties')
  async parties(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) e: string) {
    await this.election(u, e);
    return (await this.db.asUser(u, (q) => q(`select party from public.election_parties where election_id = $1 order by ballot_order`, [e]))).map((r) => r.party);
  }

  @Get('irev/review')
  review(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string) {
    return this.db.asUser(u, (q) => q(
      `select * from public.irev_sheet_results where election_id = $1 and ocr_status = 'needs_review' order by pu_code limit 200`, [e]));
  }

  @Post('irev/sheets/confirm') @HttpCode(204) @Roles('analyst', 'supervisor', 'admin')
  async confirm(@CurrentUser() u: AuthUser, @Body() d: ConfirmSheetDto) {
    await this.election(u, d.electionId);
    await this.db.asUser(u, (q) => callFn(q, 'confirm_irev_sheet', {
      p_election: d.electionId, p_pu: d.pu, p_version: d.version, p_registered: d.registered, p_accredited: d.accredited,
      p_rejected: d.rejected, p_total_valid: d.totalValid, p_votes: d.votes,
    }));
  }
}
