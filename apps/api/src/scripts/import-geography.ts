// Loads LGAs, wards and polling units from IReV into the reference tables (also in Rumfa Console: Places → Load from IReV).
// Usage: node dist/scripts/import-geography [--states 18,19] [--election <irevElectionId>] [--no-units]
// Default: the 19 northern states and the FCT, using the 2023 presidential election.
import { importGeography } from '../platform/geography-import';
import { arg, flag, log, withDb } from './run';

void withDb(async (q) => {
  await importGeography(q, { states: arg('--states')?.split(','), irevElectionId: arg('--election'), noUnits: flag('--no-units') }, (m) => log('geo', m));
});
