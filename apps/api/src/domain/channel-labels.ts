import type { Db } from '../database/db.service';
import { placeName } from '../shared';

/**
 * What people see for a conversation, built from the geography and people at read time (never stored, so names
 * stay right as the geography import fills in). The apps compose the words, so they can translate them:
 *  - area team:  place ("Tudun Wada") + level, with its parents ("Gwale LGA", "Kano") and the code
 *  - case:       the problem, open or closed, and the polling unit's name
 *  - direct:     the other person's name and role
 */
export interface ChannelLabel {
  place?: string; parents?: string[]; code?: string | null;
  person?: string; role?: string;
  category?: string; categoryCode?: string; caseStatus?: 'open' | 'closed'; unit?: string | null;
}
export interface ChannelSummary {
  label: ChannelLabel;
  last: { body: string | null; kind: string; sender: string | null; mine: boolean; at: string } | null;
  unread: number;
}

/** Unread counts stop here ("99+"): a busy state team can have thousands of messages. */
const UNREAD_CAP = 100;

/** Labels, last message and unread count for channels the caller may already see (ids from a row-level-secured query). */
export async function describeChannels(db: Db, me: string, ids: string[]): Promise<Map<string, ChannelSummary>> {
  if (!ids.length) return new Map();
  const rows = await db.system(
    `select c.id, c.kind, c.area_code,
            s.name as state, l.name as lga, w.name as ward,
            ps.name as p_state, pl.name as p_lga,
            other.full_name as person, other.role as person_role,
            ic.label as category, k.category as case_category, k.status as case_status, k.pu_code as case_pu, pu.name as unit,
            lm.body, lm.kind as last_kind, lm.sender_id, sv.full_name as sender, lm.created_at as last_at,
            (select count(*)::int from (select 1 from public.messages m
               where m.channel_id = c.id and m.created_at > coalesce(r.last_read_at, '-infinity') and m.sender_id is distinct from $2
               limit ${UNREAD_CAP}) x) as unread
       from public.channels c
       left join public.states s on c.kind = 'state' and s.code = c.area_code
       left join public.lgas l on c.kind = 'lga' and l.code = c.area_code
       left join public.wards w on c.kind = 'ward' and w.code = c.area_code
       left join public.states ps on c.kind in ('lga', 'ward') and ps.code = left(c.area_code, 2)
       left join public.lgas pl on c.kind = 'ward' and pl.code = left(c.area_code, 5)
       left join public.volunteers other on c.kind = 'direct' and other.id = case when c.member_a = $2 then c.member_b else c.member_a end
       left join public.cases k on k.id = c.case_id
       left join public.incident_categories ic on ic.code = k.category
       left join public.polling_units pu on pu.code = k.pu_code
       left join public.channel_reads r on r.channel_id = c.id and r.volunteer_id = $2
       left join lateral (select m.body, m.kind, m.sender_id, m.created_at from public.messages m
                           where m.channel_id = c.id order by m.created_at desc limit 1) lm on true
       left join public.volunteers sv on sv.id = lm.sender_id
      where c.id = any($1)`, [ids, me]);

  const out = new Map<string, ChannelSummary>();
  for (const r of rows) {
    let label: ChannelLabel;
    if (r.kind === 'direct') label = { person: r.person ?? 'Someone', role: r.person_role ?? undefined };
    else if (r.kind === 'case') {
      label = { category: r.category ?? 'Problem', categoryCode: r.case_category ?? undefined, caseStatus: ['resolved', 'closed', 'merged'].includes(r.case_status) ? 'closed' : 'open',
        unit: r.unit ? placeName(r.unit) : null, code: r.case_pu ?? null };
    } else {
      const place = placeName(r.ward ?? r.lga ?? r.state) || r.area_code;
      const parents = r.kind === 'ward' ? [r.p_lga && `${placeName(r.p_lga)} LGA`, r.p_state && placeName(r.p_state)]
        : r.kind === 'lga' ? [r.p_state && placeName(r.p_state)] : [];
      label = { place, parents: parents.filter(Boolean) as string[], code: r.area_code };
    }
    out.set(r.id, {
      label,
      last: r.last_at ? { body: r.body, kind: r.last_kind, sender: r.sender ?? null, mine: r.sender_id === me, at: r.last_at } : null,
      unread: r.unread,
    });
  }
  return out;
}
