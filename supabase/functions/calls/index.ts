// Starts calls for signed-in users.
//   { action: 'token' }                                  -> WebRTC capability token (dashboard operators)
//   { action: 'prepare', target: 'volunteer'|'contact', id, case_id? }
//                                                        -> registers an operator call; browser then dials
//   { action: 'callback', callback_id }                  -> bridged call: ring coordinator, then agent
//   { action: 'bridge', volunteer_id, case_id? }         -> bridged call between two app users (fallback for in-app calls)
import { admin, atCapabilityToken, atMakeCall, handler, HttpError, json, requireMe } from '../_shared/util.ts';

const ROOM = ['operator', 'supervisor', 'analyst', 'legal', 'security', 'admin'];

Deno.serve(handler(async (req) => {
  const { me, db } = await requireMe(req);
  const body = await req.json();
  const svc = admin();

  if (body.action === 'token') {
    if (!ROOM.includes(me.role) && me.role !== 'coordinator') throw new HttpError(403, 'Not allowed');
    const t = await atCapabilityToken(`v${me.id.replaceAll('-', '').slice(0, 20)}`);
    return json(t);
  }

  if (body.action === 'prepare') {
    // RLS on the user's own client decides whether they may see (and so call) the target
    let phone: string | null = null;
    let calleeId: string | null = null;
    let contactId: string | null = null;
    if (body.target === 'volunteer') {
      const { data } = await db.from('volunteers').select('id, phone').eq('id', body.id).maybeSingle();
      if (!data) throw new HttpError(404, 'Person not found');
      phone = data.phone; calleeId = data.id;
    } else if (body.target === 'contact') {
      const { data } = await db.from('authority_contacts').select('id, phone, status').eq('id', body.id).maybeSingle();
      if (!data?.phone) throw new HttpError(404, 'Contact not found');
      phone = data.phone; contactId = data.id;
    } else throw new HttpError(400, 'Unknown target');

    if (body.case_id) {
      const { data: c } = await db.from('cases').select('id').eq('id', body.case_id).maybeSingle();
      if (!c) throw new HttpError(404, 'Case not found');
    }
    const { data: call, error } = await svc.from('calls').insert({
      tenant_id: me.tenant_id, case_id: body.case_id ?? null, contact_id: contactId, caller_id: me.id,
      callee_id: calleeId, to_phone: phone, route: 'webrtc_pstn', reason: body.reason ?? null,
    }).select('id').single();
    if (error) throw error;
    if (body.case_id) {
      await svc.rpc('svc_case_event', { p_case: body.case_id, p_kind: 'call', p_body: body.reason ?? null,
        p_data: { call_id: call.id, to: calleeId ?? contactId }, p_actor: me.id });
    }
    return json({ call_id: call.id, phone });
  }

  if (body.action === 'callback') {
    const { data: info, error } = await db.rpc('start_callback', { p_id: body.callback_id });
    if (error) throw new HttpError(400, error.message);
    const { data: call, error: e2 } = await svc.from('calls').insert({
      tenant_id: info.tenant_id, callback_id: body.callback_id, caller_id: info.caller_id, callee_id: info.callee_id,
      to_phone: info.callee_phone, route: 'bridged', reason: 'callback',
    }).select('id').single();
    if (e2) throw e2;
    try {
      const sessionId = await atMakeCall(info.caller_phone, call.id);
      await svc.from('calls').update({ provider_session_id: sessionId, status: 'ringing' }).eq('id', call.id);
    } catch (e) {
      await svc.from('calls').update({ status: 'failed' }).eq('id', call.id);
      // Leave the request open so the coordinator can dial directly
      await svc.from('callback_requests').update({ status: 'waiting' }).eq('id', body.callback_id);
      return json({ call_id: call.id, bridged: false, dial_direct: info.callee_phone, error: (e as Error).message });
    }
    return json({ call_id: call.id, bridged: true });
  }

  if (body.action === 'bridge') {
    const { data: other } = await db.from('volunteers').select('id, phone').eq('id', body.volunteer_id).maybeSingle();
    if (!other) throw new HttpError(404, 'Person not found');
    const { data: call, error } = await svc.from('calls').insert({
      tenant_id: me.tenant_id, case_id: body.case_id ?? null, caller_id: me.id, callee_id: other.id,
      to_phone: other.phone, route: 'bridged', reason: body.reason ?? 'in-app fallback',
    }).select('id').single();
    if (error) throw error;
    const sessionId = await atMakeCall(me.phone, call.id);
    await svc.from('calls').update({ provider_session_id: sessionId, status: 'ringing' }).eq('id', call.id);
    return json({ call_id: call.id, bridged: true });
  }

  throw new HttpError(400, 'Unknown action');
}));
