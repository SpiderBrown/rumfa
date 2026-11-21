import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db, type Query } from '../database/db.service';
import { StorageService } from '../common/storage.service';
import { callFn, elections } from '../common/fn';
import { checkinFence, checkinWindow } from '../common/checkin-window';
import { judgeCheckin } from '../shared';

const PU = /^\d{2}-\d{2}-\d{2}-\d{3}$/;

class CheckinDto {
  @ApiProperty() @Matches(PU) pu: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() accuracy?: number;
  @ApiPropertyOptional({ description: 'When the person tapped Check in (phone time). Used when the check-in reaches us late, e.g. after no signal' })
  @IsOptional() @IsDateString() at?: string;
  @ApiPropertyOptional({ description: 'Why the agent is checking in away from their area, or without a location' })
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiProperty({ description: 'Id made on the phone; resending is safe' }) @IsUUID() clientId: string;
}
class ChecklistDto {
  @ApiProperty() @Matches(PU) pu: string;
  @ApiProperty() @IsString() @MaxLength(40) item: string;
  @ApiProperty({ example: { value: 'yes' } }) @IsObject() answer: { value: unknown };
  @ApiProperty() @IsUUID() clientId: string;
}
class QuickTallyDto {
  @ApiProperty() @Matches(PU) pu: string;
  @ApiProperty({ example: { APC: 120, PDP: 80 } }) @IsObject() votes: Record<string, number>;
  @ApiProperty() @IsUUID() clientId: string;
}
class ResultDto {
  @ApiProperty() @Matches(PU) pu: string;
  @ApiProperty() @IsInt() @Min(0) @Max(100000) registered: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100000) accredited: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100000) rejected: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100000) totalValid: number;
  @ApiProperty() @IsObject() votes: Record<string, number>;
  @ApiPropertyOptional({ description: 'Path returned by POST /media/upload-url (kind ec8a)' }) @IsOptional() @IsString() @MaxLength(300) photoPath?: string;
  @ApiProperty() @IsUUID() clientId: string;
}
class IncidentDto {
  @ApiProperty() @Matches(PU) pu: string;
  @ApiProperty() @IsString() @MaxLength(40) category: string;
  @ApiPropertyOptional({ enum: ['critical', 'high', 'medium', 'low'] }) @IsOptional() @IsIn(['critical', 'high', 'medium', 'low']) severity?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) mediaPaths?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sos?: boolean;
  @ApiProperty() @IsUUID() clientId: string;
}

class FullPhotoDto { @ApiProperty({ description: 'From POST /media/upload-url (kind ec8a)' }) @IsString() @MaxLength(300) path: string; }
class IrevAnswerDto {
  @ApiProperty({ description: 'true: IReV shows the same figures as the signed sheet' }) @IsBoolean() matches: boolean;
  @ApiPropertyOptional({ description: 'What is different' }) @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class IncidentDetailsDto {
  @ApiProperty({ description: 'The app\'s id for the report (the clientId it was sent with)' }) @IsUUID() clientId: string;
  @ApiPropertyOptional({ description: 'What the emergency is (replaces "Emergency (SOS)")' }) @IsOptional() @IsString() @MaxLength(40) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) mediaPaths?: string[];
  @ApiPropertyOptional({ description: 'The SOS was sent by mistake' }) @IsOptional() @IsBoolean() mistake?: boolean;
}

function votesOk(v: Record<string, number>) {
  if (Object.keys(v).length > 40 || Object.entries(v).some(([k, n]) => !/^[A-Z]{1,8}$/.test(k) || !Number.isInteger(n) || n < 0 || n > 100000)) {
    throw new BadRequestException('Votes must be whole numbers per party code');
  }
}
/** Files referenced in a report must be ones this tenant uploaded. */
function ownFile(user: AuthUser, path?: string) {
  if (path && !path.startsWith(`${user.tid}/`)) throw new BadRequestException('Unknown file');
}

@ApiTags('Field reports')
@ApiBearerAuth()
@Controller()
export class FieldController {
  constructor(private readonly db: Db, private readonly storage: StorageService) {}

  private async live(q: Query, user: AuthUser): Promise<string> {
    const { live } = await elections(q, user.tid);
    if (!live) throw new BadRequestException('No election is set up yet');
    return live;
  }

