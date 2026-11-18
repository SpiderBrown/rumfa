// Sends approved airtime/data top-ups. Primary: VTpass (naira wallet, all four
// networks). Fallback for airtime: Africa's Talking Airtime. Every top-up has a
// unique idempotency key so retries never pay twice; pending ones are requeried.

import { workerConfig as config } from '../config';
import { json, log, one, q } from '../context';

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
  await q(`update public.topup_batches set status = 'sending' where status = 'approved'`);
  // Only clients with the Airtime and data add-on switched on (others wait until it is)
  const batches = await q(`select b.id, p.data_plan_code from public.topup_batches b join public.topup_plans p on p.id = b.plan_id
                             join public.tenants t on t.id = b.tenant_id where b.status = 'sending' and t.settings->'addons'->>'airtime' = 'true'`);
  let n = 0;
  for (const b of batches) {
    const items = await q<Topup>(
      `select * from public.topups where batch_id = $1 and status in ('queued','pending') and attempts < 4 order by created_at limit $2`, [b.id, limit]);
    for (const t of items) {
      let result: { status: string; ref: string; error?: string; provider: string };
      try {
        if (t.status === 'pending' && t.provider === 'vtpass' && t.provider_ref) {
          result = { status: await vtpassRequery(t.provider_ref), ref: t.provider_ref, provider: 'vtpass' };
        } else {
          // Claim the row so two workers never send the same top-up
          const claimed = await one(`update public.topups set status = 'sending' where id = $1 and status = 'queued' returning id`, [t.id]);
          if (!claimed) continue;
          const r = await vtpassSend(t, b.data_plan_code ?? null);
          result = { ...r, provider: 'vtpass' };
          if (r.status === 'failed' && t.kind === 'airtime' && config.at.apiKey) result = { ...(await atAirtime(t)), provider: 'africastalking' };
        }
      } catch (e) {
        result = { status: 'queued', ref: t.provider_ref ?? '', error: (e as Error).message, provider: t.provider ?? 'vtpass' };
      }
      await q(`update public.topups set status = $2, provider = $3, provider_ref = coalesce(nullif($4, ''), provider_ref), attempts = attempts + 1,
                      last_error = $5, updated_at = now() where id = $1`,
        [t.id, result.status, result.provider, result.ref, result.error ?? null]);
      if (result.status === 'success') {
        await q(`insert into public.outbox (tenant_id, channel, to_volunteer, template, data) values ($1, 'sms', $2, 'topup_sent', $3)`,
          [t.tenant_id, t.volunteer_id, json({ amount: t.amount_ngn, kind: t.kind })]);
      }
      n++;
    }
    const open = await one(`select 1 from public.topups where batch_id = $1 and status in ('queued','sending','pending') limit 1`, [b.id]);
    if (!open) await q(`update public.topup_batches set status = 'done' where id = $1`, [b.id]);
  }
  if (n) log('topups', `processed ${n}`);
  return n;
}
