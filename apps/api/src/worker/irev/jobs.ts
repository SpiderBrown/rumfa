// IReV fetch jobs: baseline (past election), live (current election, with automatic recheck), recheck, and
// OCR. Jobs are created from the dashboard (IReV data manager) for a state, LGA or ward and run here, one
// ward at a time. Several workers can run: a job is claimed with SKIP LOCKED.

import { workerConfig as config } from '../config';
import { json, log, one, q, storage, upsert } from '../context';
import { NetworkError, deadLinks, describeFetchError, documentUrls, download, online, puCodeFromIrev, unitsOfWard, type IrevDocument, type IrevUnit } from './client';
import { DUPLICATE_MAX_DISTANCE, hamming, prepareSheet } from './image';
import { ocrIrevSheet } from '../ocr/pipeline';

export interface Job {
  id: string; tenant_id: string; election_id: string; job_type: 'baseline' | 'live' | 'ocr' | 'recheck';
  area_level: string; area_code: string; auto_recheck: boolean; interval_min: number; status: string;
  counts: Record<string, number>;
  /** file: download each sheet into our storage (as before); link: keep only INEC's link to it */
  keep?: 'file' | 'link';
}

/**
 * Claim one due job: one someone started (queued), or an automatic recheck that is due. Automatic rechecks (the
 * watcher, "keep checking") run only around election day: from the election's date to two days after (Lagos time),
 * when INEC is uploading. On other days they wait, so IReV is never polled for nothing. Jobs someone starts by hand
 * run whenever they're started.
 */
export async function claimJob(): Promise<Job | null> {
  const job = await one<Job>(
    `update public.irev_fetch_jobs j
        set status = 'running', started_at = case when j.status = 'queued' then now() else j.started_at end, next_run_at = null
      where j.id = (select x.id from public.irev_fetch_jobs x join public.elections e on e.id = x.election_id
                     where ((x.status = 'queued' and not x.auto_recheck)
                            or (x.auto_recheck and (x.status = 'queued' or (x.status = 'running' and x.next_run_at <= now()))
                                and (now() at time zone 'Africa/Lagos')::date between e.election_date and e.election_date + 2))
                     order by x.created_at limit 1 for update of x skip locked)
      returning j.*`);
  return job ?? null;
}

async function jobStillRunning(id: string): Promise<boolean> {
  return (await one(`select status from public.irev_fetch_jobs where id = $1`, [id]))?.status === 'running';
}

export async function failJob(id: string, error: string) {
  await q(`update public.irev_fetch_jobs set status = 'failed', error = $2, finished_at = now() where id = $1`, [id, error]);
}

/** Waits between tries while there is no connection: about 10 minutes in all, then the job is paused. */
export const OUTAGE_WAITS_S = [15, 30, 60, 120, 120, 120, 120];
const setError = (id: string, error: string | null) => q(`update public.irev_fetch_jobs set error = $2 where id = $1`, [id, error]);

/**
 * Runs one step, riding out a lost connection: the job shows "Waiting for internet…" and tries again; if the
 * connection stays down it is paused (never marking units failed for it) so it can be resumed from the dashboard.
 * Returns undefined when the job was paused or stopped meanwhile.
 */
async function despiteOutage<T>(job: Job, step: () => Promise<T>, waits = OUTAGE_WAITS_S): Promise<T | undefined> {
  let waited = false;
  for (let i = 0; ; i++) {
    try {
      const r = await step();
      if (waited) await setError(job.id, null);
      return r;
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      if (i >= waits.length) {
        await q(`update public.irev_fetch_jobs set status = 'paused', error = $2 where id = $1 and status = 'running'`,
          [job.id, `Paused: ${e.message}. Press Resume when the connection is back.`]);
        log('irev', `job ${job.id} paused: ${e.message}`);
        return undefined;
      }
      waited = true;
      await setError(job.id, `Waiting for internet: ${e.message}. Trying again in ${waits[i]} s`);
      log('irev', `job ${job.id}: ${e.message}; retrying in ${waits[i]} s`);
      await new Promise((r) => setTimeout(r, waits[i] * 1000));
      if (!(await jobStillRunning(job.id))) return undefined;
    }
  }
}