  @Post('checkins') @HttpCode(204) @Roles('agent', 'volunteer', 'coordinator')
  @ApiOperation({ summary: 'Check in at the polling unit (first check-in is the arrival time; later ones are kept as extra records)' })
  async checkin(@CurrentUser() user: AuthUser, @Body() d: CheckinDto) {
    if (user.level === 'pu' && user.area && d.pu !== user.area) throw new BadRequestException('You can only check in at your own polling unit');
    await this.db.asUser(user, async (q) => {
      const election = await this.live(q, user);
      // The phone's time counts when the check-in arrives late (no signal); never trusted beyond 12 hours or in the future
      const now = Date.now();
      const claimed = d.at ? Date.parse(d.at) : NaN;
      const at = claimed <= now + 120_000 && claimed >= now - 12 * 3600_000 ? Math.min(claimed, now) : now;
      const w = await checkinWindow(this.db, q, user.tid, election);
      if (!w.isOpen(at)) {
        const part = (o: Intl.DateTimeFormatOptions) => new Date(w.opensAt).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', ...o });
        const opens = `${part({ hour: 'numeric', minute: '2-digit', hour12: true })} on ${part({ weekday: 'long', day: 'numeric', month: 'long' })}`;
        throw new BadRequestException(at < Date.parse(w.opensAt) ? `Check-in opens at ${opens} (election day)` : 'Check-in has closed for this election');
      }
      // Within their own area? Judged here too (the phone's own check is only a guide)
      const j = judgeCheckin(await checkinFence(this.db, d.pu), d);
      await q(
        `insert into public.checkins (tenant_id, election_id, volunteer_id, pu_code, lat, lng, accuracy_m, client_id, at,
                                      checked_against, inside, distance_m, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict (client_id) do nothing`,
        [user.tid, election, user.mid, d.pu, d.lat ?? null, d.lng ?? null, d.accuracy ?? null, d.clientId, new Date(at),
          j.against, j.inside, j.distance, d.note?.trim() || null]);
    });
  }

  @Get('checkins/mine') @Roles('agent', 'volunteer', 'coordinator')
  @ApiOperation({ summary: 'My check-ins for the live election, and when check-in is open' })
  mine(@CurrentUser() user: AuthUser) {
    return this.db.asUser(user, async (q) => {
      const { live } = await elections(q, user.tid);
      if (!live) return { window: null, first: null, last: null, count: 0, arrival: null, lastInside: null, fence: null };
      const { isOpen, ...window } = await checkinWindow(this.db, q, user.tid, live);
      // first: any check-in; arrival: the first one not known to be outside; lastInside: how the latest one was judged
      const [r] = await q(
        `select min(at) as first, max(at) as last, count(*)::int as count, min(at) filter (where inside is not false) as arrival,
                (array_agg(inside order by at desc))[1] as last_inside
           from public.checkins where election_id = $1 and volunteer_id = $2`, [live, user.mid]);
      // The area to check against, so the phone can warn before sending, even with no signal
      const fence = user.level === 'pu' && user.area ? await checkinFence(this.db, user.area) : null;
      return { window: { ...window, open: isOpen(Date.now()) }, first: r.first, last: r.last, count: r.count, arrival: r.arrival,
        lastInside: r.count ? r.last_inside : null, fence };
    });
  }

  @Get('checklist/mine') @Roles('agent', 'volunteer', 'coordinator')
  @ApiOperation({ summary: 'My checklist answers for the live election' })
  checklistMine(@CurrentUser() user: AuthUser) {
    return this.db.asUser(user, async (q) => {
      const { live } = await elections(q, user.tid);
      if (!live) return {};
      const rows = await q(`select item_code, answer from public.checklist_responses where election_id = $1 and volunteer_id = $2`, [live, user.mid]);
      return Object.fromEntries(rows.map((r) => [r.item_code, r.answer?.value ?? r.answer]));
    });
  }

  @Put('checklist') @HttpCode(204) @Roles('agent', 'volunteer', 'coordinator')
  async checklist(@CurrentUser() user: AuthUser, @Body() d: ChecklistDto) {
    await this.db.asUser(user, async (q) => q(
      `insert into public.checklist_responses (tenant_id, election_id, volunteer_id, pu_code, item_code, answer, client_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (election_id, volunteer_id, item_code) do update set answer = excluded.answer, at = now()`,
      [user.tid, await this.live(q, user), user.mid, d.pu, d.item, JSON.stringify(d.answer ?? null), d.clientId]));
  }

  @Post('quick-tallies') @HttpCode(204) @Roles('agent', 'volunteer', 'coordinator')
  async quick(@CurrentUser() user: AuthUser, @Body() d: QuickTallyDto) {
    votesOk(d.votes);
    await this.db.asUser(user, async (q) => q(
      `insert into public.quick_tallies (tenant_id, election_id, volunteer_id, pu_code, votes, client_id)
       values ($1, $2, $3, $4, $5, $6) on conflict (client_id) do nothing`,
      [user.tid, await this.live(q, user), user.mid, d.pu, JSON.stringify(d.votes), d.clientId]));
  }

