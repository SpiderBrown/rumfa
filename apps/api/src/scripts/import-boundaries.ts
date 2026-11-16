// Loads area outlines for the situation-room map from open boundary data (GeoJSON) into public.area_shapes.
// Shapes are matched to our codes by name (state, then LGA within its state, then ward within its LGA),
// simplified for fast phones, and stored once for all tenants. Re-running replaces them.
//
// Free sources (download the GeoJSON yourself; nothing is fetched by this script):
//   - States and LGAs: OCHA Nigeria administrative boundaries on HDX (levels 1 and 2)
//   - Wards: GRID3 Nigeria ward boundaries (GRID3 data hub)
//
// Usage (after `npm run build`):
//   npm run import:boundaries -- --level state --file nga_admin1.geojson
//     (also saves the six geopolitical zones' outlines: each zone's states merged into one)
//   npm run import:boundaries -- --level lga   --file nga_admin2.geojson
//   npm run import:boundaries -- --level ward  --file nga_wards.geojson
//   npm run import:boundaries -- --level senatorial --file nga_senatorialdistricts.geojson
//     (districts, their outlines, and which district each LGA belongs to: load LGA outlines first)
// Options: --name <property> --state <property> --lga <property> override the name fields if auto-detection
//          picks the wrong ones; --source "<text>" records where the data came from.
import { readFileSync } from 'node:fs';
import { union, type MultiPolygon } from 'polygon-clipping';
import { center, normName, simplify, type Geometry } from './geo';
import { arg, log, withDb, type Q } from './run';
import { pointInGeometry } from '../shared';

// Field names used by the common sources, tried in order
const FIELDS = {
  state: ['statename', 'state_name', 'adm1_name', 'admin1Name_en', 'ADM1_EN', 'adm1_en', 'NAME_1', 'state', 'State', 'name'],
  lga: ['lganame', 'lga_name', 'adm2_name', 'admin2Name_en', 'ADM2_EN', 'adm2_en', 'NAME_2', 'lga', 'LGA', 'name'],
  ward: ['wardname', 'ward_name', 'adm3_name', 'admin3Name_en', 'ADM3_EN', 'adm3_en', 'NAME_3', 'ward', 'Ward', 'name'],
  senatorial: ['sendist_en', 'sendistrefname', 'senatorial', 'name'],
};
const TOLERANCE = { zone: 0.01, state: 0.01, senatorial: 0.005, lga: 0.003, ward: 0.0008 }; // degrees (~1 km, 300 m, 90 m)
// Names that differ between INEC and the boundary sources
const STATE_ALIASES: Record<string, string> = { fct: 'federalcapitalterritory', abuja: 'federalcapitalterritory', nassarawa: 'nasarawa' };
// LGA names that differ between INEC (our geography) and OCHA, as normalised names: INEC -> OCHA. Add more as found.
const LGA_ALIASES: Record<string, string> = {
  gire1: 'girei', dambam: 'damban', otukpo: 'oturkpo', maidugurimc: 'maiduguri', shongom: 'shomgom', yalmaltudeba: 'yamaltudeba',
  birninkudu: 'birnikudu', birniwa: 'biriniwa', makarfi: 'markafi', zangonkataf: 'zangokataf', danbata: 'dambatta',
  dawakikudu: 'dawakinkudu', dawakitofa: 'dawakintofa', garunmalam: 'garummallam', malufashi: 'malumfashi', aliero: 'aleiro',
  arewa: 'arewadandi', olamaboro: 'olamabolo', municipal: 'abujamunicipal',
};

interface ShapeRow { code: string; level: string; geometry: Geometry; center_lat: number; center_lng: number; source: string }
/** Saves outlines 100 at a time: one round trip per batch instead of one per area (the database may be far away). */
async function saveShapes(q: Q, rows: ShapeRow[]) {
  for (let i = 0; i < rows.length; i += 100) {
    await q(`insert into public.area_shapes (code, level, geometry, center_lat, center_lng, source, updated_at)
             select x.code, x.level, x.geometry, x.center_lat, x.center_lng, x.source, now()
               from jsonb_to_recordset($1::jsonb) as x(code text, level text, geometry jsonb, center_lat float8, center_lng float8, source text)
             on conflict (code) do update set level = excluded.level, geometry = excluded.geometry, center_lat = excluded.center_lat,
               center_lng = excluded.center_lng, source = excluded.source, updated_at = now()`,
      [JSON.stringify(rows.slice(i, i + 100))]);
  }
}

