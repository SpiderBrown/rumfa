// Sends approved airtime/data top-ups. Primary: VTpass (naira wallet, all four
// networks). Fallback for airtime: Africa's Talking Airtime. Every top-up has a
// unique idempotency key so retries never pay twice; pending ones are requeried.

import { config } from '../config.ts';
import { db, log } from '../db.ts';

interface Topup { id: string; tenant_id: string; batch_id: string; volunteer_id: string; phone: string; network: string | null;
  kind: 'airtime' | 'data'; amount_ngn: number; status: string; provider: string | null; provider_ref: string | null;
  idempotency_key: string; attempts: number; plan_id: string }

const VT_SERVICE: Record<string, { airtime: string; data: string }> = {
  mtn: { airtime: 'mtn', data: 'mtn-data' }, airtel: { airtime: 'airtel', data: 'airtel-data' },
  glo: { airtime: 'glo', data: 'glo-data' }, '9mobile': { airtime: 'etisalat', data: 'etisalat-data' },
};

/** VTpass request_id: YYYYMMDDHHmm in Africa/Lagos time + unique suffix (provider requirement). */
export function vtRequestId(key: string, now = new Date()): string {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);   // WAT = UTC+1, no DST
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${lagos.getUTCFullYear()}${p(lagos.getUTCMonth() + 1)}${p(lagos.getUTCDate())}${p(lagos.getUTCHours())}${p(lagos.getUTCMinutes())}`;
  return `${stamp}${key.replace(/[^a-zA-Z0-9]/g, '').slice(-20)}`;
}

async function vtpass(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${config.vtpass.baseUrl}/${path}`, {
    method: 'POST',
    headers: { 'api-key': config.vtpass.apiKey, 'secret-key': config.vtpass.secretKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function vtpassSend(t: Topup, dataPlanCode: string | null): Promise<{ status: 'success' | 'pending' | 'failed'; ref: string; error?: string }> {
  const svc = VT_SERVICE[t.network ?? ''];
  if (!svc) return { status: 'failed', ref: '', error: 'Unknown network' };
  const request_id = t.provider_ref ?? vtRequestId(t.idempotency_key);
  const phone = t.phone.replace('+234', '0');
  const body: Record<string, unknown> = { request_id, serviceID: t.kind === 'data' ? svc.data : svc.airtime, phone, amount: t.amount_ngn };
  if (t.kind === 'data') { body.billersCode = phone; body.variation_code = dataPlanCode; }
  const j = await vtpass('pay', body);
  const st = j?.content?.transactions?.status;
  if (j?.code === '000' && st === 'delivered') return { status: 'success', ref: request_id };
  if (j?.code === '099' || st === 'pending' || st === 'initiated') return { status: 'pending', ref: request_id };
  return { status: 'failed', ref: request_id, error: j?.response_description ?? JSON.stringify(j).slice(0, 200) };
}

async function vtpassRequery(ref: string): Promise<'success' | 'pending' | 'failed'> {
  const j = await vtpass('requery', { request_id: ref });
  const st = j?.content?.transactions?.status;
  if (st === 'delivered') return 'success';
  if (st === 'failed' || st === 'reversed') return 'failed';
  return 'pending';
}

async function atAirtime(t: Topup): Promise<{ status: 'success' | 'failed'; ref: string; error?: string }> {
  const base = config.at.username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const res = await fetch(`${base}/version1/airtime/send`, {
    method: 'POST',
    headers: { apiKey: config.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: config.at.username,
      recipients: JSON.stringify([{ phoneNumber: t.phone, currencyCode: 'NGN', amount: t.amount_ngn }]),
      maxNumRetry: '0', idempotencyKey: t.idempotency_key } as any),
  });
  const j = await res.json() as any;
  const r = j?.responses?.[0];
  if (r?.status === 'Sent' || r?.status === 'Success') return { status: 'success', ref: r.requestId };
  return { status: 'failed', ref: r?.requestId ?? '', error: r?.errorMessage ?? j?.errorMessage };
}

export async function processTopups(limit = 30): Promise<number> {
  // Approved batches start sending
  await db().from('topup_batches').update({ status: 'sending' }).eq('status', 'approved');
  const { data: batches } = await db().from('topup_batches').select('id, plan_id').eq('status', 'sending');
  let n = 0;
  for (const b of batches ?? []) {
    const { data: plan } = await db().from('topup_plans').select('data_plan_code').eq('id', b.plan_id).single();
    const { data: items } = await db().from('topups').select('*').eq('batch_id', b.id)
      .in('status', ['queued', 'pending']).lt('attempts', 4).limit(limit);
    for (const t of (items ?? []) as Topup[]) {
      let result: { status: string; ref: string; error?: string; provider: string };
      try {
        if (t.status === 'pending' && t.provider === 'vtpass' && t.provider_ref) {
          result = { status: await vtpassRequery(t.provider_ref), ref: t.provider_ref, provider: 'vtpass' };
        } else {
          // claim the row so two workers never send the same top-up
          const { data: claimed } = await db().from('topups').update({ status: 'sending' }).eq('id', t.id).eq('status', 'queued').select('id');
          if (!claimed?.length) continue;
          const r = await vtpassSend(t, plan?.data_plan_code ?? null);
          result = { ...r, provider: 'vtpass' };
          if (r.status === 'failed' && t.kind === 'airtime' && config.at.apiKey) {
            const r2 = await atAirtime(t);
            result = { ...r2, provider: 'africastalking' };
          }
        }
      } catch (e) {
        result = { status: 'queued', ref: t.provider_ref ?? '', error: (e as Error).message, provider: t.provider ?? 'vtpass' };
      }
      await db().from('topups').update({
        status: result.status, provider: result.provider, provider_ref: result.ref || t.provider_ref,
        attempts: t.attempts + 1, last_error: result.error ?? null, updated_at: new Date().toISOString(),
      }).eq('id', t.id);
      if (result.status === 'success') {
        await db().from('outbox').insert({ tenant_id: t.tenant_id, channel: 'sms', to_volunteer: t.volunteer_id, template: 'topup_sent',
          data: { amount: t.amount_ngn, kind: t.kind } });
      }
      n++;
    }
    const { count } = await db().from('topups').select('id', { count: 'exact', head: true }).eq('batch_id', b.id).in('status', ['queued', 'sending', 'pending']);
    if (!count) await db().from('topup_batches').update({ status: 'done' }).eq('id', b.id);
  }
  if (n) log('topups', `processed ${n}`);
  return n;
}
