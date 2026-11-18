// Loads area outlines for the maps from a GeoJSON file (the ones Rumfa uses are in apps/api/boundaries; Rumfa Console's
// Places → Refresh outlines loads them too). Name matches for names spelt
// differently can be added in Rumfa Console (Places → Name matches).
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
import { importBoundaries, type BoundaryLevel } from '../platform/boundary-import';
import { arg, log, withDb } from './run';

void withDb(async (q) => {
  const level = arg('--level') as BoundaryLevel;
  const file = arg('--file');
  if (!['state', 'senatorial', 'lga', 'ward'].includes(level) || !file) throw new Error('Usage: --level state|senatorial|lga|ward --file <geojson>');
  await importBoundaries(q, JSON.parse(readFileSync(file, 'utf8')),
    { level, source: arg('--source') ?? file.split('/').pop()!, name: arg('--name'), state: arg('--state'), lga: arg('--lga') },
    (m, extra) => log('boundaries', m, extra));
});
