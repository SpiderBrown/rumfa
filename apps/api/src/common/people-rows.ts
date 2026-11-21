import { LEVELS, normaliseNgPhone, normalisePuCode, ROLES } from '../shared';

/** One person from a list (CSV), checked and normalised */
export interface PersonRow { full_name: string; phone: string; role: string; level: string; area: string; email: string | null; languages: string[]; network: string | null }

/**
 * Checks a list of people (CSV columns: full_name, phone, role, level, area_code, email?, languages?, network?).
 * Used by the dashboard's Import list and by `npm run import:people`. Problems name the line, as the admin sees it.
 */
export function checkPeopleRows(rows: Record<string, string>[]): { ok: PersonRow[]; problems: string[] } {
  const problems: string[] = [];
  const ok: PersonRow[] = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const line = i + 2;
    const phone = normaliseNgPhone(r.phone ?? '');
    const role = (r.role || 'agent').trim().toLowerCase();
    const level = (r.level || (role === 'agent' ? 'pu' : '')).trim().toLowerCase();
    let area = (r.area_code ?? '').trim();
    if (!r.full_name?.trim()) { problems.push(`Line ${line}: no name`); continue; }
    if (!phone) { problems.push(`Line ${line}: ${r.phone || 'no phone'} is not a Nigerian mobile number`); continue; }
    if (seen.has(phone)) { problems.push(`Line ${line}: ${phone} is in the list twice`); continue; }
    if (!(ROLES as readonly string[]).includes(role)) { problems.push(`Line ${line}: unknown role "${role}"`); continue; }
    if (!(LEVELS as readonly string[]).includes(level)) { problems.push(`Line ${line}: unknown level "${level}"`); continue; }
    if (level === 'pu') {
      const pu = normalisePuCode(area);
      if (!pu) { problems.push(`Line ${line}: "${area}" is not a polling unit code`); continue; }
      area = pu;
    }
    if (level === 'national') area = 'NG';
    if (!area) { problems.push(`Line ${line}: no area code`); continue; }
    seen.add(phone);
    ok.push({ full_name: r.full_name.trim(), phone, role, level, area, email: r.email?.trim().toLowerCase() || null,
      languages: r.languages ? r.languages.split(/[;| ]+/).filter(Boolean) : ['en'], network: r.network ? r.network.trim().toLowerCase() : null });
  }
  return { ok, problems };
}
