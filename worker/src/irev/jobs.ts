// IReV fetch jobs: baseline (past election), live (current election, with
// automatic recheck), recheck, and OCR. Jobs are created from the dashboard
// (IReV data manager) for a state, LGA or ward and run here, one ward at a time.

import { db, log, must } from '../db.ts';
import { config } from '../config.ts';
import { documentUrls, download, puCodeFromIrev, unitsOfWard, type IrevDocument, type IrevUnit } from './client.ts';
import { prepareSheet, hamming, DUPLICATE_MAX_DISTANCE } from './image.ts';
import { ocrIrevSheet } from '../ocr/pipeline.ts';

interface Job {
  id: string; tenant_id: string; election_id: string; job_type: 'baseline' | 'live' | 'ocr' | 'recheck';
  area_level: string; area_code: string; auto_recheck: boolean; interval_min: number; status: string;
  counts: Record<string, number>;
}

/** Claim one due job (queued, or a live job whose next recheck is due). */
export async function claimJob(): Promise<Job | null> {
  const now = new Date().toISOString();
  const { data } = await db().from('irev_fetch_jobs').select('*')
    .or(`status.eq.queued,and(status.eq.running,auto_recheck.eq.true,next_run_at.lte.${now})`)
    .order('created_at').limit(1);
  const job = data?.[0] as Job | undefined;
  if (!job) return null;
  // optimistic claim: only proceed if nobody else changed it
  const { data: claimed } = await db().from('irev_fetch_jobs')
    .update({ status: 'running', started_at: job.status === 'queued' ? now : undefined, next_run_at: null })
    .eq('id', job.id).eq('status', job.status).select('id');
  return claimed?.length ? job : null;
}

async function jobStillRunning(id: string): Promise<boolean> {
  const { data } = await db().from('irev_fetch_jobs').select('status').eq('id', id).single();
  return data?.status === 'running';
}

export async function runJob(job: Job): Promise<void> {
  const { data: election } = await db().from('elections').select('id, irev_election_id').eq('id', job.election_id).single();
  if (!election?.irev_election_id) {
    await db().from('irev_fetch_jobs').update({ status: 'failed', error: 'Election has no IReV id yet' }).eq('id', job.id);
    return;
  }
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

  if (job.job_type === 'ocr') {
    const units = await unitsWithStatus(job, ['downloaded', 'replaced'], ['not_read']);
    for (const pu of units) {
      if (!(await jobStillRunning(job.id))) return;
      try { bump(await ocrIrevSheet(job.election_id, pu)); } catch (e) { bump('ocr_failed'); log('ocr', `${pu}: ${(e as Error).message}`); }
      if ((counts.read ?? 0) % 25 === 0) await saveCounts(job.id, counts);
    }
    await finish(job, counts);
    return;
  }

  // Fetch: walk the wards of the area
  const wards = must(await db().from('wards').select('code, irev_id')
    .like('code', job.area_code === 'NG' ? '%' : `${job.area_code}%`).not('irev_id', 'is', null).order('code'));
  for (const w of wards as { code: string; irev_id: string }[]) {
    if (!(await jobStillRunning(job.id))) return;   // paused or cancelled from the dashboard
    let units: IrevUnit[];
    try {
      units = await unitsOfWard(election.irev_election_id, w.irev_id);
    } catch (e) {
      bump('ward_failed');
      log('irev', `ward ${w.code} failed: ${(e as Error).message}`);
      continue;
    }
    for (const u of units) {
      const status = await processUnit(job, election.irev_election_id, u);
      bump(status);
    }
    await saveCounts(job.id, counts);
  }
  await finish(job, counts);
}

async function unitsWithStatus(job: Job, statuses: string[], ocr: string[]): Promise<string[]> {
  const q = db().from('irev_availability').select('pu_code').eq('election_id', job.election_id)
    .in('status', statuses).in('ocr_status', ocr);
  const { data } = job.area_code === 'NG' ? await q : await q.like('pu_code', `${job.area_code}%`);
  return (data ?? []).map((r) => r.pu_code);
}

async function saveCounts(id: string, counts: Record<string, number>) {
  await db().from('irev_fetch_jobs').update({ counts }).eq('id', id);
}

async function finish(job: Job, counts: Record<string, number>) {
  if (job.auto_recheck && job.job_type === 'live') {
    await db().from('irev_fetch_jobs').update({
      counts, next_run_at: new Date(Date.now() + job.interval_min * 60_000).toISOString(),
    }).eq('id', job.id);
    if (job.job_type === 'live') await db().rpc('svc_flag_missing_uploads', { p_election: job.election_id, p_hours: 4 });
  } else {
    await db().from('irev_fetch_jobs').update({ status: 'done', counts, finished_at: new Date().toISOString() }).eq('id', job.id);
  }
  log('irev', `job ${job.id} pass complete`, counts);
}

