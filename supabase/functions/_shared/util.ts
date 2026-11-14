// Shared helpers for Edge Functions (Deno runtime).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export const env = (k: string, required = true): string => {
  const v = Deno.env.get(k);
  if (!v && required) throw new Error(`Missing env ${k}`);
  return v ?? '';
};

export const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`, {
    headers: { 'Content-Type': 'application/xml' },
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

/** Service-role client: bypasses RLS. Only for trusted server logic. */
export function admin(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
}

/** Client acting as the signed-in user (RLS applies). */
export function asUser(req: Request): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

export interface Me { id: string; tenant_id: string; role: string; level: string; area_code: string; phone: string; full_name: string }

/** Resolve the caller's volunteer record, or throw 401. */
export async function requireMe(req: Request): Promise<{ me: Me; db: SupabaseClient }> {
  const db = asUser(req);
  const { data: u, error } = await db.auth.getUser();
  if (error || !u.user) throw new HttpError(401, 'Not signed in');
  const { data, error: e2 } = await admin().from('volunteers')
    .select('id, tenant_id, role, level, area_code, phone, full_name')
    .eq('user_id', u.user.id).eq('status', 'active').maybeSingle();
  if (e2 || !data) throw new HttpError(403, 'No active account');
  return { me: data as Me, db };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  };
}

/** Webhooks from providers carry a shared secret in the query string. */
export function checkWebhookKey(req: Request): void {
  const key = new URL(req.url).searchParams.get('key');
  if (!key || key !== env('WEBHOOK_KEY')) throw new HttpError(401, 'Bad webhook key');
}

export async function formBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return await req.json();
  const f = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of f.entries()) out[k] = String(v);
  return out;
}

// ---------------------------------------------------------------------------
// Africa's Talking
// ---------------------------------------------------------------------------

const AT_SANDBOX = () => env('AT_USERNAME') === 'sandbox';

export async function atMakeCall(to: string, clientRequestId: string): Promise<string | null> {
  const base = AT_SANDBOX() ? 'https://voice.sandbox.africastalking.com' : 'https://voice.africastalking.com';
  const res = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { apiKey: env('AT_API_KEY'), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: env('AT_USERNAME'), from: env('AT_VOICE_NUMBER'), to, clientRequestId }),
  });
  if (!res.ok) throw new Error(`AT call failed ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const entry = body?.entries?.[0];
  if (entry?.status !== 'Queued') throw new Error(`AT call not queued: ${JSON.stringify(body)}`);
  return entry.sessionId ?? null;
}

/** WebRTC capability token for a browser operator. */
export async function atCapabilityToken(clientName: string): Promise<{ token: string; lifeTimeSec: string }> {
  const res = await fetch('https://webrtc.africastalking.com/capability-token/request', {
    method: 'POST',
    headers: { apiKey: env('AT_API_KEY'), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: env('AT_USERNAME'), clientName, phoneNumber: env('AT_VOICE_NUMBER'),
      incoming: 'false', outgoing: 'true', expire: '3600s',
    }),
  });
  if (!res.ok) throw new Error(`AT token failed ${res.status}: ${await res.text()}`);
  return await res.json();
}

// ---------------------------------------------------------------------------
// LiveKit access tokens (HS256 JWT, signed with Web Crypto)
// ---------------------------------------------------------------------------

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function livekitToken(identity: string, name: string, room: string, canPublish: boolean, ttlSec = 1800): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: env('LIVEKIT_API_KEY'), sub: identity, name, nbf: now - 10, exp: now + ttlSec,
    video: { room, roomJoin: true, canPublish, canSubscribe: !canPublish, canPublishData: false,
             canPublishSources: canPublish ? ['camera', 'microphone'] : [] },
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('LIVEKIT_API_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
