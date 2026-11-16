// Client for INEC's IReV public API (unofficial; read-only). Rate-limited.
// Endpoints used (per election):
//   GET {base}/elections/{electionId}/lga/state/{irevStateNo}  -> LGAs of a state, each with its wards
//   GET {base}/elections/{electionId}/pus?ward={wardMongoId}    -> polling units of a ward with documents

import { workerConfig as config } from '../config';

export interface IrevDocument {
  _id?: string;
  url?: string;              // thumb on inc-s3-cache, or PDF on docs.inecelectionresults.net (dead)
  document_url?: string;     // DigitalOcean Spaces copy
  backup_url?: string;
  size?: number;
  updated_at?: string;
}

export interface IrevUnit {
  _id: string;
  pu_code: string;          // "19/28/02/003"
  name: string;
  document?: IrevDocument | null;
  old_documents?: IrevDocument[];
  updated_at?: string;
}

export interface IrevWard { _id: string; name: string; code: string; senatorial_district_id?: number; federal_constituency_id?: number; state_constituency_id?: number }
export interface IrevLga { lga: { _id: string; name: string; code: string }; wards: IrevWard[] }

/**
 * No connection at all (DNS, refused, reset, timed out), as opposed to a server answering with an error.
 * Jobs wait and retry on these instead of marking units failed: on a weak link everything fails at once.
 */
export class NetworkError extends Error {}

/** fetch() says only "fetch failed"; the cause says why (e.g. ENOTFOUND host). */
export function describeFetchError(e: unknown, host?: string): Error {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new NetworkError(`Timed out${host ? ` reaching ${host}` : ''}`);
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    const why = err.cause?.code ?? err.cause?.message ?? 'no connection';
    return new NetworkError(`No connection${host ? ` to ${host}` : ''} (${why})`);
  }
  return err instanceof Error ? err : new Error(String(e));
}

// Separate limits for the API and for image downloads (images come from CDNs).
const lastCall: Record<string, number> = {};
async function throttle(key: 'api' | 'download' = 'api'): Promise<void> {
  const rps = key === 'api' ? config.irev.requestsPerSecond : config.irev.downloadsPerSecond;
  const gap = 1000 / rps;
  const next = (lastCall[key] ?? 0) + gap;
  lastCall[key] = Math.max(Date.now(), next);
  const wait = next - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function irevGet<T>(path: string, attempts = 4): Promise<T> {
  let err: unknown;
  for (let i = 0; i < attempts; i++) {
    await throttle();
    try {
      const res = await fetch(`${config.irev.baseUrl}${path}`, {
        headers: { 'User-Agent': config.irev.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      }).catch((e) => { throw describeFetchError(e, new URL(config.irev.baseUrl).host); });
      if (res.status === 429 || res.status >= 500) throw new Error(`IReV ${res.status}`);
      if (!res.ok) throw new Error(`IReV ${res.status} for ${path}`);
      return (await res.json()) as T;
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw err;
}

export async function lgasOfState(irevElectionId: string, irevStateNo: number): Promise<IrevLga[]> {
  const r = await irevGet<{ data: IrevLga[] }>(`/elections/${irevElectionId}/lga/state/${irevStateNo}`);
  return r.data ?? [];
}

export async function unitsOfWard(irevElectionId: string, wardId: string): Promise<IrevUnit[]> {
  const r = await irevGet<{ data: IrevUnit[] }>(`/elections/${irevElectionId}/pus?ward=${encodeURIComponent(wardId)}`);
  return r.data ?? [];
}

/** "19/28/02/003" -> "19-28-02-003" */
export function puCodeFromIrev(code: string): string {
  return code.trim().replace(/\//g, '-');
}

/**
 * Download URLs for a sheet, in order of preference. Thumbnails are good enough
 * for OCR (~150 KB); full images are the thumb URL without "_thumb". PDFs on the old
 * docs.inecelectionresults.net domain are dead; use the Spaces copies.
 */
/** Hosts IReV still lists but that no longer exist (checked Nov 2026: no DNS record). Skipped, never retried. */
export const DEAD_HOSTS = ['docs.inecelectionresults.net', 'irevx.ams3.cdn.digitaloceanspaces.com', 'inc-s3-cache.incportals.com'];

/** Sheet links IReV lists that point only at dead servers (or nowhere): nothing can be downloaded. */
export function deadLinks(doc: IrevDocument): string[] {
  return [doc.url, doc.document_url, doc.backup_url].filter((u): u is string => !!u && DEAD_HOSTS.some((h) => u.includes(h)));
}

/**
 * Is the internet reachable at all? Asked when every link of a sheet failed to connect: if IReV's own API host
 * resolves, the sheet's server is gone (not our connection), so the job should not wait for it.
 */
export async function online(): Promise<boolean> {
  const { lookup } = await import('node:dns/promises');
  try { await lookup(new URL(config.irev.baseUrl).hostname); return true; } catch { return false; }
}

export function documentUrls(doc: IrevDocument): string[] {
  const out: string[] = [];
  const isDeadPdf = (u?: string) => !!u && DEAD_HOSTS.some((h) => u.includes(h));
  if (doc.url && !isDeadPdf(doc.url) && new URL(doc.url).pathname.length > 1) {
    // Thumbnail first: small and readable enough for OCR; full size as fallback
    if (doc.url.includes('_thumb')) out.push(doc.url, doc.url.replace('_thumb', ''));
    else out.push(doc.url);
  }
  if (doc.document_url && !isDeadPdf(doc.document_url)) out.push(doc.document_url);
  if (doc.backup_url && !isDeadPdf(doc.backup_url)) out.push(doc.backup_url);
  return [...new Set(out)];
}

/**
 * Downloads a sheet. Connection problems and server errors are retried a few times (sheets are PDFs of up to
 * ~15 MB, so a slow link needs time); a NetworkError means none of the tries reached the server.
 */
export async function download(url: string, attempts = 3): Promise<{ bytes: Buffer; contentType: string }> {
  const host = new URL(url).host;
  let last: Error = new Error('Download failed');
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    await throttle('download');
    try {
      const res = await fetch(url, { headers: { 'User-Agent': config.irev.userAgent }, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (res.status >= 500 || res.status === 429) { last = new Error(`Download ${res.status} from ${host}`); continue; }
      return await readSheet(res, host);
    } catch (e) {
      last = describeFetchError(e, host);
      if (!(last instanceof NetworkError)) throw last;
      // Host not found: retrying here only wastes time (a real outage is waited out by the job instead)
      if (/ENOTFOUND|EAI_AGAIN/.test(last.message)) break;
    }
  }
  throw last;
}

async function readSheet(res: Response, host: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!res.ok) throw new Error(`Download ${res.status} from ${host}`);
  const finalUrl = res.url;
  if (/ww\d+\./.test(new URL(finalUrl).hostname)) throw new Error('Redirected to a parked domain');
  const bytes = Buffer.from(await res.arrayBuffer().catch((e) => { throw describeFetchError(e, host); }));
  if (bytes.length < 1000) throw new Error('File too small to be a result sheet');
  return { bytes, contentType: res.headers.get('content-type') ?? '' };
}
