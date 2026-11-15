import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { ProvidersService } from '../common/providers.service';
import { requireCallMode } from '../common/tenant-settings';

/** How long a call rings before it counts as not answered. */
export const RING_SECONDS = 45;
const room = (callId: string) => `call-${callId}`;

/**
 * App calls: free voice calls over the internet between two people in the Rumfa apps, through LiveKit
 * (self-hosted, or LiveKit Cloud). The call is a row in public.calls (route 'inapp'):
 * ringing → answered → completed, or no_answer / busy. Each change is announced live to both people;
 * the callee also gets a push notification.
 */
@Injectable()
export class AppCallsService {
  constructor(private readonly db: Db, private readonly providers: ProvidersService) {}

  /** Starts ringing `calleeId`. The caller joins the call room at once and waits for an answer. */
  async start(u: AuthUser, calleeId: string, opts: { caseId?: string; reason?: string } = {}) {
    await requireCallMode(this.db, u.tid, 'inapp');
    this.providers.livekitReady();
    if (calleeId === u.mid) throw new BadRequestException('You cannot call yourself');
    const [callee] = await this.db.system(
      `select id, full_name from public.volunteers where id = $1 and tenant_id = $2 and status <> 'removed'`, [calleeId, u.tid]);
    if (!callee) throw new NotFoundException('Person not found');
    if (await this.busy(callee.id)) throw new ConflictException(`${callee.full_name} is on another call`);
    const [me] = await this.db.system(`select full_name from public.volunteers where id = $1`, [u.mid]);
    const [call] = await this.db.system(
      `insert into public.calls (tenant_id, case_id, caller_id, callee_id, route, status, reason)
       values ($1, $2, $3, $4, 'inapp', 'ringing', $5) returning id`,
      [u.tid, opts.caseId ?? null, u.mid, callee.id, opts.reason ?? null]);
    await this.db.system(
      `insert into public.outbox (tenant_id, channel, to_volunteer, template, data) values ($1, 'push', $2, 'app_call', $3)`,
      [u.tid, callee.id, JSON.stringify({ call_id: call.id, name: me?.full_name ?? '' })]);
    if (opts.caseId) {
      await this.db.system(`select public.svc_case_event($1, 'call', $2, $3, $4)`,
        [opts.caseId, opts.reason ?? null, JSON.stringify({ call_id: call.id, to: callee.id, route: 'inapp' }), u.mid]);
    }
    return { callId: call.id, url: this.providers.livekitUrl(), token: this.providers.livekitCallToken(u.mid, me?.full_name ?? '', room(call.id)),
      ringSeconds: RING_SECONDS, callee: { id: callee.id, full_name: callee.full_name } };
  }

  /** The call as one of its two people sees it. */
  async get(u: AuthUser, id: string) {
    const [c] = await this.db.system(
      `select c.id, c.status, c.started_at, c.ended_at, c.caller_id, a.full_name as caller_name, c.callee_id, b.full_name as callee_name
         from public.calls c join public.volunteers a on a.id = c.caller_id join public.volunteers b on b.id = c.callee_id
        where c.id = $1 and c.tenant_id = $2 and c.route = 'inapp' and $3 in (c.caller_id, c.callee_id)`, [id, u.tid, u.mid]);
    if (!c) throw new NotFoundException('Call not found');
    const ringing = c.status === 'ringing' && Date.now() - new Date(c.started_at).getTime() < RING_SECONDS * 1000;
    return { id: c.id, status: c.status === 'ringing' && !ringing ? 'no_answer' : c.status, me: c.caller_id === u.mid ? 'caller' : 'callee',
      caller: { id: c.caller_id, full_name: c.caller_name }, callee: { id: c.callee_id, full_name: c.callee_name } };
  }

  /** Calls ringing for me now (for when the app opens or reconnects). */
  incoming(u: AuthUser) {
    return this.db.system(
      `select c.id, v.full_name as caller_name from public.calls c join public.volunteers v on v.id = c.caller_id
        where c.callee_id = $1 and c.tenant_id = $2 and c.route = 'inapp' and c.status = 'ringing'
          and c.started_at > now() - make_interval(secs => $3) order by c.started_at desc`, [u.mid, u.tid, RING_SECONDS]);
  }

  async answer(u: AuthUser, id: string) {
    this.providers.livekitReady();
    const [c] = await this.db.system(
      `update public.calls set status = 'answered', started_at = now()
        where id = $1 and tenant_id = $2 and route = 'inapp' and callee_id = $3 and status = 'ringing'
          and started_at > now() - make_interval(secs => $4) returning id`, [id, u.tid, u.mid, RING_SECONDS]);
    if (!c) throw new ConflictException('This call has ended');
    const [me] = await this.db.system(`select full_name from public.volunteers where id = $1`, [u.mid]);
    return { callId: id, url: this.providers.livekitUrl(), token: this.providers.livekitCallToken(u.mid, me?.full_name ?? '', room(id)) };
  }

  /** Hang up, decline, or give up ringing. Ending a call that already ended does nothing. */
  async end(u: AuthUser, id: string, reason: 'hangup' | 'declined' | 'timeout' = 'hangup') {
    const [c] = await this.db.system(
      `update public.calls set
          status = case when status = 'answered' then 'completed' when $4 = 'declined' then 'busy' else 'no_answer' end,
          duration_s = case when status = 'answered' then greatest(0, extract(epoch from now() - started_at))::int end,
          ended_at = now()
        where id = $1 and tenant_id = $2 and route = 'inapp' and $3 in (caller_id, callee_id) and status in ('ringing', 'answered')
        returning status, duration_s`, [id, u.tid, u.mid, reason]);
    return c ?? { status: 'ended' };
  }

  /** On a call now, or being rung by one that has not timed out. Answered calls older than 4 hours are stale. */
  private async busy(volunteerId: string): Promise<boolean> {
    const [r] = await this.db.system(
      `select 1 from public.calls where route = 'inapp' and $1 in (caller_id, callee_id)
          and ((status = 'ringing' and started_at > now() - make_interval(secs => $2))
            or (status = 'answered' and started_at > now() - interval '4 hours')) limit 1`, [volunteerId, RING_SECONDS]);
    return !!r;
  }
}
