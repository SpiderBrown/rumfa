// OCR of IReV sheets and of agents' EC8A photos.

import { checkResult } from '../../../shared/src/index.ts';
import { config } from '../config.ts';
import { db, log } from '../db.ts';
import { parseEc8a } from './ec8a-parser.ts';
import { ocrProvider } from './providers.ts';

async function partiesOf(electionId: string): Promise<string[]> {
  const { data } = await db().from('election_parties').select('party').eq('election_id', electionId).order('ballot_order');
  return (data ?? []).map((r) => r.party);
}

async function fetchStorage(bucket: string, path: string): Promise<{ bytes: Buffer; contentType: string }> {
  const { data, error } = await db().storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
  return { bytes: Buffer.from(await data.arrayBuffer()), contentType: data.type };
}

/** Read one IReV sheet. Returns 'read' or 'needs_review'. */
export async function ocrIrevSheet(electionId: string, pu: string): Promise<string> {
  const { data: av } = await db().from('irev_availability').select('storage_path, seen_doc_ids')
    .eq('election_id', electionId).eq('pu_code', pu).single();
  if (!av?.storage_path) throw new Error('No stored sheet');
  const version = Math.max(1, (av.seen_doc_ids ?? []).length);
  const { bytes, contentType } = await fetchStorage('irev', av.storage_path);
  const provider = ocrProvider();
  const lines = await provider.read(bytes, contentType);
  const parsed = parseEc8a(lines, await partiesOf(electionId));
  const issues = checkResult(parsed.figures);
  const ok = provider.name !== 'manual' && parsed.missing.length === 0 && issues.length === 0
    && parsed.minConfidence >= config.ocr.minConfidence
    && (!parsed.sheetPuCode || parsed.sheetPuCode === pu);
  const status = ok ? 'read' : 'needs_review';

  await db().from('irev_sheet_results').upsert({
    election_id: electionId, pu_code: pu, sheet_version: version,
    registered: parsed.figures.registered, accredited: parsed.figures.accredited, rejected: parsed.figures.rejected,
    total_valid: parsed.figures.totalValid, votes: parsed.figures.votes, confidence: parsed.confidence,
    min_confidence: parsed.minConfidence, sheet_pu_code: parsed.sheetPuCode, ocr_status: status,
    check_issues: issues,
  });
  await db().from('ocr_extractions').insert({
    election_id: electionId, pu_code: pu, source: 'irev', sheet_version: version, sheet_pu_code: parsed.sheetPuCode,
    serial_no: parsed.serialNo, figures: parsed.figures, confidence: parsed.confidence, min_confidence: parsed.minConfidence,
    provider: provider.name,
  });
  await db().from('irev_availability').update({ ocr_status: status }).eq('election_id', electionId).eq('pu_code', pu);
  if (status === 'read') await db().rpc('svc_verify_unit', { p_election: electionId, p_pu: pu });
  return status;
}

/** OCR agents' EC8A photos that have not been read yet (second source of the three-source check). */
export async function ocrPendingAgentPhotos(limit = 20): Promise<number> {
  if (config.ocr.provider === 'manual') return 0;
  const { data: subs } = await db().from('result_submissions')
    .select('id, tenant_id, election_id, pu_code, sheet_photo_path')
    .not('sheet_photo_path', 'is', null).order('submitted_at', { ascending: false }).limit(200);
  let n = 0;
  for (const s of subs ?? []) {
    if (n >= limit) break;
    const { count } = await db().from('ocr_extractions').select('id', { count: 'exact', head: true }).eq('submission_id', s.id);
    if (count) continue;
    try {
      const { bytes, contentType } = await fetchStorage('ec8a', s.sheet_photo_path!);
      const lines = await ocrProvider().read(bytes, contentType);
      const parsed = parseEc8a(lines, await partiesOf(s.election_id));
      await db().from('ocr_extractions').insert({
        tenant_id: s.tenant_id, election_id: s.election_id, pu_code: s.pu_code, source: 'agent_photo', submission_id: s.id,
        sheet_pu_code: parsed.sheetPuCode, serial_no: parsed.serialNo, figures: parsed.figures,
        confidence: parsed.confidence, min_confidence: parsed.minConfidence, provider: ocrProvider().name,
      });
      if (parsed.sheetPuCode && parsed.sheetPuCode !== s.pu_code) {
        await db().rpc('svc_raise_alert', { p_tenant: s.tenant_id, p_election: s.election_id, p_rule: 'wrong_unit_sheet',
          p_pu: s.pu_code, p_area: s.pu_code, p_details: { source: 'agent_photo', sheet_pu_code: parsed.sheetPuCode },
          p_dedupe: `wrong_unit_agent:${s.id}` });
      }
      await db().rpc('svc_verify_unit', { p_election: s.election_id, p_pu: s.pu_code });
      n++;
    } catch (e) {
      log('ocr', `agent photo ${s.id}: ${(e as Error).message}`);
    }
  }
  return n;
}
