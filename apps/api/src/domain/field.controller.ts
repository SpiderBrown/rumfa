import { BadRequestException, Body, Controller, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db, type Query } from '../database/db.service';
import { callFn, elections } from '../common/fn';

const PU = /^\d{2}-\d{2}-\d{2}-\d{3}$/;

class CheckinDto {
  @ApiProperty() @Matches(PU) pu: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() accuracy?: number;
  @ApiProperty({ description: 'Id made on the phone; resending is safe' }) @IsUUID() clientId: string;
}
class ChecklistDto {
  @ApiProperty() @Matches(PU) pu: string;
  @ApiProperty() @IsString() @MaxLength(40) item: string;
  @ApiProperty() answer: unknown;
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
  async checkin(@CurrentUser() user: AuthUser, @Body() d: CheckinDto) {
    await this.db.asUser(user, async (q) => q(
      `insert into public.checkins (tenant_id, election_id, volunteer_id, pu_code, lat, lng, accuracy_m, client_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (client_id) do nothing`,
      [user.tid, await this.live(q, user), user.mid, d.pu, d.lat ?? null, d.lng ?? null, d.accuracy ?? null, d.clientId]));
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
