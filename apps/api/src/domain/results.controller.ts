import { BadRequestException, ConflictException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
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
  @ApiPropertyOptional({ enum: ['file', 'link'], description: 'file: download each sheet (default); link: save only INEC\'s link to it' })
  @IsOptional() @IsIn(['file', 'link']) keep?: 'file' | 'link';
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
  // Items 3, 4, 5 and 8 of the sheet: optional
  @ApiPropertyOptional({ description: 'Item 3: ballot papers issued to the polling unit' }) @IsOptional() @IsInt() @Min(0) ballotsReceived?: number;
  @ApiPropertyOptional({ description: 'Item 4: unused ballot papers' }) @IsOptional() @IsInt() @Min(0) unused?: number;
  @ApiPropertyOptional({ description: 'Item 5: spoiled ballot papers' }) @IsOptional() @IsInt() @Min(0) spoiled?: number;
  @ApiPropertyOptional({ description: 'Item 8: used ballot papers, as written on the sheet' }) @IsOptional() @IsInt() @Min(0) used?: number;
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

  /** Each sub-area of an area with our sheets, IReV, matching, differences and missing sheets, and votes from each source */
  @Get('results/by-area')
  async byArea(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string, @Query('area') area?: string, @Query('group') group?: string) {
    await this.election(u, e);
    // NG, a state, LGA or ward; a zone (Z-NC) or a senatorial district (19-SD1). group: zone (the country) or senatorial (a state)
    const a = area && /^(NG|\d{2}(-\d{2}){0,2}|Z-(NC|NE|NW|SE|SS|SW)|\d{2}-SD\d)$/.test(area) ? area : 'NG';
    const g = group === 'zone' || group === 'senatorial' ? group : null;
    return this.db.asUser(u, (q) => selectFn(q, 'results_by_area', { p_election: e, p_area: a, p_group: g }));
  }

  /** Ask the agent's app to upload the full-resolution original of a sheet photo */
  @Post('results/:id/request-full-photo') @HttpCode(204) @Roles('analyst', 'supervisor', 'admin', 'legal', 'operator')
  async requestFull(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [s] = await this.db.asUser(u, (q) => q(`select id from public.result_submissions where id = $1 and tenant_id = $2`, [id, u.tid]));
    if (!s) throw new BadRequestException('Result not found');
    await this.db.system(`select app.request_full_photo($1)`, [id]);
  }

  /** One polling unit: our agent's signed sheet and IReV's, side by side (for the Results preview) */
  @Get('results/unit')
  async unit(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string, @Query('pu') pu: string) {
    if (!/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(pu ?? '')) throw new BadRequestException('Give a polling unit code');
    await this.election(u, e);
    const [ours] = await this.db.asUser(u, (q) => q(
      `select x.id, x.version, x.registered, x.accredited, x.rejected, x.total_valid, x.votes, x.sheet_photo_path is not null as has_photo, x.submitted_at, x.status,
              x.full_photo_path is not null as has_full, x.full_photo_requested_at,
              v.full_name as by
         from public.result_submissions x left join public.volunteers v on v.id = x.volunteer_id
        where x.tenant_id = $1 and x.election_id = $2 and x.pu_code = $3 order by x.version desc limit 1`, [u.tid, e, pu]));
    const [irev] = await this.db.system(
      `select sheet_version as version, registered, accredited, rejected, total_valid, votes, ocr_status, min_confidence
         from public.irev_sheet_results where election_id = $1 and pu_code = $2 order by sheet_version desc limit 1`, [e, pu]);
    const [avail] = await this.db.system(
      `select status, storage_path is not null as stored, sheet_url is not null as linked, irev_updated_at, replaced_count from public.irev_availability where election_id = $1 and pu_code = $2`, [e, pu]);
    const [ver] = await this.db.system(`select status, diff from public.verifications where tenant_id = $1 and election_id = $2 and pu_code = $3`, [u.tid, e, pu]);
    const [check] = await this.db.system(
      `select status, note, case_id from public.irev_unit_checks where tenant_id = $1 and election_id = $2 and pu_code = $3 order by answered_at desc nulls last limit 1`, [u.tid, e, pu]);
    const [place] = await this.db.system(
      `select p.name, w.name as ward, l.name as lga, p.registered_voters from public.polling_units p join public.wards w on w.code = p.ward_code join public.lgas l on l.code = w.lga_code where p.code = $1`, [pu]);
    return { pu, place: place ?? null, ours: ours ?? null, irev: irev ?? null, availability: avail ?? null, verification: ver ?? null, agentCheck: check ?? null };
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

  /** How IReV is being followed for this election: Rumfa's watcher (interval, next pass) and the last check */
  @Get('irev/status')
  async irevStatus(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string) {
    await this.election(u, e);
    const [r] = await this.db.system(
      `select (select row_to_json(j) from (select status, interval_min, area_code, next_run_at, started_at from public.irev_fetch_jobs
                 where election_id = $1 and watcher and status in ('queued','running','paused') limit 1) j) as watcher,
              (select max(last_checked_at) from public.irev_availability where election_id = $1) as last_checked_at,
              (select row_to_json(j) from (select id, status, area_code, counts, created_at from public.irev_fetch_jobs
                 where election_id = $1 and tenant_id = $2 and status in ('queued','running') order by created_at desc limit 1) j) as pulling`,
      [e, u.tid]);
    return r;
  }

  /** The newest sheets on IReV in an area (for the dashboard's preview tiles) */
  @Get('irev/latest')
  async irevLatest(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string, @Query('area') area = 'NG') {
    if (!/^(NG|\d{2}(-\d{2}){0,2})$/.test(area)) throw new BadRequestException('Give NG, a state, an LGA or a ward');
    await this.election(u, e);
    return this.db.system(
      `select a.pu_code, p.name as pu_name, w.name as ward_name, a.status, a.ocr_status, coalesce(a.irev_updated_at, a.first_seen_at) as at,
              (a.storage_path is null and a.sheet_url is not null) as from_link
         from public.irev_availability a join public.polling_units p on p.code = a.pu_code left join public.wards w on w.code = left(a.pu_code, 8)
        where a.election_id = $1 and a.status in ('on_irev','downloaded','replaced') and ($2 = 'NG' or a.pu_code like $2 || '-%')
          and exists (select 1 from public.tenant_coverage c where c.tenant_id = $3 and (c.level = 'national' or a.pu_code like c.area_code || '%'))
        order by coalesce(a.irev_updated_at, a.first_seen_at) desc nulls last limit 12`, [e, area, u.tid]);
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

  /** "Pull now" from the dashboard: always links only (downloading sheets is done from Rumfa Console) */
  @Post('irev/jobs') @Roles('analyst', 'supervisor', 'admin')
  async createJob(@CurrentUser() u: AuthUser, @Body() d: JobDto) {
    await this.election(u, d.electionId);
    d.keep = 'link';
    // From the dashboard: an LGA or a ward at a time (a state or the whole country is hours of requests to INEC: Console),
    // once only (no repeats), and never again for an area being checked or checked in the last 10 minutes
    if (!['lga', 'ward'].includes(d.areaLevel)) throw new BadRequestException('Choose an LGA or a ward to check. Larger areas are checked from Rumfa Console.');
    d.autoRecheck = false;
    const [busy] = await this.db.system(
      `select id, status, created_at from public.irev_fetch_jobs
        where election_id = $1 and (area_code = $2 or $2 like area_code || '-%' or area_code like $2 || '-%')
          and (status in ('queued','running') or created_at > now() - interval '10 minutes') order by created_at desc limit 1`,
      [d.electionId, d.areaCode]);
    if (busy) throw new ConflictException(busy.status === 'queued' || busy.status === 'running'
      ? 'This area is being checked now. New sheets appear as they are found.' : 'This area was checked a few minutes ago. Try again in 10 minutes.');
    const [row] = await this.db.asUser(u, (q) => q(
      `insert into public.irev_fetch_jobs (tenant_id, election_id, job_type, area_level, area_code, auto_recheck, interval_min, requested_by, keep)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [u.tid, d.electionId, d.jobType, d.areaLevel, d.areaCode, d.autoRecheck ?? false, d.intervalMin ?? 10, u.mid, d.keep ?? 'file']));
    return row;
  }

  @Patch('irev/jobs/:id') @Roles('analyst', 'supervisor', 'admin')
  async jobStatus(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: JobStatusDto) {
    const [row] = await this.db.asUser(u, (q) => q(`update public.irev_fetch_jobs set status = $2, error = case when $2 = 'queued' then null else error end where id = $1 and tenant_id = $3 returning *`, [id, d.status, u.tid]));
    if (!row) throw new BadRequestException('Job not found');
    return row;
  }

  @Get('elections/:id/parties')
  async parties(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) e: string, @Query('fallback') fallback?: string) {
    await this.election(u, e);
    const ballot = (await this.db.asUser(u, (q) => q(`select party from public.election_parties where election_id = $1 order by ballot_order`, [e]))).map((r) => r.party);
    // No ballot list set for this election: all registered parties, alphabetically (INEC's ballot order), when asked
    if (!ballot.length && fallback === 'registered') return (await this.db.system(`select acronym from public.parties order by acronym`)).map((r) => r.acronym);
    return ballot;
  }

  @Get('irev/review')
  review(@CurrentUser() u: AuthUser, @Query('election', ParseUUIDPipe) e: string) {
    return this.db.asUser(u, (q) => q(
      // With what the sheet's header shows (state, LGA, ward, unit, election), so the form can mirror it
      `select r.*, pu.name as pu_name, pu.registered_voters as pu_registered, w.name as ward_name, l.name as lga_name, st.name as state_name,
              el.name as election_name, el.election_type, el.election_date,
              (a.storage_path is null and a.sheet_url is not null) as from_link,
              -- What our agent at the unit said about this sheet (matches: verified for us, nothing to type; differs: a case is open)
              (select k.status from public.irev_unit_checks k where k.tenant_id = $2 and k.election_id = r.election_id and k.pu_code = r.pu_code
                order by (k.status = 'differs') desc, k.answered_at desc nulls last limit 1) as agent_check,
              (select k.note from public.irev_unit_checks k where k.tenant_id = $2 and k.election_id = r.election_id and k.pu_code = r.pu_code and k.status = 'differs'
                order by k.answered_at desc limit 1) as agent_note,
              -- Our agent's signed sheet for the unit, to compare with (the latest version)
              (select json_build_object('id', x.id, 'registered', x.registered, 'accredited', x.accredited, 'rejected', x.rejected, 'total_valid', x.total_valid,
                        'votes', x.votes, 'has_photo', x.sheet_photo_path is not null, 'submitted_at', x.submitted_at, 'by', v.full_name,
                        'has_full', x.full_photo_path is not null, 'full_requested_at', x.full_photo_requested_at)
                 from public.result_submissions x left join public.volunteers v on v.id = x.volunteer_id
                where x.tenant_id = $2 and x.election_id = r.election_id and x.pu_code = r.pu_code order by x.version desc limit 1) as ours
         from public.irev_sheet_results r
         join public.polling_units pu on pu.code = r.pu_code
         join public.wards w on w.code = pu.ward_code
         join public.lgas l on l.code = w.lga_code
         join public.states st on st.code = l.state_code
         join public.elections el on el.id = r.election_id
         left join public.irev_availability a on a.election_id = r.election_id and a.pu_code = r.pu_code
        where r.election_id = $1 and r.ocr_status = 'needs_review' order by r.pu_code limit 400`, [e, u.tid]));
  }

  @Post('irev/sheets/confirm') @HttpCode(204) @Roles('analyst', 'supervisor', 'admin')
  async confirm(@CurrentUser() u: AuthUser, @Body() d: ConfirmSheetDto) {
    await this.election(u, d.electionId);
    await this.db.asUser(u, (q) => callFn(q, 'confirm_irev_sheet', {
      p_election: d.electionId, p_pu: d.pu, p_version: d.version, p_registered: d.registered, p_accredited: d.accredited,
      p_rejected: d.rejected, p_total_valid: d.totalValid, p_votes: d.votes,
      p_ballots_received: d.ballotsReceived, p_unused: d.unused, p_spoiled: d.spoiled, p_used: d.used,
    }));
  }
}
