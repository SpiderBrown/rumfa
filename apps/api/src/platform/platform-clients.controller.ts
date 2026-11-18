import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Db } from '../database/db.service';
import { addonSettings } from '../common/tenant-settings';
import type { AppConfig } from '../config/configuration';
import { CurrentStaff, Platform } from '../auth/decorators';
import type { PlatformUser } from '../auth/auth.types';
import { keyedHash, randomToken } from '../auth/crypto';
import { normaliseNgPhone } from '../shared';
import { audit } from './audit';
import { SEATS, coordinatorLevels, insideSeat, seatAreaValid, seatInfo, staffArea } from './seats';
import { WARDS_OF_CONSTITUENCY } from './constituency-import';

type Q = (sql: string, params?: unknown[]) => Promise<any[]>;

class AdminDto {
  @ApiProperty() @IsString() @Length(3, 80) fullName: string;
  @ApiProperty() @IsEmail() @MaxLength(120) email: string;
  @ApiProperty({ description: 'Every person has a phone (calls, SMS alerts)' }) @IsString() @MaxLength(20) phone: string;
}
class CoordinatorDto {
  @ApiProperty() @IsString() @Length(3, 80) fullName: string;
  @ApiProperty() @IsString() @MaxLength(20) phone: string;
  @ApiProperty({ enum: ['national', 'state', 'lga', 'ward'] }) @IsIn(['national', 'state', 'lga', 'ward']) level: string;
  @ApiProperty() @IsString() @MaxLength(12) areaCode: string;
}
class OnboardDto {
  @ApiProperty({ description: 'Organisation name, e.g. "Abba for Governor 2027"' }) @IsString() @Length(3, 100) name: string;
  @ApiProperty({ description: 'Short name shown in the apps and at the start of SMS' }) @IsString() @Length(2, 20) brand: string;
  @ApiProperty() @IsString() @Length(3, 100) candidateName: string;
  @ApiProperty() @Matches(/^[A-Z]{1,8}$/) party: string;
  @ApiProperty({ enum: SEATS.map((s) => s.seat) }) @IsIn(SEATS.map((s) => s.seat)) seat: string;
  @ApiProperty({ description: 'NG, a state (19), a senatorial district (19-SD1), an LGA (19-28) or a ward (19-28-02)' }) @IsString() @MaxLength(12) seatArea: string;
  @ApiProperty() @IsUUID() liveElectionId: string;
  @ApiPropertyOptional({ description: 'A past election to compare with' }) @IsOptional() @IsUUID() baselineElectionId?: string;
  @ApiProperty({ type: [AdminDto] }) @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => AdminDto) admins: AdminDto[];
  @ApiProperty({ type: [CoordinatorDto] }) @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => CoordinatorDto) coordinators: CoordinatorDto[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(/^[a-z0-9.-]+(:[0-9]+)?$/, { each: true }) domains?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
class LimitsDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) topup_per_person_cap_ngn?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) topup_daily_cap_ngn?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) merge_window_min?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) reopen_window_min?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) related_window_min?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) callback_retry_min?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) irev_recheck_min?: number;
}
class AddonsDto {
  @ApiPropertyOptional({ description: 'Voice outreach' }) @IsOptional() @IsBoolean() voice?: boolean;
  @ApiPropertyOptional({ description: 'Airtime and data top-ups' }) @IsOptional() @IsBoolean() airtime?: boolean;
}
class UpdateClientDto {
  @ApiPropertyOptional({ type: AddonsDto, description: 'Premium add-ons to switch on or off' }) @IsOptional() @ValidateNested() @Type(() => AddonsDto) addons?: AddonsDto;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 20) brand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(3, 100) candidateName?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{1,8}$/) party?: string;
  @ApiPropertyOptional({ enum: ['active', 'suspended', 'archived'] }) @IsOptional() @IsIn(['active', 'suspended', 'archived']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional({ type: LimitsDto }) @IsOptional() @ValidateNested() @Type(() => LimitsDto) limits?: LimitsDto;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(10) @Matches(/^[a-z0-9.-]+(:[0-9]+)?$/, { each: true }) domains?: string[];
  @ApiPropertyOptional() @IsOptional() @IsUUID() liveElectionId?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() baselineElectionId?: string | null;
}
class SeatDto {
  @ApiProperty({ enum: SEATS.map((s) => s.seat) }) @IsIn(SEATS.map((s) => s.seat)) seat: string;
  @ApiProperty() @IsString() @MaxLength(12) seatArea: string;
  @ApiPropertyOptional({ description: 'false (default): only show what would change; true: change it' }) @IsOptional() @IsBoolean() confirm?: boolean;
}
class AddPersonDto {
  @ApiProperty({ enum: ['admin', 'coordinator'] }) @IsIn(['admin', 'coordinator']) kind: 'admin' | 'coordinator';
  @ApiProperty() @IsString() @Length(3, 80) fullName: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(120) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['national', 'state', 'lga', 'ward']) level?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(12) areaCode?: string;
}

