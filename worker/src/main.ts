// Rumfa worker: runs alongside Supabase.
//  - every TICK_SECONDS: case/callback timers, notifications, top-ups, agent-photo OCR
//  - every minute: voice outreach dialer
//  - every 10 minutes: trend check
//  - continuously: IReV fetch jobs (one at a time)

import { config } from './config.ts';
import { db, log } from './db.ts';
import { claimJob, runJob } from './irev/jobs.ts';
import { drainOutbox } from './notify/outbox.ts';
import { ocrPendingAgentPhotos } from './ocr/pipeline.ts';
import { runTrendCheck } from './rules/trend.ts';
import { processTopups } from './topups/send.ts';
import { dialCampaigns } from './voice/dialer.ts';

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

function every(name: string, seconds: number, fn: () => Promise<unknown>) {
  let busy = false;
  const run = async () => {
    if (busy || stopping) return;
    busy = true;
    try { await fn(); } catch (e) { log(name, `error: ${(e as Error).message}`); } finally { busy = false; }
  };
  void run();
  return setInterval(run, seconds * 1000);
}

async function irevLoop() {
  while (!stopping) {
    const job = await claimJob().catch((e) => { log('irev', (e as Error).message); return null; });
    if (!job) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    log('irev', `running ${job.job_type} job ${job.id} for ${job.area_level} ${job.area_code}`);
    try { await runJob(job); } catch (e) {
      log('irev', `job ${job.id} failed: ${(e as Error).message}`);
      await db().from('irev_fetch_jobs').update({ status: 'failed', error: (e as Error).message }).eq('id', job.id);
    }
  }
}

log('worker', 'starting');
const timers = [
  every('tick', config.tickSeconds, async () => { await db().rpc('svc_tick'); }),
  every('outbox', 5, () => drainOutbox()),
  every('topups', 15, () => processTopups()),
  every('ocr-agent', 30, () => ocrPendingAgentPhotos()),
  every('voice', 60, () => dialCampaigns()),
  every('trend', 600, () => runTrendCheck()),
];
await irevLoop();
timers.forEach(clearInterval);
log('worker', 'stopped');