export async function runJob(job: Job): Promise<void> {
  const election = await one(`select id, irev_election_id from public.elections where id = $1`, [job.election_id]);
  if (!election?.irev_election_id) return failJob(job.id, 'Election has no IReV id yet');
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

  if (job.job_type === 'ocr') {
    const units = await unitsWithStatus(job, ['downloaded', 'replaced'], ['not_read']);
    for (const pu of units) {
      if (!(await jobStillRunning(job.id))) return;
      try { bump(await ocrIrevSheet(job.election_id, pu)); } catch (e) { bump('ocr_failed'); log('ocr', `${pu}: ${(e as Error).message}`); }
      if ((counts.read ?? 0) % 25 === 0) await saveCounts(job.id, counts);
    }
    return finish(job, counts);
  }

  const wards = await q<{ code: string; irev_id: string }>(
    `select code, irev_id from public.wards where code like $1 and irev_id is not null order by code`,
    [job.area_code === 'NG' ? '%' : `${job.area_code}%`]);
  if (!wards.length) {
    return failJob(job.id, 'No wards with IReV links in this area yet. Run the geography import for this state first.');
  }
  for (const w of wards) {
    if (!(await jobStillRunning(job.id))) return; // paused or cancelled from the dashboard
    let units: IrevUnit[] | undefined;
    try {
      units = await despiteOutage(job, () => unitsOfWard(election.irev_election_id, w.irev_id));
      if (!units) return;
    } catch (e) {
      bump('ward_failed');
      log('irev', `ward ${w.code} failed: ${(e as Error).message}`);
      continue;
    }
    for (const u of units) {
      const r = await despiteOutage(job, () => processUnit(job, u));
      if (r === undefined) { await saveCounts(job.id, counts); return; }
      bump(r);
    }
    await saveCounts(job.id, counts);
  }
  await finish(job, counts);
}

async function unitsWithStatus(job: Job, statuses: string[], ocr: string[]): Promise<string[]> {
  const rows = await q(
    `select pu_code from public.irev_availability
      where election_id = $1 and (status = any($2) or (storage_path is null and sheet_url is not null))
        and ocr_status = any($3) and ($4::text = 'NG' or pu_code like $4 || '%')
      order by pu_code`,
    [job.election_id, statuses, ocr, job.area_code]);
  return rows.map((r) => r.pu_code);
}

const saveCounts = (id: string, counts: Record<string, number>) =>
  q(`update public.irev_fetch_jobs set counts = $2 where id = $1`, [id, json(counts)]);

async function finish(job: Job, counts: Record<string, number>) {
  if (job.auto_recheck && job.job_type === 'live') {
    // Never sooner than 10 minutes after a pass finishes
    await q(`update public.irev_fetch_jobs set counts = $2, next_run_at = now() + make_interval(mins => greatest($3, 10)) where id = $1`,
      [job.id, json(counts), job.interval_min]);
    await q(`select public.svc_flag_missing_uploads($1, 4)`, [job.election_id]);
  } else {
    await q(`update public.irev_fetch_jobs set status = 'done', counts = $2, finished_at = now() where id = $1`, [job.id, json(counts)]);
  }
  log('irev', `job ${job.id} pass complete`, counts);
}

