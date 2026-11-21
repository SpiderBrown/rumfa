// Bulk onboarding from a CSV (e.g. the party's list of accredited agents).
// Columns: full_name, phone, role, level, area_code (pu code for agents), email?, languages?, network?
// People are created as 'invited'; they activate their phone (SMS code or activation code) to sign in.
// Usage: node dist/scripts/import-people --tenant <uuid> --file agents.csv [--dry-run]
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkPeopleRows } from '../common/people-rows';
import { parseCsv } from './csv';
import { arg, flag, log, withDb, type Q } from './run';

const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
async function agentCode(q: Q, tenant: string, phone: string): Promise<string> {
  for (;;) {
    const code = Array.from({ length: 4 }, () => A[randomInt(0, A.length)]).join('');
    const [{ taken }] = await q(`select exists (select 1 from public.volunteers where agent_code = $1 and (tenant_id = $2 or phone = $3)) as taken`, [code, tenant, phone]);
    if (!taken) return code;
  }
}

void withDb(async (q) => {
  const tenant = arg('--tenant'), file = arg('--file');
  if (!tenant || !file) throw new Error('Usage: --tenant <uuid> --file <csv> [--dry-run]');
  const { ok, problems: errors } = checkPeopleRows(parseCsv(readFileSync(file, 'utf8')));
  const pus = [...new Set(ok.filter((o) => o.level === 'pu').map((o) => o.area))];
  const found = new Set((await q(`select code from public.polling_units where code = any($1)`, [pus])).map((r) => r.code));
  for (const c of pus) if (!found.has(c)) errors.push(`unknown polling unit ${c}`);
  log('people', `${ok.length} valid rows, ${errors.length} problems`);
  errors.slice(0, 50).forEach((e) => console.log('  ' + e));
  if (errors.length) { console.log('Nothing imported: fix the problems above (or remove those rows) and run again.'); process.exitCode = 1; return; }
  if (flag('--dry-run')) return;
  for (const o of ok) {
    const code = o.role === 'agent' ? await agentCode(q, tenant, o.phone) : null;
    await q(`insert into public.volunteers (tenant_id, full_name, phone, email, role, level, area_code, agent_code, languages, network, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'invited')
             on conflict (tenant_id, phone) do update set full_name = excluded.full_name, email = coalesce(excluded.email, volunteers.email),
               role = excluded.role, level = excluded.level, area_code = excluded.area_code, languages = excluded.languages,
               network = coalesce(excluded.network, volunteers.network), agent_code = coalesce(volunteers.agent_code, excluded.agent_code)`,
      [tenant, o.full_name, o.phone, o.email, o.role, o.level, o.area, code, o.languages, o.network]);
  }
  log('people', `imported ${ok.length}`);
});