const LIMIT_KEYS = ['topup_per_person_cap_ngn', 'topup_daily_cap_ngn', 'merge_window_min', 'reopen_window_min', 'related_window_min',
  'callback_retry_min', 'irev_recheck_min'] as const;

/**
 * Rumfa Console: clients (a candidate's campaign). Onboarding creates the organisation, its area (from the seat), its
 * elections, its situation room desks, its first admins (invite links) and its first coordinators, in one step.
 */
@ApiTags('Rumfa Console: clients')
@ApiBearerAuth()
@Controller('platform/clients')
@Platform()
export class PlatformClientsController {
  private readonly secret: string;
  constructor(private readonly db: Db, config: ConfigService) {
    this.secret = config.get<AppConfig['auth']>('auth')!.jwtSecret;
  }

  @Get('seats')
  @ApiOperation({ summary: 'Seats a client can run for, the area each needs and the levels of its first coordinators' })
  seats() {
    return SEATS.map((s) => ({ ...s, coordinatorLevels: coordinatorLevels(s.seat) }));
  }

  @Get()
  list() {
    return this.db.system(
      `select t.id, t.name, coalesce(t.settings->>'brand', t.name) as brand, t.status, t.candidate_name, t.party, t.seat, t.seat_area,
              ${AREA_NAME('t.seat_area')} as seat_area_name, t.created_at,
              (select e.name from public.tenant_elections te join public.elections e on e.id = te.election_id
                where te.tenant_id = t.id and te.purpose = 'live' limit 1) as live_election,
              (select count(*) from public.volunteers v where v.tenant_id = t.id and v.role = 'agent')::int as agents,
              (select count(*) from public.volunteers v where v.tenant_id = t.id and v.role = 'coordinator')::int as coordinators,
              (select count(*) from public.volunteers v where v.tenant_id = t.id and v.role not in ('agent', 'volunteer', 'coordinator'))::int as staff,
              (select array_agg(d.domain order by d.domain) from public.tenant_domains d where d.tenant_id = t.id) as domains,
              coalesce(t.settings->'addons', '{}'::jsonb) as addons
         from public.tenants t order by t.status = 'active' desc, t.created_at desc`);
  }

  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const [t] = await this.db.system(
      `select t.*, ${AREA_NAME('t.seat_area')} as seat_area_name from public.tenants t where t.id = $1`, [id]);
    if (!t) throw new NotFoundException('Client not found');
    const [coverage, elections, domains, people, recent] = [
      await this.db.system(`select level, area_code, ${AREA_NAME('area_code')} as name from public.tenant_coverage where tenant_id = $1 order by area_code`, [id]),
      await this.db.system(
        `select te.purpose, e.id, e.name, e.election_type, to_char(e.election_date, 'YYYY-MM-DD') as election_date, e.status from public.tenant_elections te
           join public.elections e on e.id = te.election_id where te.tenant_id = $1 order by te.purpose desc`, [id]),
      (await this.db.system(`select domain from public.tenant_domains where tenant_id = $1 order by domain`, [id])).map((d) => d.domain),
      await this.db.system(
        `select v.id, v.full_name, v.role, v.level, v.area_code, ${AREA_NAME('v.area_code')} as area_name, v.email, v.phone, v.status, v.created_at
           from public.volunteers v where v.tenant_id = $1 and v.role not in ('agent', 'volunteer') and v.platform_staff_id is null
          order by v.role = 'admin' desc, length(v.area_code), v.full_name limit 200`, [id]),
      await this.db.system(
        `select a.at, a.action, a.details, s.full_name as by from public.platform_audit a left join public.platform_staff s on s.id = a.staff_id
          where a.tenant_id = $1 order by a.at desc limit 30`, [id]),
    ];
    const settings = t.settings ?? {};
    return {
      id: t.id, name: t.name, brand: settings.brand ?? t.name, status: t.status, candidateName: t.candidate_name, party: t.party,
      seat: t.seat, seatArea: t.seat_area, seatAreaName: t.seat_area_name, notes: t.notes, createdAt: t.created_at,
      limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, settings[k] ?? null])),
      addons: addonSettings(settings),
      coverage, elections, domains, people, recent,
    };
  }

  @Post()
  @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Onboard a client: organisation, area from the seat, elections, desks, first admins and coordinators' })
  async onboard(@CurrentStaff() s: PlatformUser, @Body() d: OnboardDto) {
    const seat = seatInfo(d.seat)!;
    if (!seat.ready) throw new BadRequestException(`${seat.label} needs constituencies, which are not loaded yet`);
    if (!seatAreaValid(d.seat, d.seatArea)) throw new BadRequestException(`Pick the ${seat.area === 'senatorial' ? 'senatorial district' : seat.area} for a ${seat.label} seat`);
    if (!d.admins.length) throw new BadRequestException('Add at least one admin for the client\'s dashboard');

    return this.db.systemTx(async (q) => {
      await this.mustExist(q, d.seatArea);
      const [party] = await q(`select acronym from public.parties where acronym = $1`, [d.party]);
      if (!party) throw new BadRequestException('Unknown party');
      await this.mustBeElection(q, d.liveElectionId);
      if (d.baselineElectionId) await this.mustBeElection(q, d.baselineElectionId);
      const { cover, districtLgas } = await this.coverageFor(q, d.seat, d.seatArea);

      const settings = { brand: d.brand.trim(), party: d.party };
      // The table's default settings (limits) plus the brand and party
      const [t] = await q(
        `insert into public.tenants (name, candidate_name, party, seat, seat_area, onboarded_by, notes)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [d.name.trim(), d.candidateName.trim(), d.party, d.seat, d.seatArea, s.sid, d.notes ?? null]);
      await q(`update public.tenants set settings = settings || $2::jsonb where id = $1`, [t.id, JSON.stringify(settings)]);
      const tid: string = t.id;

      // Area: what the client works in (and may see)
      for (const [level, code] of cover) await q(`insert into public.tenant_coverage values ($1, $2, $3)`, [tid, level, code]);

      await q(`insert into public.tenant_elections values ($1, $2, 'live')`, [tid, d.liveElectionId]);
      if (d.baselineElectionId && d.baselineElectionId !== d.liveElectionId) {
        await q(`insert into public.tenant_elections values ($1, $2, 'baseline')`, [tid, d.baselineElectionId]);
      }

      // Situation room desks: one room for the area, plus security, legal and the agents' helpdesk
      await this.roomDesk(q, tid, seat.area, d.seatArea);
      await q(`insert into public.queues (tenant_id, kind, state_code, name) values
                 ($1, 'security', null, 'Security desk'), ($1, 'legal', null, 'Legal desk'), ($1, 'helpdesk', null, 'Agent helpdesk')`, [tid]);

      const where = staffArea(d.seat, d.seatArea);
      const invites = [];
      for (const a of dedupe(d.admins, (x) => x.email.toLowerCase())) invites.push(await this.addAdmin(q, tid, a.fullName, a.email, a.phone, where));
      const coordinators = [];
      for (const c of dedupe(d.coordinators, (x) => normaliseNgPhone(x.phone) ?? x.phone)) {
        coordinators.push(await this.addCoordinator(q, tid, d.seat, d.seatArea, districtLgas, c));
      }
      for (const dom of d.domains ?? []) await this.addDomain(q, tid, dom);

      await audit(q, s, 'client.onboard', 'client', tid,
        { name: d.name, seat: d.seat, seatArea: d.seatArea, party: d.party, admins: invites.length, coordinators: coordinators.length }, tid);
      return { id: tid, invites, coordinators };
    });
  }

  @Patch(':id')
  @Platform('owner', 'staff')
  async update(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateClientDto) {
    return this.db.systemTx(async (q) => {
      const [t] = await q(`select id, settings from public.tenants where id = $1 for update`, [id]);
      if (!t) throw new NotFoundException('Client not found');
      const sets: string[] = [];
      const vals: unknown[] = [id];
      const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (d.name !== undefined) add('name', d.name.trim());
      if (d.candidateName !== undefined) add('candidate_name', d.candidateName.trim());
      if (d.party !== undefined) {
        if (!(await q(`select 1 from public.parties where acronym = $1`, [d.party])).length) throw new BadRequestException('Unknown party');
        add('party', d.party);
      }
      if (d.status !== undefined) add('status', d.status);
      if (d.notes !== undefined) add('notes', d.notes);
      const patch: Record<string, unknown> = {};
      if (d.brand !== undefined) patch.brand = d.brand.trim();
      if (d.party !== undefined) patch.party = d.party;
      for (const k of LIMIT_KEYS) if (d.limits?.[k] !== undefined) patch[k] = d.limits[k];
      if (d.addons) patch.addons = { ...addonSettings(t.settings), ...Object.fromEntries(Object.entries(d.addons).filter(([, v]) => v !== undefined)) };
      if (Object.keys(patch).length) add('settings', JSON.stringify({ ...(t.settings ?? {}), ...patch }));
      if (sets.length) await q(`update public.tenants set ${sets.join(', ')} where id = $1`, vals);

      if (d.domains) {
        await q(`delete from public.tenant_domains where tenant_id = $1 and not (domain = any($2))`, [id, d.domains]);
        for (const dom of d.domains) await this.addDomain(q, id, dom);
      }
      if (d.liveElectionId) {
        await this.mustBeElection(q, d.liveElectionId);
        await q(`delete from public.tenant_elections where tenant_id = $1 and (purpose = 'live' or election_id = $2)`, [id, d.liveElectionId]);
        await q(`insert into public.tenant_elections values ($1, $2, 'live')`, [id, d.liveElectionId]);
      }
      if (d.baselineElectionId !== undefined) {
        await q(`delete from public.tenant_elections where tenant_id = $1 and purpose = 'baseline'`, [id]);
        if (d.baselineElectionId) {
          await this.mustBeElection(q, d.baselineElectionId);
          await q(`insert into public.tenant_elections values ($1, $2, 'baseline') on conflict do nothing`, [id, d.baselineElectionId]);
        }
      }
      const changed = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
      await audit(q, s, d.status && Object.keys(changed).length === 1 ? `client.${d.status}` : 'client.update', 'client', id, changed, id);
      return { ok: true };
    });
  }

  @Post(':id/seat')
  @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Change the seat: the client\'s area follows, admins move to it, a room desk is added. Without confirm, only shows what would change' })
  async changeSeat(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: SeatDto) {
    const seat = seatInfo(d.seat)!;
    if (!seat.ready) throw new BadRequestException(`${seat.label} needs constituencies, which are not loaded yet`);
    if (!seatAreaValid(d.seat, d.seatArea)) throw new BadRequestException(`Pick the ${seat.area === 'senatorial' ? 'senatorial district' : seat.area} for a ${seat.label} seat`);
    return this.db.systemTx(async (q) => {
      const [t] = await q(`select id, seat, seat_area from public.tenants where id = $1 for update`, [id]);
      if (!t) throw new NotFoundException('Client not found');
      await this.mustExist(q, d.seatArea);
      const { cover, districtLgas } = await this.coverageFor(q, d.seat, d.seatArea);
      const codes = cover.map(([, c]) => c);
      const where = staffArea(d.seat, d.seatArea);
      const old = t.seat ? staffArea(t.seat, t.seat_area) : null;
      // Admins at the old seat's top move with the seat; everyone else stays where they are
      const admins = await q(
        `select id from public.volunteers where tenant_id = $1 and role = 'admin' and platform_staff_id is null and status <> 'removed'
           and ($2::text is null or area_code = $2)`, [id, old?.area ?? null]);
      const [outside] = await q(
        `select count(*)::int as n, count(*) filter (where role = 'coordinator')::int as coordinators, count(*) filter (where role = 'agent')::int as agents
           from public.volunteers v
          where v.tenant_id = $1 and v.platform_staff_id is null and v.status <> 'removed' and v.role <> 'admin'
            and not exists (select 1 from unnest($2::text[]) c where c = 'NG' or v.area_code = c or v.area_code like c || '-%')`, [id, codes]);
      const names = await q(`select ${AREA_NAME('c')} as name from unnest($1::text[]) c`, [codes]);
      const preview = {
        seat: d.seat, seatArea: d.seatArea, coverage: names.map((n) => n.name), adminsMoved: admins.length, adminArea: where,
        outside, districtLgas: districtLgas.length,
      };
      if (!d.confirm) return { preview };

      await q(`update public.tenants set seat = $2, seat_area = $3 where id = $1`, [id, d.seat, d.seatArea]);
      await q(`delete from public.tenant_coverage where tenant_id = $1`, [id]);
      for (const [level, code] of cover) await q(`insert into public.tenant_coverage values ($1, $2, $3)`, [id, level, code]);
      await this.roomDesk(q, id, seat.area, d.seatArea);
      if (admins.length) {
        await q(`update public.volunteers set level = $2, area_code = $3 where id = any($1)`, [admins.map((a) => a.id), where.level, where.area]);
      }
      await q(`update public.volunteers set level = $2, area_code = $3 where tenant_id = $1 and platform_staff_id is not null`, [id, where.level, where.area]);
      await audit(q, s, 'client.seat', 'client', id, { from: { seat: t.seat, seatArea: t.seat_area }, to: { seat: d.seat, seatArea: d.seatArea }, adminsMoved: admins.length }, id);
      return { preview, changed: true };
    });
  }

  @Post(':id/people')
  @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Add an admin (answers with an invite link) or a coordinator to a client' })
  async addPerson(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: AddPersonDto) {
    return this.db.systemTx(async (q) => {
      const [t] = await q(`select seat, seat_area from public.tenants where id = $1`, [id]);
      if (!t) throw new NotFoundException('Client not found');
      let out;
      if (d.kind === 'admin') {
        if (!d.email || !d.phone) throw new BadRequestException('An admin needs an email address and a phone number');
        const where = t.seat ? staffArea(t.seat, t.seat_area) : { level: 'national', area: 'NG' };
        out = await this.addAdmin(q, id, d.fullName, d.email, d.phone, where);
      } else {
        if (!d.phone || !d.level || !d.areaCode) throw new BadRequestException('A coordinator needs a phone number, a level and an area');
        const lgas = t.seat && ['senatorial', 'constituency'].includes(seatInfo(t.seat)?.area ?? '')
          ? (await this.coverageFor(q, t.seat, t.seat_area)).districtLgas : [];
        out = await this.addCoordinator(q, id, t.seat ?? 'presidential', t.seat_area ?? 'NG', lgas, d as CoordinatorDto);
      }
      await audit(q, s, `client.add_${d.kind}`, 'client', id, { fullName: d.fullName, email: d.email, phone: d.phone, areaCode: d.areaCode }, id);
      return out;
    });
  }

  @Post(':id/people/:pid/invite')
  @Platform('owner', 'staff', 'support')
  @ApiOperation({ summary: 'A new invite link for one of the client\'s dashboard staff (to set or reset their password)' })
  async reinvite(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.db.systemTx(async (q) => {
      const [v] = await q(`select id, email, role, full_name from public.volunteers where id = $1 and tenant_id = $2`, [pid, id]);
      if (!v) throw new NotFoundException('Person not found');
      if (!v.email || ['agent', 'volunteer', 'coordinator'].includes(v.role)) throw new BadRequestException('Only dashboard staff sign in with an invite link');
      const token = await this.invite(q, v.id);
      await audit(q, s, 'client.reinvite', 'person', v.id, { email: v.email }, id);
      return { fullName: v.full_name, email: v.email, inviteToken: token };
    });
  }

  @Post(':id/open')
  @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Open the client\'s dashboard as an admin: a one-time ticket (2 minutes) and the addresses to open it on' })
  async open(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string) {
    const [t] = await this.db.system(`select status from public.tenants where id = $1`, [id]);
    if (!t) throw new NotFoundException('Client not found');
    if (t.status !== 'active') throw new BadRequestException('Make the client active first');
    const ticket = randomToken();
    await this.db.system(
      `insert into public.platform_support_tickets (token_hash, staff_id, tenant_id, expires_at) values ($1, $2, $3, now() + interval '2 minutes')`,
      [keyedHash(this.secret, `support:${ticket}`), s.sid, id]);
    const domains = (await this.db.system(`select domain from public.tenant_domains where tenant_id = $1 order by domain`, [id])).map((d) => d.domain);
    return { ticket, domains };
  }

  // ---- helpers ------------------------------------------------------------------------------------

  /** What a seat covers: the whole country, a state, a district's LGAs, or the LGA (of an LGA or ward seat). */
  private async coverageFor(q: Q, seat: string, area: string) {
    const info = seatInfo(seat)!;
    const districtLgas: string[] = info.area === 'senatorial'
      ? (await q(`select code from public.lgas where senatorial_code = $1 order by code`, [area])).map((l) => l.code)
      : info.area === 'constituency' ? (await q(`select distinct lga_code as code from (${WARDS_OF_CONSTITUENCY('$1')}) w order by 1`, [area])).map((l) => l.code) : [];
    if (info.area === 'senatorial' && !districtLgas.length) throw new BadRequestException('That district has no LGAs linked yet (load senatorial boundaries)');
    if (info.area === 'constituency' && !districtLgas.length) throw new BadRequestException('No wards are linked to that constituency yet (load the state\'s places from IReV)');
    const cover: [string, string][] = info.area === 'national' ? [['national', 'NG']] : info.area === 'state' ? [['state', area]]
      : info.area === 'senatorial' || info.area === 'constituency' ? districtLgas.map((l) => ['lga', l]) : [['lga', area.slice(0, 5)]];
    return { cover, districtLgas };
  }

  /** The seat's situation room desk (the national room, or the state's room), if the client has none yet. */
  private async roomDesk(q: Q, tid: string, areaKind: string, area: string) {
    if (areaKind === 'national') {
      // (no state code, so the unique key does not catch a second one: check first)
      await q(`insert into public.queues (tenant_id, kind, state_code, name) select $1, 'national', null, 'National room'
                where not exists (select 1 from public.queues where tenant_id = $1 and kind = 'national')`, [tid]);
      return;
    }
    const [st] = await q(`select name from public.states where code = $1`, [area.slice(0, 2)]);
    await q(`insert into public.queues (tenant_id, kind, state_code, name) values ($1, 'state', $2, $3) on conflict do nothing`, [tid, area.slice(0, 2), `${st.name} room`]);
  }

  private async addAdmin(q: Q, tid: string, fullName: string, email: string, rawPhone: string, where: { level: string; area: string }) {
    const e = email.trim().toLowerCase();
    const phone = normaliseNgPhone(rawPhone);
    if (!phone) throw new BadRequestException(`${fullName}: enter a Nigerian mobile number`);
    const [dup] = await q(`select 1 from public.volunteers where tenant_id = $1 and (lower(email) = $2 or phone = $3)`, [tid, e, phone]);
    if (dup) throw new ConflictException(`${e} or ${phone} is already in this client`);
    const [v] = await q(
      `insert into public.volunteers (tenant_id, full_name, email, phone, role, level, area_code, status)
       values ($1, $2, $3, $4, 'admin', $5, $6, 'invited') returning id`, [tid, fullName.trim(), e, phone, where.level, where.area]);
    return { id: v.id, fullName: fullName.trim(), email: e, phone, inviteToken: await this.invite(q, v.id) };
  }

  private async invite(q: Q, volunteerId: string) {
    const token = randomToken();
    await q(`insert into public.staff_invites (volunteer_id, token_hash, expires_at) values ($1, $2, now() + interval '7 days')`,
      [volunteerId, keyedHash(this.secret, `invite:${token}`)]);
    return token;
  }

  private async addCoordinator(q: Q, tid: string, seat: string, seatArea: string, districtLgas: string[], c: CoordinatorDto) {
    const phone = normaliseNgPhone(c.phone);
    if (!phone) throw new BadRequestException(`${c.fullName}: enter a Nigerian mobile number`);
    if (!coordinatorLevels(seat).includes(c.level)) throw new BadRequestException(`${c.fullName}: a ${seatInfo(seat)!.label} client's first coordinators are at ${coordinatorLevels(seat).join(' or ')} level`);
    const len = { national: 2, state: 2, lga: 5, ward: 8 }[c.level]!;
    if (c.level === 'national' ? c.areaCode !== 'NG' : c.areaCode.length !== len) throw new BadRequestException(`${c.fullName}: the area does not match the level`);
    if (!insideSeat(seat, seatArea, c.areaCode, districtLgas)) throw new BadRequestException(`${c.fullName}: that area is outside the seat`);
    if (c.areaCode !== 'NG') await this.mustExist(q, c.areaCode);
    const [dup] = await q(`select 1 from public.volunteers where tenant_id = $1 and phone = $2`, [tid, phone]);
    if (dup) throw new ConflictException(`${phone} is already in this client`);
    const [v] = await q(
      `insert into public.volunteers (tenant_id, full_name, phone, role, level, area_code, status)
       values ($1, $2, $3, 'coordinator', $4, $5, 'invited') returning id`, [tid, c.fullName.trim(), phone, c.level, c.areaCode]);
    return { id: v.id, fullName: c.fullName.trim(), phone, level: c.level, areaCode: c.areaCode };
  }

  private async addDomain(q: Q, tid: string, domain: string) {
    const [other] = await q(`select tenant_id from public.tenant_domains where domain = $1`, [domain]);
    if (other && other.tenant_id !== tid) throw new ConflictException(`${domain} is already used by another client`);
    await q(`insert into public.tenant_domains (domain, tenant_id) values ($1, $2) on conflict do nothing`, [domain, tid]);
  }

  private async mustExist(q: Q, code: string) {
    if (code === 'NG') return;
    const [r] = await q(
      `select 1 from public.states where code = $1 union all select 1 from public.senatorial_districts where code = $1
       union all select 1 from public.lgas where code = $1 union all select 1 from public.wards where code = $1
       union all select 1 from public.constituencies where code = $1`, [code]);
    if (!r) throw new BadRequestException(`Unknown area ${code}`);
  }

  private async mustBeElection(q: Q, id: string) {
    if (!(await q(`select 1 from public.elections where id = $1`, [id])).length) throw new BadRequestException('Unknown election');
  }
}

/** SQL for the name of an area code (Nigeria, state, district, LGA, ward or polling unit). */
export const AREA_NAME = (col: string) => `(case when ${col} = 'NG' then 'Nigeria' else coalesce(
  (select name from public.states where code = ${col}), (select name from public.senatorial_districts where code = ${col}),
  (select name from public.constituencies where code = ${col}),
  (select name from public.lgas where code = ${col}), (select name from public.wards where code = ${col}),
  (select name from public.polling_units where code = ${col})) end)`;

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}
