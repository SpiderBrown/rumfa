import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db, type Query } from '../database/db.service';
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
  constructor(private readonly db: Db) {}

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