  @Post('results') @HttpCode(200) @Roles('agent', 'coordinator')
  @ApiOperation({ summary: 'Submit the signed EC8A figures (and photo); returns checks and version' })
  result(@CurrentUser() user: AuthUser, @Body() d: ResultDto) {
    votesOk(d.votes);
    ownFile(user, d.photoPath);
    return this.db.asUser(user, (q) => callFn(q, 'submit_result', {
      p_pu: d.pu, p_registered: d.registered, p_accredited: d.accredited, p_rejected: d.rejected, p_total_valid: d.totalValid,
      p_votes: d.votes, p_photo: d.photoPath ?? null, p_client_id: d.clientId,
    }));
  }

  // ---- Full-resolution sheet photos ---------------------------------------------------------------------
  /** Sheet photos the room asked me for in full resolution (the app keeps the originals) */
  @Get('results/full-photo-requests') @Roles('agent', 'coordinator')
  fullRequests(@CurrentUser() user: AuthUser) {
    return this.db.system(
      `select id, client_id, pu_code from public.result_submissions
        where volunteer_id = $1 and tenant_id = $2 and full_photo_requested_at is not null and full_photo_path is null and client_id is not null`, [user.mid, user.tid]);
  }

  @Post('results/:id/full-photo') @HttpCode(204) @Roles('agent', 'coordinator')
  async fullPhoto(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: FullPhotoDto) {
    ownFile(user, d.path);
    const [r] = await this.db.system(
      `update public.result_submissions set full_photo_path = $3 where id = $1 and volunteer_id = $2 returning id`, [id, user.mid, d.path]);
    if (!r) throw new BadRequestException('Result not found');
  }

  // ---- My sheet against IReV ------------------------------------------------------------------------
  /** IReV sheets of my unit waiting for me to compare (and the ones I answered), with my figures and IReV's read of them */
  @Get('irev-checks/mine') @Roles('agent', 'coordinator')
  irevChecks(@CurrentUser() user: AuthUser) {
    return this.db.asUser(user, (q) => q(
      `select k.id, k.election_id, k.pu_code, k.status, k.note, k.case_id, k.asked_at, k.answered_at, e.name as election_name, pu.name as pu_name,
              (select json_build_object('registered', r.registered, 'accredited', r.accredited, 'rejected', r.rejected, 'total_valid', r.total_valid, 'votes', r.votes)
                 from public.result_submissions r where r.tenant_id = k.tenant_id and r.election_id = k.election_id and r.pu_code = k.pu_code
                 order by r.version desc limit 1) as mine,
              (select json_build_object('registered', s.registered, 'accredited', s.accredited, 'rejected', s.rejected, 'total_valid', s.total_valid, 'votes', s.votes, 'status', s.ocr_status)
                 from public.irev_sheet_results s where s.election_id = k.election_id and s.pu_code = k.pu_code and s.ocr_status in ('read','confirmed')
                 order by s.sheet_version desc limit 1) as irev
         from public.irev_unit_checks k join public.elections e on e.id = k.election_id join public.polling_units pu on pu.code = k.pu_code
        where k.volunteer_id = $1 order by (k.status = 'asked') desc, k.asked_at desc limit 20`, [user.mid]));
  }

  @Post('irev-checks/:id') @HttpCode(200) @Roles('agent', 'coordinator')
  @ApiOperation({ summary: 'Answer: the IReV sheet matches my signed sheet, or it is different (opens a case)' })
  async answerIrev(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: IrevAnswerDto) {
    if (!d.matches && !d.note?.trim()) throw new BadRequestException('Say what is different');
    const caseId = await this.db.asUser(user, (q) => callFn(q, 'answer_irev_check', { p_id: id, p_matches: d.matches, p_note: d.note?.trim() || null }));
    // Different: keep our own copy of INEC's sheet with the case, in case it is changed or taken down on IReV
    if (!d.matches && caseId) void this.keepIrevEvidence(user.tid, id, caseId).catch(() => undefined);
    return { caseId: caseId ?? null };
  }

