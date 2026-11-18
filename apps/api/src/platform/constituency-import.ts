// Loads federal (House of Representatives) and state (State House of Assembly) constituencies from IReV: the names
// come from IReV's list of elections held in each constituency (every one had an election in 2023), asked state by
// state. Wards already carry IReV's constituency numbers, which link them. Re-running updates names.
import { irevGet } from '../worker/irev/client';

type Q = (sql: string, params?: unknown[]) => Promise<any[]>;

/** IReV's election types (ids of its own records) */
const REPS = '5f129a04df41d910dcdc1d53';
const ASSEMBLY = '5f129a04df41d910dcdc1d54';

interface IrevElection {
  state?: { code?: string };
  domain?: { name?: string; code?: string; federal_constituency_id?: number; state_constituency_id?: number };
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, a, b) => a + b.toUpperCase()).trim();

export async function importConstituencies(q: Q, states: string[] | undefined, log: (m: string) => void,
                                           progress: (p: object) => void = () => undefined) {
  const all = await q(`select code, name, irev_state_no from public.states where irev_state_no is not null order by code`);
  const list = all.filter((s) => !states?.length || states.includes(s.code));
  const p = { state: null as string | null, statesDone: 0, statesTotal: list.length, federal: 0, state_: 0 };
  for (const s of list) {
    p.state = s.name; progress(p);
    for (const [kind, type, key, prefix] of [['federal', REPS, 'federal_constituency_id', 'FC'], ['state', ASSEMBLY, 'state_constituency_id', 'SC']] as const) {
      const r = await irevGet<{ data?: IrevElection[] }>(`/elections?election_type=${type}&state_id=${s.irev_state_no}`);
      const found = new Map<number, { name: string; code: string }>();
      for (const e of r.data ?? []) {
        const no = e.domain?.[key];
        // Safety: IReV must have answered for this state
        if (!no || !e.domain?.name || (e.state?.code && e.state.code !== s.code)) continue;
        found.set(no, { name: titleCase(e.domain.name), code: e.domain.code ?? '' });
      }
      if (!found.size) { log(`${s.name}: no ${kind === 'federal' ? 'House of Reps' : 'State Assembly'} constituencies on IReV`); continue; }
      const rows = [...found].map(([no, c]) => ({ code: `${s.code}-${prefix}${no}`, kind, state_code: s.code, name: c.name, irev_no: no, irev_code: c.code }));
      await q(`insert into public.constituencies (code, kind, state_code, name, irev_no, irev_code)
               select x.code, x.kind, x.state_code, x.name, x.irev_no, x.irev_code
                 from jsonb_to_recordset($1::jsonb) as x(code text, kind text, state_code text, name text, irev_no int, irev_code text)
               on conflict (code) do update set name = excluded.name, irev_code = excluded.irev_code, updated_at = now()`, [JSON.stringify(rows)]);
      if (kind === 'federal') p.federal += rows.length; else p.state_ += rows.length;
      // Wards that point at a number IReV did not list (e.g. no 2023 election there)
      const [orphans] = await q(
        `select count(distinct w.${kind === 'federal' ? 'federal_constituency' : 'state_constituency'})::int as n from public.wards w
          where w.code like $1 || '-%' and w.${kind === 'federal' ? 'federal_constituency' : 'state_constituency'} is not null
            and not exists (select 1 from public.constituencies c where c.kind = $2 and c.irev_no::text = w.${kind === 'federal' ? 'federal_constituency' : 'state_constituency'})`,
        [s.code, kind]);
      log(`${s.name}: ${rows.length} ${kind === 'federal' ? 'House of Reps' : 'State Assembly'} constituencies${orphans.n ? ` (${orphans.n} more referred to by wards but not on IReV)` : ''}`);
    }
    p.statesDone++; progress(p);
  }
  p.state = null;
  return { ...p, state: undefined, assembly: p.state_ };
}

/** SQL: the wards of a constituency code ($n), joined by IReV number. */
export const WARDS_OF_CONSTITUENCY = (param: string) => `
  select w.code, w.lga_code, w.name from public.wards w join public.constituencies c on c.code = ${param}
   where w.lga_code like c.state_code || '-%'
     and ((c.kind = 'federal' and w.federal_constituency = c.irev_no::text) or (c.kind = 'state' and w.state_constituency = c.irev_no::text))`;
