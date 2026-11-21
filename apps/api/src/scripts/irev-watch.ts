// Keeps checking IReV for an election at a gentle interval, saving INEC's link to each new or replaced sheet
// (no download). Same as Rumfa Console → IReV → Watch. The worker (npm run start:worker) does the checking, at
// IREV_RPS requests a second; one pass goes through every ward in the area, then waits --interval minutes.
// Usage: node dist/scripts/irev-watch --election <uuid> [--interval 20] [--area NG|19|19-28] | --off
import { arg, flag, log, withDb } from './run';

void withDb(async (q) => {
  const election = arg('--election');
  if (!election) throw new Error('Usage: --election <uuid> [--interval 20] [--area NG] | --off');
  const [e] = await q(`select id, name, irev_election_id, scope_state_code from public.elections where id = $1`, [election]);
  if (!e) throw new Error('Election not found');
  if (!e.irev_election_id) throw new Error('This election has no IReV id yet (set it in Rumfa Console → Elections)');
  await q(`update public.irev_fetch_jobs set status = 'cancelled', finished_at = now()
            where election_id = $1 and watcher and status in ('queued','running','paused')`, [election]);
  if (flag('--off')) { log('irev', `stopped watching ${e.name}`); return; }
  const interval = Math.max(10, Number(arg('--interval') ?? 20));
  const area = arg('--area') ?? e.scope_state_code ?? 'NG';
  if (!/^(NG|\d{2}(-\d{2}){0,2})$/.test(area)) throw new Error('--area is NG, a state (19), an LGA (19-28) or a ward (19-28-02)');
  const level = area === 'NG' ? 'national' : area.length === 2 ? 'state' : area.length === 5 ? 'lga' : 'ward';
  await q(`insert into public.irev_fetch_jobs (election_id, job_type, area_level, area_code, auto_recheck, interval_min, keep, watcher)
           values ($1, 'live', $2, $3, true, $4, 'link', true)`, [election, level, area, interval]);
  log('irev', `watching ${e.name} (${area}) every ${interval} min after each pass; links only. Keep the worker running.`);
});
