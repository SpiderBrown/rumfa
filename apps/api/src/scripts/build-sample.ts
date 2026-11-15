// Chooses the statistical sample of units for the early estimate (stage 1): stratified by state, units drawn
// with probability proportional to registered voters, only units with an assigned agent.
// Usage: node dist/scripts/build-sample --tenant <uuid> --election <uuid> [--size 1500] [--seed 42]
import { arg, log, withDb } from './run';

void withDb(async (q) => {
  const tenant = arg('--tenant'), election = arg('--election');
  if (!tenant || !election) throw new Error('Usage: --tenant <uuid> --election <uuid> [--size 1500]');
  const size = Number(arg('--size') ?? 1500);
  let seed = Number(arg('--seed') ?? 42);
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const units = await q<{ code: string; registered_voters: number | null }>(
    `select distinct p.code, p.registered_voters from public.polling_units p
       join public.volunteers v on v.area_code = p.code and v.tenant_id = $1 and v.role = 'agent' and v.status in ('invited','active')`, [tenant]);
  const byState = new Map<string, typeof units>();
  for (const u of units) byState.set(u.code.slice(0, 2), [...(byState.get(u.code.slice(0, 2)) ?? []), u]);
  const totalVoters = units.reduce((a, u) => a + (u.registered_voters ?? 500), 0);
  const chosen: { pu: string; stratum: string }[] = [];
  for (const [state, list] of byState) {
    const stateVoters = list.reduce((a, u) => a + (u.registered_voters ?? 500), 0);
    const k = Math.max(10, Math.round((size * stateVoters) / totalVoters));
    // weighted sampling without replacement (Efraimidis–Spirakis)
    const keyed = list.map((u) => ({ u, key: Math.pow(rand(), 1 / (u.registered_voters ?? 500)) }))
      .sort((a, b) => b.key - a.key).slice(0, Math.min(k, list.length));
    for (const { u } of keyed) chosen.push({ pu: u.code, stratum: state });
  }
  await q(`delete from public.sample_units where tenant_id = $1 and election_id = $2`, [tenant, election]);
  for (const c of chosen) {
    await q(`insert into public.sample_units (tenant_id, election_id, pu_code, stratum, weight) values ($1, $2, $3, $4, 1)`, [tenant, election, c.pu, c.stratum]);
  }
  log('sample', `${chosen.length} units across ${byState.size} states`);
});
