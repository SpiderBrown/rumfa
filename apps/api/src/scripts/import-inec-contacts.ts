// Imports official INEC office contacts (section 11.7 of the design):
//   - state offices page: state, office address, Resident Electoral Commissioner
//   - one LGA directory PDF per state: LGA office addresses
// plus the INEC Citizens Contact Centre hotlines. Records are tagged source_type = 'official', shared by all
// tenants, and enter as 'pending' until a test call succeeds. Re-running updates records, never duplicates.
// Usage: node dist/scripts/import-inec-contacts [--states 18,19]
import { arg, log, withDb } from './run';

const STATE_PAGE = 'https://inecnigeria.org/about/state-offices';
const UA = { 'User-Agent': 'Rumfa-contacts-import/1.0' };
let lgas: { code: string; state_code: string; name: string }[] = [];
// pdfjs-dist is an ES module; load it with a real dynamic import from this CommonJS build
const esm = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

void withDb(async (q) => {
  const stateFilter = arg('--states')?.split(',') ?? null;
  const upsert = async (c: Record<string, unknown>) => {
    const row: Record<string, unknown> = { source_type: 'official', status: 'pending', ...c };
    const cols = Object.keys(row);
    await q(`insert into public.authority_contacts (tenant_id, fetched_at, ${cols.join(', ')}) values (null, now(), ${cols.map((_, i) => `$${i + 1}`).join(', ')})
             on conflict (source_type, external_key) do update set fetched_at = now(), ${cols.filter((k) => !['source_type', 'external_key', 'status'].includes(k)).map((k) => `${k} = excluded.${k}`).join(', ')}`,
      cols.map((k) => row[k])).catch((e) => log('contacts', `failed ${c.external_key}: ${(e as Error).message}`));
  };

  const states = await q<{ code: string; name: string; is_north: boolean }>(`select code, name, is_north from public.states`);
  const byName = new Map(states.map((s) => [norm(s.name), s]));
  lgas = await q<{ code: string; state_code: string; name: string }>(`select code, state_code, name from public.lgas`);
  const unmatched: string[] = [];

  // National hotlines (from the INEC contact page; re-check before the election)
  const ICCC = ['+2349084444333', '+2349050858629'];
  for (const [i, phone] of ICCC.entries()) {
    await upsert({ agency: 'INEC', title: 'Citizens Contact Centre (ICCC)', phone, level: 'national', area_code: 'NG',
      source_url: 'https://inecnigeria.org/contact', external_key: `inec-iccc-${i}` });
  }

  const html = await (await fetch(STATE_PAGE, { headers: UA })).text();
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'");
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const pdfLinks = [...html.matchAll(/href="([^"]+\.pdf)"/gi)].map((m) => new URL(m[1], STATE_PAGE).toString());

  for (let i = 0; i < lines.length; i++) {
    const m = /^(.+?) State$|^(Federal Capital Territory)$/.exec(lines[i]);
    if (!m) continue;
    const s = byName.get(norm(m[1] ?? m[2]));
    if (!s || (stateFilter && !stateFilter.includes(s.code))) continue;
    const block = lines.slice(i, i + 12);
    const address = block.find((l) => /INEC State Headquarters/i.test(l)) ?? null;
    const recIdx = block.findIndex((l) => /RESIDENT ELECTORAL COMMISSIONER/i.test(l));
    const rec = recIdx >= 0 ? block[recIdx + 1] : null;
    await upsert({ agency: 'INEC', title: 'Resident Electoral Commissioner (state office)', person_name: rec, address,
      level: 'state', area_code: s.code, source_url: STATE_PAGE, external_key: `inec-state-${s.code}` });

    const pdf = pdfLinks.find((u) => norm(u).includes(norm(s.name).replace(/ /g, '')) ||
      norm(decodeURIComponent(u)).includes(norm(s.name)));
    if (!pdf) { log('contacts', `no LGA PDF for ${s.name}`); continue; }
    for (const row of await lgaRows(pdf)) {
      const lga = lgas.find((l) => l.state_code === s.code && norm(l.name) === norm(row.lga));
      if (!lga) { unmatched.push(`${s.name}: ${row.lga}`); continue; }
      await upsert({ agency: 'INEC', title: 'LGA office', address: row.address, level: 'lga', area_code: lga.code,
        source_url: pdf, external_key: `inec-lga-${lga.code}` });
    }
  }
  if (unmatched.length) log('contacts', `LGA names to review (${unmatched.length})`, unmatched);


  log('contacts', 'INEC import finished');
});

async function lgaRows(url: string): Promise<{ lga: string; address: string }[]> {
  const bytes = new Uint8Array(await (await fetch(url, { headers: UA })).arrayBuffer());
  const { getDocument } = await esm('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: bytes }).promise;
  let all = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent();
    let lastY: number | null = null;
    for (const it of c.items as any[]) {
      const y = it.transform[5];
      all += lastY !== null && Math.abs(y - lastY) > 2 ? '\n' : ' ';
      all += it.str; lastY = y;
    }
    all += '\n';
  }
  // Rows look like "12 FAGGE COCO AVENUE, NO 170 ..." possibly wrapped onto the next line
  const rows: { lga: string; address: string }[] = [];
  const knownNames = lgas.map((l) => l.name.toUpperCase()).sort((a, b) => b.length - a.length);
  for (const raw of all.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const m = /^(\d{1,2}) (.+)$/.exec(line);
    if (m) {
      const rest = m[2];
      const name = knownNames.find((n) => rest.toUpperCase().startsWith(n + ' ')) ?? rest.split(' ').slice(0, 1).join(' ');
      rows.push({ lga: name, address: rest.slice(name.length).trim() });
    } else if (rows.length && line && !/^S\/N|^LGA|STATE$/i.test(line)) {
      rows[rows.length - 1].address += ' ' + line;
    }
  }
  return rows;
}

function norm(s: string): string { return s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }

