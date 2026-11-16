import type { Query } from '../database/db.service';
import type { Db } from '../database/db.service';
import type { CheckinFence } from '../shared';
import { checkinSettings, tenantSettings } from './tenant-settings';

/** Agents who check in by this time (Lagos) count as on time: INEC officials arrive about 7:30, voting starts 8:30. */
export const ON_TIME = '07:30';

export interface CheckinWindow { opensAt: string; closesAt: string; electionDate: string; anyDay: boolean; isOpen: (t: number) => boolean }

/**
 * When check-in is open for an election: election day (Lagos time) from the organisation's opening time until
 * midnight, or any time when practice check-ins are allowed.
 */
export async function checkinWindow(db: Db, q: Query, tenantId: string, election: string): Promise<CheckinWindow> {
  const c = checkinSettings(await tenantSettings(db, tenantId));
  const [w] = await q<{ opens_at: Date; closes_at: Date; election_date: string }>(
    `select (e.election_date + $2::time) at time zone 'Africa/Lagos' as opens_at,
            (e.election_date + 1)::timestamp at time zone 'Africa/Lagos' as closes_at, e.election_date::text as election_date
       from public.elections e where e.id = $1`, [election, c.opens]);
  return { opensAt: w.opens_at.toISOString(), closesAt: w.closes_at.toISOString(), electionDate: w.election_date, anyDay: c.anyDay,
    isOpen: (t: number) => c.anyDay || (t >= w.opens_at.getTime() && t < w.closes_at.getTime()) };
}

/**
 * What a polling unit's check-ins are compared against: the ward outline if we have it, else the unit's own
 * position, else the LGA outline, else the state outline. Null when we have none of these.
 */
export async function checkinFence(db: Db, pu: string): Promise<CheckinFence | null> {
  const ward = pu.slice(0, 8), lga = pu.slice(0, 5), state = pu.slice(0, 2);
  const [r] = await db.system(
    `select p.name as unit, p.lat, p.lng, w.name as ward, l.name as lga, s.name as state,
            sw.geometry as w_geo, sw.center_lat as w_lat, sw.center_lng as w_lng,
            sl.geometry as l_geo, sl.center_lat as l_lat, sl.center_lng as l_lng,
            ss.geometry as s_geo, ss.center_lat as s_lat, ss.center_lng as s_lng
       from public.polling_units p
       left join public.wards w on w.code = $2 left join public.lgas l on l.code = $3 left join public.states s on s.code = $4
       left join public.area_shapes sw on sw.code = $2 left join public.area_shapes sl on sl.code = $3 left join public.area_shapes ss on ss.code = $4
      where p.code = $1`, [pu, ward, lga, state]);
  if (!r) return null;
  const c = (lat: number | null, lng: number | null) => (lat == null || lng == null ? null : { lat, lng });
  if (r.w_geo) return { level: 'ward', code: ward, name: r.ward ?? ward, geometry: r.w_geo, center: c(r.w_lat, r.w_lng) };
  if (r.lat != null && r.lng != null) return { level: 'unit', code: pu, name: r.unit, center: c(r.lat, r.lng) };
  if (r.l_geo) return { level: 'lga', code: lga, name: r.lga ?? lga, geometry: r.l_geo, center: c(r.l_lat, r.l_lng) };
  if (r.s_geo) return { level: 'state', code: state, name: r.state ?? state, geometry: r.s_geo, center: c(r.s_lat, r.s_lng) };
  return null;
}
