// Chooses the statistical sample of units for the early estimate (stage 1):
// stratified by state, units drawn with probability proportional to
// registered voters, only units with an assigned agent.
// Usage: node src/scripts/build-sample.ts --tenant <uuid> --election <uuid> [--size 1500] [--seed 42]

import { db, log } from '../db.ts';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const tenant = arg('--tenant'), election = arg('--election');
const size = Number(arg('--size') ?? 1500);
let seed = Number(arg('--seed') ?? 42);
if (!tenant || !election) { console.error('Usage: --tenant <uuid> --election <uuid> [--size 1500]'); process.exit(1); }
const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };

// Units with an active agent
const agents: { area_code: string }[] = [];
for (let from = 0; ; from += 1000) {
  const { data } = await db().from('volunteers').select('area_code').eq('tenant_id', tenant).eq('role', 'agent')
    .in('status', ['invited', 'active']).range(from, from + 999);
  agents.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const covered = new Set(agents.map((a) => a.area_code));
const units: { code: string; registered_voters: number | null }[] = [];
for (let from = 0; ; from += 1000) {
  const { data } = await db().from('polling_units').select('code, registered_voters').range(from, from + 999);
  units.push(...(data ?? []).filter((u) => covered.has(u.code)));
  if (!data || data.length < 1000) break;
}
const byState = new Map<string, typeof units>();
for (const u of units) byState.set(u.code.slice(0, 2), [...(byState.get(u.code.slice(0, 2)) ?? []), u]);
const totalVoters = units.reduce((a, u) => a + (u.registered_voters ?? 500), 0);

const chosen: { tenant_id: string; election_id: string; pu_code: string; stratum: string; weight: number }[] = [];
for (const [state, list] of byState) {
  const stateVoters = list.reduce((a, u) => a + (u.registered_voters ?? 500), 0);
  const k = Math.max(10, Math.round(size * stateVoters / totalVoters));
  // weighted sampling without replacement (Efraimidis–Spirakis)
  const keyed = list.map((u) => ({ u, key: Math.pow(rand(), 1 / (u.registered_voters ?? 500)) }))
    .sort((a, b) => b.key - a.key).slice(0, Math.min(k, list.length));
  for (const { u } of keyed) chosen.push({ tenant_id: tenant, election_id: election, pu_code: u.code, stratum: state, weight: 1 });
}
await db().from('sample_units').delete().eq('tenant_id', tenant).eq('election_id', election);
for (let i = 0; i < chosen.length; i += 500) await db().from('sample_units').insert(chosen.slice(i, i + 500));
log('sample', `${chosen.length} units across ${byState.size} states`);
