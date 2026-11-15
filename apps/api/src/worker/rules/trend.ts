// Trend check: compares each unit's result with the same unit in the baseline
// election, relative to the swing across its LGA. A unit that moves far more
// than its neighbours is flagged for the legal desk to look at. Fixed rules.

import { json, q } from '../context';

export interface UnitShare { pu: string; now: number; before: number }

/** Units whose swing differs from their LGA's median swing by more than `threshold`. */
export function outliers(units: UnitShare[], threshold = 0.25, minUnits = 5): { pu: string; swing: number; lgaMedian: number }[] {
  const byLga = new Map<string, UnitShare[]>();
  for (const u of units) {
    const k = u.pu.slice(0, 5);
    byLga.set(k, [...(byLga.get(k) ?? []), u]);
  }
  const out: { pu: string; swing: number; lgaMedian: number }[] = [];
  for (const list of byLga.values()) {
    if (list.length < minUnits) continue;
    const swings = list.map((u) => u.now - u.before).sort((a, b) => a - b);
    const median = swings[Math.floor(swings.length / 2)];
    for (const u of list) {
      const s = u.now - u.before;
      if (Math.abs(s - median) > threshold) out.push({ pu: u.pu, swing: s, lgaMedian: median });
    }
  }
  return out;
}

/** Run for each tenant's live election against its baseline, for one party (default APC). */
export async function runTrendCheck(party = 'APC'): Promise<number> {
  const pairs = await q(
    `select l.tenant_id, l.election_id as live, b.election_id as base from public.tenant_elections l
       join public.tenant_elections b on b.tenant_id = l.tenant_id and b.purpose = 'baseline' where l.purpose = 'live'`);
  let raised = 0;
  for (const p of pairs) {
    const rows = await q(
      `select n.pu_code, n.share as now, b.share as before from public.v_baseline_unit_shares n
         join public.v_baseline_unit_shares b on b.pu_code = n.pu_code and b.election_id = $2 and b.party = $3
        where n.election_id = $1 and n.party = $3`, [p.live, p.base, party]);
    const units: UnitShare[] = rows.map((r) => ({ pu: r.pu_code, now: Number(r.now), before: Number(r.before) }));
    for (const o of outliers(units)) {
      const [{ r }] = await q(`select public.svc_raise_alert($1, $2, 'trend_outlier', $3, $3, $4, $5) as r`,
        [p.tenant_id, p.live, o.pu, json({ party, swing: o.swing, lga_median_swing: o.lgaMedian }), `trend:${o.pu}`]);
      if (r) raised++;
    }
  }
  return raised;
}
