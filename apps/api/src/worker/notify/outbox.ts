// Sends queued notifications from public.outbox: push (FCM), SMS (Africa's Talking) and WhatsApp (Cloud API).
// Templates are rendered here. One worker drains at a time (advisory lock in the worker loop).

import { createSign } from 'node:crypto';
import { workerConfig as config } from '../config';
import { log, one, q } from '../context';

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
    case 'app_call': return { title: 'Incoming call', body: `${d.name || 'Someone'} is calling you in the app. Open it to answer.` };
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
  const j = (await res.json()) as any;
  if (!j.access_token) throw new Error('FCM auth failed');
  fcmToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return fcmToken.token;
}

async function sendPush(volunteerId: string, msg: { title: string; body: string }, data: Record<string, any>): Promise<void> {
  const tokens = await q(`select token from public.device_tokens where volunteer_id = $1`, [volunteerId]);
  if (!tokens.length) throw new Error('No device token');
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
    if (res.status === 404 || res.status === 400) await q(`delete from public.device_tokens where token = $1`, [t.token]);
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
  const j = (await res.json()) as any;
  const r = j?.SMSMessageData?.Recipients?.[0];
  if (!r || !['Success', 'Sent'].includes(r.status)) throw new Error(`SMS failed: ${r?.status ?? res.status}`);
}

async function sendWhatsApp(to: string, template: string, params: string[]): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'template',
      template: { name: template, language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}`);
}

// Client short names, cached for the life of the worker process
const brands = new Map<string, string>();
async function brandOf(tenantId: string | null): Promise<string> {
  if (!tenantId) return DEFAULT_BRAND;
  if (!brands.has(tenantId)) {
    const t = await one(`select name, settings from public.tenants where id = $1`, [tenantId]);
    brands.set(tenantId, t?.settings?.brand || t?.name || DEFAULT_BRAND);
  }
  return brands.get(tenantId)!;
}

export type Senders = { push: typeof sendPush; sms: typeof sendSms; whatsapp: typeof sendWhatsApp };
const realSenders: Senders = { push: sendPush, sms: sendSms, whatsapp: sendWhatsApp };

export async function drainOutbox(batch = 50, send: Senders = realSenders): Promise<number> {
  const rows = await q<OutboxRow>(`select * from public.outbox where status = 'queued' and attempts < 5 order by created_at limit $1`, [batch]);
  let sent = 0;
  for (const r of rows) {
    try {
      const brand = await brandOf(r.tenant_id);
      const msg = render(r.template, r.data, brand);
      let phone = r.to_phone;
      if (!phone && r.to_volunteer) phone = (await one(`select phone from public.volunteers where id = $1`, [r.to_volunteer]))?.phone ?? null;
      if (r.channel === 'push') {
        try { await send.push(r.to_volunteer!, msg, { template: r.template, ...r.data }); }
        catch (e) {
          // No app token or push failed: fall back to SMS for anything important
          if (phone && ['callback_request', 'case_task', 'live_view_request', 'case_assigned'].includes(r.template)) await send.sms(phone, `${brand}: ${msg.title}. ${msg.body}`);
          else throw e;
        }
      } else if (r.channel === 'sms') {
        if (!phone) throw new Error('No phone');
        await send.sms(phone, msg.body);
      } else {
        if (!phone) throw new Error('No phone');
        await send.whatsapp(phone, r.template, [msg.body]);
      }
      await q(`update public.outbox set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = $1`, [r.id]);
      sent++;
    } catch (e) {
      await q(`update public.outbox set attempts = attempts + 1, last_error = $2, status = case when attempts + 1 >= 5 then 'failed' else 'queued' end where id = $1`,
        [r.id, (e as Error).message]);
    }
  }
  if (sent) log('outbox', `sent ${sent}`);
  return sent;
}
