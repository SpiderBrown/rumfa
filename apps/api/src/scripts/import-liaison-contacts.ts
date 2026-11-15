// Imports the campaign's liaison list (police, INEC, party legal team).
// Columns: agency, title, person_name, phone, level (national|state|lga|ward), area_code, notes?
// Usage: node dist/scripts/import-liaison-contacts --tenant <uuid> --file liaison.csv
import { readFileSync } from 'node:fs';
import { normaliseNgPhone } from '../shared';
import { parseCsv } from './csv';
import { arg, log, withDb } from './run';

void withDb(async (q) => {
  const tenant = arg('--tenant'), file = arg('--file');
  if (!tenant || !file) throw new Error('Usage: --tenant <uuid> --file <csv>');
  let n = 0;
  for (const [i, r] of parseCsv(readFileSync(file, 'utf8')).entries()) {
    const phone = normaliseNgPhone(r.phone ?? '');
    if (!phone || !r.agency || !r.title || !['national', 'state', 'lga', 'ward'].includes(r.level)) {
      console.log(`line ${i + 2}: skipped (check phone, agency, title, level)`); continue;
    }
    const area = r.level === 'national' ? 'NG' : r.area_code;
    await q(`insert into public.authority_contacts (tenant_id, agency, title, person_name, phone, level, area_code, notes, source_type, status, fetched_at, external_key)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'liaison', 'pending', now(), $9)
             on conflict (source_type, external_key) do update set agency = excluded.agency, title = excluded.title, person_name = excluded.person_name,
               level = excluded.level, area_code = excluded.area_code, notes = excluded.notes, fetched_at = excluded.fetched_at`,
      [tenant, r.agency, r.title, r.person_name || null, phone, r.level, area, r.notes || null, `${tenant}:${phone}:${area}`]);
    n++;
  }
  log('contacts', `liaison contacts imported: ${n}`);
});
