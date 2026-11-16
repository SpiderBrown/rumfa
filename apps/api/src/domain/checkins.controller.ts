import { BadRequestException, Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { elections } from '../common/fn';
import { ON_TIME, checkinWindow } from '../common/checkin-window';
import { childLength, inScope, mapScope } from './map.controller';
import { ROOM } from './roles';

const PEOPLE_MAX = 300;

interface Agg { agents: number; checkedIn: number; onTime: number; late: number; notYet: number; outside: number; units: number; unitsCovered: number }
const agg = (): Agg => ({ agents: 0, checkedIn: 0, onTime: 0, late: 0, notYet: 0, outside: 0, units: 0, unitsCovered: 0 });

/**
 * Situation room: which polling-unit agents have checked in, for any area and its sub-areas, and who has not.
 * Arrival is the first check-in within the agent's own area (ward, else unit, LGA or state, whichever we have an outline
 * or position for); on time means by 7:30 am (Lagos). Check-ins outside their area are listed with the agent's note.
 */
@ApiTags('Field reports')
@ApiBearerAuth()
@Controller('checkins')
export class CheckinsController {
  constructor(private readonly db: Db) {}

  @Get('summary') @Roles(...ROOM, 'coordinator')
  @ApiOperation({ summary: 'Agents checked in, late and not yet, for an area (default: yours) and each sub-area, with the people' })
  async summary(@CurrentUser() u: AuthUser, @Query('area') areaQ?: string) {
    const scope = mapScope(u);
    const area = (areaQ || scope).trim();
    if (!/^(NG|\d{2}(-\d{2}){0,3})$/.test(area)) throw new BadRequestException('Unknown area');
    if (!inScope(scope, area)) throw new ForbiddenException('That area is outside yours');
    const { live } = await this.db.asUser(u, (q) => elections(q, u.tid));
    if (!live) throw new BadRequestException('No election is set up yet');
    const len = childLength(area);
    const prefix = area === 'NG' ? '%' : area.length === 12 ? area : `${area}-%`;

    // Per agent: arrival = first check-in not known to be outside their area; the latest one says where they are now
    const rows = await this.db.system(
      `select v.id, v.full_name, v.phone, v.area_code as pu, v.status, p.name as unit, c.*,
              coalesce(c.arrival, c.first) is not null and (coalesce(c.arrival, c.first) at time zone 'Africa/Lagos')::time <= $4::time as on_time
         from public.volunteers v
         join public.polling_units p on p.code = v.area_code
         left join lateral (
           select min(k.at) as first, min(k.at) filter (where k.inside is not false) as arrival, count(*)::int as count,
                  (array_agg(k.inside order by k.at desc))[1] as last_inside, (array_agg(k.distance_m order by k.at desc))[1] as last_distance,
                  (array_agg(k.checked_against order by k.at desc))[1] as against,
                  (array_agg(k.note order by k.at desc) filter (where k.note is not null))[1] as note,
                  (array_agg(k.inside order by k.at) filter (where k.inside is not false))[1] as arrival_inside
             from public.checkins k where k.election_id = $2 and k.volunteer_id = v.id having count(*) > 0) c on true
        where v.tenant_id = $1 and v.role = 'agent' and v.level = 'pu' and v.status in ('invited', 'active') and v.area_code like $3
        order by v.area_code, v.full_name`, [u.tid, live, prefix, ON_TIME]);

    const people = rows.map((r) => ({
      id: r.id, name: r.full_name, phone: r.phone, pu: r.pu, unit: r.unit, invited: r.status === 'invited',
      first: r.first ?? null, arrival: r.arrival ?? null, count: r.count ?? 0, onTime: !!r.on_time,
      // Outside: every check-in so far was outside their area (a later one from the right place clears it)
      outside: !!r.first && !r.arrival, lastOutside: r.last_inside === false, distance: r.last_inside === false ? r.last_distance : null,
      against: r.against ?? null, note: r.note ?? null,
      // Checked in, but the location could not be compared (no location from the phone, or no outline for the area)
      unverified: !!r.arrival && r.arrival_inside == null,
    }));

    const add = (a: Agg, p: (typeof people)[number]) => {
      a.agents++;
      if (!p.first) a.notYet++; else { a.checkedIn++; if (p.onTime) a.onTime++; else a.late++; if (p.outside) a.outside++; }
    };
    const unitsOf = (list: typeof people) => {
      const by = new Map<string, boolean>();
      for (const p of list) by.set(p.pu, (by.get(p.pu) ?? false) || !!p.arrival);
      return { units: by.size, unitsCovered: [...by.values()].filter(Boolean).length };
    };
    const totals = agg();
    for (const p of people) add(totals, p);
    Object.assign(totals, unitsOf(people));

    let children: any[] = [];
    if (len) {
      const groups = new Map<string, typeof people>();
      for (const p of people) { const k = p.pu.slice(0, len); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(p); }
      const kidsSql = { 2: `select code, name from public.states`, 5: `select code, name from public.lgas where state_code = $1`,
        8: `select code, name from public.wards where lga_code = $1`, 12: `select code, name from public.polling_units where ward_code = $1` }[len]!;
      const kids = await this.db.system(kidsSql, len === 2 ? [] : [area]);
      children = kids.map((k) => {
        const list = groups.get(k.code) ?? [];
        const a = agg();
        for (const p of list) add(a, p);
        return { code: k.code, name: k.name, ...a, ...unitsOf(list) };
      }).filter((c) => c.agents > 0);
    }

    // Everyone when the list is short; otherwise those who need a call first (not yet, then far, then late)
    const rank = (p: (typeof people)[number]) => (!p.first ? 0 : p.outside ? 1 : !p.onTime ? 2 : 3);
    const listed = people.length <= PEOPLE_MAX ? people : people.filter((p) => rank(p) < 3).sort((a, b) => rank(a) - rank(b)).slice(0, PEOPLE_MAX);

    const { isOpen, ...window } = await this.db.asUser(u, (q) => checkinWindow(this.db, q, u.tid, live));
    return {
      area, scope, onTimeBy: ON_TIME, window: { ...window, open: isOpen(Date.now()) }, ...totals,
      childLevel: len ? ({ 2: 'state', 5: 'lga', 8: 'ward', 12: 'pu' } as Record<number, string>)[len] : null, children,
      people: listed, peopleTruncated: listed.length < people.length,
      breadcrumb: await this.breadcrumb(scope, area),
    };
  }

  private async breadcrumb(scope: string, area: string) {
    const parts = area === 'NG' ? [] : area.split('-');
    const chain = parts.map((_, i) => parts.slice(0, i + 1).join('-')).filter((c) => inScope(scope, c));
    const codes = [...(scope === 'NG' ? ['NG'] : []), ...chain];
    const names = await this.db.system(
      `select code, name from public.states where code = any($1) union all select code, name from public.lgas where code = any($1)
       union all select code, name from public.wards where code = any($1) union all select code, name from public.polling_units where code = any($1)`, [codes]);
    return codes.map((code) => ({ code, name: code === 'NG' ? 'Nigeria' : names.find((n) => n.code === code)?.name ?? code }));
  }
}
