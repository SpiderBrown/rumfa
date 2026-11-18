import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe,
  Patch, Post, Put, Query, Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsDateString, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength,
} from 'class-validator';
import type { Response } from 'express';
import sharp from 'sharp';
import { Db } from '../database/db.service';
import type { AppConfig } from '../config/configuration';
import { CurrentStaff, Platform, Public } from '../auth/decorators';
import type { PlatformUser } from '../auth/auth.types';
import { keyedHash, randomToken } from '../auth/crypto';
import { StorageService } from '../common/storage.service';
import { audit } from './audit';

const ELECTION_TYPES = ['presidential', 'governorship', 'senate', 'reps', 'state_assembly', 'chairman', 'councillor', 'fct_area_council'];

class PartyDto {
  @ApiProperty() @Matches(/^[A-Z]{1,8}$/) acronym: string;
  @ApiProperty() @IsString() @Length(2, 100) name: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) colour?: string;
}
class PartyUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 100) name?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) colour?: string | null;
}
class LogoDto {
  @ApiProperty({ description: 'The image as a data URL (PNG, JPEG, WebP or SVG), up to 2 MB' }) @IsString() @MaxLength(2_800_000) dataUrl: string;
}
class ElectionDto {
  @ApiProperty() @IsString() @Length(3, 120) name: string;
  @ApiProperty({ enum: ELECTION_TYPES }) @IsIn(ELECTION_TYPES) electionType: string;
  @ApiProperty() @IsDateString() electionDate: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[0-9a-f]{24}$/) irevElectionId?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{2}$/) scopeStateCode?: string;
  @ApiPropertyOptional({ enum: ['upcoming', 'live', 'collation', 'closed'] }) @IsOptional() @IsIn(['upcoming', 'live', 'collation', 'closed']) status?: string;
  @ApiPropertyOptional({ description: 'Party acronyms in ballot order', type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(40) @Matches(/^[A-Z]{1,8}$/, { each: true }) parties?: string[];
}
class ElectionUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() electionDate?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Matches(/^[0-9a-f]{24}$/) irevElectionId?: string | null;
  @ApiPropertyOptional({ enum: ['upcoming', 'live', 'collation', 'closed'] }) @IsOptional() @IsIn(['upcoming', 'live', 'collation', 'closed']) status?: string;
}
class BallotDto {
  @ApiProperty({ description: 'Party acronyms in ballot order', type: [String] }) @IsArray() @ArrayMaxSize(40) @Matches(/^[A-Z]{1,8}$/, { each: true }) parties: string[];
}
class StaffDto {
  @ApiProperty() @IsEmail() @MaxLength(120) email: string;
  @ApiProperty() @IsString() @Length(3, 80) fullName: string;
  @ApiProperty({ enum: ['owner', 'staff', 'support'] }) @IsIn(['owner', 'staff', 'support']) role: string;
}
class StaffUpdateDto {
  @ApiPropertyOptional({ enum: ['owner', 'staff', 'support'] }) @IsOptional() @IsIn(['owner', 'staff', 'support']) role?: string;
  @ApiPropertyOptional({ enum: ['active', 'suspended'] }) @IsOptional() @IsIn(['active', 'suspended']) status?: string;
}

const logoUrl = (acronym: string, version: number) => version ? `/api/v1/parties/${acronym}/logo?v=${version}` : null;

/** Rumfa Console: shared data used by every client (parties, elections, places), Rumfa staff and the action log. */
@ApiTags('Rumfa Console: shared data')
@ApiBearerAuth()
@Controller('platform')
@Platform()
export class PlatformDataController {
  private readonly secret: string;
  constructor(private readonly db: Db, private readonly storage: StorageService, config: ConfigService) {
    this.secret = config.get<AppConfig['auth']>('auth')!.jwtSecret;
  }

  // ---- Parties ------------------------------------------------------------------------------------

  @Get('parties')
  async parties() {
    const rows = await this.db.system(
      `select p.acronym, p.name, p.colour, p.logo_version, p.updated_at,
              (select count(*) from public.election_parties ep where ep.party = p.acronym)::int as elections,
              (select count(*) from public.tenants t where t.party = p.acronym)::int as clients
         from public.parties p order by p.acronym`);
    return rows.map(({ logo_version, ...p }) => ({ ...p, logoUrl: logoUrl(p.acronym, logo_version) }));
  }

