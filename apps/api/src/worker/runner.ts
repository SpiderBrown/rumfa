import { hostname } from 'node:os';
import { DataSource } from 'typeorm';
import { workerConfig } from './config';
import { log, q } from './context';
import { claimJob, failJob, runJob } from './irev/jobs';
import { drainOutbox } from './notify/outbox';
import { ocrPendingAgentPhotos } from './ocr/pipeline';
import { runTrendCheck } from './rules/trend';
import { processTopups } from './topups/send';
import { dialCampaigns } from './voice/dialer';
import { dialAnnouncements } from './voice/announcements';

/**
 * Background loops. Several worker containers may run: each timer takes a Postgres advisory lock for its
 * run, so a timer never runs twice at once; IReV jobs are claimed one at a time with SKIP LOCKED.
 */
export function startWorker(ds: DataSource): { stop: () => Promise<void> } {
  let stopping = false;

  const locked = async (name: string, fn: () => Promise<unknown>) => {
    const qr = ds.createQueryRunner();
    await qr.connect();
    try {
      const [{ ok }] = await qr.query(`select pg_try_advisory_lock(hashtext('rumfa:' || $1)) as ok`, [name]);
      if (!ok) return;
      try { await fn(); } finally { await qr.query(`select pg_advisory_unlock(hashtext('rumfa:' || $1))`, [name]); }
    } finally {
      await qr.release();
    }
  };

  // One task at a time: the worker never holds more than two connections for its timers (Supabase's pooler allows
  // only a few in session mode, shared with the API), and a slow task doesn't pile others up behind it.
  let chain: Promise<unknown> = Promise.resolve();
  // When the database can't be reached (no internet, DNS, the pooler full), wait instead of failing every few seconds
  let downUntil = 0, backoff = 15_000;
  const unreachable = (e: unknown) => /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EMAXCONN|max clients|Connection terminated|timeout exceeded/i.test((e as Error)?.message ?? '');
  const noteOutage = (e: unknown) => {
    if (!unreachable(e)) return false;
    if (Date.now() >= downUntil) log('worker', `database unreachable (${(e as Error).message}); trying again in ${Math.round(backoff / 1000)}s`);
    downUntil = Date.now() + backoff;
    backoff = Math.min(backoff * 2, 5 * 60_000);
    return true;
  };
  // Heartbeats for Rumfa Console: per task, at most once a minute (and at once on an error)
  const host = `${hostname()}:${process.pid}`;
  const beats = new Map<string, { at: number; runs: number }>();
  const beat = async (task: string, seconds: number, error?: string) => {
    const b = beats.get(task) ?? { at: 0, runs: 0 };
    b.runs++; beats.set(task, b);
    if (!error && Date.now() - b.at < 60_000) return;
    const runs = b.runs; b.at = Date.now(); b.runs = 0;
    await q(`insert into public.worker_heartbeats (task, every_s, last_run_at, last_ok_at, last_error, last_error_at, runs, worker)
             values ($1, $2, now(), case when $3::text is null then now() end, $3, case when $3::text is not null then now() end, $4, $5)
             on conflict (task) do update set every_s = excluded.every_s, last_run_at = now(), runs = worker_heartbeats.runs + excluded.runs, worker = excluded.worker,
               last_ok_at = coalesce(excluded.last_ok_at, worker_heartbeats.last_ok_at),
               last_error = coalesce(excluded.last_error, worker_heartbeats.last_error),
               last_error_at = coalesce(excluded.last_error_at, worker_heartbeats.last_error_at)`,
      [task, seconds, error ?? null, runs, host]).catch(() => undefined);
  };
  const every = (name: string, seconds: number, fn: () => Promise<unknown>) => {
    let busy = false;
    const run = () => {
      if (busy || stopping || Date.now() < downUntil) return;
      busy = true;
      chain = chain.then(async () => {
        try { await locked(name, fn); backoff = 15_000; await beat(name, seconds); }
        catch (e) { if (!noteOutage(e)) { log(name, `error: ${(e as Error).message}`); await beat(name, seconds, (e as Error).message.slice(0, 500)); } }
        finally { busy = false; }
      });
    };
    run();
    return setInterval(run, seconds * 1000);
  };

  const timers = [
    every('tick', workerConfig.tickSeconds, () => q(`select public.svc_tick()`)),   // case and callback deadlines
    every('outbox', 5, () => drainOutbox()),
    every('topups', 15, () => processTopups()),
    every('ocr-agent', 30, () => ocrPendingAgentPhotos()),
    every('voice', 60, () => dialCampaigns()),
    every('voice messages', 30, () => dialAnnouncements()),
    every('trend', 600, () => runTrendCheck()),
    every('figures', 300, () => q(`select public.svc_flag_missing_accreditation('11:00')`)), // checked in, no accreditation figure
    every('tasks', 300, () => q(`select public.svc_flag_not_checked_in('08:30')`)),   // agents not checked in once voting starts
    every('stale-contacts', 3600, () => q(`select app.mark_stale_contacts(7)`)),
  ];

  const requeue = new Set<string>();
  const irev = (async () => {
    while (!stopping) {
      if (Date.now() < downUntil) { await new Promise((r) => setTimeout(r, downUntil - Date.now())); continue; }
      // Jobs cut off by an outage go back in the queue (sheets already saved are skipped when they run again)
      if (requeue.size) {
        const ok = await q(`update public.irev_fetch_jobs set status = 'queued' where id = any($1) and status = 'running'`, [[...requeue]]).then(() => true, (e) => !noteOutage(e));
        if (ok) requeue.clear(); else continue;
      }
      const job = await claimJob().catch((e) => { if (!noteOutage(e)) log('irev', (e as Error).message); return null; });
      await beat('irev', 15);
      // Nothing to do: look again in 15 s (jobs started from the dashboard or Console wait at most that long)
      if (!job) { await new Promise((r) => setTimeout(r, 15_000)); continue; }
      log('irev', `running ${job.job_type} job ${job.id} for ${job.area_level} ${job.area_code}`);
      try { await runJob(job); } catch (e) {
        // A lost database connection isn't the job's fault: leave it running, it is picked up again after the outage
        if (noteOutage(e)) { requeue.add(job.id); continue; }
        log('irev', `job ${job.id} failed: ${(e as Error).message}`);
        await beat('irev', 15, `job ${job.id}: ${(e as Error).message}`.slice(0, 500));
        await failJob(job.id, (e as Error).message).catch(() => undefined);
      }
    }
  })();

  return {
    stop: async () => {
      stopping = true;
      timers.forEach(clearInterval);
      await irev;
    },
  };
}
