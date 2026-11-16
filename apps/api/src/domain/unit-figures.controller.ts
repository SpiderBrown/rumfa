import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsObject, IsOptional, IsUUID, Matches } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { elections } from '../common/fn';
import { ownParty, tenantSettings } from '../common/tenant-settings';
import { UNIT_FIGURE_KEYS, figureFlags, placeName, type UnitFigures } from '../shared';
import { childLength, inScope, mapScope } from './map.controller';
import { ROOM } from './roles';

const STAGES = ['setup', 'accreditation', 'close', 'result'] as const;
/** Flags these figures can raise (each is an alert category and becomes a case on its desk). */
export const FIGURE_RULES = ['over_registered', 'over_accredited', 'ballots_unbalanced', 'used_mismatch', 'very_high_turnout',
  'low_turnout', 'stronghold_low_turnout', 'accreditation_dropped', 'no_accreditation_figures'];

class FiguresDto {
  @ApiProperty() @Matches(/^\d{2}-\d{2}-\d{2}-\d{3}$/) pu: string;
  @ApiProperty({ enum: STAGES }) @IsIn(STAGES) stage: (typeof STAGES)[number];
  @ApiProperty({ example: { registered: 650, ballots_received: 700 } }) @IsObject() figures: Record<string, number>;
  @ApiPropertyOptional({ description: 'When the agent saved it (phone time)' }) @IsOptional() @IsDateString() at?: string;
  @ApiProperty() @IsUUID() clientId: string;
}

interface Update { stage: string; figures: UnitFigures; reported_at: string }

/** The latest value of each figure, and whether accreditation has closed (a close or result figure was sent). */
export function mergeUpdates(updates: Update[]): { latest: UnitFigures; final: boolean; lastAt: string | null } {
  const latest: UnitFigures = {};
  let final = false, lastAt: string | null = null;
  for (const u of [...updates].sort((a, b) => Date.parse(a.reported_at) - Date.parse(b.reported_at))) {
    Object.assign(latest, u.figures);
    if ((u.stage === 'close' || u.stage === 'result') && 'accredited' in u.figures) final = true;
    lastAt = u.reported_at;
  }
  return { latest, final, lastAt };
}

/**
 * Polling-day figures: the agent sends each EC8A summary figure as soon as it is announced (setup, accreditation
 * through the day, close of poll, result). Problems are flagged straight away to the desk that handles them.
 */
@ApiTags('Field reports')
@ApiBearerAuth()
@Controller('unit-figures')
export class UnitFiguresController {
  constructor(private readonly db: Db) {}

  @Post() @HttpCode(200) @Roles('agent')
  @ApiOperation({ summary: 'Send figures for one stage; returns the unit\'s current figures and any flags raised' })
  async send(@CurrentUser() u: AuthUser, @Body() d: FiguresDto) {
    if (u.level !== 'pu' || u.area !== d.pu) throw new ForbiddenException('Only the agent at this polling unit can send its figures');
    const figures: UnitFigures = {};
    for (const [k, v] of Object.entries(d.figures)) {
      if (!UNIT_FIGURE_KEYS.includes(k as keyof UnitFigures)) throw new BadRequestException(`Unknown figure: ${k}`);
      if (!Number.isInteger(v) || v < 0 || v > 100000) throw new BadRequestException(`${k} must be a whole number`);
      figures[k as keyof UnitFigures] = v;
    }
    if (!Object.keys(figures).length) throw new BadRequestException('No figures to send');
    const election = await this.liveElection(u);
    const now = Date.now(), claimed = d.at ? Date.parse(d.at) : NaN;
    const at = claimed <= now + 120_000 && claimed >= now - 24 * 3600_000 ? new Date(Math.min(claimed, now)) : new Date(now);

    const history = await this.history(u.tid, election, d.pu);
    const previousAccredited = mergeUpdates(history).latest.accredited ?? null;
    const [row] = await this.db.system(
      `insert into public.unit_figure_updates (tenant_id, election_id, pu_code, volunteer_id, stage, figures, reported_at, client_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (client_id) do nothing returning id`,
      [u.tid, election, d.pu, u.mid, d.stage, JSON.stringify(figures), at, d.clientId]);
    const all = row ? [...history, { stage: d.stage, figures, reported_at: at.toISOString() }] : history;
    const { latest, final } = mergeUpdates(all);

    // Flags (once per unit and kind; a repeat or a resend raises nothing new)
    const flags = row ? figureFlags(latest, {
      final, baseline: await this.baseline(u.tid, d.pu),
      previousAccredited: 'accredited' in figures ? previousAccredited : null,
    }) : [];
    for (const f of flags) {
      await this.db.system(`select public.svc_raise_alert($1, $2, $3, $4, $4, $5, $6)`,
        [u.tid, election, f.flag, d.pu, JSON.stringify({ ...f.details, message: f.message }), `${f.flag}:${d.pu}`]);
    }
    return { latest, final, flags: flags.map((f) => ({ flag: f.flag, message: f.message })) };
  }