void withDb(async (q) => {
  const level = arg('--level') as 'state' | 'senatorial' | 'lga' | 'ward';
  const file = arg('--file');
  if (!['state', 'senatorial', 'lga', 'ward'].includes(level) || !file) throw new Error('Usage: --level state|senatorial|lga|ward --file <geojson>');
  const fc = JSON.parse(readFileSync(file, 'utf8'));
  const features: any[] = fc.features ?? [];
  if (!features.length) throw new Error('No features in that file (expected a GeoJSON FeatureCollection)');
  const props = features[0].properties ?? {};
  // --name is the field for the level being loaded; --state / --lga name its parents. Otherwise auto-detect
  // (a bare "name" field only ever counts as the level being loaded).
  const pick = (kind: 'state' | 'senatorial' | 'lga' | 'ward') =>
    (kind === level ? arg('--name') : arg(`--${kind}`)) ?? FIELDS[kind].find((f) => f in props && (kind === level || f !== 'name'));
  const field = { state: pick('state'), senatorial: level === 'senatorial' ? pick('senatorial') : undefined,
    lga: level === 'lga' || level === 'ward' ? pick('lga') : undefined, ward: level === 'ward' ? pick('ward') : undefined };
  log('boundaries', `${features.length} ${level} shapes; name fields`, field);
  if (!field[level]) throw new Error(`Could not find the ${level} name field; pass --name <property>. Fields: ${Object.keys(props).join(', ')}`);

  const states = await q<{ code: string; name: string; zone: string | null }>(`select code, name, zone from public.states`);
  const lgas = await q<{ code: string; state_code: string; name: string }>(`select code, state_code, name from public.lgas`);
  const wards = await q<{ code: string; lga_code: string; name: string }>(`select code, lga_code, name from public.wards`);
  const stateKey = (n: string) => { const k = normName(n); return STATE_ALIASES[k] ?? k; };
  const stateBy = new Map(states.map((s) => [stateKey(s.name), s.code]));
  const lgaKey = (n: string) => { const k = normName(n); return LGA_ALIASES[k] ?? k; };
  if (level === 'senatorial') return importSenatorial(q, features, field.state!, field.senatorial!, (n) => stateBy.get(stateKey(n)), file);

  const unmatched: string[] = [];
  const toSave: ShapeRow[] = [];
  const stateShapes = new Map<string, Geometry>(); // full detail, for merging into zones
  for (const f of features) {
    const p = f.properties ?? {};
    const g = f.geometry as Geometry;
    if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const stateCode = field.state ? stateBy.get(stateKey(p[field.state])) : undefined;
    let code: string | undefined;
    if (level === 'state') code = stateBy.get(stateKey(p[field.state!]));
    else if (level === 'lga') code = lgas.find((l) => (!stateCode || l.state_code === stateCode) && lgaKey(l.name) === lgaKey(p[field.lga!]))?.code;
    else {
      const lga = lgas.find((l) => (!stateCode || l.state_code === stateCode) && lgaKey(l.name) === lgaKey(p[field.lga!]));
      code = lga && wards.find((w) => w.lga_code === lga.code && normName(w.name) === normName(p[field.ward!]))?.code;
    }
    const label = [field.state && p[field.state], field.lga && p[field.lga], field.ward && p[field.ward]].filter(Boolean).join(' / ');
    if (!code) { unmatched.push(label); continue; }
    const shape = simplify(g, TOLERANCE[level]);
    const c = center(shape);
    toSave.push({ code, level, geometry: shape, center_lat: c.lat, center_lng: c.lng, source: arg('--source') ?? file.split('/').pop()! });
    if (level === 'state') stateShapes.set(code, g);
  }
  await saveShapes(q, toSave);
  log('boundaries', `saved ${toSave.length} ${level} shapes`);
  if (level === 'state') await saveZones(q, states, stateShapes, arg('--source') ?? file.split('/').pop()!);
  if (unmatched.length) log('boundaries', `${unmatched.length} not matched to our ${level}s (check names or load the geography first)`, unmatched.slice(0, 50));
});

/**
 * Geopolitical zones (Z-NC, Z-NE, Z-NW, Z-SE, Z-SS, Z-SW): each zone's states merged into one outline, so the
 * national map can be shown by zone without state borders inside a zone. Merged before simplifying, so shared
 * borders line up exactly and disappear.
 */
