// Africa's Talking incoming SMS webhook.
// Accepts SMS fallback messages (results, incidents, callback requests) built
// by the agent app. Only accepted from the agent's registered number, with a
// matching agent code and checksum.
import { decodeSms, SmsDecodeError, normaliseNgPhone } from '../_shared/shared.ts';
import { admin, checkWebhookKey, formBody, handler, json } from '../_shared/util.ts';

Deno.serve(handler(async (req) => {
  checkWebhookKey(req);
  const f = await formBody(req);
  const from = normaliseNgPhone(f.from ?? '');
  const text = f.text ?? '';
  const db = admin();

  const { data: log, error: logErr } = await db.from('sms_inbound')
    .insert({ provider_id: f.id ?? null, from_phone: f.from ?? '', to_number: f.to ?? null, text })
    .select('id').single();
  if (logErr) {
    if (logErr.code === '23505') return json({ ok: true, duplicate: true });  // provider retry
    throw logErr;
  }
  const finish = async (patch: Record<string, unknown>, reply?: string) => {
    await db.from('sms_inbound').update({ ...patch, processed_at: new Date().toISOString() }).eq('id', log.id);
    if (reply && from) {
      await db.from('outbox').insert({ channel: 'sms', to_phone: from, template: 'raw', data: { text: reply },
        tenant_id: patch.tenant_id ?? null });
    }
    return json({ ok: true });
  };

  if (!from) return finish({ error: 'Sender is not a Nigerian mobile number' });

  let msg;
  try {
    msg = decodeSms(text);
  } catch (e) {
    const reason = e instanceof SmsDecodeError ? e.message : 'Unreadable';
    return finish({ error: reason }, 'ALAWA: message not accepted. Please resend from the app.');
  }

  const { data: v } = await db.from('volunteers')
    .select('id, tenant_id, agent_code, area_code, role')
    .eq('phone', from).eq('status', 'active').eq('agent_code', msg.agentCode).maybeSingle();
  if (!v) return finish({ decoded: msg, error: 'Unknown sender or agent code' });

  const base = { decoded: msg, tenant_id: v.tenant_id, volunteer_id: v.id };
  try {
    if (msg.kind === 'result') {
      // client_id derived from the message so a resend is idempotent
      const { data, error } = await db.rpc('svc_ingest_result', {
        p_volunteer: v.id, p_pu: msg.puCode, p_registered: msg.registered, p_accredited: msg.accredited,
        p_rejected: msg.rejected, p_total_valid: msg.totalValid, p_votes: msg.votes, p_source: 'sms', p_client_id: null,
      });
      if (error) throw error;
      return finish(base, `ALAWA: result for ${msg.puCode} received (ref ${String(data.submission_id).slice(0, 8)}).`);
    }
    if (msg.kind === 'incident') {
      const { error } = await db.rpc('svc_ingest_incident', {
        p_volunteer: v.id, p_pu: msg.puCode, p_category: msg.category, p_severity: msg.severity,
        p_description: 'Sent by SMS', p_source: 'sms', p_client_id: null,
      });
      if (error) throw error;
      return finish(base, `ALAWA: report for ${msg.puCode} received. The situation room will call you.`);
    }
    const { error } = await db.rpc('svc_ingest_callback', { p_volunteer: v.id, p_reason: msg.reason, p_channel: 'sms' });
    if (error) throw error;
    return finish(base, 'ALAWA: your coordinator will call you shortly.');
  } catch (e) {
    return finish({ ...base, error: (e as Error).message ?? String(e) }, 'ALAWA: message could not be processed. Please call your coordinator.');
  }
}));