/** Check one unit against IReV, download a new or replaced sheet. Returns the resulting status. */
export async function processUnit(job: Job, _irevElectionId: string, u: IrevUnit): Promise<string> {
  const pu = puCodeFromIrev(u.pu_code);
  const now = new Date().toISOString();
  const { data: cur } = await db().from('irev_availability').select('*')
    .eq('election_id', job.election_id).eq('pu_code', pu).maybeSingle();
  const doc = u.document && (u.document.url || u.document.document_url) ? u.document : null;

  const record = async (patch: Record<string, unknown>, detail?: unknown) => {
    await db().from('irev_availability').upsert({ election_id: job.election_id, pu_code: pu, last_checked_at: now, ...patch });
    await db().from('irev_check_log').insert({ election_id: job.election_id, pu_code: pu, status: String(patch.status ?? cur?.status), detail: detail ?? null });
  };

  if (!doc) {
    if (cur?.status === 'downloaded') { await record({ status: 'downloaded' }, { note: 'IReV no longer lists a sheet' }); return 'downloaded'; }
    await record({ status: 'not_on_irev' });
    return 'not_on_irev';
  }

  const docId = doc._id ?? doc.updated_at ?? 'unknown';
  const seen: string[] = cur?.seen_doc_ids ?? [];
  const isNew = !seen.includes(docId);
  const replaced = isNew && seen.length > 0;
  if (!isNew && cur?.status === 'downloaded') { await record({ status: 'downloaded' }); return 'downloaded'; }

  const urls = documentUrls(doc);
  const base = {
    irev_doc_id: docId, document_url: doc.document_url ?? null, backup_url: doc.backup_url ?? null,
    thumb_url: doc.url && doc.url.includes('_thumb') ? doc.url : null,
    irev_updated_at: doc.updated_at ?? u.updated_at ?? null,
    first_seen_at: cur?.first_seen_at ?? now,
    seen_doc_ids: isNew ? [...seen, docId] : seen,
    replaced_count: (cur?.replaced_count ?? 0) + (replaced ? 1 : 0),
    // older versions listed by IReV also count as replacements
    ...(u.old_documents?.length && !cur ? { replaced_count: u.old_documents.length } : {}),
  };

  let lastErr = '';
  for (const url of urls) {
    try {
      const { bytes, contentType } = await download(url);
      const sheet = await prepareSheet(bytes, contentType, config.irev.maxImageWidth);
      const version = (base.seen_doc_ids as string[]).length;
      const path = `${job.election_id}/${pu}/v${version}.${sheet.ext}`;
      const up = await db().storage.from('irev').upload(path, sheet.bytes, { contentType: sheet.contentType, upsert: true });
      if (up.error) throw new Error(up.error.message);
      await record({
        ...base, status: replaced ? 'replaced' : 'downloaded', storage_path: path, size_bytes: sheet.bytes.length,
        checksum: sheet.sha256, phash: sheet.phash, content_type: sheet.contentType, ocr_status: 'not_read',
        attempts: (cur?.attempts ?? 0) + 1, last_error: null,
      }, { url, replaced });
      await checkDuplicate(job, pu, sheet.sha256, sheet.phash);
      if (job.job_type === 'live') {
        // Live: read figures straight away so the IReV tally and matching stay current
        try { await ocrIrevSheet(job.election_id, pu); } catch (e) { log('ocr', `${pu}: ${(e as Error).message}`); }
      }
      if (replaced) await db().rpc('svc_verify_unit', { p_election: job.election_id, p_pu: pu });
      return replaced ? 'replaced' : 'downloaded';
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  await record({ ...base, status: urls.length ? 'failed' : 'on_irev', attempts: (cur?.attempts ?? 0) + 1, last_error: lastErr || 'No usable URL' });
  return urls.length ? 'failed' : 'on_irev';
}

/**
 * Same (or near-identical) image used for another unit of the same election.
 * Re-uploads are usually within the same LGA, so compare against that LGA,
 * plus any exact byte match anywhere.
 */
async function checkDuplicate(job: Job, pu: string, sha: string, phash: string | null) {
  const dupes = new Set<string>();
  const { data: exact } = await db().from('irev_availability').select('pu_code')
    .eq('election_id', job.election_id).eq('checksum', sha).neq('pu_code', pu).limit(10);
  for (const r of exact ?? []) dupes.add(r.pu_code);
  if (phash) {
    const { data: near } = await db().from('irev_availability').select('pu_code, phash')
      .eq('election_id', job.election_id).like('pu_code', `${pu.slice(0, 5)}%`).neq('pu_code', pu).not('phash', 'is', null);
    for (const r of near ?? []) if (r.phash.length === phash.length && hamming(r.phash, phash) <= DUPLICATE_MAX_DISTANCE) dupes.add(r.pu_code);
  }
  if (!dupes.size) return;
  const { data: tenants } = await db().from('tenant_elections').select('tenant_id').eq('election_id', job.election_id);
  for (const t of tenants ?? []) {
    await db().rpc('svc_raise_alert', {
      p_tenant: t.tenant_id, p_election: job.election_id, p_rule: 'duplicate_sheet', p_pu: pu, p_area: pu,
      p_details: { same_as: [...dupes] }, p_dedupe: `dup:${pu}:${sha.slice(0, 16)}`,
    });
  }
}

export type { IrevDocument };
