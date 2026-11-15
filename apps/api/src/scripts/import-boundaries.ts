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
//   npm run import:boundaries -- --level lga   --file nga_admin2.geojson
//   npm run import:boundaries -- --level ward  --file nga_wards.geojson
// Options: --name <property> --state <property> --lga <property> override the name fields if auto-detection
//          picks the wrong ones; --source "<text>" records where the data came from.
import { readFileSync } from 'node:fs';
import { center, normName, simplify, type Geometry } from './geo';
import { arg, log, withDb } from './run';

// Field names used by the common sources, tried in order
const FIELDS = {
  state: ['statename', 'state_name', 'adm1_name', 'admin1Name_en', 'ADM1_EN', 'adm1_en', 'NAME_1', 'state', 'State', 'name'],
  lga: ['lganame', 'lga_name', 'adm2_name', 'admin2Name_en', 'ADM2_EN', 'adm2_en', 'NAME_2', 'lga', 'LGA', 'name'],
  ward: ['wardname', 'ward_name', 'adm3_name', 'admin3Name_en', 'ADM3_EN', 'adm3_en', 'NAME_3', 'ward', 'Ward', 'name'],
};
const TOLERANCE = { state: 0.01, lga: 0.003, ward: 0.0008 }; // degrees (~1 km, 300 m, 90 m)
// Names that differ between INEC and the boundary sources
const STATE_ALIASES: Record<string, string> = { fct: 'federalcapitalterritory', abuja: 'federalcapitalterritory', nassarawa: 'nasarawa' };

void withDb(async (q) => {
  const level = arg('--level') as 'state' | 'lga' | 'ward';
  const file = arg('--file');
  if (!['state', 'lga', 'ward'].includes(level) || !file) throw new Error('Usage: --level state|lga|ward --file <geojson>');
  const fc = JSON.parse(readFileSync(file, 'utf8'));
  const features: any[] = fc.features ?? [];
  if (!features.length) throw new Error('No features in that file (expected a GeoJSON FeatureCollection)');
  const props = features[0].properties ?? {};
  // --name is the field for the level being loaded; --state / --lga name its parents. Otherwise auto-detect
  // (a bare "name" field only ever counts as the level being loaded).
  const pick = (kind: 'state' | 'lga' | 'ward') =>
    (kind === level ? arg('--name') : arg(`--${kind}`)) ?? FIELDS[kind].find((f) => f in props && (kind === level || f !== 'name'));
  const field = { state: pick('state'), lga: level !== 'state' ? pick('lga') : undefined, ward: level === 'ward' ? pick('ward') : undefined };
  log('boundaries', `${features.length} ${level} shapes; name fields`, field);
  if (!field[level]) throw new Error(`Could not find the ${level} name field; pass --name <property>. Fields: ${Object.keys(props).join(', ')}`);

  const states = await q<{ code: string; name: string }>(`select code, name from public.states`);
  const lgas = await q<{ code: string; state_code: string; name: string }>(`select code, state_code, name from public.lgas`);
  const wards = await q<{ code: string; lga_code: string; name: string }>(`select code, lga_code, name from public.wards`);
  const stateKey = (n: string) => { const k = normName(n); return STATE_ALIASES[k] ?? k; };
  const stateBy = new Map(states.map((s) => [stateKey(s.name), s.code]));

  const unmatched: string[] = [];
  let saved = 0;
  for (const f of features) {
    const p = f.properties ?? {};
    const g = f.geometry as Geometry;
    if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const stateCode = field.state ? stateBy.get(stateKey(p[field.state])) : undefined;
    let code: string | undefined;
    if (level === 'state') code = stateBy.get(stateKey(p[field.state!]));
    else if (level === 'lga') code = lgas.find((l) => (!stateCode || l.state_code === stateCode) && normName(l.name) === normName(p[field.lga!]))?.code;
    else {
      const lga = lgas.find((l) => (!stateCode || l.state_code === stateCode) && normName(l.name) === normName(p[field.lga!]));
      code = lga && wards.find((w) => w.lga_code === lga.code && normName(w.name) === normName(p[field.ward!]))?.code;
    }
    const label = [field.state && p[field.state], field.lga && p[field.lga], field.ward && p[field.ward]].filter(Boolean).join(' / ');
    if (!code) { unmatched.push(label); continue; }
    const shape = simplify(g, TOLERANCE[level]);
    const c = center(shape);
    await q(`insert into public.area_shapes (code, level, geometry, center_lat, center_lng, source, updated_at)
             values ($1, $2, $3, $4, $5, $6, now())
             on conflict (code) do update set level = excluded.level, geometry = excluded.geometry, center_lat = excluded.center_lat,
               center_lng = excluded.center_lng, source = excluded.source, updated_at = now()`,
      [code, level, JSON.stringify(shape), c.lat, c.lng, arg('--source') ?? file.split('/').pop()]);
    saved++;
  }
  log('boundaries', `saved ${saved} ${level} shapes`);
  if (unmatched.length) log('boundaries', `${unmatched.length} not matched to our ${level}s (check names or load the geography first)`, unmatched.slice(0, 50));
});
