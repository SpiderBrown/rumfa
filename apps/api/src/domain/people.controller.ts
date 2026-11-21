import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { randomInt } from 'node:crypto';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db, type Query as Q } from '../database/db.service';
import { normaliseNgPhone, normalisePuCode } from '../shared';
import { selectFn } from '../common/fn';
import { checkPeopleRows } from '../common/people-rows';
import { parseCsv } from '../scripts/csv';
import { withCasePlaces } from './case-places';
import { ROOM } from './roles';

const ROLES = ['agent', 'volunteer', 'coordinator', 'operator', 'supervisor', 'analyst', 'legal', 'security', 'voice_ops', 'admin'];
const LEVELS = ['pu', 'ward', 'lga', 'state', 'national'];

class CreatePersonDto {
  @ApiProperty() @IsString() @MaxLength(120) fullName: string;
  @ApiProperty() @IsString() @MaxLength(20) phone: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role: string;
  @ApiProperty({ enum: LEVELS }) @IsIn(LEVELS) level: string;
  @ApiProperty() @IsString() @MaxLength(20) areaCode: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() deputyOf?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) languages?: string[];
}
class ImportDto {
  @ApiProperty({ description: 'CSV text: full_name, phone, role, level, area_code, email?, languages?, network?' }) @IsString() @MaxLength(2_000_000) csv: string;
  @ApiPropertyOptional({ description: 'Only check the list' }) @IsOptional() @IsBoolean() dryRun?: boolean;
}
class UpdatePersonDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) fullName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional({ enum: ['invited', 'active', 'suspended', 'removed'] }) @IsOptional() @IsIn(['invited', 'active', 'suspended', 'removed']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) languages?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() deputyOf?: string;
}

const COLS = `id, full_name, phone, email, role, level, area_code, agent_code, languages, network, status, deputy_of, onboarded_at, created_at,
  (user_id is not null) as activated`;

@ApiTags('People')
@ApiBearerAuth()
@Controller('people')
export class PeopleController {
  constructor(private readonly db: Db) {}

  /** Admins and room staff see the tenant (within their area); coordinators see people in their area. Each person comes
   *  with their place by name, which app they use (Dashboard, Android, iPhone, or not installed) and when last seen. */
  @Get() @Roles(...ROOM, 'coordinator')
  async list(@CurrentUser() user: AuthUser, @Query('area') area?: string, @Query('role') role?: string, @Query('status') status?: string,
       @Query('q') search?: string, @Query('areas') areas?: string) {
    const people = await this.db.asUser(user, (q) => q(
      `select ${COLS}, user_id from public.volunteers
        where tenant_id = $1 and status <> 'removed' and platform_staff_id is null
          and ($2::text is null or area_code like $2 || '%')
          and ($3::text is null or role = any(string_to_array($3, ',')))
          and ($4::text is null or status = $4)
          and ($5::text is null or full_name ilike '%' || $5 || '%' or phone like '%' || $5 || '%')
          and ($6::text is null or area_code = any(string_to_array($6, ',')))
        order by area_code, full_name limit 5000`,
      [user.tid, area || null, role || null, status || null, search || null, areas || null]));
    if (!people.length) return [];
    // Devices and staff status aren't readable as the user; these people are already ones the user may see
    const seen = await this.db.system<{ id: string; platform: string | null; last_seen: string | null }>(
      `select v.id,
              (select d.platform from public.auth_devices d where d.identity_id = v.user_id and d.revoked_at is null order by d.last_seen_at desc nulls last limit 1) as platform,
              greatest((select max(d.last_seen_at) from public.auth_devices d where d.identity_id = v.user_id), st.updated_at) as last_seen
         from public.volunteers v left join public.staff_status st on st.volunteer_id = v.id
        where v.id = any($1) and v.tenant_id = $2`, [people.map((p) => p.id), user.tid]);
    const byId = new Map(seen.map((x) => [x.id, x]));
    const placed = await withCasePlaces(this.db, people);
    return placed.map(({ user_id, what, ...p }) => ({ ...p, platform: byId.get(p.id)?.platform ?? null, last_seen: byId.get(p.id)?.last_seen ?? null }));
  }

