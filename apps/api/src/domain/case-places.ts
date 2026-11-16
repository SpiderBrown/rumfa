import type { Db } from '../database/db.service';
import { placeName } from '../shared';

/**
 * Readable "what" and "where" for cases, worked out at read time (the stored title keeps the code, for history and
 * notifications): the problem ("Violence or attack") and the place by name, with its parents and the code last.
 */
export interface CasePlace { name: string; parents: string[]; code: string; level: 'pu' | 'ward' | 'lga' | 'state' | 'national' }

export async function withCasePlaces<T extends { area_code?: string | null; pu_code?: string | null; category?: string | null }>(
  db: Db, rows: T[],
): Promise<(T & { what: string | null; where: CasePlace | null })[]> {
  if (!rows.length) return [];
  const codes = [...new Set(rows.map((r) => r.pu_code || r.area_code).filter((c): c is string => !!c))];
  const cats = [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))];
  const [names, labels] = await Promise.all([
    db.system<{ code: string; pu: string | null; ward: string | null; lga: string | null; state: string | null }>(
      `select x.code, p.name as pu, w.name as ward, l.name as lga, s.name as state
         from unnest($1::text[]) as x(code)
         left join public.polling_units p on length(x.code) = 12 and p.code = x.code
         left join public.wards w on length(x.code) >= 8 and w.code = left(x.code, 8)
         left join public.lgas l on length(x.code) >= 5 and l.code = left(x.code, 5)
         left join public.states s on length(x.code) >= 2 and s.code = left(x.code, 2)`, [codes]),
    db.system<{ code: string; label: string }>(`select code, label from public.incident_categories where code = any($1)`, [cats]),
  ]);
  const byCode = new Map(names.map((n) => [n.code, n]));
  const label = new Map(labels.map((l) => [l.code, l.label]));
  return rows.map((r) => {
    const code = r.pu_code || r.area_code || '';
    const n = byCode.get(code);
    let where: CasePlace | null = null;
    if (code === 'NG') where = { name: 'Nationwide', parents: [], code, level: 'national' };
    else if (n) {
      const ward = n.ward && placeName(n.ward), lga = n.lga && `${placeName(n.lga)} LGA`, state = n.state && placeName(n.state);
      const level = ({ 12: 'pu', 8: 'ward', 5: 'lga', 2: 'state' } as const)[code.length as 12 | 8 | 5 | 2] ?? 'pu';
      const own = level === 'pu' ? n.pu && placeName(n.pu) : level === 'ward' ? ward : level === 'lga' ? lga : state;
      const parents = level === 'pu' ? [ward, lga, state] : level === 'ward' ? [lga, state] : level === 'lga' ? [state] : [];
      where = { name: own || code, parents: parents.filter(Boolean) as string[], code, level };
    }
    return { ...r, what: (r.category && label.get(r.category)) ?? null, where };
  });
}