  @Get('mine') @Roles('agent')
  @ApiOperation({ summary: 'This agent\'s figures so far (to carry on after reinstalling)' })
  async mine(@CurrentUser() u: AuthUser) {
    const { live } = await this.db.asUser(u, (q) => elections(q, u.tid));
    if (!live || u.level !== 'pu') return { latest: {}, final: false, history: [] };
    const history = await this.history(u.tid, live, u.area);
    return { ...mergeUpdates(history), history };
  }

  @Get('summary') @Roles(...ROOM, 'coordinator')
  @ApiOperation({ summary: 'Register, accreditation and turnout so far for an area (default: yours) and each sub-area' })
  async summary(@CurrentUser() u: AuthUser, @Query('area') areaQ?: string) {
    const { scope, area, prefix, len } = this.area(u, areaQ);
    const election = await this.liveElection(u);
    const units = await this.unitFigures(u.tid, election, prefix);
    const base = await this.baselines(u.tid, prefix);
    const [agents] = await this.db.system(
      `select count(distinct area_code)::int as n from public.volunteers
        where tenant_id = $1 and role = 'agent' and level = 'pu' and status in ('invited', 'active') and area_code like $2`, [u.tid, prefix]);
    const flags = await this.db.system(
      `select a.pu_code, a.rule from public.alerts a join public.cases c on c.id = a.case_id
        where a.tenant_id = $1 and a.election_id = $2 and a.rule = any($3) and a.pu_code like $4
          and c.status in ('queued', 'assigned', 'in_progress', 'escalated')`, [u.tid, election, FIGURE_RULES, prefix]);

    const agg = (list: typeof units) => {
      const withBoth = list.filter((x) => x.latest.registered != null && x.latest.accredited != null);
      const registered = withBoth.reduce((s, x) => s + x.latest.registered!, 0);
      const accredited = withBoth.reduce((s, x) => s + x.latest.accredited!, 0);
      const b = withBoth.flatMap((x) => { const v = base.get(x.pu); return v ? [v] : []; });
      const bReg = b.reduce((s, x) => s + x.registered, 0), bAcc = b.reduce((s, x) => s + x.accredited, 0);
      return {
        unitsReporting: list.length, unitsWithTurnout: withBoth.length, unitsClosed: list.filter((x) => x.final).length,
        registered, accredited, turnout: registered ? accredited / registered : null,
        baselineTurnout: bReg ? bAcc / bReg : null, baselineUnits: b.length,
        flags: flags.filter((f) => list.some((x) => x.pu === f.pu_code)).length,
        lastAt: list.reduce<string | null>((m, x) => (!m || (x.lastAt && x.lastAt > m) ? x.lastAt : m), null),
      };
    };

    let children: any[] = [];
    if (len) {
      const kidsSql = { 2: `select code, name from public.states`, 5: `select code, name from public.lgas where state_code = $1`,
        8: `select code, name from public.wards where lga_code = $1`, 12: `select code, name from public.polling_units where ward_code = $1` }[len]!;
      const kids = await this.db.system(kidsSql, len === 2 ? [] : [area]);
      children = kids.map((k) => ({ code: k.code, name: placeName(k.name), ...agg(units.filter((x) => x.pu.startsWith(k.code))) }))
        .filter((c) => c.unitsReporting > 0 || (len === 12 && area !== 'NG'));
    }
    return { area, scope, unitsWithAgent: agents.n, ...agg(units), childLevel: len ? ({ 2: 'state', 5: 'lga', 8: 'ward', 12: 'pu' } as any)[len] : null,
      children, breadcrumb: await this.breadcrumb(scope, area) };
  }

