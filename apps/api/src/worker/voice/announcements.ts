// Voice messages: rings each person on a sent voice message; when they answer, the API's voice webhook plays it and
// hangs up. Anyone not reached (out of network, busy, no answer) is tried again after the message's retry interval,
// up to its maximum number of calls, until it ends. Calls go out at a steady pace so the line isn't flooded.
import { log, one, q } from '../context';
import { makeCall, voiceConfigured } from './dialer';

/** Calls placed per run (about every 30 s): ~60 a minute */
const PER_RUN = 30;

export async function dialAnnouncements(): Promise<number> {
  // Finished: everyone heard it, gave up, or the time ran out
  await q(`update public.voice_announcement_calls c set status = 'cancelled', updated_at = now()
             from public.voice_announcements a where a.id = c.announcement_id and a.status = 'sending' and a.ends_at < now()
              and c.status in ('waiting','no_answer','busy','failed')`);
  await q(`update public.voice_announcements a set status = 'done' where a.status = 'sending'
             and not exists (select 1 from public.voice_announcement_calls c where c.announcement_id = a.id
                              and (c.status in ('waiting','calling') or (c.status in ('no_answer','busy','failed') and c.attempts < a.max_attempts)))`);
  if (!voiceConfigured()) {
    const [waiting] = await q(`select 1 from public.voice_announcements where status = 'sending' limit 1`);
    if (waiting) log('voice', "voice messages are waiting but no calls are placed: set the live AT_USERNAME, AT_API_KEY and AT_VOICE_NUMBER");
    return 0;
  }
  // A call left "calling" for 10 minutes never reported back: count it as not answered
  await q(`update public.voice_announcement_calls set status = 'no_answer', updated_at = now() where status = 'calling' and updated_at < now() - interval '10 minutes'`);
  let placed = 0;
  for (let i = 0; i < PER_RUN; i++) {
    const c = await one<{ id: string; phone: string }>(
      `update public.voice_announcement_calls c set status = 'calling', attempts = c.attempts + 1, updated_at = now(),
              next_try_at = now() + make_interval(mins => a.retry_min), provider_session_id = null
         from public.voice_announcements a
        where c.id = (select x.id from public.voice_announcement_calls x join public.voice_announcements y on y.id = x.announcement_id
                       where y.status = 'sending' and y.ends_at > now() and x.next_try_at <= now()
                         and (x.status = 'waiting' or (x.status in ('no_answer','busy','failed') and x.attempts < y.max_attempts))
                       order by x.attempts, x.next_try_at limit 1 for update of x skip locked)
          and a.id = c.announcement_id
        returning c.id, c.phone`);
    if (!c) break;
    try {
      const session = await makeCall(c.phone, `ann-${c.id}`);
      await q(`update public.voice_announcement_calls set provider_session_id = $2 where id = $1`, [c.id, session]);
      placed++;
    } catch (e) {
      await q(`update public.voice_announcement_calls set status = 'failed', updated_at = now() where id = $1`, [c.id]);
      log('voice', (e as Error).message);
    }
  }
  if (placed) log('voice', `voice messages: placed ${placed} calls`);
  return placed;
}