/** Check one unit against IReV, download a new or replaced sheet. Returns the resulting status. */
export async function processUnit(job: Job, u: IrevUnit): Promise<string> {
  const pu = puCodeFromIrev(u.pu_code);
  const now = new Date().toISOString();
  const cur = await one(`select * from public.irev_availability where election_id = $1 and pu_code = $2`, [job.election_id, pu]);
  const doc = u.document && (u.document.url || u.document.document_url) ? u.document : null;

  const record = async (patch: Record<string, unknown>, detail?: unknown) => {
    await upsert('irev_availability', { election_id: job.election_id, pu_code: pu, last_checked_at: now, ...patch }, ['election_id', 'pu_code']);
    await q(`insert into public.irev_check_log (election_id, pu_code, status, detail) values ($1, $2, $3, $4)`,
      [job.election_id, pu, String(patch.status ?? cur?.status), json(detail)]);
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
  // Link only: nothing new since we saved its link, and no download asked for
  if (!isNew && job.keep === 'link' && cur?.sheet_url) { await record({ status: cur.status }); return 'linked'; }

  const urls = documentUrls(doc);
  const seenNow = isNew ? [...seen, docId] : seen;
  const base: Record<string, unknown> = {
    irev_doc_id: docId, document_url: doc.document_url ?? null, backup_url: doc.backup_url ?? null,
    thumb_url: doc.url && doc.url.includes('_thumb') ? doc.url : null,
    irev_updated_at: doc.updated_at ?? u.updated_at ?? null,
    first_seen_at: cur?.first_seen_at ?? now,
    seen_doc_ids: seenNow,
    // older versions listed by IReV also count as replacements
    replaced_count: u.old_documents?.length && !cur ? u.old_documents.length : (cur?.replaced_count ?? 0) + (replaced ? 1 : 0),
  };

  if (job.keep === 'link' && urls.length) return keepLink(job, pu, base, urls, replaced, record);

  const errors: string[] = [];
  let offline = urls.length > 0; // stays true while every URL failed for lack of a connection
  for (const url of urls) {
    let sheet;
    try {
      const { bytes, contentType } = await download(url);
      sheet = await prepareSheet(bytes, contentType, config.irev.maxImageWidth);
    } catch (e) {
      errors.push((e as Error).message);
      if (!(e instanceof NetworkError)) offline = false;
      continue;
    }
    // Saving is its own step: a dropped connection here is waited out like any other; a refusal is reported as such
    const path = `${job.election_id}/${pu}/v${seenNow.length}.${sheet.ext}`;
    try {
      await storage().put('irev', path, sheet.bytes, sheet.contentType);
    } catch (e) {
      const err = describeFetchError(e);
      if (err instanceof NetworkError) throw new NetworkError(`Saving to storage: ${err.message}`);
      await record({ ...base, status: 'failed', attempts: (cur?.attempts ?? 0) + 1,
        last_error: `Downloaded (${(sheet.bytes.length / 1e6).toFixed(1)} MB) but saving to storage failed: ${err.message}` });
      return 'failed';
    }
    await record({
      ...base, status: replaced ? 'replaced' : 'downloaded', storage_path: path, size_bytes: sheet.bytes.length,
      checksum: sheet.sha256, phash: sheet.phash, content_type: sheet.contentType,
      // The same file again (e.g. re-downloaded after the local copy was lost): its figures are already read
      ocr_status: cur?.checksum === sheet.sha256 && cur?.ocr_status ? cur.ocr_status : 'not_read',
      attempts: (cur?.attempts ?? 0) + 1, last_error: null,
    }, { url, replaced });
    await checkDuplicate(job, pu, sheet.sha256, sheet.phash);
    if (job.job_type === 'live') {
      // Live: read figures straight away so the IReV tally and matching stay current
      try { await ocrIrevSheet(job.election_id, pu); } catch (e) { log('ocr', `${pu}: ${(e as Error).message}`); }
    }
    if (replaced) await q(`select public.svc_verify_unit($1, $2)`, [job.election_id, pu]);
    return replaced ? 'replaced' : 'downloaded';
  }
  // No connection at all: leave the unit as it was and let the job wait and retry. But if the internet is up,
  // the sheet's server itself is gone: record that and move on.
  if (offline && !(await online())) throw new NetworkError(errors.at(-1) ?? 'No connection');
  const dead = deadLinks(doc);
  const lastErr = [...new Set(errors)].join('; ')
    || (dead.length ? `IReV lists this sheet only on servers that no longer exist (${[...new Set(dead.map((u) => new URL(u).host))].join(', ')})` : '');
  await record({ ...base, status: urls.length ? 'failed' : 'on_irev', attempts: (cur?.attempts ?? 0) + 1, last_error: lastErr || 'No usable URL' });
  return urls.length ? 'failed' : 'on_irev';
}

/**
 * Link only: save INEC's link to the sheet instead of downloading it (saves storage). The sheet is shown in
 * review straight from INEC, and its figures are read by streaming it from INEC (nothing is kept). A sheet
 * downloaded earlier keeps its file. Duplicate-image checks need the file, so they only run on downloads.
 */
async function keepLink(job: Job, pu: string, base: Record<string, unknown>, urls: string[], replaced: boolean,
                        record: (patch: Record<string, unknown>, detail?: unknown) => Promise<void>): Promise<string> {
  // A new version of the sheet makes any old copy and its figures stale
  const fresh = replaced ? { storage_path: null, checksum: null, phash: null, size_bytes: null, ocr_status: 'not_read' } : {};
  await record({ ...base, ...fresh, status: replaced ? 'replaced' : 'on_irev', sheet_url: urls[0], last_error: null }, { url: urls[0], replaced, keep: 'link' });
  if (job.job_type === 'live') {
    try { await ocrIrevSheet(job.election_id, pu); } catch (e) { log('ocr', `${pu}: ${(e as Error).message}`); }
  }
  if (replaced) await q(`select public.svc_verify_unit($1, $2)`, [job.election_id, pu]);
  return replaced ? 'replaced' : 'linked';
}

/**
 * Same (or near-identical) image used for another unit of the same election. Re-uploads are usually within
 * the same LGA, so compare against that LGA, plus any exact byte match anywhere.
 */
async function checkDuplicate(job: Job, pu: string, sha: string, phash: string | null) {
  const dupes = new Set<string>();
  for (const r of await q(`select pu_code from public.irev_availability where election_id = $1 and checksum = $2 and pu_code <> $3 limit 10`,
    [job.election_id, sha, pu])) dupes.add(r.pu_code);
  if (phash) {
    const near = await q(`select pu_code, phash from public.irev_availability
                            where election_id = $1 and pu_code like $2 and pu_code <> $3 and phash is not null`,
      [job.election_id, `${pu.slice(0, 5)}%`, pu]);
    for (const r of near) if (r.phash.length === phash.length && hamming(r.phash, phash) <= DUPLICATE_MAX_DISTANCE) dupes.add(r.pu_code);
  }
  if (!dupes.size) return;
  for (const t of await q(`select tenant_id from public.tenant_elections where election_id = $1`, [job.election_id])) {
    await q(`select public.svc_raise_alert($1, $2, 'duplicate_sheet', $3, $3, $4, $5)`,
      [t.tenant_id, job.election_id, pu, json({ same_as: [...dupes] }), `dup:${pu}:${sha.slice(0, 16)}`]);
  }
}

export type { IrevDocument };
