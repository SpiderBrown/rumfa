// Bulk onboarding from a CSV (e.g. the party's list of accredited agents).
// Columns: full_name, phone, role, level, area_code (pu code for agents), agent_code?, languages?, network?
// People are created as 'invited'; their login links when they first sign in
// with an OTP to that phone. Usage:
//   node src/scripts/import-people.ts --tenant <uuid> --file agents.csv [--dry-run]

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { normaliseNgPhone, normalisePuCode, ROLES, LEVELS } from '../../../shared/src/index.ts';
import { db, log } from '../db.ts';
import { parseCsv } from './csv.ts';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const tenant = arg('--tenant');
const file = arg('--file');
const dry = args.includes('--dry-run');
if (!tenant || !file) { console.error('Usage: --tenant <uuid> --file <csv> [--dry-run]'); process.exit(1); }

const rows = parseCsv(readFileSync(file, 'utf8'));
const errors: string[] = [];
const ok: Record<string, unknown>[] = [];
const seenPhones = new Set<string>();

const newAgentCode = () => randomBytes(3).toString('hex').toUpperCase().slice(0, 4);

for (const [i, r] of rows.entries()) {
  const line = i + 2;
  const phone = normaliseNgPhone(r.phone ?? '');
  const role = (r.role || 'agent').toLowerCase();
  let level = (r.level || (role === 'agent' ? 'pu' : '')).toLowerCase();
  let area = r.area_code ?? '';
  if (!r.full_name) { errors.push(`line ${line}: missing name`); continue; }
  if (!phone) { errors.push(`line ${line}: bad phone ${r.phone}`); continue; }
  if (seenPhones.has(phone)) { errors.push(`line ${line}: duplicate phone ${phone}`); continue; }
  if (!(ROLES as readonly string[]).includes(role)) { errors.push(`line ${line}: unknown role ${role}`); continue; }
  if (!(LEVELS as readonly string[]).includes(level)) { errors.push(`line ${line}: unknown level ${level}`); continue; }
  if (level === 'pu') {
    const pu = normalisePuCode(area);
    if (!pu) { errors.push(`line ${line}: bad polling unit code ${area}`); continue; }
    area = pu;
  }
  if (level === 'national') area = 'NG';
  seenPhones.add(phone);
  ok.push({
    tenant_id: tenant, full_name: r.full_name, phone, role, level, area_code: area,
    agent_code: role === 'agent' ? (r.agent_code || newAgentCode()) : null,
    languages: r.languages ? r.languages.split(/[;| ]+/) : ['en'],
    network: r.network ? r.network.toLowerCase() : null, status: 'invited',
  });
}

// Check unit codes exist
const puCodes = [...new Set(ok.filter((o) => o.level === 'pu').map((o) => o.area_code as string))];
for (let i = 0; i < puCodes.length; i += 500) {
  const { data } = await db().from('polling_units').select('code').in('code', puCodes.slice(i, i + 500));
  const found = new Set((data ?? []).map((d) => d.code));
  for (const c of puCodes.slice(i, i + 500)) if (!found.has(c)) errors.push(`unknown polling unit ${c}`);
}

log('people', `${ok.length} valid rows, ${errors.length} problems`);
errors.slice(0, 50).forEach((e) => console.log('  ' + e));
if (dry || errors.length) { if (errors.length) console.log('Nothing imported: fix the problems above (or remove those rows) and run again.'); process.exit(errors.length ? 1 : 0); }

for (let i = 0; i < ok.length; i += 500) {
  const { error } = await db().from('volunteers').upsert(ok.slice(i, i + 500), { onConflict: 'tenant_id,phone', ignoreDuplicates: false });
  if (error) { console.error(error.message); process.exit(1); }
}
log('people', `imported ${ok.length}`);
