// Trend check: compares each unit's result with the same unit in the baseline
// election, relative to the swing across its LGA. A unit that moves far more
// than its neighbours is flagged for the legal desk to look at. Fixed rules.

import { db } from '../db.ts';

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
  const { data: tes } = await db().from('tenant_elections').select('tenant_id, election_id, purpose');
  let raised = 0;
  const tenants = new Set((tes ?? []).map((t) => t.tenant_id));
  for (const tenant of tenants) {
    const live = tes!.find((t) => t.tenant_id === tenant && t.purpose === 'live')?.election_id;
    const base = tes!.find((t) => t.tenant_id === tenant && t.purpose === 'baseline')?.election_id;
    if (!live || !base) continue;
    const { data: now } = await db().from('v_baseline_unit_shares').select('pu_code, share').eq('election_id', live).eq('party', party);
    const { data: before } = await db().from('v_baseline_unit_shares').select('pu_code, share').eq('election_id', base).eq('party', party);
    const prev = new Map((before ?? []).map((r) => [r.pu_code, Number(r.share)]));
    const units: UnitShare[] = (now ?? []).filter((r) => prev.has(r.pu_code))
      .map((r) => ({ pu: r.pu_code, now: Number(r.share), before: prev.get(r.pu_code)! }));
    for (const o of outliers(units)) {
      const { data } = await db().rpc('svc_raise_alert', {
        p_tenant: tenant, p_election: live, p_rule: 'trend_outlier', p_pu: o.pu, p_area: o.pu,
        p_details: { party, swing: o.swing, lga_median_swing: o.lgaMedian }, p_dedupe: `trend:${o.pu}`,
      });
      if (data) raised++;
    }
  }
  return raised;
}
