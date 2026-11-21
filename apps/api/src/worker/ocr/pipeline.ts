// OCR of IReV sheets and of agents' EC8A photos.

import { checkResult, figureFlags } from '../../shared';
import { workerConfig as config } from '../config';
import { json, log, one, q, storage } from '../context';
import { parseEc8a } from './ec8a-parser';
import { ocrProvider } from './providers';
import { download } from '../irev/client';
import { prepareSheet } from '../irev/image';

/** A sheet we only have INEC's link to: fetched for reading, never stored. */
async function sheetFromLink(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const { bytes, contentType } = await download(url);
  const sheet = await prepareSheet(bytes, contentType, config.irev.maxImageWidth);
  return { bytes: sheet.bytes, contentType: sheet.contentType };
}

async function partiesOf(electionId: string): Promise<string[]> {
  return (await q(`select party from public.election_parties where election_id = $1 order by ballot_order`, [electionId])).map((r) => r.party);
}

/** Read one IReV sheet. Returns 'read' or 'needs_review'. */
export async function ocrIrevSheet(electionId: string, pu: string): Promise<string> {
  const av = await one(`select storage_path, sheet_url, seen_doc_ids from public.irev_availability where election_id = $1 and pu_code = $2`, [electionId, pu]);
  if (!av?.storage_path && !av?.sheet_url) throw new Error('No stored sheet or link');
  const version = Math.max(1, (av.seen_doc_ids ?? []).length);
  // Our copy if we kept one; otherwise stream it from INEC's link (read, then dropped)
  const { bytes, contentType } = av.storage_path ? await storage().get('irev', av.storage_path) : await sheetFromLink(av.sheet_url);
  const provider = ocrProvider();
  const parsed = parseEc8a(await provider.read(bytes, contentType), await partiesOf(electionId));
  // The sheet's own arithmetic, including its ballot papers when they were read (items 3, 4, 5 and 8)
  const b = parsed.ballots;
  const ballotFlags = figureFlags({ ...b, rejected: parsed.figures.rejected, total_valid: parsed.figures.totalValid })
    .filter((x) => x.flag === 'ballots_unbalanced' || x.flag === 'used_mismatch')
    .map((x) => ({ code: x.flag, message: x.message }));
  const issues = [...checkResult(parsed.figures), ...ballotFlags];
  const ok = provider.name !== 'manual' && parsed.missing.length === 0 && issues.length === 0
    && parsed.minConfidence >= config.ocr.minConfidence && (!parsed.sheetPuCode || parsed.sheetPuCode === pu);
  const status = ok ? 'read' : 'needs_review';
  const f = parsed.figures;
  await q(
    `insert into public.irev_sheet_results (election_id, pu_code, sheet_version, registered, accredited, rejected, total_valid, votes,
                                            confidence, min_confidence, sheet_pu_code, ocr_status, check_issues,
                                            ballots_received, unused, spoiled, used)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (election_id, pu_code, sheet_version) do update set registered = excluded.registered, accredited = excluded.accredited,
       rejected = excluded.rejected, total_valid = excluded.total_valid, votes = excluded.votes, confidence = excluded.confidence,
       min_confidence = excluded.min_confidence, sheet_pu_code = excluded.sheet_pu_code, ocr_status = excluded.ocr_status,
       check_issues = excluded.check_issues, ballots_received = excluded.ballots_received, unused = excluded.unused,
       spoiled = excluded.spoiled, used = excluded.used`,
    [electionId, pu, version, f.registered, f.accredited, f.rejected, f.totalValid, json(f.votes), json(parsed.confidence),
     parsed.minConfidence, parsed.sheetPuCode, status, json(issues),
     parsed.ballots.ballots_received ?? null, parsed.ballots.unused ?? null, parsed.ballots.spoiled ?? null, parsed.ballots.used ?? null]);
  await q(
    `insert into public.ocr_extractions (election_id, pu_code, source, sheet_version, sheet_pu_code, serial_no, figures, confidence, min_confidence, provider)
     values ($1, $2, 'irev', $3, $4, $5, $6, $7, $8, $9)`,
    [electionId, pu, version, parsed.sheetPuCode, parsed.serialNo, json(f), json(parsed.confidence), parsed.minConfidence, provider.name]);
  await q(`update public.irev_availability set ocr_status = $3 where election_id = $1 and pu_code = $2`, [electionId, pu, status]);
  if (status === 'read') await q(`select public.svc_verify_unit($1, $2)`, [electionId, pu]);
  return status;
}

/** OCR agents' EC8A photos not read yet (the second source of the three-source check). */
export async function ocrPendingAgentPhotos(limit = 20): Promise<number> {
  if (config.ocr.provider === 'manual') return 0;
  const subs = await q(
    `select s.id, s.tenant_id, s.election_id, s.pu_code, s.sheet_photo_path from public.result_submissions s
      where s.sheet_photo_path is not null and not exists (select 1 from public.ocr_extractions o where o.submission_id = s.id)
      order by s.submitted_at desc limit $1`, [limit]);
  let n = 0;
  for (const s of subs) {
    try {
      const { bytes, contentType } = await storage().get('ec8a', s.sheet_photo_path);
      const parsed = parseEc8a(await ocrProvider().read(bytes, contentType), await partiesOf(s.election_id));
      await q(
        `insert into public.ocr_extractions (tenant_id, election_id, pu_code, source, submission_id, sheet_pu_code, serial_no, figures, confidence, min_confidence, provider)
         values ($1, $2, $3, 'agent_photo', $4, $5, $6, $7, $8, $9, $10)`,
        [s.tenant_id, s.election_id, s.pu_code, s.id, parsed.sheetPuCode, parsed.serialNo, json(parsed.figures), json(parsed.confidence),
         parsed.minConfidence, ocrProvider().name]);
      if (parsed.sheetPuCode && parsed.sheetPuCode !== s.pu_code) {
        await q(`select public.svc_raise_alert($1, $2, 'wrong_unit_sheet', $3, $3, $4, $5)`,
          [s.tenant_id, s.election_id, s.pu_code, json({ source: 'agent_photo', sheet_pu_code: parsed.sheetPuCode }), `wrong_unit_agent:${s.id}`]);
      }
      await q(`select public.svc_verify_unit($1, $2)`, [s.election_id, s.pu_code]);
      n++;
    } catch (e) {
      log('ocr', `agent photo ${s.id}: ${(e as Error).message}`);
    }
  }
  return n;
}
