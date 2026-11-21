import { BadRequestException, Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { elections } from '../common/fn';
import { ROOM } from './roles';
import { spreadAround, spreadInside, type Spot } from './approx-places';

/** The middle of the units already placed (by their location or their agents' check-ins), and a radius that holds them all */
function fromCheckins(rows: { lat: number | null; lng: number | null }[]): Spot | null {
  const pts = rows.filter((r) => r.lat != null && r.lng != null).map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) }));
  if (!pts.length) return null;
  const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng = pts.reduce((a, p) => a + p.lng, 0) / pts.length;
  const cos = Math.cos((lat * Math.PI) / 180);
  const far = Math.max(...pts.map((p) => Math.hypot((p.lat - lat) * 111_320, (p.lng - lng) * 111_320 * cos)));
  return { lat, lng, radius_m: Math.round(Math.max(700, far + 400)) };
}

/** Open case statuses shown on the map. */
const OPEN = ['queued', 'assigned', 'in_progress', 'escalated'];

type Votes = Record<string, number>;
const add = (a: Votes, b: Votes) => { for (const [k, v] of Object.entries(b ?? {})) a[k] = (a[k] ?? 0) + Number(v); return a; };
/**
 * Expected final votes per party: what is confirmed (EC8A, IReV) and counted (agents' sorting and live counts)
 * so far, scaled up from the units that have either to all units. A plain ratio estimate, shown as one.
 */
