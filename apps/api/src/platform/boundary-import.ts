// Area outlines for the maps from open boundary data (GeoJSON), matched to our codes by name (state, then LGA within
// its state, then ward within its LGA), simplified for fast phones, stored once for all clients. Re-running replaces
// them. Run with `npm run import:boundaries` (the files live in data/boundaries).
//
// Free sources: states and LGAs from OCHA Nigeria administrative boundaries (HDX, levels 1 and 2), senatorial districts
// from OCHA too, wards from GRID3 (GRID3 data hub).
import { union, type MultiPolygon } from 'polygon-clipping';
import { center, normName, simplify, type Geometry } from '../scripts/geo';
import { pointInGeometry } from '../shared';

// Field names used by the common sources, tried in order
const FIELDS = {
  state: ['statename', 'state_name', 'adm1_name', 'admin1Name_en', 'ADM1_EN', 'adm1_en', 'NAME_1', 'state', 'State', 'name'],
  lga: ['lganame', 'lga_name', 'adm2_name', 'admin2Name_en', 'ADM2_EN', 'adm2_en', 'NAME_2', 'lga', 'LGA', 'name'],
  ward: ['wardname', 'ward_name', 'adm3_name', 'admin3Name_en', 'ADM3_EN', 'adm3_en', 'NAME_3', 'ward', 'Ward', 'name'],
  senatorial: ['sendist_en', 'sendistrefname', 'senatorial', 'name'],
};
const TOLERANCE = { zone: 0.01, state: 0.01, senatorial: 0.005, lga: 0.003, ward: 0.0008 }; // degrees (~1 km, 300 m, 90 m)
// Names spelt differently in the outline files are matched with public.place_name_aliases (Rumfa Console → Places →
// Name matches), read each time outlines are loaded.

type Q = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;
type Say = (msg: string, extra?: unknown) => void;
export type BoundaryLevel = 'state' | 'senatorial' | 'lga' | 'ward';
export interface BoundaryOptions {
  level: BoundaryLevel;
  /** Where the data came from (the file name), kept with each outline */
  source: string;
  /** Name fields, when auto-detection picks the wrong ones: for the level being loaded, and its parents */
  name?: string; state?: string; lga?: string;
  /** Only this state's areas (a state code); the rest of the file is skipped */
  onlyState?: string;
}
export interface BoundaryResult { features: number; saved: number; unmatched: string[]; linked?: number; zones?: number }

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

/**
 * Matches a GeoJSON file's areas to ours by name and saves their outlines, using the name matches in
 * public.place_name_aliases (Rumfa Console → Places → Name matches).
 */
export async function importBoundaries(q: Q, fc: any, o: BoundaryOptions, say: Say): Promise<BoundaryResult> {
  const level = o.level;
  const features: any[] = fc?.features ?? [];
  if (!features.length) throw new Error('No areas in that file (expected a GeoJSON FeatureCollection)');
  const props = features[0].properties ?? {};
  // --name is the field for the level being loaded; --state / --lga name its parents. Otherwise auto-detect
  // (a bare "name" field only ever counts as the level being loaded).
  const pick = (kind: 'state' | 'senatorial' | 'lga' | 'ward') =>
    (kind === level ? o.name : o[kind as 'state' | 'lga']) ?? FIELDS[kind].find((f) => f in props && (kind === level || f !== 'name'));
  const field = { state: pick('state'), senatorial: level === 'senatorial' ? pick('senatorial') : undefined,
    lga: level === 'lga' || level === 'ward' ? pick('lga') : undefined, ward: level === 'ward' ? pick('ward') : undefined };
  say(`${features.length} ${level} shapes; name fields`, field);
  if (!field[level]) throw new Error(`Could not find the ${level} name field. Fields in the file: ${Object.keys(props).join(', ')}`);

  const states = await q<{ code: string; name: string; zone: string | null }>(`select code, name, zone from public.states`);
  const lgas = await q<{ code: string; state_code: string; name: string }>(`select code, state_code, name from public.lgas`);
  const wards = await q<{ code: string; lga_code: string; name: string }>(`select code, lga_code, name from public.wards`);
  // Name matches (Rumfa Console → Places → Name matches)
  const extra = await q<{ level: string; from_key: string; to_key: string }>(`select level, from_key, to_key from public.place_name_aliases`);
  const stateAliases: Record<string, string> = Object.fromEntries(extra.filter((x) => x.level === 'state').map((x) => [x.from_key, x.to_key]));
  const lgaAliases: Record<string, string> = Object.fromEntries(extra.filter((x) => x.level === 'lga').map((x) => [x.from_key, x.to_key]));
  const wardAliases = Object.fromEntries(extra.filter((x) => x.level === 'ward').map((x) => [x.from_key, x.to_key]));
  const stateKey = (n: string) => { const k = normName(n); return stateAliases[k] ?? k; };
  const stateBy = new Map(states.map((s) => [stateKey(s.name), s.code]));
  const lgaKey = (n: string) => { const k = normName(n); return lgaAliases[k] ?? k; };
  const wardKey = (n: string) => { const k = normName(n); return wardAliases[k] ?? k; };
  if (level === 'senatorial') return importSenatorial(q, features, field.state!, field.senatorial!, (n) => stateBy.get(stateKey(n)), o.source, say, o.onlyState);

  const unmatched: string[] = [];
  const toSave: ShapeRow[] = [];
  const stateShapes = new Map<string, Geometry>(); // full detail, for merging into zones
  for (const f of features) {
    const p = f.properties ?? {};
    const g = f.geometry as Geometry;
    if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const stateCode = field.state ? stateBy.get(stateKey(p[field.state])) : undefined;
    if (o.onlyState && stateCode !== o.onlyState) continue;
    let code: string | undefined;
    if (level === 'state') code = stateBy.get(stateKey(p[field.state!]));
    else if (level === 'lga') code = lgas.find((l) => (!stateCode || l.state_code === stateCode) && lgaKey(l.name) === lgaKey(p[field.lga!]))?.code;
    else {
      const lga = lgas.find((l) => (!stateCode || l.state_code === stateCode) && lgaKey(l.name) === lgaKey(p[field.lga!]));
      code = lga && wards.find((w) => w.lga_code === lga.code && wardKey(w.name) === wardKey(p[field.ward!]))?.code;
    }
    const label = [field.state && p[field.state], field.lga && p[field.lga], field.ward && p[field.ward]].filter(Boolean).join(' / ');
    if (!code) { unmatched.push(label); continue; }
    const shape = simplify(g, TOLERANCE[level]);
    const c = center(shape);
    toSave.push({ code, level, geometry: shape, center_lat: c.lat, center_lng: c.lng, source: o.source });
    if (level === 'state') stateShapes.set(code, g);
  }
  await saveShapes(q, toSave);
  say(`saved ${toSave.length} ${level} shapes`);
  // Zones merge all of a zone's states, so only when every state was loaded
  const zones = level === 'state' && !o.onlyState ? await saveZones(q, states, stateShapes, o.source, say) : undefined;
  if (unmatched.length) say(`${unmatched.length} not matched to our ${level}s (check names, or load the geography first)`, unmatched.slice(0, 50));
  return { features: features.length, saved: toSave.length, unmatched, zones };
}

