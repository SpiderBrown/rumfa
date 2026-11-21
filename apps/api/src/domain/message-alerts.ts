import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { rulesOf } from '../common/rules';
import { tenantSettings } from '../common/tenant-settings';
import { FIELD, ROOM } from './roles';

/** At most one alert per conversation per person in this window, so a busy chat doesn't buzz every line. */
const PUSH_GAP_MIN = 2;
/** At most one SMS per direct chat per person in this window. */
const SMS_GAP_MIN = 30;

/**
 * Tells people in the field about a new chat message (Room staff see it live in the dashboard instead):
 *  - direct chat: the other person; by SMS too when their app hasn't been seen for a while (Settings → SMS after)
 *  - case chat: field people who reported on the case or wrote in its chat
 *  - area chat (ward, LGA, state): everyone in the area, but only when a coordinator or the room writes;
 *    agents chatting among themselves only raise the unread badge
 */
@Injectable()
export class MessageAlerts {
  constructor(private readonly db: Db) {}

  async sent(u: AuthUser, channelId: string, msg: { id: string; body: string | null; kind: string }) {
    const [ch] = await this.db.system(`select id, kind, tenant_id, case_id, member_a, member_b, area_code from public.channels where id = $1`, [channelId]);
    if (!ch) return;
    const [me] = await this.db.system(`select full_name, role from public.volunteers where id = $1`, [u.mid]);
    const leads = me && (me.role === 'coordinator' || ROOM.includes(me.role));
    const text = msg.body?.trim() || ({ photo: 'Photo', video: 'Video', voice: 'Voice note' } as Record<string, string>)[msg.kind] || 'New message';
    const data = { channel_id: ch.id, message_id: msg.id, sender: me?.full_name ?? 'Someone', text: text.slice(0, 140), kind: ch.kind };

    const people = await this.db.system<{ id: string; phone: string | null; seen: string | null }>(
      `with r as (
         select case when c.member_a = $2 then c.member_b else c.member_a end as id from public.channels c where c.id = $1 and c.kind = 'direct'
         union select m.sender_id from public.messages m join public.channels c on c.id = m.channel_id where c.id = $1 and c.kind = 'case'
         union select i.volunteer_id from public.incidents i join public.channels c on c.case_id = i.case_id where c.id = $1 and c.kind = 'case'
         union select v.id from public.volunteers v join public.channels c on v.tenant_id = c.tenant_id
                where c.id = $1 and c.kind in ('ward', 'lga', 'state') and $3 and v.area_code like c.area_code || '%')
       select v.id, v.phone, (select max(d.last_seen_at) from public.auth_devices d where v.user_id is not null and d.identity_id = v.user_id) as seen
         from public.volunteers v join r on r.id = v.id
        where v.id <> $2 and v.status = 'active' and v.role = any($4)`,
      [ch.id, u.mid, !!leads, FIELD]);
    if (!people.length) return;

    await this.db.system(
      `insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
       select $1, 'push', p, 'new_message', $3::jsonb from unnest($2::uuid[]) p
        where not exists (select 1 from public.outbox o where o.to_volunteer = p and o.template = 'new_message'
                            and o.data->>'channel_id' = $4 and o.created_at > now() - make_interval(mins => $5))`,
      [ch.tenant_id, people.map((p) => p.id), JSON.stringify(data), ch.id, PUSH_GAP_MIN]);

    if (ch.kind !== 'direct') return;
    const smsAfter = rulesOf(await tenantSettings(this.db, ch.tenant_id)).alerts.smsAfterMin;
    const away = people.filter((p) => p.phone && (!p.seen || Date.now() - new Date(p.seen).getTime() > smsAfter * 60_000));
    if (!away.length) return;
    await this.db.system(
      `insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
       select $1, 'sms', p, 'new_message_sms', $3::jsonb from unnest($2::uuid[]) p
        where not exists (select 1 from public.outbox o where o.to_volunteer = p and o.template = 'new_message_sms'
                            and o.data->>'channel_id' = $4 and o.created_at > now() - make_interval(mins => $5))`,
      [ch.tenant_id, away.map((p) => p.id), JSON.stringify(data), ch.id, SMS_GAP_MIN]);
  }
}