  @Post('parties') @Platform('owner', 'staff')
  async addParty(@CurrentStaff() s: PlatformUser, @Body() d: PartyDto) {
    const [r] = await this.db.system(
      `insert into public.parties (acronym, name, colour) values ($1, $2, $3) on conflict do nothing returning acronym`, [d.acronym, d.name.trim(), d.colour ?? null]);
    if (!r) throw new ConflictException(`${d.acronym} already exists`);
    await audit(this.q, s, 'party.add', 'party', d.acronym, d as any);
    return { acronym: d.acronym };
  }

  @Patch('parties/:acronym') @Platform('owner', 'staff')
  async updateParty(@CurrentStaff() s: PlatformUser, @Param('acronym') acronym: string, @Body() d: PartyUpdateDto) {
    const [r] = await this.db.system(
      `update public.parties set name = coalesce($2, name), colour = case when $4 then $3 else colour end, updated_at = now()
        where acronym = $1 returning acronym`, [acronym, d.name?.trim() ?? null, d.colour ?? null, d.colour !== undefined]);
    if (!r) throw new NotFoundException('Party not found');
    await audit(this.q, s, 'party.update', 'party', acronym, d as any);
    return { ok: true };
  }

  @Put('parties/:acronym/logo') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Set a party\'s logo (resized to a 256 px square PNG on a transparent background)' })
  async setLogo(@CurrentStaff() s: PlatformUser, @Param('acronym') acronym: string, @Body() d: LogoDto) {
    const m = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,(.+)$/.exec(d.dataUrl);
    if (!m) throw new BadRequestException('Upload a PNG, JPEG, WebP or SVG image');
    const raw = Buffer.from(m[2], 'base64');
    if (raw.length > 2_000_000) throw new BadRequestException('The image is over 2 MB');
    let png: Buffer;
    try {
      png = await sharp(raw).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    } catch { throw new BadRequestException('That file could not be read as an image'); }
    const [p] = await this.db.system(`select acronym from public.parties where acronym = $1`, [acronym]);
    if (!p) throw new NotFoundException('Party not found');
    await this.storage.put('party-logos', `${acronym}.png`, png, 'image/png');
    const [r] = await this.db.system(
      `update public.parties set logo_path = $2, logo_version = logo_version + 1, updated_at = now() where acronym = $1 returning logo_version`,
      [acronym, `${acronym}.png`]);
    await audit(this.q, s, 'party.logo', 'party', acronym, { bytes: png.length });
    return { logoUrl: logoUrl(acronym, r.logo_version) };
  }

  @Delete('parties/:acronym/logo') @HttpCode(204) @Platform('owner', 'staff')
  async removeLogo(@CurrentStaff() s: PlatformUser, @Param('acronym') acronym: string) {
    await this.db.system(`update public.parties set logo_path = null, logo_version = 0, updated_at = now() where acronym = $1`, [acronym]);
    await audit(this.q, s, 'party.logo_removed', 'party', acronym);
  }

  // ---- Elections ----------------------------------------------------------------------------------

  @Get('elections')
  elections() {
    return this.db.system(
      `select e.id, e.name, e.election_type, to_char(e.election_date, 'YYYY-MM-DD') as election_date, e.irev_election_id, e.scope_state_code, e.status,
              (select coalesce(json_agg(ep.party order by ep.ballot_order, ep.party), '[]') from public.election_parties ep where ep.election_id = e.id) as parties,
              (select count(*) from public.tenant_elections te where te.election_id = e.id)::int as clients
         from public.elections e order by e.election_date desc, e.name`);
  }

  @Post('elections') @Platform('owner', 'staff')
  async addElection(@CurrentStaff() s: PlatformUser, @Body() d: ElectionDto) {
    return this.db.systemTx(async (q) => {
      const [r] = await q(
        `insert into public.elections (name, election_type, election_date, irev_election_id, scope_state_code, status)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [d.name.trim(), d.electionType, d.electionDate, d.irevElectionId ?? null, d.scopeStateCode ?? null, d.status ?? 'upcoming']);
      if (d.parties?.length) await this.saveBallot(q, r.id, d.parties);
      await audit(q, s, 'election.add', 'election', r.id, d as any);
      return { id: r.id };
    });
  }

  @Patch('elections/:id') @Platform('owner', 'staff')
  async updateElection(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ElectionUpdateDto) {
    const [r] = await this.db.system(
      `update public.elections set name = coalesce($2, name), election_date = coalesce($3::date, election_date),
              irev_election_id = case when $6 then $4 else irev_election_id end, status = coalesce($5, status)
        where id = $1 returning id`,
      [id, d.name?.trim() ?? null, d.electionDate ?? null, d.irevElectionId ?? null, d.status ?? null, d.irevElectionId !== undefined]);
    if (!r) throw new NotFoundException('Election not found');
    await audit(this.q, s, 'election.update', 'election', id, d as any);
    return { ok: true };
  }

  @Put('elections/:id/parties') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'The parties on an election\'s ballot, in ballot order' })
  async ballot(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: BallotDto) {
    return this.db.systemTx(async (q) => {
      if (!(await q(`select 1 from public.elections where id = $1`, [id])).length) throw new NotFoundException('Election not found');
      const list = await this.saveBallot(q, id, d.parties);
      await audit(q, s, 'election.ballot', 'election', id, { parties: list });
      return { parties: list };
    });
  }

  /** The ballot: these parties in this order (unknown acronyms refused). */
  private async saveBallot(q: (sql: string, p?: unknown[]) => Promise<any[]>, id: string, parties: string[]) {
    const list = [...new Set(parties)];
    const known = (await q(`select acronym from public.parties where acronym = any($1)`, [list])).map((p) => p.acronym);
    const unknown = list.filter((p) => !known.includes(p));
    if (unknown.length) throw new BadRequestException(`Unknown parties: ${unknown.join(', ')}. Add them on the Parties page first.`);
    await q(`delete from public.election_parties where election_id = $1 and not (party = any($2))`, [id, list]);
    for (const [i, p] of list.entries()) {
      await q(`insert into public.election_parties (election_id, party, ballot_order) values ($1, $2, $3)
               on conflict (election_id, party) do update set ballot_order = excluded.ballot_order`, [id, p, i + 1]);
    }
    return list;
  }

  // ---- Places (for onboarding: pick a seat's area) ------------------------------------------------

  @Get('places')
  @ApiOperation({ summary: 'Children of an area: NG → states (with zone), a state → LGAs and senatorial districts, an LGA → wards' })
  async places(@Query('parent') parent = 'NG') {
    if (parent === 'NG') return { items: await this.db.system(`select code, name, zone from public.states order by name`) };
    if (/^\d{2}$/.test(parent)) {
      return {
        items: await this.db.system(`select code, name, senatorial_code from public.lgas where state_code = $1 order by name`, [parent]),
        districts: await this.db.system(
          `select d.code, d.name, (select count(*) from public.lgas l where l.senatorial_code = d.code)::int as lgas
             from public.senatorial_districts d where d.state_code = $1 order by d.code`, [parent]),
        // House of Reps (federal) and State Assembly (state) constituencies, with the LGAs their wards are in
        constituencies: await this.db.system(
          `select c.code, c.name, c.kind,
                  coalesce((select array_agg(distinct w.lga_code order by w.lga_code) from public.wards w
                             where w.lga_code like c.state_code || '-%'
                               and ((c.kind = 'federal' and w.federal_constituency = c.irev_no::text) or (c.kind = 'state' and w.state_constituency = c.irev_no::text))), '{}') as lgas
             from public.constituencies c where c.state_code = $1 order by c.kind, c.name`, [parent]),
      };
    }
    if (/^\d{2}-\d{2}$/.test(parent)) return { items: await this.db.system(`select code, name from public.wards where lga_code = $1 order by name`, [parent]) };
    throw new BadRequestException('Unknown area');
  }

  // ---- Rumfa staff and the action log -------------------------------------------------------------

  @Get('staff')
  staff() {
    return this.db.system(
      `select s.id, s.email, s.full_name, s.role, s.status, s.created_at, i.last_login_at
         from public.platform_staff s left join public.identities i on i.id = s.identity_id order by s.status, s.full_name`);
  }

  @Post('staff') @Platform('owner')
  @ApiOperation({ summary: 'Invite a Rumfa staff member (answers with a link to set their password)' })
  async addStaff(@CurrentStaff() s: PlatformUser, @Body() d: StaffDto) {
    const email = d.email.trim().toLowerCase();
    return this.db.systemTx(async (q) => {
      const [r] = await q(
        `insert into public.platform_staff (email, full_name, role, created_by) values ($1, $2, $3, $4) on conflict (email) do nothing returning id`,
        [email, d.fullName.trim(), d.role, s.sid]);
      if (!r) throw new ConflictException(`${email} is already Rumfa staff`);
      const token = await this.staffInvite(q, r.id, s.sid);
      await audit(q, s, 'staff.invite', 'staff', r.id, { email, role: d.role });
      return { id: r.id, inviteToken: token };
    });
  }

  @Patch('staff/:id') @Platform('owner')
  async updateStaff(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: StaffUpdateDto) {
    if (id === s.sid && (d.role && d.role !== 'owner' || d.status === 'suspended')) throw new ForbiddenException('You cannot remove your own owner access');
    await this.db.systemTx(async (q) => {
      const [r] = await q(`update public.platform_staff set role = coalesce($2, role), status = coalesce($3, status) where id = $1 returning id`,
        [id, d.role ?? null, d.status ?? null]);
      if (!r) throw new NotFoundException('Staff member not found');
      if (d.status === 'suspended') await q(`update public.platform_refresh_tokens set revoked_at = now() where staff_id = $1 and revoked_at is null`, [id]);
      await audit(q, s, 'staff.update', 'staff', id, d as any);
    });
    return { ok: true };
  }

  @Post('staff/:id/reset') @Platform('owner')
  @ApiOperation({ summary: 'A new link to set the password (they are signed out now)' })
  async resetStaff(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.systemTx(async (q) => {
      const [r] = await q(`select identity_id from public.platform_staff where id = $1`, [id]);
      if (!r) throw new NotFoundException('Staff member not found');
      await q(`update public.platform_refresh_tokens set revoked_at = now() where staff_id = $1 and revoked_at is null`, [id]);
      const token = await this.staffInvite(q, id, s.sid);
      await audit(q, s, 'staff.reset', 'staff', id);
      return { inviteToken: token };
    });
  }

  @Get('audit')
  audit(@Query('client') client?: string, @Query('limit') limit?: string) {
    return this.db.system(
      `select a.id, a.at, a.action, a.target_type, a.target_id, a.details, a.tenant_id, t.name as client, s.full_name as by
         from public.platform_audit a left join public.platform_staff s on s.id = a.staff_id left join public.tenants t on t.id = a.tenant_id
        where ($1::uuid is null or a.tenant_id = $1) order by a.at desc limit $2`,
      [client || null, Math.min(Number(limit) || 100, 500)]);
  }

  private async staffInvite(q: (sql: string, p?: unknown[]) => Promise<any[]>, staffId: string, by: string) {
    const token = randomToken();
    await q(`insert into public.platform_invites (staff_id, token_hash, expires_at, created_by) values ($1, $2, now() + interval '3 days', $3)`,
      [staffId, keyedHash(this.secret, `pinvite:${token}`), by]);
    return token;
  }

  private q = (sql: string, p?: unknown[]) => this.db.system(sql, p);
}

/** Party logos for every app (no sign-in; they are public symbols). Cached for a year: the URL changes with each new logo. */
@ApiTags('Parties')
@Controller('parties')
export class PartyLogoController {
  constructor(private readonly db: Db, private readonly storage: StorageService) {}

  @Public() @Get(':acronym/logo')
  async logo(@Param('acronym') acronym: string, @Res() res: Response) {
    const [p] = await this.db.system(`select logo_path from public.parties where acronym = $1`, [acronym]);
    if (!p?.logo_path) throw new NotFoundException('No logo');
    const { bytes } = await this.storage.get('party-logos', p.logo_path);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(bytes);
  }
}