async function saveZones(q: Q, states: { code: string; zone: string | null }[], shapes: Map<string, Geometry>, source: string) {
  const byZone = new Map<string, Geometry[]>();
  for (const s of states) {
    const g = shapes.get(s.code);
    if (!s.zone || !g) continue;
    if (!byZone.has(s.zone)) byZone.set(s.zone, []);
    byZone.get(s.zone)!.push(g);
  }
  const rows: ShapeRow[] = [];
  for (const [zone, gs] of byZone) {
    const parts = gs.map((g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as MultiPolygon);
    const merged = union(parts[0], ...parts.slice(1));
    const shape = simplify({ type: 'MultiPolygon', coordinates: merged } as Geometry, TOLERANCE.zone);
    const c = center(shape);
    rows.push({ code: `Z-${zone}`, level: 'zone', geometry: shape, center_lat: c.lat, center_lng: c.lng, source: `${source} (states merged)` });
  }
  await saveShapes(q, rows);
  const missing = states.filter((s) => s.zone && !shapes.has(s.code)).map((s) => s.code);
  log('boundaries', `saved ${rows.length} zone outlines` + (missing.length ? `; states with no outline left out: ${missing.join(', ')}` : ''));
}

/**
 * Senatorial districts: one row and outline per district (code = state + its number there, e.g. 20-SD1), then each
 * LGA of the state is linked to the district holding most of its outline's points. LGAs without an outline yet are
 * listed; run again after loading them.
 */
async function importSenatorial(q: Q, features: any[], stateField: string, nameField: string,
  stateOf: (name: string) => string | undefined, file: string) {
  const unmatched: string[] = [];
  const byState = new Map<string, { code: string; geometry: Geometry }[]>();
  const districts: { code: string; state_code: string; name: string }[] = [];
  const shapes: ShapeRow[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const g = f.geometry as Geometry;
    if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const stateCode = stateOf(p[stateField]);
    const num = Number(String(p.sendistpcode ?? p.pcode ?? '').slice(-2));
    if (!stateCode || !num) { unmatched.push(`${p[stateField]} / ${p[nameField]}`); continue; }
    const code = `${stateCode}-SD${num}`;
    const shape = simplify(g, TOLERANCE.senatorial);
    const c = center(shape);
    districts.push({ code, state_code: stateCode, name: String(p[nameField]).trim() });
    shapes.push({ code, level: 'senatorial', geometry: shape, center_lat: c.lat, center_lng: c.lng, source: arg('--source') ?? file.split('/').pop()! });
    if (!byState.has(stateCode)) byState.set(stateCode, []);
    byState.get(stateCode)!.push({ code, geometry: g });
  }
  // Districts first (the outlines and LGA links refer to them), each list in one statement
  await q(`insert into public.senatorial_districts (code, state_code, name, updated_at)
           select x.code, x.state_code, x.name, now() from jsonb_to_recordset($1::jsonb) as x(code text, state_code text, name text)
           on conflict (code) do update set name = excluded.name, updated_at = now()`, [JSON.stringify(districts)]);
  await saveShapes(q, shapes);
  log('boundaries', `saved ${districts.length} senatorial districts`);
  if (unmatched.length) log('boundaries', `${unmatched.length} not matched to our states`, unmatched);

  // Link each LGA (that has an outline) to the district holding most of its outline's points
  const lgaShapes = await q<{ code: string; state_code: string; name: string; geometry: Geometry }>(
    `select l.code, l.state_code, l.name, s.geometry from public.lgas l join public.area_shapes s on s.code = l.code`);
  const links: { code: string; senatorial_code: string }[] = [];
  const unsure: string[] = [];
  for (const l of lgaShapes) {
    const districts = byState.get(l.state_code) ?? [];
    if (!districts.length) continue;
    const pts = (l.geometry.type === 'Polygon' ? [l.geometry.coordinates] : l.geometry.coordinates).flatMap((poly) => poly[0]);
    const step = Math.max(1, Math.floor(pts.length / 60)); // up to ~60 points per LGA is plenty
    const votes = districts.map((d) => ({ code: d.code, n: pts.filter((_, i) => i % step === 0)
      .filter(([lng, lat]) => pointInGeometry(lat, lng, d.geometry as any)).length }));
    votes.sort((a, b) => b.n - a.n);
    if (!votes[0].n) { unsure.push(`${l.code} ${l.name}`); continue; }
    links.push({ code: l.code, senatorial_code: votes[0].code });
  }
  await q(`update public.lgas l set senatorial_code = x.senatorial_code
             from jsonb_to_recordset($1::jsonb) as x(code text, senatorial_code text) where l.code = x.code`, [JSON.stringify(links)]);
  const linked = links.length;
  // IReV's own district id, from the wards of each district's LGAs
  await q(`update public.senatorial_districts d set irev_id = x.irev_id
             from (select l.senatorial_code as code, mode() within group (order by w.senatorial_district) as irev_id
                     from public.wards w join public.lgas l on l.code = w.lga_code
                    where l.senatorial_code is not null and w.senatorial_district is not null group by l.senatorial_code) x
            where x.code = d.code`);
  const [noShape] = await q(`select count(*)::int as n from public.lgas l where not exists (select 1 from public.area_shapes s where s.code = l.code)`);
  log('boundaries', `linked ${linked} LGAs to their senatorial district`
    + (noShape.n ? `; ${noShape.n} LGAs have no outline yet (load LGA outlines, then run this again)` : ''));
  if (unsure.length) log('boundaries', `${unsure.length} LGAs did not fall inside any district`, unsure);
}

