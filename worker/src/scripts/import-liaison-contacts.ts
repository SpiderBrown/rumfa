// Imports the campaign's liaison list (police, INEC, party legal team).
// Columns: agency, title, person_name, phone, level (national|state|lga|ward), area_code, notes?
// Usage: node src/scripts/import-liaison-contacts.ts --tenant <uuid> --file liaison.csv

import { readFileSync } from 'node:fs';
import { normaliseNgPhone } from '../../../shared/src/index.ts';
import { db, log } from '../db.ts';
import { parseCsv } from './csv.ts';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const tenant = arg('--tenant');
const file = arg('--file');
if (!tenant || !file) { console.error('Usage: --tenant <uuid> --file <csv>'); process.exit(1); }

let n = 0;
for (const [i, r] of parseCsv(readFileSync(file, 'utf8')).entries()) {
  const phone = normaliseNgPhone(r.phone ?? '');
  if (!phone || !r.agency || !r.title || !['national', 'state', 'lga', 'ward'].includes(r.level)) {
    console.log(`line ${i + 2}: skipped (check phone, agency, title, level)`); continue;
  }
  const { error } = await db().from('authority_contacts').upsert({
    tenant_id: tenant, agency: r.agency, title: r.title, person_name: r.person_name || null, phone,
    level: r.level, area_code: r.level === 'national' ? 'NG' : r.area_code, notes: r.notes || null,
    source_type: 'liaison', status: 'pending', fetched_at: new Date().toISOString(),
    external_key: `${tenant}:${phone}:${r.area_code}`,
  }, { onConflict: 'source_type,external_key' });
  if (error) console.log(`line ${i + 2}: ${error.message}`); else n++;
}
log('contacts', `liaison contacts imported: ${n}`);
