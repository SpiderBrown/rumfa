// Loads LGAs, wards and polling units from IReV into the reference tables,
// with IReV ids so fetch jobs can call the ward endpoint directly.
// Usage: node src/scripts/import-geography.ts [--states 18,19] [--election <irevElectionId>]
// Default: the 19 northern states and the FCT, using the 2023 presidential election.

import { db, log, must } from '../db.ts';
import { lgasOfState, unitsOfWard, puCodeFromIrev } from '../irev/client.ts';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const irevElection = arg('--election') ?? '63f8f25b594e164f8146a213';
const stateFilter = arg('--states')?.split(',');
const withUnits = !args.includes('--no-units');

const states = must(await db().from('states').select('code, name, irev_state_no, is_north').order('code')) as
  { code: string; name: string; irev_state_no: number; is_north: boolean }[];
const targets = states.filter((s) => (stateFilter ? stateFilter.includes(s.code) : s.is_north));

for (const s of targets) {
  const lgas = await lgasOfState(irevElection, s.irev_state_no);
  if (!lgas.length) { log('geo', `no LGAs for ${s.name} (IReV ${s.irev_state_no}); check irev_state_no`); continue; }
  let unitCount = 0;
  for (const l of lgas) {
    const lgaCode = `${s.code}-${String(l.lga.code).padStart(2, '0')}`;
    must(await db().from('lgas').upsert({ code: lgaCode, state_code: s.code, name: titleCase(l.lga.name), irev_id: l.lga._id }));
    const wardRows = l.wards.map((w) => ({
      code: `${lgaCode}-${String(w.code).padStart(2, '0')}`, lga_code: lgaCode, name: titleCase(w.name), irev_id: w._id,
      senatorial_district: w.senatorial_district_id != null ? String(w.senatorial_district_id) : null,
      federal_constituency: w.federal_constituency_id != null ? String(w.federal_constituency_id) : null,
      state_constituency: w.state_constituency_id != null ? String(w.state_constituency_id) : null,
    }));
    must(await db().from('wards').upsert(wardRows));
    if (!withUnits) continue;
    for (const w of wardRows) {
      const units = await unitsOfWard(irevElection, w.irev_id);
      const rows = units.map((u) => ({ code: puCodeFromIrev(u.pu_code), ward_code: w.code, name: titleCase(u.name), irev_id: u._id }))
        .filter((r) => r.code.startsWith(w.code + '-'));
      if (rows.length !== units.length) log('geo', `ward ${w.code}: ${units.length - rows.length} units with unexpected codes skipped`);
      if (rows.length) must(await db().from('polling_units').upsert(rows));
      unitCount += rows.length;
    }
  }
  log('geo', `${s.name}: ${lgas.length} LGAs, ${unitCount} units`);
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();
}
