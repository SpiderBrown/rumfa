// Loads LGAs, wards and polling units from IReV into the reference tables, with IReV ids so fetch jobs can
// call the ward endpoint directly.
// Usage: node dist/scripts/import-geography [--states 18,19] [--election <irevElectionId>] [--no-units]
// Default: the 19 northern states and the FCT, using the 2023 presidential election.
import { lgasOfState, puCodeFromIrev, unitsOfWard } from '../worker/irev/client';
import { arg, flag, log, withDb } from './run';

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();

void withDb(async (q) => {
  const irevElection = arg('--election') ?? '63f8f25b594e164f8146a213';
  const stateFilter = arg('--states')?.split(',');
  const states = await q<{ code: string; name: string; irev_state_no: number; is_north: boolean }>(`select code, name, irev_state_no, is_north from public.states order by code`);
  for (const s of states.filter((x) => (stateFilter ? stateFilter.includes(x.code) : x.is_north))) {
    const lgas = await lgasOfState(irevElection, s.irev_state_no);
    if (!lgas.length) { log('geo', `no LGAs for ${s.name} (IReV ${s.irev_state_no}); check irev_state_no`); continue; }
    let unitCount = 0;
    for (const l of lgas) {
      const lgaCode = `${s.code}-${String(l.lga.code).padStart(2, '0')}`;
      await q(`insert into public.lgas (code, state_code, name, irev_id) values ($1, $2, $3, $4)
               on conflict (code) do update set name = excluded.name, irev_id = excluded.irev_id`, [lgaCode, s.code, titleCase(l.lga.name), l.lga._id]);
      for (const w of l.wards) {
        const code = `${lgaCode}-${String(w.code).padStart(2, '0')}`;
        await q(`insert into public.wards (code, lga_code, name, irev_id, senatorial_district, federal_constituency, state_constituency)
                 values ($1, $2, $3, $4, $5, $6, $7)
                 on conflict (code) do update set name = excluded.name, irev_id = excluded.irev_id, senatorial_district = excluded.senatorial_district,
                   federal_constituency = excluded.federal_constituency, state_constituency = excluded.state_constituency`,
          [code, lgaCode, titleCase(w.name), w._id, w.senatorial_district_id?.toString() ?? null, w.federal_constituency_id?.toString() ?? null,
           w.state_constituency_id?.toString() ?? null]);
        if (flag('--no-units')) continue;
        const units = await unitsOfWard(irevElection, w._id);
        const rows = units.map((u) => ({ code: puCodeFromIrev(u.pu_code), name: titleCase(u.name), irev_id: u._id })).filter((r) => r.code.startsWith(code + '-'));
        if (rows.length !== units.length) log('geo', `ward ${code}: ${units.length - rows.length} units with unexpected codes skipped`);
        for (const r of rows) {
          await q(`insert into public.polling_units (code, ward_code, name, irev_id) values ($1, $2, $3, $4)
                   on conflict (code) do update set name = excluded.name, irev_id = excluded.irev_id`, [r.code, code, r.name, r.irev_id]);
        }
        unitCount += rows.length;
      }
    }
    log('geo', `${s.name}: ${lgas.length} LGAs, ${unitCount} units`);
  }
});
