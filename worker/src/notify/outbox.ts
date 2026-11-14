// Sends queued notifications from public.outbox: push (FCM), SMS (Africa's
// Talking) and WhatsApp (Cloud API). Templates are rendered here.

import { createSign } from 'node:crypto';
import { config } from '../config.ts';
import { db, log } from '../db.ts';

interface OutboxRow {
  id: number; tenant_id: string | null; channel: 'push' | 'sms' | 'whatsapp'; to_volunteer: string | null;
  to_phone: string | null; template: string; data: Record<string, any>; attempts: number;
}

const REASON: Record<string, string> = { form: 'question about a form', unit: 'problem at the unit', app: 'app problem', other: 'other' };

export const DEFAULT_BRAND = 'Rumfa';

/** Plain-text rendering used for SMS, push body and WhatsApp fallback.
 *  `brand` is the client's short name (tenant settings.brand), e.g. the name
 *  their agents know; it prefixes SMS so people recognise the sender. */
export function render(t: string, d: Record<string, any>, brand = DEFAULT_BRAND): { title: string; body: string } {
  const b = brand;
  switch (t) {
    case 'raw': return { title: b, body: `${b}: ${d.text}` };
    case 'case_assigned': return { title: `New ${d.severity} case`, body: d.title };
    case 'case_updated': return { title: 'Case updated', body: `${d.reports} reports${d.severity_raised ? ', severity raised' : ''}` };
    case 'case_resolved': return { title: 'Your report was resolved', body: d.outcome ?? '' };
    case 'case_task': return { title: 'Task from the situation room', body: d.body };
    case 'case_task_sms': return { title: b, body: `${b} situation room: ${d.body}` };
    case 'ack_missed': return { title: 'Case not acknowledged', body: 'A case was reassigned after its deadline passed.' };
    case 'callback_request': return { title: d.escalated ? 'Callback request (escalated)' : 'Callback request', body: `${d.name ?? 'An agent'} asked you to call: ${REASON[d.reason] ?? ''}` };
    case 'callback_request_sms': return { title: b, body: `${b}: ${d.name ?? 'An agent'} ${d.phone ?? ''} asked you to call back (${REASON[d.reason] ?? 'help'}). Open the app to call.` };
    case 'callback_missed': return { title: b, body: `${b}: we could not reach you. Please request a call again in the app or call your coordinator.` };
    case 'callback_missed_retry': return { title: b, body: `${b}: your coordinator tried to call you. They will try again in 5 minutes.` };
    case 'live_view_request': return { title: 'Live view request', body: 'The situation room asks to see your unit. Open the app to accept.' };
    case 'contact_call_failed': return { title: 'Contact unreachable', body: 'A verified contact did not answer a test call.' };
    case 'topup_sent': return { title: b, body: `${b}: ${d.kind === 'data' ? 'data' : 'airtime'} of N${d.amount} has been sent to your line for election duty.` };
    case 'shift_reminder': return { title: 'Shift reminder', body: `Your shift starts at ${d.time}.` };
    default: return { title: b, body: d.text ?? t };
  }
}

// FCM HTTP v1 with a service-account JWT ---------------------------------------
let fcmToken: { token: string; exp: number } | null = null;
async function fcmAccessToken(): Promise<string> {
  if (fcmToken && fcmToken.exp > Date.now() + 60_000) return fcmToken.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: config.fcm.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(config.fcm.privateKey, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = await res.json() as any;
  if (!j.access_token) throw new Error(`FCM auth failed: ${JSON.stringify(j)}`);
  fcmToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return fcmToken.token;
}

async function sendPush(volunteerId: string, msg: { title: string; body: string }, data: Record<string, any>): Promise<void> {
  const { data: tokens } = await db().from('device_tokens').select('token').eq('volunteer_id', volunteerId);
  if (!tokens?.length) throw new Error('No device token');
  const access = await fcmAccessToken();
  for (const t of tokens) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${config.fcm.projectId}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token: t.token, notification: msg,
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: 'HIGH' },
      } }),
    });
    if (res.status === 404 || res.status === 400) await db().from('device_tokens').delete().eq('token', t.token);
    else if (!res.ok) throw new Error(`FCM ${res.status}`);
  }
}

export async function sendSms(to: string, text: string): Promise<void> {
  const base = config.at.username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const body = new URLSearchParams({ username: config.at.username, to, message: text });
  if (config.at.senderId) body.set('from', config.at.senderId);
  const res = await fetch(`${base}/version1/messaging`, {
    method: 'POST', headers: { apiKey: config.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await res.json() as any;
  const r = j?.SMSMessageData?.Recipients?.[0];
  if (!r || !['Success', 'Sent'].includes(r.status)) throw new Error(`SMS failed: ${JSON.stringify(j)}`);
}

async function sendWhatsApp(to: string, template: string, params: string[]): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'template',
      template: { name: template, language: { code: 'en' },
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
}

// Client short names, cached for the life of the worker process
const brands = new Map<string, string>();
async function brandOf(tenantId: string | null): Promise<string> {
  if (!tenantId) return DEFAULT_BRAND;
  if (!brands.has(tenantId)) {
    const { data } = await db().from('tenants').select('name, settings').eq('id', tenantId).maybeSingle();
    brands.set(tenantId, (data?.settings as any)?.brand || data?.name || DEFAULT_BRAND);
  }
  return brands.get(tenantId)!;
}

export async function drainOutbox(batch = 50): Promise<number> {
  const { data: rows } = await db().from('outbox').select('*').eq('status', 'queued').lt('attempts', 5)
    .order('created_at').limit(batch);
  let sent = 0;
  for (const r of (rows ?? []) as OutboxRow[]) {
    try {
      const brand = await brandOf(r.tenant_id);
      const msg = render(r.template, r.data, brand);
      let phone = r.to_phone;
      if (!phone && r.to_volunteer) {
        const { data: v } = await db().from('volunteers').select('phone').eq('id', r.to_volunteer).single();
        phone = v?.phone ?? null;
      }
      if (r.channel === 'push') {
        try { await sendPush(r.to_volunteer!, msg, { template: r.template, ...r.data }); }
        catch (e) {
          // No app token or push failed: fall back to SMS for anything important
          if (phone && ['callback_request', 'case_task', 'live_view_request', 'case_assigned'].includes(r.template)) await sendSms(phone, `${brand}: ${msg.title}. ${msg.body}`);
          else throw e;
        }
      } else if (r.channel === 'sms') {
        if (!phone) throw new Error('No phone');
        await sendSms(phone, msg.body);
      } else {
        if (!phone) throw new Error('No phone');
        await sendWhatsApp(phone, r.template, [msg.body]);
      }
      await db().from('outbox').update({ status: 'sent', sent_at: new Date().toISOString(), attempts: r.attempts + 1 }).eq('id', r.id);
      sent++;
    } catch (e) {
      const attempts = r.attempts + 1;
      await db().from('outbox').update({ attempts, last_error: (e as Error).message, status: attempts >= 5 ? 'failed' : 'queued' }).eq('id', r.id);
    }
  }
  if (sent) log('outbox', `sent ${sent}`);
  return sent;
}