  /** Saves the IReV sheet (if we only had INEC's link) and notes it on the case as evidence */
  private async keepIrevEvidence(tenant: string, checkId: string, caseId: string) {
    const [k] = await this.db.system(
      `select k.election_id, k.pu_code, a.storage_path, a.sheet_url, a.document_url, a.backup_url
         from public.irev_unit_checks k left join public.irev_availability a on a.election_id = k.election_id and a.pu_code = k.pu_code
        where k.id = $1 and k.tenant_id = $2`, [checkId, tenant]);
    if (!k) return;
    let path: string | null = k.storage_path;
    if (!path) {
      const urls = [...new Set([k.sheet_url, k.document_url, k.backup_url].filter((x): x is string => typeof x === 'string' && /^https:\/\//.test(x)))];
      for (const url of urls) {
        try {
          const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Rumfa evidence' } });
          if (!r.ok) continue;
          const type = r.headers.get('content-type') || (url.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
          const ext = type.includes('pdf') ? 'pdf' : type.includes('png') ? 'png' : 'jpg';
          path = `${k.election_id}/${k.pu_code}/evidence-${Date.now()}.${ext}`;
          await this.storage.put('irev', path, Buffer.from(await r.arrayBuffer()), type);
          await this.db.system(`update public.irev_availability set storage_path = coalesce(storage_path, $3) where election_id = $1 and pu_code = $2`,
            [k.election_id, k.pu_code, path]);
          break;
        } catch { path = null; }
      }
    }
    await this.db.system(
      `insert into public.case_events (tenant_id, case_id, kind, body, data) values ($1, $2, 'note', $3, $4)`,
      [tenant, caseId, path ? 'IReV sheet saved with this case as evidence' : 'Could not save a copy of the IReV sheet (INEC did not answer)',
        JSON.stringify({ irev_path: path, election_id: k.election_id, pu: k.pu_code })]);
  }

  /** The app asks Rumfa to look at IReV for my unit now (a links-only check of my ward; at most every 10 minutes per ward) */
  @Post('irev/check-mine') @HttpCode(200) @Roles('agent')
  async checkMine(@CurrentUser() user: AuthUser) {
    const pu = user.area;
    if (!/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(pu ?? '')) throw new BadRequestException('Only agents at a polling unit');
    return this.db.asUser(user, async (q) => {
      const e = await this.live(q, user);
      const ward = pu!.slice(0, 8);
      const [el] = await this.db.system(`select irev_election_id from public.elections where id = $1`, [e]);
      if (!el?.irev_election_id) return { queued: false, reason: 'INEC has not opened results for this election on IReV yet' };
      const [recent] = await this.db.system(
        `select 1 from public.irev_fetch_jobs where election_id = $1 and area_code = any($2) and created_at > now() - interval '10 minutes' limit 1`, [e, [ward, pu!.slice(0, 5), pu!.slice(0, 2)]]);
      if (recent) return { queued: false, reason: 'Checked a moment ago' };
      await this.db.system(
        `insert into public.irev_fetch_jobs (tenant_id, election_id, job_type, area_level, area_code, keep, requested_by) values ($1, $2, 'live', 'ward', $3, 'link', $4)`,
        [user.tid, e, ward, user.mid]);
      return { queued: true };
    });
  }

  @Get('incidents/mine/:clientId')
  @ApiOperation({ summary: 'How my report or SOS is being handled: sent, seen by the room, who is on it (the reporter only)' })
  async myIncident(@CurrentUser() user: AuthUser, @Param('clientId', ParseUUIDPipe) clientId: string) {
    const [r] = await this.db.system(
      `select i.reported_at, c.id as case_id, c.status, c.acknowledged_at, c.assigned_to is not null as assigned, v.full_name as handler
         from public.incidents i left join public.cases c on c.id = i.case_id left join public.volunteers v on v.id = c.assigned_to
        where i.tenant_id = $1 and i.volunteer_id = $2 and i.client_id = $3`, [user.tid, user.mid, clientId]);
    if (!r) return null;
    return { reportedAt: r.reported_at, status: r.status ?? 'queued', seen: !!r.acknowledged_at || !['queued', null].includes(r.status), seenAt: r.acknowledged_at, handler: r.assigned ? r.handler : null };
  }

  @Post('incidents/details') @HttpCode(200)
  @ApiOperation({ summary: 'After an SOS or report: what is happening, a note, a photo, or "sent by mistake" (the reporter only)' })
  incidentDetails(@CurrentUser() user: AuthUser, @Body() d: IncidentDetailsDto) {
    (d.mediaPaths ?? []).forEach((p) => ownFile(user, p));
    return this.db.asUser(user, (q) => callFn(q, 'add_incident_details', {
      p_client_id: d.clientId, p_category: d.category ?? null, p_note: d.note ?? null, p_media: d.mediaPaths ?? [], p_mistake: d.mistake ?? false,
    }));
  }

  @Post('incidents') @HttpCode(200)
  @ApiOperation({ summary: 'Report an incident or SOS; returns the case it joined or opened' })
  incident(@CurrentUser() user: AuthUser, @Body() d: IncidentDto) {
    (d.mediaPaths ?? []).forEach((p) => ownFile(user, p));
    return this.db.asUser(user, (q) => callFn(q, 'report_incident', {
      p_pu: d.pu, p_category: d.category, p_severity: d.severity ?? null, p_description: d.description ?? null,
      p_media: d.mediaPaths ?? [], p_client_id: d.clientId, p_is_sos: d.sos ?? false,
    }));
  }
}