  @Get('feed') @Roles(...ROOM, 'coordinator')
  @ApiOperation({ summary: 'Figures and flags as they come in, newest first, for an area (default: yours)' })
  async feed(@CurrentUser() u: AuthUser, @Query('area') areaQ?: string) {
    const { prefix } = this.area(u, areaQ);
    const election = await this.liveElection(u);
    const updates = await this.db.system(
      `select f.id, f.pu_code, p.name as unit, v.full_name as agent, f.stage, f.figures, f.reported_at, f.created_at
         from public.unit_figure_updates f
         join public.polling_units p on p.code = f.pu_code
         join public.volunteers v on v.id = f.volunteer_id
        where f.tenant_id = $1 and f.election_id = $2 and f.pu_code like $3
        order by f.created_at desc limit 60`, [u.tid, election, prefix]);
    const flags = await this.db.system(
      `select a.id, a.rule, a.severity, a.pu_code, p.name as unit, a.details, a.created_at, a.case_id, c.status as case_status, ic.label
         from public.alerts a
         join public.incident_categories ic on ic.code = a.rule
         left join public.polling_units p on p.code = a.pu_code
         left join public.cases c on c.id = a.case_id
        where a.tenant_id = $1 and a.election_id = $2 and a.rule = any($3) and a.pu_code like $4
        order by a.created_at desc limit 60`, [u.tid, election, FIGURE_RULES, prefix]);
    // Each update with the unit's register, so the room sees turnout at a glance
    const registers = new Map((await this.unitFigures(u.tid, election, prefix)).map((x) => [x.pu, x.latest.registered ?? null]));
    return {
      updates: updates.map((r) => ({ ...r, unit: placeName(r.unit), registered: registers.get(r.pu_code) ?? null })),
      flags: flags.map((r) => ({ ...r, unit: r.unit ? placeName(r.unit) : null })),
    };
  }

  // ---- helpers ----

  private area(u: AuthUser, areaQ?: string) {
    const scope = mapScope(u);
    const area = (areaQ || scope).trim();
    if (!/^(NG|\d{2}(-\d{2}){0,3})$/.test(area)) throw new BadRequestException('Unknown area');
    if (!inScope(scope, area)) throw new ForbiddenException('That area is outside yours');
    return { scope, area, len: childLength(area), prefix: area === 'NG' ? '%' : area.length === 12 ? area : `${area}-%` };
  }

  private async liveElection(u: AuthUser): Promise<string> {
    const { live } = await this.db.asUser(u, (q) => elections(q, u.tid));
    if (!live) throw new BadRequestException('No election is set up yet');
    return live;
  }

  private history(tenant: string, election: string, pu: string): Promise<Update[]> {
    return this.db.system(
      `select stage, figures, reported_at from public.unit_figure_updates
        where tenant_id = $1 and election_id = $2 and pu_code = $3 order by reported_at`, [tenant, election, pu]);
  }

  /** Every unit in the area with figures, merged to its latest values. */
  private async unitFigures(tenant: string, election: string, prefix: string) {
    const rows = await this.db.system<Update & { pu_code: string }>(
      `select pu_code, stage, figures, reported_at from public.unit_figure_updates
        where tenant_id = $1 and election_id = $2 and pu_code like $3 order by pu_code, reported_at`, [tenant, election, prefix]);
    const by = new Map<string, Update[]>();
    for (const r of rows) { if (!by.has(r.pu_code)) by.set(r.pu_code, []); by.get(r.pu_code)!.push(r); }
    return [...by].map(([pu, list]) => ({ pu, ...mergeUpdates(list) }));
  }

  /** Last election at this unit: turnout and our party's share of the vote (for stronghold flags). */
  private async baseline(tenant: string, pu: string): Promise<{ turnout: number | null; ownShare: number | null } | null> {
    const b = (await this.baselines(tenant, pu)).get(pu);
    if (!b) return null;
    const party = ownParty(await tenantSettings(this.db, tenant));
    const total = Object.values(b.votes).reduce((s, n) => s + n, 0);
    return { turnout: b.registered ? b.accredited / b.registered : null, ownShare: party && total ? (b.votes[party] ?? 0) / total : null };
  }

  private async baselines(tenant: string, prefix: string) {
    const rows = await this.db.system(
      `select distinct on (s.pu_code) s.pu_code, s.registered, s.accredited, s.votes
         from public.irev_sheet_results s
         join public.tenant_elections te on te.election_id = s.election_id and te.tenant_id = $1 and te.purpose = 'baseline'
        where s.pu_code like $2 and s.ocr_status in ('confirmed', 'read') and s.registered > 0 and s.accredited is not null
        order by s.pu_code, s.sheet_version desc`, [tenant, prefix]);
    return new Map(rows.map((r) => [r.pu_code, { registered: r.registered as number, accredited: r.accredited as number, votes: (r.votes ?? {}) as Record<string, number> }]));
  }

  private async breadcrumb(scope: string, area: string) {
    const parts = area === 'NG' ? [] : area.split('-');
    const chain = parts.map((_, i) => parts.slice(0, i + 1).join('-')).filter((c) => inScope(scope, c));
    const codes = [...(scope === 'NG' ? ['NG'] : []), ...chain];
    const names = await this.db.system(
      `select code, name from public.states where code = any($1) union all select code, name from public.lgas where code = any($1)
       union all select code, name from public.wards where code = any($1) union all select code, name from public.polling_units where code = any($1)`, [codes]);
    return codes.map((code) => ({ code, name: code === 'NG' ? 'Nigeria' : placeName(names.find((n) => n.code === code)?.name) || code }));
  }
}