export function estimate(confirmed: Votes, counted: Votes, units: number, known: number): Votes {
  if (!known || !units) return {};
  const k = Math.max(1, units / known);
  return Object.fromEntries(Object.entries(add(add({}, confirmed), counted)).map(([p, v]) => [p, Math.round(v * k)]));
}
/** The area as a whole (sums of its sub-areas), with its own estimate */
function totalsOf(rows: any[]) {
  const t = { units: 0, registered: 0, reported: 0, ec8a: 0, irev: 0, quick: 0, live: 0, verified: 0, mismatch: 0, open: 0, critical: 0,
    agents: 0, checked_in: 0, turnout_units: 0, accredited: 0, turnout_registered: 0, confirmed: {} as Votes, counted: {} as Votes, estimate: {} as Votes };
  for (const r of rows) {
    for (const f of ['units', 'registered', 'reported', 'ec8a', 'irev', 'quick', 'live', 'verified', 'mismatch', 'open', 'critical', 'agents',
      'checked_in', 'turnout_units', 'accredited', 'turnout_registered'] as const) t[f] += Number(r[f] ?? 0);
    add(t.confirmed, r.confirmed); add(t.counted, r.counted);
  }
  t.estimate = estimate(t.confirmed, t.counted, t.units, t.reported);
  return t;
}
const LEVEL_OF_LEN: Record<number, string> = { 2: 'state', 5: 'lga', 8: 'ward', 12: 'pu' };
/** Geopolitical zones (states.zone); on the map as Z-NC etc. */
export const ZONES: Record<string, string> = {
  NC: 'North Central', NE: 'North East', NW: 'North West', SE: 'South East', SS: 'South South', SW: 'South West',
};
const isZone = (c: string) => /^Z-(NC|NE|NW|SE|SS|SW)$/.test(c);

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
  async map(@CurrentUser() u: AuthUser, @Query('parent') parentQ?: string, @Query('election') electionQ?: string,
            @Query('group') groupQ?: string) {
    const scope = mapScope(u);
    const parent = (parentQ || scope).trim();
    if (!/^(NG|\d{2}(-\d{2}){0,2}|\d{2}-SD\d)$/.test(parent) && !isZone(parent)) throw new BadRequestException('Unknown area');
    const district = /^\d{2}-SD\d$/.test(parent);
    const zone = isZone(parent);
    if (zone ? scope !== 'NG' : !inScope(scope, district ? parent.slice(0, 2) : parent)) throw new ForbiddenException('That area is outside yours');
    // group: comma list. zone = the country by geopolitical zone (a zone shows its states); senatorial = a state by
    // senatorial district (a district shows its LGAs). Both stay on while going down, so the path shows them.
    const groups = new Set((groupQ ?? '').split(','));
    const byZone = groups.has('zone') && parent === 'NG' && scope === 'NG';
    const bySenatorial = groups.has('senatorial') && parent.length === 2 && parent !== 'NG';
    const len = district ? 5 : zone ? 2 : childLength(parent)!;
    const prefix = parent === 'NG' || zone ? '%' : district ? `${parent.slice(0, 2)}-%` : `${parent}-%`;
    /** The sub-area a unit, case or person belongs to: the first part of its code, or its LGA's district, or its state's zone */
    const key = (col: string) => bySenatorial ? `(select l.senatorial_code from public.lgas l where l.code = left(${col}, 5))`
      : byZone ? `(select 'Z-' || s.zone from public.states s where s.code = left(${col}, 2))` : `left(${col}, $5)`;

    const el = await this.db.asUser(u, (q) => elections(q, u.tid));
    const election = electionQ || el.live;
    if (electionQ && electionQ !== el.live && electionQ !== el.baseline) throw new BadRequestException('Unknown election');

    const covered = `exists (select 1 from public.tenant_coverage c where c.tenant_id = $1 and (c.level = 'national' or c.area_code = s.code or c.area_code like s.code || '-%'))`;
    const zoneNames = `(values ${Object.entries(ZONES).map(([k, v]) => `('${k}', '${v}')`).join(', ')}) as z(zone, name)`;
    const kidsSql = {
      2: byZone ? `select 'Z-' || z.zone as code, z.name from ${zoneNames}
                    where exists (select 1 from public.states s where s.zone = z.zone and ${covered})`
        : zone ? `select s.code, s.name from public.states s where s.zone = right($4, 2) and ${covered}`
        : `select s.code, s.name from public.states s where ${covered}`,
      5: district ? `select code, name from public.lgas where senatorial_code = $4`
        : bySenatorial ? `select code, name from public.senatorial_districts where state_code = $4`
        : `select code, name from public.lgas where state_code = $4`,
      8: `select code, name from public.wards where lga_code = $4`,
      12: `select code, name from public.polling_units where ward_code = $4`,
    }[len]!;

    const rows = await this.db.system(
      `with kids as (${kidsSql}),
       units as (
         select ${key('pu.code')} as k, count(*)::int as units, coalesce(sum(pu.registered_voters), 0)::int as registered
           from public.polling_units pu where pu.code like $3 group by 1),
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
         select ${key('pu')} as k, count(*)::int as n,
                count(*) filter (where src = 'ec8a')::int as ec8a, count(*) filter (where src = 'irev')::int as irev,
                count(*) filter (where src = 'quick')::int as quick, count(*) filter (where src = 'live')::int as live
           from best group by 1),
       votes as (
         select k, jsonb_object_agg(party, n) as votes, jsonb_object_agg(party, c) as confirmed, jsonb_object_agg(party, q) as counted from (
           select ${key('b.pu')} as k, v.key as party, sum(v.value::int)::int as n,
                  coalesce(sum(v.value::int) filter (where b.src in ('ec8a', 'irev')), 0)::int as c,
                  coalesce(sum(v.value::int) filter (where b.src in ('quick', 'live')), 0)::int as q
             from best b, jsonb_each_text(b.votes) v group by 1, 2) t group by k),
       -- Election day: agents in place, and turnout from the accredited figures agents send through the day
       checked as (
         select ${key('pu_code')} as k, count(distinct pu_code)::int as n from public.checkins
          where tenant_id = $1 and election_id = $2 and pu_code like $3 group by 1),
       figs as (
         select pu_code,
                (array_agg((figures->>'accredited')::int order by reported_at desc) filter (where figures ? 'accredited'))[1] as accredited,
                (array_agg((figures->>'registered')::int order by reported_at desc) filter (where figures ? 'registered'))[1] as registered
           from public.unit_figure_updates where tenant_id = $1 and election_id = $2 and pu_code like $3 group by 1),
       turnout as (
         select ${key('f.pu_code')} as k, count(*)::int as units, sum(f.accredited)::int as accredited,
                sum(coalesce(f.registered, pu.registered_voters))::int as registered
           from figs f join public.polling_units pu on pu.code = f.pu_code
          where f.accredited is not null and coalesce(f.registered, pu.registered_voters) > 0 group by 1),
       verified as (
         select ${key('pu_code')} as k, count(*) filter (where status = 'verified')::int as verified,
                count(*) filter (where status = 'mismatch')::int as mismatch
           from public.verifications where tenant_id = $1 and election_id = $2 and pu_code like $3 group by 1),
       issues as (
         select ${key('area_code')} as k, count(*)::int as open,
                count(*) filter (where severity = 'critical')::int as critical, count(*) filter (where severity = 'high')::int as high,
                count(*) filter (where severity = 'medium')::int as medium, count(*) filter (where severity = 'low')::int as low,
                count(*) filter (where status = 'escalated')::int as escalated
           from public.cases where tenant_id = $1 and status = any($6) and length(area_code) >= $5 and area_code like $3 group by 1),
       people as (
         select ${key('area_code')} as k,
                count(*) filter (where role = 'agent')::int as agents,
                (array_agg(jsonb_build_object('id', id, 'full_name', full_name) order by full_name)
                   filter (where role = 'coordinator' and length(area_code) = $5 and not ${bySenatorial || byZone}))[1] as coordinator
           from public.volunteers where tenant_id = $1 and status in ('invited', 'active') and area_code like $3 group by 1),
       spots as (
         select pu_code as k, avg(lat) as lat, avg(lng) as lng from public.checkins
          where tenant_id = $1 and pu_code like $3 and lat is not null and accuracy_m < 200 group by 1)
       select kids.code, kids.name, $4::text as parent, sh.geometry as shape,
              coalesce(sh.center_lat, pu.lat, sp.lat) as lat, coalesce(sh.center_lng, pu.lng, sp.lng) as lng,
              coalesce(un.units, 0) as units, coalesce(un.registered, pu.registered_voters, 0) as registered,
              coalesce(r.n, 0) as reported, coalesce(r.ec8a, 0) as ec8a, coalesce(r.irev, 0) as irev, coalesce(r.quick, 0) as quick, coalesce(r.live, 0) as live,
              coalesce(vf.verified, 0) as verified, coalesce(vf.mismatch, 0) as mismatch,
              coalesce(vo.votes, '{}'::jsonb) as votes, coalesce(vo.confirmed, '{}'::jsonb) as confirmed, coalesce(vo.counted, '{}'::jsonb) as counted,
              coalesce(ck.n, 0) as checked_in, coalesce(tu.units, 0) as turnout_units, coalesce(tu.accredited, 0) as accredited,
              coalesce(tu.registered, 0) as turnout_registered,
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
         left join checked ck on ck.k = kids.code
         left join turnout tu on tu.k = kids.code
         left join verified vf on vf.k = kids.code
         left join issues i on i.k = kids.code
         left join people p on p.k = kids.code
        order by kids.code`,
      [u.tid, election, prefix, parent, len, OPEN]);

    const [shape] = parent === 'NG' ? [] : await this.db.system(`select geometry, center_lat, center_lng from public.area_shapes where code = $1`, [parent]);

    // Wards and units with no outline or location yet get rough places inside their parent, so every one can be
    // seen and opened (shown as dashed circles, marked approximate). A ward with no outline gets one too.
    // A ward with no outline: a dashed circle around where its agents checked in (units share school compounds, so
    // this only needs to be roughly right); with no check-ins yet, a rough place inside its LGA
    const approxArea = len === 12 && !shape ? (fromCheckins(rows) ?? await this.wardSpot(parent)) : null;
    if (len === 8 || len === 12) {
      const missing = rows.filter((r) => !r.shape && (r.lat == null || r.lng == null));
      const spots = shape?.geometry ? spreadInside(shape.geometry, missing.length) : approxArea ? spreadAround(approxArea, missing.length) : [];
      spots.forEach((p, i) => Object.assign(missing[i], { lat: p.lat, lng: p.lng, radius_m: p.radius_m, approx: true }));
    }

    // Issues on the area itself rather than one of its sub-areas (e.g. an LGA-wide case while viewing its wards)
    const [wide] = await this.db.system(
      `select count(*)::int as open, count(*) filter (where severity = 'critical')::int as critical from public.cases
        where tenant_id = $1 and status = any($2) and area_code = $3`,
      [u.tid, OPEN, parent]);

    const [t] = await this.db.system(`select settings from public.tenants where id = $1`, [u.tid]);
    const parties = election
      ? (await this.db.system(`select party from public.election_parties where election_id = $1 order by ballot_order`, [election])).map((p) => p.party)
      : [];

    return {
      scope, parent, level: parent === 'NG' ? 'national' : zone ? 'zone' : district ? 'senatorial' : LEVEL_OF_LEN[parent.length],
      childLevel: byZone ? 'zone' : bySenatorial ? 'senatorial' : LEVEL_OF_LEN[len], group: byZone || zone ? 'zone' : bySenatorial || district ? 'senatorial' : null,
      election, parties, partyColours: Object.fromEntries(
        (await this.db.system(`select acronym, colour from public.parties where colour is not null`)).map((c) => [c.acronym, c.colour])),
      breadcrumb: await this.breadcrumb(scope, parent, groups.has('senatorial') || district, groups.has('zone') || zone),
      shape: shape?.geometry ?? null,
      center: shape ? { lat: shape.center_lat, lng: shape.center_lng } : approxArea ? { lat: approxArea.lat, lng: approxArea.lng } : null,
      approxArea,
      areaWide: wide ?? { open: 0, critical: 0 },
      children: rows.map((r) => ({ ...r, approx: !!r.approx, radius_m: r.radius_m ?? null, leader: leader(r.votes),
        estimate: estimate(r.confirmed, r.counted, r.units, r.reported) })),
      totals: totalsOf(rows),
    };
  }

  /** The rough place of a ward with no outline: the same one it gets on its LGA's map (spread over the LGA outline). */
  private async wardSpot(ward: string): Promise<Spot | null> {
    if (ward.length !== 8) return null;
    const [lga] = await this.db.system(`select geometry from public.area_shapes where code = $1`, [ward.slice(0, 5)]);
    if (!lga?.geometry) return null;
    const list = (await this.db.system(
      `select w.code from public.wards w where w.lga_code = $1 and not exists (select 1 from public.area_shapes s where s.code = w.code) order by w.code`,
      [ward.slice(0, 5)])).map((w) => w.code as string);
    const i = list.indexOf(ward);
    return i < 0 ? null : spreadInside(lga.geometry, list.length)[i];
  }

  /**
   * From the person's own area down to `parent`, with names; by district, the district sits between state and LGA;
   * by zone (national staff only), the zone sits between Nigeria and the state.
   */
  private async breadcrumb(scope: string, parent: string, senatorial = false, zones = false) {
    let path = parent === 'NG' ? [] : isZone(parent) ? [parent] : /^\d{2}-SD\d$/.test(parent) ? [parent.slice(0, 2), parent] : chain(parent);
    if (senatorial && parent.length >= 5 && !parent.includes('SD')) {
      const [l] = await this.db.system(`select senatorial_code from public.lgas where code = $1`, [parent.slice(0, 5)]);
      if (l?.senatorial_code) path = [path[0], l.senatorial_code, ...path.slice(1)];
    }
    if (zones && scope === 'NG' && parent !== 'NG' && !isZone(parent)) {
      const [s] = await this.db.system(`select zone from public.states where code = $1`, [parent.slice(0, 2)]);
      if (s?.zone) path = [`Z-${s.zone}`, ...path];
    }
    const codes = parent === 'NG' ? ['NG'] : [...(scope === 'NG' ? ['NG'] : []),
      ...path.filter((c) => isZone(c) ? scope === 'NG' : inScope(scope, c.includes('SD') ? c.slice(0, 2) : c))];
    const names = await this.db.system(
      `select code, name from public.states where code = any($1) union all select code, name from public.lgas where code = any($1)
       union all select code, name from public.wards where code = any($1) union all select code, name from public.senatorial_districts where code = any($1)`, [codes]);
    return codes.map((code) => ({ code, name: code === 'NG' ? 'Nigeria' : isZone(code) ? ZONES[code.slice(2)]
      : names.find((n) => n.code === code)?.name ?? code }));
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