/**
 * Geopolitical zones (Z-NC, Z-NE, Z-NW, Z-SE, Z-SS, Z-SW): each zone's states merged into one outline, so the
 * national map can be shown by zone without state borders inside a zone. Merged before simplifying, so shared
 * borders line up exactly and disappear.
 */
async function saveZones(q: Q, states: { code: string; zone: string | null }[], shapes: Map<string, Geometry>, source: string, say: Say) {
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
  say(`saved ${rows.length} zone outlines` + (missing.length ? `; states with no outline left out: ${missing.join(', ')}` : ''));
  return rows.length;
}

/**
 * Senatorial districts: one row and outline per district (code = state + its number there, e.g. 20-SD1), then each
 * LGA of the state is linked to the district holding most of its outline's points. LGAs without an outline yet are
 * listed; run again after loading them.
 */
async function importSenatorial(q: Q, features: any[], stateField: string, nameField: string,
  stateOf: (name: string) => string | undefined, source: string, say: Say, onlyState?: string): Promise<BoundaryResult> {
  const unmatched: string[] = [];
  const byState = new Map<string, { code: string; geometry: Geometry }[]>();
  const districts: { code: string; state_code: string; name: string }[] = [];
  const shapes: ShapeRow[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const g = f.geometry as Geometry;
    if (!g || !['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const stateCode = stateOf(p[stateField]);
    if (onlyState && stateCode !== onlyState) continue;
    const num = Number(String(p.sendistpcode ?? p.pcode ?? '').slice(-2));
    if (!stateCode || !num) { unmatched.push(`${p[stateField]} / ${p[nameField]}`); continue; }
    const code = `${stateCode}-SD${num}`;
    const shape = simplify(g, TOLERANCE.senatorial);
    const c = center(shape);
    districts.push({ code, state_code: stateCode, name: String(p[nameField]).trim() });
    shapes.push({ code, level: 'senatorial', geometry: shape, center_lat: c.lat, center_lng: c.lng, source });
    if (!byState.has(stateCode)) byState.set(stateCode, []);
    byState.get(stateCode)!.push({ code, geometry: g });
  }
  // Districts first (the outlines and LGA links refer to them), each list in one statement
  await q(`insert into public.senatorial_districts (code, state_code, name, updated_at)
           select x.code, x.state_code, x.name, now() from jsonb_to_recordset($1::jsonb) as x(code text, state_code text, name text)
           on conflict (code) do update set name = excluded.name, updated_at = now()`, [JSON.stringify(districts)]);
  await saveShapes(q, shapes);
  say(`saved ${districts.length} senatorial districts`);
  if (unmatched.length) say(`${unmatched.length} not matched to our states`, unmatched);

  // Link each LGA (that has an outline) to the district holding most of its outline's points
  const lgaShapes = await q<{ code: string; state_code: string; name: string; geometry: Geometry }>(
    `select l.code, l.state_code, l.name, s.geometry from public.lgas l join public.area_shapes s on s.code = l.code`);
  const links: { code: string; senatorial_code: string }[] = [];
  const unsure: string[] = [];
  for (const l of lgaShapes.filter((x) => !onlyState || x.state_code === onlyState)) {
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
  say(`linked ${linked} LGAs to their senatorial district`
    + (noShape.n ? `; ${noShape.n} LGAs have no outline yet (load LGA outlines, then run this again)` : ''));
  if (unsure.length) say(`${unsure.length} LGAs did not fall inside any district`, unsure);
  return { features: features.length, saved: districts.length, unmatched, linked };
}

