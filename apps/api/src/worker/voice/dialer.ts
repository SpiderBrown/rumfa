// Voice outreach dialer: places calls for running campaigns inside their
// daily window (Lagos time), at the campaign's calls-per-minute rate, skipping
// anyone who opted out. The API's voice webhook plays the recording.

import { workerConfig as config } from '../config';
import { log, one, q } from '../context';

/** Minutes since midnight in Africa/Lagos (UTC+1). */
export function lagosMinutes(now = new Date()): number {
  return ((now.getUTCHours() + 1) % 24) * 60 + now.getUTCMinutes();
}
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Africa's Talking voice has no sandbox: outreach calls need the live app and a voice number. */
export function voiceConfigured(): boolean {
  return config.at.username !== 'sandbox' && !!config.at.apiKey && !!config.at.voiceNumber;
}

export async function makeCall(to: string, clientRequestId: string): Promise<string> {
  const res = await fetch('https://voice.africastalking.com/call', {
    method: 'POST',
    headers: { apiKey: config.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: config.at.username, from: config.at.voiceNumber, to, clientRequestId }),
  });
  const j = await res.json() as any;
  const e = j?.entries?.[0];
  if (e?.status !== 'Queued') throw new Error(`Call not queued: ${JSON.stringify(j).slice(0, 200)}`);
  return e.sessionId;
}

/** Called about once a minute (one worker at a time). */
export async function dialCampaigns(): Promise<number> {
  if (!voiceConfigured()) {
    const [running] = await q(`select 1 from public.voice_campaigns where status = 'running' limit 1`);
    if (running) log('voice', "campaigns are running but no calls are placed: set the live AT_USERNAME, AT_API_KEY and AT_VOICE_NUMBER (Africa's Talking voice has no sandbox)");
    return 0;
  }
  const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
  // Only clients with the Voice outreach add-on switched on
  const camps = await q(`select c.* from public.voice_campaigns c join public.tenants t on t.id = c.tenant_id
                          where c.status = 'running' and c.starts_on <= $1 and c.ends_on >= $1 and t.settings->'addons'->>'voice' = 'true'`, [today]);
  const nowMin = lagosMinutes();
  let placed = 0;
  for (const c of camps) {
    if (nowMin < toMin(c.daily_start) || nowMin >= toMin(c.daily_end)) continue;
    const langs: string[] = c.audience?.languages ?? Object.keys(c.recordings);
    // Contacts not opted out, with no attempt in progress, under the attempt limit, and not tried in the last 3 hours
    const contacts = await q(
      `select vc.id, vc.phone, coalesce(a.attempt, 0) as attempts
         from public.voice_contacts vc
         left join lateral (select attempt, status, created_at from public.voice_call_attempts x
                             where x.campaign_id = $2 and x.contact_id = vc.id order by attempt desc limit 1) a on true
        where vc.tenant_id = $1 and vc.language = any($3)
          and ($4::text[] is null or vc.state_code = any($4)) and ($5::text[] is null or vc.lga_code = any($5))
          and not exists (select 1 from public.voice_opt_outs o where o.phone = vc.phone)
          and (a.attempt is null or (a.status not in ('answered','completed','opted_out','queued','dialing')
               and a.attempt < $6 and a.created_at < now() - interval '3 hours'))
        limit $7`,
      [c.tenant_id, c.id, langs, c.audience?.states?.length ? c.audience.states : null, c.audience?.lgas?.length ? c.audience.lgas : null,
       c.max_attempts, c.calls_per_minute]);
    for (const ct of contacts) {
      const att = await one(
        `insert into public.voice_call_attempts (tenant_id, campaign_id, contact_id, attempt, status) values ($1, $2, $3, $4, 'dialing')
         on conflict do nothing returning id`, [c.tenant_id, c.id, ct.id, Number(ct.attempts) + 1]);
      if (!att) continue; // another worker took it
      try {
        const sessionId = await makeCall(ct.phone, att.id);
        await q(`update public.voice_call_attempts set provider_session_id = $2 where id = $1`, [att.id, sessionId]);
        placed++;
      } catch (e) {
        await q(`update public.voice_call_attempts set status = 'failed' where id = $1`, [att.id]);
        log('voice', (e as Error).message);
      }
    }
  }
  if (placed) log('voice', `placed ${placed} calls`);
  return placed;
}
