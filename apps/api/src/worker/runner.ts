import { DataSource } from 'typeorm';
import { workerConfig } from './config';
import { log, q } from './context';
import { claimJob, failJob, runJob } from './irev/jobs';
import { drainOutbox } from './notify/outbox';
import { ocrPendingAgentPhotos } from './ocr/pipeline';
import { runTrendCheck } from './rules/trend';
import { processTopups } from './topups/send';
import { dialCampaigns } from './voice/dialer';

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

  const every = (name: string, seconds: number, fn: () => Promise<unknown>) => {
    let busy = false;
    const run = async () => {
      if (busy || stopping) return;
      busy = true;
      try { await locked(name, fn); } catch (e) { log(name, `error: ${(e as Error).message}`); } finally { busy = false; }
    };
    void run();
    return setInterval(run, seconds * 1000);
  };

  const timers = [
    every('tick', workerConfig.tickSeconds, () => q(`select public.svc_tick()`)),   // case and callback deadlines
    every('outbox', 5, () => drainOutbox()),
    every('topups', 15, () => processTopups()),
    every('ocr-agent', 30, () => ocrPendingAgentPhotos()),
    every('voice', 60, () => dialCampaigns()),
    every('trend', 600, () => runTrendCheck()),
    every('figures', 300, () => q(`select public.svc_flag_missing_accreditation('11:00')`)), // checked in, no accreditation figure
    every('stale-contacts', 3600, () => q(`select app.mark_stale_contacts(7)`)),
  ];

  const irev = (async () => {
    while (!stopping) {
      const job = await claimJob().catch((e) => { log('irev', (e as Error).message); return null; });
      if (!job) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      log('irev', `running ${job.job_type} job ${job.id} for ${job.area_level} ${job.area_code}`);
      try { await runJob(job); } catch (e) {
        log('irev', `job ${job.id} failed: ${(e as Error).message}`);
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
