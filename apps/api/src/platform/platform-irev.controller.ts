import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { Db } from '../database/db.service';
import { CurrentStaff, Platform } from '../auth/decorators';
import type { PlatformUser } from '../auth/auth.types';
import { audit } from './audit';

class JobDto {
  @ApiProperty() @IsUUID() electionId: string;
  @ApiProperty({ enum: ['baseline', 'live', 'ocr', 'recheck'] }) @IsIn(['baseline', 'live', 'ocr', 'recheck']) jobType: string;
  @ApiProperty({ description: 'NG, a state (19), an LGA (19-28) or a ward (19-28-02)' }) @IsString() @Matches(/^(NG|\d{2}(-\d{2}){0,2})$/) areaCode: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoRecheck?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(5) @Max(720) intervalMin?: number;
  @ApiPropertyOptional({ enum: ['file', 'link'] }) @IsOptional() @IsIn(['file', 'link']) keep?: 'file' | 'link';
}
class StatusDto { @ApiProperty({ enum: ['queued', 'paused', 'cancelled'] }) @IsIn(['queued', 'paused', 'cancelled']) status: string; }
class WatchDto {
  @ApiProperty() @IsUUID() electionId: string;
  @ApiProperty({ description: 'false stops the watcher' }) @IsBoolean() on: boolean;
  @ApiPropertyOptional({ description: 'Minutes between passes (each pass goes through every ward in the area at INEC\'s pace)' }) @IsOptional() @IsInt() @Min(10) @Max(720) intervalMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^(NG|\d{2}(-\d{2}){0,2})$/) areaCode?: string;
}
const levelOf = (code: string) => (code === 'NG' ? 'national' : code.length === 2 ? 'state' : code.length === 5 ? 'lga' : 'ward');

/**
 * Rumfa Console: IReV for every election. Fetch result sheets by area (keep the file, or only INEC's link), follow
 * the jobs, and keep one watcher per election that rechecks IReV at a gentle pace and saves links to new sheets.
 */
@ApiTags('Rumfa Console: IReV')
@ApiBearerAuth()
@Controller('platform/irev')
@Platform()
export class PlatformIrevController {
  constructor(private readonly db: Db) {}
  private q = (sql: string, p?: unknown[]) => this.db.system(sql, p);

  /** Elections with IReV progress and their watcher */
  @Get('elections')
  elections() {
    return this.db.system(
      `select e.id, e.name, e.election_type, to_char(e.election_date, 'YYYY-MM-DD') as election_date, e.irev_election_id, e.status, e.scope_state_code,
              (select count(*) from public.irev_availability a where a.election_id = e.id and a.status in ('on_irev','downloaded','replaced'))::int as on_irev,
              (select count(*) from public.irev_availability a where a.election_id = e.id and a.storage_path is not null)::int as stored,
              (select count(*) from public.irev_availability a where a.election_id = e.id and a.storage_path is null and a.sheet_url is not null)::int as linked,
              (select count(*) from public.irev_availability a where a.election_id = e.id and a.ocr_status = 'needs_review')::int as review,
              (select max(a.last_checked_at) from public.irev_availability a where a.election_id = e.id) as last_checked_at,
              (select row_to_json(j) from (select id, status, interval_min, area_code, next_run_at, error, counts from public.irev_fetch_jobs
                 where election_id = e.id and watcher and status in ('queued','running','paused') limit 1) j) as watcher
         from public.elections e order by e.election_date desc, e.name`);
  }

  /** Progress by area for one election, one level down from `parent` */
  @Get('summary')
  summary(@Query('election', ParseUUIDPipe) e: string, @Query('parent') parent = 'NG') {
    if (!/^(NG|\d{2}(-\d{2}){0,2})$/.test(parent)) throw new BadRequestException('Give NG, a state, an LGA or a ward');
    return this.db.system(`select * from public.svc_irev_area_summary($1, $2)`, [e, parent]);
  }

  @Get('jobs')
  jobs(@Query('election', ParseUUIDPipe) e: string) {
    return this.db.system(
      `select j.*, coalesce(ps.full_name, v.full_name) as requested_by_name, t.name as client_name
         from public.irev_fetch_jobs j left join public.platform_staff ps on ps.id = j.requested_by_staff
         left join public.volunteers v on v.id = j.requested_by left join public.tenants t on t.id = j.tenant_id
        where j.election_id = $1 order by j.created_at desc limit 300`, [e]);
  }

  @Post('jobs') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Fetch sheets for an area (keep the file, or only the link)' })
  async addJob(@CurrentStaff() s: PlatformUser, @Body() d: JobDto) {
    await this.withIrevId(d.electionId);
    const [row] = await this.db.system(
      `insert into public.irev_fetch_jobs (election_id, job_type, area_level, area_code, auto_recheck, interval_min, keep, requested_by_staff)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [d.electionId, d.jobType, levelOf(d.areaCode), d.areaCode, d.autoRecheck ?? false, d.intervalMin ?? 10, d.keep ?? 'link', s.sid]);
    await audit(this.q, s, 'irev.job', 'election', d.electionId, d as any);
    return row;
  }

  @Patch('jobs/:id') @Platform('owner', 'staff')
  async jobStatus(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: StatusDto) {
    const [row] = await this.db.system(
      `update public.irev_fetch_jobs set status = $2, error = case when $2 = 'queued' then null else error end,
              finished_at = case when $2 = 'cancelled' then now() else finished_at end where id = $1 returning *`, [id, d.status]);
    if (!row) throw new NotFoundException('Job not found');
    await audit(this.q, s, `irev.job.${d.status}`, 'irev_job', id);
    return row;
  }

  /** Starts, changes or stops the election's watcher: a links-only live job that rechecks by itself */
  @Post('watch') @Platform('owner', 'staff')
  @ApiOperation({ summary: "Keep checking IReV for an election at a gentle interval, saving links to new or replaced sheets" })
  async watch(@CurrentStaff() s: PlatformUser, @Body() d: WatchDto) {
    const e = await this.withIrevId(d.electionId);
    const area = d.areaCode ?? e.scope_state_code ?? 'NG';
    const result = await this.db.systemTx(async (q) => {
      await q(`update public.irev_fetch_jobs set status = 'cancelled', finished_at = now()
                where election_id = $1 and watcher and status in ('queued','running','paused')`, [d.electionId]);
      if (!d.on) return null;
      const [row] = await q(
        `insert into public.irev_fetch_jobs (election_id, job_type, area_level, area_code, auto_recheck, interval_min, keep, watcher, requested_by_staff)
         values ($1, 'live', $2, $3, true, $4, 'link', true, $5) returning *`,
        [d.electionId, levelOf(area), area, d.intervalMin ?? 20, s.sid]);
      return row;
    });
    await audit(this.q, s, d.on ? 'irev.watch' : 'irev.unwatch', 'election', d.electionId, { area, intervalMin: d.intervalMin ?? 20 });
    return result ?? { status: 'stopped' };
  }

  private async withIrevId(id: string) {
    const [e] = await this.db.system(`select id, irev_election_id, scope_state_code from public.elections where id = $1`, [id]);
    if (!e) throw new NotFoundException('Election not found');
    if (!e.irev_election_id) throw new BadRequestException("This election has no IReV id yet. Set it under Elections first.");
    return e;
  }
}