  /** Bulk add from a list (e.g. the party's accredited agents). Checks every line first; nothing is added if any line
   *  is wrong. People already on the list (same phone) are left as they are. */
  @Post('import') @HttpCode(200) @Roles('admin')
  async import(@CurrentUser() user: AuthUser, @Body() dto: ImportDto) {
    const rows = parseCsv(dto.csv);
    if (!rows.length) throw new BadRequestException('The list is empty. The first line must be the column names.');
    if (rows.length > 20_000) throw new BadRequestException('Up to 20,000 people at a time');
    const { ok, problems } = checkPeopleRows(rows);
    const pus = [...new Set(ok.filter((o) => o.level === 'pu').map((o) => o.area))];
    const found = new Set((await this.db.system<{ code: string }>(`select code from public.polling_units where code = any($1)`, [pus])).map((r) => r.code));
    for (const c of pus) if (!found.has(c)) problems.push(`Polling unit ${c} doesn't exist`);
    const existing = new Set((await this.db.system<{ phone: string }>(
      `select phone from public.volunteers where tenant_id = $1 and phone = any($2)`, [user.tid, ok.map((o) => o.phone)])).map((r) => r.phone));
    const fresh = ok.filter((o) => !existing.has(o.phone));
    const summary = { valid: ok.length, problems: problems.slice(0, 100), problemCount: problems.length, already: ok.length - fresh.length, added: 0 };
    if (problems.length || dto.dryRun) return summary;
    await this.db.asUser(user, async (q) => {
      for (const o of fresh) {
        const code = o.role === 'agent' ? await freeAgentCode(q, o.phone) : null;
        await q(
          `insert into public.volunteers (tenant_id, full_name, phone, email, role, level, area_code, agent_code, languages, network, status, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'invited', $11) on conflict (tenant_id, phone) do nothing`,
          [user.tid, o.full_name, o.phone, o.email, o.role, o.level, o.area, code, o.languages, o.network, user.mid]);
      }
    });
    return { ...summary, added: fresh.length };
  }

  @Get('room-staff') @Roles(...ROOM)
  roomStaff(@CurrentUser() user: AuthUser) {
    return this.db.asUser(user, (q) => selectFn(q, 'room_staff'));
  }

  /** Admins add anyone; coordinators add agents, volunteers and ward coordinators inside their own area. */
  @Post() @Roles('admin', 'coordinator')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreatePersonDto) {
    const phone = normaliseNgPhone(dto.phone);
    if (!phone) throw new BadRequestException('Enter a Nigerian mobile number');
    const area = dto.level === 'pu' ? normalisePuCode(dto.areaCode) : dto.areaCode.trim();
    if (!area) throw new BadRequestException('Check the area code');
    if (user.role === 'coordinator' && !['agent', 'volunteer', 'coordinator'].includes(dto.role)) {
      throw new BadRequestException('Coordinators can add agents, volunteers and coordinators below them');
    }
    return this.db.asUser(user, async (q) => {
      const agentCode = dto.role === 'agent' ? await freeAgentCode(q, phone) : null;
      const [row] = await q(
        `insert into public.volunteers (tenant_id, full_name, phone, email, role, level, area_code, deputy_of, languages, agent_code, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::text[], '{en}'), $10, $11) returning ${COLS}`,
        [user.tid, dto.fullName.trim(), phone, dto.email?.toLowerCase() ?? null, dto.role, dto.level, area, dto.deputyOf ?? null, dto.languages ?? null, agentCode, user.mid]);
      return row;
    });
  }

  @Patch(':id') @Roles('admin', 'coordinator')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePersonDto) {
    const [row] = await this.db.asUser(user, (q) => q(
      `update public.volunteers set
          full_name = coalesce($2::text, full_name), email = coalesce($3::text, email), status = coalesce($4::text, status),
          languages = coalesce($5::text[], languages), deputy_of = coalesce($6::uuid, deputy_of)
        where id = $1 and tenant_id = $7 returning ${COLS}`,
      [id, dto.fullName ?? null, dto.email?.toLowerCase() ?? null, dto.status ?? null, dto.languages ?? null, dto.deputyOf ?? null, user.tid]));
    if (!row) throw new BadRequestException('Person not found in your area');
    return row;
  }

  @Delete(':id') @HttpCode(204) @Roles('admin', 'coordinator')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.update(user, id, { status: 'removed' });
  }
}

/** Agent codes go into coded SMS; they must be unique across every client the same phone works for. */
async function freeAgentCode(q: Q, phone: string): Promise<string> {
  const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  for (let i = 0; i < 20; i++) {
    const code = Array.from({ length: 4 }, () => A[randomInt(0, A.length)]).join('');
    const [{ taken }] = await q(`select public.agent_code_taken($1, $2) as taken`, [phone, code]);
    if (!taken) return code;
  }
  throw new BadRequestException('Could not allocate an agent code; try again');
}
