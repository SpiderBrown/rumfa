// Signed URLs for private media, issued only when the caller can see the
// record the media belongs to (RLS on the caller's own client decides).
//   { kind: 'ec8a', submission_id } | { kind: 'incident', incident_id, index }
//   { kind: 'message', message_id } | { kind: 'irev', election_id, pu_code }
//   { kind: 'callback', callback_id } | { kind: 'live', request_id }
import { admin, handler, HttpError, json, requireMe } from '../_shared/util.ts';

const TTL = 300;

Deno.serve(handler(async (req) => {
  const { db } = await requireMe(req);
  const b = await req.json();
  let bucket = '';
  let path: string | null = null;

  if (b.kind === 'ec8a') {
    const { data } = await db.from('result_submissions').select('sheet_photo_path').eq('id', b.submission_id).maybeSingle();
    bucket = 'ec8a'; path = data?.sheet_photo_path ?? null;
  } else if (b.kind === 'incident') {
    const { data } = await db.from('incidents').select('media_paths').eq('id', b.incident_id).maybeSingle();
    bucket = 'incident-media'; path = data?.media_paths?.[b.index ?? 0] ?? null;
  } else if (b.kind === 'message') {
    const { data } = await db.from('messages').select('media_path').eq('id', b.message_id).maybeSingle();
    bucket = 'chat-media'; path = data?.media_path ?? null;
  } else if (b.kind === 'irev') {
    const { data } = await db.from('irev_availability').select('storage_path').eq('election_id', b.election_id).eq('pu_code', b.pu_code).maybeSingle();
    bucket = 'irev'; path = data?.storage_path ?? null;
  } else if (b.kind === 'callback') {
    const { data } = await db.from('callback_requests').select('voice_note_path').eq('id', b.callback_id).maybeSingle();
    bucket = 'voice-notes'; path = data?.voice_note_path ?? null;
  } else if (b.kind === 'live') {
    const { data } = await db.from('live_view_requests').select('media_path').eq('id', b.request_id).maybeSingle();
    bucket = 'live-clips'; path = data?.media_path ?? null;
  } else throw new HttpError(400, 'Unknown kind');

  if (!path) throw new HttpError(404, 'Not found');
  const { data, error } = await admin().storage.from(bucket).createSignedUrl(path, TTL);
  if (error) throw error;
  return json({ url: data.signedUrl, expires_in: TTL });
}));
