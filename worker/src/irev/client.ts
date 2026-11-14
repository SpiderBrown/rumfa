// Client for INEC's IReV public API (unofficial; read-only). Rate-limited.
// Endpoints used (per election):
//   GET {base}/elections/{electionId}/lga/state/{irevStateNo}  -> LGAs of a state, each with its wards
//   GET {base}/elections/{electionId}/pus?ward={wardMongoId}    -> polling units of a ward with documents

import { config } from '../config.ts';

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
      });
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
export function documentUrls(doc: IrevDocument): string[] {
  const out: string[] = [];
  const isDeadPdf = (u?: string) => !!u && u.includes('docs.inecelectionresults.net');
  if (doc.url && !isDeadPdf(doc.url)) {
    // Thumbnail first: small and readable enough for OCR; full size as fallback
    if (doc.url.includes('_thumb')) out.push(doc.url, doc.url.replace('_thumb', ''));
    else out.push(doc.url);
  }
  if (doc.document_url) out.push(doc.document_url);
  if (doc.backup_url) out.push(doc.backup_url);
  return [...new Set(out)];
}

export async function download(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  await throttle('download');
  const res = await fetch(url, { headers: { 'User-Agent': config.irev.userAgent }, redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download ${res.status}`);
  const finalUrl = res.url;
  if (/ww\d+\./.test(new URL(finalUrl).hostname)) throw new Error('Redirected to a parked domain');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error('File too small to be a result sheet');
  return { bytes, contentType: res.headers.get('content-type') ?? '' };
}
