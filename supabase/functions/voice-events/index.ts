// Africa's Talking voice callback URL (set on the voice number).
// Handles:
//   - bridged calls: first leg answered -> dial the second person
//   - WebRTC operator calls from the dashboard -> dial the registered number
//   - voice outreach calls -> play the approved recording, offer opt-out (press 9)
//   - DTMF results and end-of-call notifications
import { normaliseNgPhone } from '../_shared/shared.ts';
import { admin, checkWebhookKey, env, escapeXml, formBody, handler, xml } from '../_shared/util.ts';

const SIGNED_URL_TTL = 600;

Deno.serve(handler(async (req) => {
  checkWebhookKey(req);
  const f = await formBody(req);
  const db = admin();
  const url = new URL(req.url);
  const sessionId = f.sessionId ?? '';
  const ourNumber = env('AT_VOICE_NUMBER');

  // DTMF result from a voice outreach call
  if (url.searchParams.get('step') === 'dtmf') {
    const attemptId = url.searchParams.get('attempt');
    if (f.dtmfDigits === '9' && attemptId) {
      const { data: a } = await db.from('voice_call_attempts').select('id, contact_id').eq('id', attemptId).maybeSingle();
      if (a) {
        const { data: c } = await db.from('voice_contacts').select('phone').eq('id', a.contact_id).single();
        await db.from('voice_opt_outs').upsert({ phone: c!.phone, source: 'dtmf' });
        await db.from('voice_call_attempts').update({ status: 'opted_out', dtmf: '9' }).eq('id', a.id);
      }
      return xml('<Say voice="en-US-Standard-C">You will not receive these calls again. Goodbye.</Say>');
    }
    return xml('');
  }

  // End-of-call notification
  if (f.isActive === '0') {
    const duration = Number(f.durationInSeconds ?? 0) || 0;
    const answered = duration > 0 && (f.status ?? '').toLowerCase() === 'success';
    const status = answered ? 'completed' : (f.hangupCause ?? '').toLowerCase().includes('busy') ? 'busy' : 'no_answer';

    const { data: call } = await db.from('calls').select('id, contact_id, case_id')
      .eq('provider_session_id', sessionId).maybeSingle();
    if (call) {
      await db.from('calls').update({ status, duration_s: duration, recording_url: f.recordingUrl ?? null,
        ended_at: new Date().toISOString() }).eq('id', call.id);
      if (call.contact_id) await db.rpc('svc_contact_call_result', { p_contact: call.contact_id, p_ok: answered });
      return xml('');
    }
    const { data: att } = await db.from('voice_call_attempts').select('id, status').eq('provider_session_id', sessionId).maybeSingle();
    if (att && att.status !== 'opted_out') {
      await db.from('voice_call_attempts').update({ status: answered ? 'completed' : status, duration_s: duration,
        updated_at: new Date().toISOString() }).eq('id', att.id);
    }
    return xml('');
  }

  // Active call: decide what to do
  // 1. Outbound bridged call (makeCall): first person answered
  let { data: call } = await db.from('calls').select('id, to_phone, route, status')
    .eq('provider_session_id', sessionId).maybeSingle();
  if (!call && f.clientRequestId) {
    ({ data: call } = await db.from('calls').select('id, to_phone, route, status').eq('id', f.clientRequestId).maybeSingle());
    if (call) await db.from('calls').update({ provider_session_id: sessionId }).eq('id', call.id);
  }
  if (call && call.route === 'bridged') {
    await db.from('calls').update({ status: 'answered' }).eq('id', call.id);
    return xml(`<Say>Connecting you now.</Say><Dial phoneNumbers="${escapeXml(call.to_phone!)}" record="true" callerId="${escapeXml(ourNumber)}" sequential="true"/>`);
  }

  // 2. Voice outreach call
  const { data: att } = await db.from('voice_call_attempts')
    .select('id, campaign_id, contact_id').eq('provider_session_id', sessionId).maybeSingle();
  if (att) {
    const { data: camp } = await db.from('voice_campaigns').select('recordings').eq('id', att.campaign_id).single();
    const { data: contact } = await db.from('voice_contacts').select('language').eq('id', att.contact_id).single();
    const recId = camp!.recordings[contact!.language] ?? Object.values(camp!.recordings)[0];
    const { data: rec } = await db.from('voice_recordings').select('storage_path, status').eq('id', recId).single();
    if (!rec || rec.status !== 'approved') return xml('<Reject/>');
    const { data: signed } = await db.storage.from('voice-recordings').createSignedUrl(rec.storage_path, SIGNED_URL_TTL);
    await db.from('voice_call_attempts').update({ status: 'answered' }).eq('id', att.id);
    const cb = `${env('SUPABASE_URL')}/functions/v1/voice-events?key=${encodeURIComponent(env('WEBHOOK_KEY'))}&step=dtmf&attempt=${att.id}`;
    return xml(`<Play url="${escapeXml(signed!.signedUrl)}"/>` +
      `<GetDigits timeout="8" numDigits="1" callbackUrl="${escapeXml(cb)}"><Say>To stop receiving these calls, press 9.</Say></GetDigits>`);
  }

  // 3. WebRTC call from a dashboard operator: only numbers registered via calls.prepare
  const dest = normaliseNgPhone(f.clientDialedNumber ?? f.destinationNumber ?? '');
  const caller = f.callerNumber ?? '';
  if (dest && caller.includes('.v')) {
    const since = new Date(Date.now() - 3 * 60_000).toISOString();
    const { data: pending } = await db.from('calls').select('id')
      .eq('route', 'webrtc_pstn').eq('status', 'initiated').eq('to_phone', dest).gte('started_at', since)
      .order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (pending) {
      await db.from('calls').update({ provider_session_id: sessionId, status: 'ringing' }).eq('id', pending.id);
      return xml(`<Dial phoneNumbers="${escapeXml(dest)}" record="true" callerId="${escapeXml(ourNumber)}"/>`);
    }
  }

  // Anything else (e.g. someone calling the number back)
  return xml('<Say>Thank you for calling. Please use the app or call your coordinator.</Say>');
}));
