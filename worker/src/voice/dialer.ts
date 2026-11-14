// Voice outreach dialer: places calls for running campaigns inside their
// daily window (Lagos time), at the campaign's calls-per-minute rate, skipping
// anyone who opted out. The voice-events Edge Function plays the recording.

import { config } from '../config.ts';
import { db, log } from '../db.ts';

/** Minutes since midnight in Africa/Lagos (UTC+1). */
export function lagosMinutes(now = new Date()): number {
  return ((now.getUTCHours() + 1) % 24) * 60 + now.getUTCMinutes();
}
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

async function makeCall(to: string, clientRequestId: string): Promise<string> {
  const base = config.at.username === 'sandbox' ? 'https://voice.sandbox.africastalking.com' : 'https://voice.africastalking.com';
  const res = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { apiKey: config.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: config.at.username, from: config.at.voiceNumber, to, clientRequestId }),
  });
  const j = await res.json() as any;
  const e = j?.entries?.[0];
  if (e?.status !== 'Queued') throw new Error(`Call not queued: ${JSON.stringify(j).slice(0, 200)}`);
  return e.sessionId;
}

/** Called about once a minute. */
export async function dialCampaigns(): Promise<number> {
  const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
  const { data: camps } = await db().from('voice_campaigns').select('*').eq('status', 'running')
    .lte('starts_on', today).gte('ends_on', today);
  const nowMin = lagosMinutes();
  let placed = 0;
  for (const c of camps ?? []) {
    if (nowMin < toMin(c.daily_start) || nowMin >= toMin(c.daily_end)) continue;
    const langs: string[] = c.audience?.languages ?? Object.keys(c.recordings);
    let q = db().from('voice_contacts').select('id, phone').eq('tenant_id', c.tenant_id).in('language', langs);
    if (c.audience?.states?.length) q = q.in('state_code', c.audience.states);
    if (c.audience?.lgas?.length) q = q.in('lga_code', c.audience.lgas);
    const { data: contacts } = await q.limit(c.calls_per_minute * 5);
    const { data: optouts } = await db().from('voice_opt_outs').select('phone').in('phone', (contacts ?? []).map((x) => x.phone));
    const blocked = new Set((optouts ?? []).map((o) => o.phone));
    let budget = c.calls_per_minute;
    for (const ct of contacts ?? []) {
      if (budget <= 0) break;
      if (blocked.has(ct.phone)) continue;
      const { data: prev } = await db().from('voice_call_attempts').select('attempt, status, created_at')
        .eq('campaign_id', c.id).eq('contact_id', ct.id).order('attempt', { ascending: false }).limit(1);
      const last = prev?.[0];
      if (last && (['answered', 'completed', 'opted_out', 'queued', 'dialing'].includes(last.status) || last.attempt >= c.max_attempts)) continue;
      if (last && Date.now() - new Date(last.created_at).getTime() < 3 * 3600_000) continue;   // wait 3h before retrying
      const { data: att, error } = await db().from('voice_call_attempts')
        .insert({ tenant_id: c.tenant_id, campaign_id: c.id, contact_id: ct.id, attempt: (last?.attempt ?? 0) + 1, status: 'dialing' })
        .select('id').single();
      if (error) continue;   // another worker took it
      try {
        const sessionId = await makeCall(ct.phone, att.id);
        await db().from('voice_call_attempts').update({ provider_session_id: sessionId }).eq('id', att.id);
        placed++; budget--;
      } catch (e) {
        await db().from('voice_call_attempts').update({ status: 'failed' }).eq('id', att.id);
        log('voice', (e as Error).message);
      }
    }
  }
  if (placed) log('voice', `placed ${placed} calls`);
  return placed;
}
