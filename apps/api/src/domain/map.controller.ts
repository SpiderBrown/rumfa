import { BadRequestException, Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { elections } from '../common/fn';
import { ROOM } from './roles';

/** Open case statuses shown on the map. */
const OPEN = ['queued', 'assigned', 'in_progress', 'escalated'];
const LEVEL_OF_LEN: Record<number, string> = { 2: 'state', 5: 'lga', 8: 'ward', 12: 'pu' };

/** The area a person may see on the map: everything for national staff, otherwise their own area and below. */
export function mapScope(u: AuthUser): string {
  return u.level === 'national' || !u.area ? 'NG' : u.area;
}
export function inScope(scope: string, code: string): boolean {
  return scope === 'NG' || code === scope || code.startsWith(scope + '-');
}
/** The children of an area: NG → states, state → LGAs, LGA → wards, ward → polling units. */
export function childLength(parent: string): number | null {
  if (parent === 'NG') return 2;
  return ({ 2: 5, 5: 8, 8: 12 } as Record<number, number>)[parent.length] ?? null;
}

/**
 * Situation-room map: one area's sub-areas with their votes, reporting and open issues, for colouring
 * (votes by leading party, issues as a heat scale). Room staff see their area; coordinators see theirs
 * (in the agent app). Everything is scoped to the caller's organisation and area.
 */
@ApiTags('Map')
@ApiBearerAuth()
@Controller('map')
@Roles(...ROOM, 'coordinator')
export class MapController {
  constructor(private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'Sub-areas of an area with votes, reporting and open issues (defaults to your own area)' })
  async map(@CurrentUser() u: AuthUser, @Query('parent') parentQ?: string, @Query('election') electionQ?: string) {
    const scope = mapScope(u);
    const parent = (parentQ || scope).trim();
    if (!/^(NG|\d{2}(-\d{2}){0,2})$/.test(parent)) throw new BadRequestException('Unknown area');
    if (!inScope(scope, parent)) throw new ForbiddenException('That area is outside yours');
    const len = childLength(parent)!;
    const prefix = parent === 'NG' ? '%' : `${parent}-%`;

    const el = await this.db.asUser(u, (q) => elections(q, u.tid));
    const election = electionQ || el.live;
    if (electionQ && electionQ !== el.live && electionQ !== el.baseline) throw new BadRequestException('Unknown election');

    const kidsSql = {
      2: `select s.code, s.name from public.states s
           where exists (select 1 from public.tenant_coverage c where c.tenant_id = $1 and (c.level = 'national' or c.area_code = s.code or c.area_code like s.code || '-%'))`,
      5: `select code, name from public.lgas where state_code = $4`,
      8: `select code, name from public.wards where lga_code = $4`,
      12: `select code, name from public.polling_units where ward_code = $4`,
    }[len]!;

    const rows = await this.db.system(
      `with kids as (${kidsSql}),
       units as (
         select left(code, $5) as k, count(*)::int as units, coalesce(sum(registered_voters), 0)::int as registered
           from public.polling_units where code like $3 group by 1),
       best as (
         select distinct on (pu) pu, votes, src from (
           select pu_code as pu, votes, 'ec8a' as src, 1 as pr from public.v_latest_results
            where tenant_id = $1 and election_id = $2 and pu_code like $3
           union all
           (select distinct on (pu_code) pu_code, votes, 'irev', 2 from public.irev_sheet_results
             where election_id = $2 and pu_code like $3 and (ocr_status = 'confirmed' or (ocr_status = 'read' and min_confidence >= 0.85))
             order by pu_code, sheet_version desc)
           union all
           (select distinct on (pu_code) pu_code, votes, 'quick', 3 from public.quick_tallies
             where tenant_id = $1 and election_id = $2 and pu_code like $3
             order by pu_code, at desc)
           union all
           select pu_code, counts, 'live', 4 from public.live_counts
            where tenant_id = $1 and election_id = $2 and pu_code like $3) x
          order by pu, pr),
       reported as (
         select left(pu, $5) as k, count(*)::int as n,
                count(*) filter (where src = 'ec8a')::int as ec8a, count(*) filter (where src = 'irev')::int as irev,
                count(*) filter (where src = 'quick')::int as quick, count(*) filter (where src = 'live')::int as live
           from best group by 1),
       votes as (
         select k, jsonb_object_agg(party, n) as votes from (
           select left(b.pu, $5) as k, v.key as party, sum(v.value::int)::int as n
             from best b, jsonb_each_text(b.votes) v group by 1, 2) t group by k),
       verified as (
         select left(pu_code, $5) as k, count(*) filter (where status = 'verified')::int as verified,
                count(*) filter (where status = 'mismatch')::int as mismatch
           from public.verifications where tenant_id = $1 and election_id = $2 and pu_code like $3 group by 1),
       issues as (
         select left(area_code, $5) as k, count(*)::int as open,
                count(*) filter (where severity = 'critical')::int as critical, count(*) filter (where severity = 'high')::int as high,
                count(*) filter (where severity = 'medium')::int as medium, count(*) filter (where severity = 'low')::int as low,
                count(*) filter (where status = 'escalated')::int as escalated
           from public.cases where tenant_id = $1 and status = any($6) and length(area_code) >= $5 and area_code like $3 group by 1),
       people as (
         select left(area_code, $5) as k,
                count(*) filter (where role = 'agent')::int as agents,
                (array_agg(jsonb_build_object('id', id, 'full_name', full_name) order by full_name)
                   filter (where role = 'coordinator' and length(area_code) = $5))[1] as coordinator
           from public.volunteers where tenant_id = $1 and status in ('invited', 'active') and area_code like $3 group by 1),
       spots as (
         select pu_code as k, avg(lat) as lat, avg(lng) as lng from public.checkins
          where tenant_id = $1 and pu_code like $3 and lat is not null and accuracy_m < 200 group by 1)
       select kids.code, kids.name, $4::text as parent, sh.geometry as shape,
              coalesce(sh.center_lat, pu.lat, sp.lat) as lat, coalesce(sh.center_lng, pu.lng, sp.lng) as lng,
              coalesce(un.units, 0) as units, coalesce(un.registered, pu.registered_voters, 0) as registered,
              coalesce(r.n, 0) as reported, coalesce(r.ec8a, 0) as ec8a, coalesce(r.irev, 0) as irev, coalesce(r.quick, 0) as quick, coalesce(r.live, 0) as live,
              coalesce(vf.verified, 0) as verified, coalesce(vf.mismatch, 0) as mismatch,
              coalesce(vo.votes, '{}'::jsonb) as votes,
              coalesce(i.open, 0) as open, coalesce(i.critical, 0) as critical, coalesce(i.high, 0) as high,
              coalesce(i.medium, 0) as medium, coalesce(i.low, 0) as low, coalesce(i.escalated, 0) as escalated,
              coalesce(p.agents, 0) as agents, p.coordinator
         from kids
         left join public.area_shapes sh on sh.code = kids.code
         left join public.polling_units pu on $5 = 12 and pu.code = kids.code
         left join spots sp on $5 = 12 and sp.k = kids.code
         left join units un on un.k = kids.code
         left join reported r on r.k = kids.code
         left join votes vo on vo.k = kids.code
         left join verified vf on vf.k = kids.code
         left join issues i on i.k = kids.code
         left join people p on p.k = kids.code
        order by kids.code`,
      [u.tid, election, prefix, parent, len, OPEN]);

    // Issues on the area itself rather than one of its sub-areas (e.g. an LGA-wide case while viewing its wards)
    const [wide] = await this.db.system(
      `select count(*)::int as open, count(*) filter (where severity = 'critical')::int as critical from public.cases
        where tenant_id = $1 and status = any($2) and area_code = $3`,
      [u.tid, OPEN, parent]);

    const [shape] = parent === 'NG' ? [] : await this.db.system(`select geometry, center_lat, center_lng from public.area_shapes where code = $1`, [parent]);
    const [t] = await this.db.system(`select settings from public.tenants where id = $1`, [u.tid]);
    const parties = election
      ? (await this.db.system(`select party from public.election_parties where election_id = $1 order by ballot_order`, [election])).map((p) => p.party)
      : [];

    return {
      scope, parent, level: parent === 'NG' ? 'national' : LEVEL_OF_LEN[parent.length], childLevel: LEVEL_OF_LEN[len],
      election, parties, partyColours: t?.settings?.party_colours ?? {},
      breadcrumb: await this.breadcrumb(scope, parent),
      shape: shape?.geometry ?? null, center: shape ? { lat: shape.center_lat, lng: shape.center_lng } : null,
      areaWide: wide ?? { open: 0, critical: 0 },
      children: rows.map((r) => ({ ...r, leader: leader(r.votes) })),
    };
  }

  /** From the person's own area down to `parent`, with names. */
  private async breadcrumb(scope: string, parent: string) {
    const codes = parent === 'NG' ? ['NG'] : [...(scope === 'NG' ? ['NG'] : []), ...chain(parent).filter((c) => inScope(scope, c))];
    const names = await this.db.system(
      `select code, name from public.states where code = any($1) union all select code, name from public.lgas where code = any($1)
       union all select code, name from public.wards where code = any($1)`, [codes]);
    return codes.map((code) => ({ code, name: code === 'NG' ? 'Nigeria' : names.find((n) => n.code === code)?.name ?? code }));
  }
}

/** "19-28-02" → ["19", "19-28", "19-28-02"] */
function chain(code: string): string[] {
  const p = code.split('-');
  return p.map((_, i) => p.slice(0, i + 1).join('-'));
}

function leader(votes: Record<string, number>): { party: string; votes: number; share: number; margin: number } | null {
  const sorted = Object.entries(votes ?? {}).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  if (!sorted.length || !total) return null;
  const [party, n] = sorted[0];
  return { party, votes: n, share: n / total, margin: (n - (sorted[1]?.[1] ?? 0)) / total };
}
