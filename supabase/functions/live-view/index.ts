// Live view tokens.
//   { action: 'publish', request_id }  -> agent who accepted gets a publish-only token
//   { action: 'view', request_id }     -> requester (or supervisor) gets a view-only token
//   { action: 'end', request_id, media_path? } -> mark ended (clip path when a clip was uploaded instead)
import { admin, env, handler, HttpError, json, livekitToken, requireMe } from '../_shared/util.ts';

Deno.serve(handler(async (req) => {
  const { me, db } = await requireMe(req);
  const body = await req.json();
  const { data: r } = await db.from('live_view_requests').select('*').eq('id', body.request_id).maybeSingle();
  if (!r) throw new HttpError(404, 'Request not found');
  const svc = admin();

  if (body.action === 'publish') {
    if (r.agent_id !== me.id || !['accepted', 'live'].includes(r.status)) throw new HttpError(403, 'Not allowed');
    await svc.from('live_view_requests').update({ status: 'live', mode: 'live', started_at: new Date().toISOString() }).eq('id', r.id);
    return json({ url: env('LIVEKIT_URL'), token: await livekitToken(me.id, me.full_name, r.room_name, true) });
  }
  if (body.action === 'view') {
    if (r.requested_by !== me.id && !['supervisor', 'admin'].includes(me.role)) throw new HttpError(403, 'Not allowed');
    return json({ url: env('LIVEKIT_URL'), token: await livekitToken(me.id, me.full_name, r.room_name, false) });
  }
  if (body.action === 'end') {
    if (r.agent_id !== me.id && r.requested_by !== me.id) throw new HttpError(403, 'Not allowed');
    const patch: Record<string, unknown> = { status: body.media_path ? 'clip_uploaded' : 'ended', ended_at: new Date().toISOString() };
    if (body.media_path) { patch.media_path = body.media_path; patch.mode = 'clip'; }
    await svc.from('live_view_requests').update(patch).eq('id', r.id);
    if (r.case_id) {
      await svc.rpc('svc_case_event', { p_case: r.case_id, p_kind: body.media_path ? 'clip_uploaded' : 'live_view_ended',
        p_body: null, p_data: { request_id: r.id, media_path: body.media_path ?? null }, p_actor: me.id });
    }
    return json({ ok: true });
  }
  throw new HttpError(400, 'Unknown action');
}));
