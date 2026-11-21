import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { ProvidersService } from '../common/providers.service';
import { requireCallMode } from '../common/tenant-settings';
import { publishChange } from '../live/live-bus';

/** How long a call rings before it counts as not answered. */
export const RING_SECONDS = 45;
const room = (callId: string) => `call-${callId}`;
/** Tells the two people on a call straight away (sockets), as the database's change feed would */
const announce = (op: 'insert' | 'update', c: { id: string; tenant_id: string; caller_id: string | null; callee_id: string | null; status: string }) =>
  publishChange({ t: 'calls', op, id: c.id, tenant_id: c.tenant_id, caller_id: c.caller_id, callee_id: c.callee_id, status: c.status });
export const groupRoom = (groupId: string) => `group-${groupId}`;
/** Who may start a group call, and how many people one can ring */
export const GROUP_CALLERS = ['coordinator', 'supervisor', 'admin'];
export const GROUP_MAX = 50;
const GROUP_ROLES = ['coordinator', 'agent', 'volunteer'];

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
    announce('insert', { id: call.id, tenant_id: u.tid, caller_id: u.mid, callee_id: callee.id, status: 'ringing' });
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
          and started_at > now() - make_interval(secs => $4)
          and (group_id is null or exists (select 1 from public.group_calls g where g.id = group_id and g.status = 'active'))
        returning id, group_id, tenant_id, caller_id, callee_id, status`, [id, u.tid, u.mid, RING_SECONDS]);
    if (!c) throw new ConflictException('This call has ended');
    announce('update', c);
    const [me] = await this.db.system(`select full_name from public.volunteers where id = $1`, [u.mid]);
    // A group call: everyone answers into the group's one room
    return { callId: id, url: this.providers.livekitUrl(), group: !!c.group_id,
      token: this.providers.livekitCallToken(u.mid, me?.full_name ?? '', c.group_id ? groupRoom(c.group_id) : room(id)) };
  }

  /** Hang up, decline, or give up ringing. Ending a call that already ended does nothing. */
  async end(u: AuthUser, id: string, reason: 'hangup' | 'declined' | 'timeout' = 'hangup') {
    const [c] = await this.db.system(
      `update public.calls set
          status = case when status = 'answered' then 'completed' when $4 = 'declined' then 'busy' else 'no_answer' end,
          duration_s = case when status = 'answered' then greatest(0, extract(epoch from now() - started_at))::int end,
          ended_at = now()
        where id = $1 and tenant_id = $2 and route = 'inapp' and $3 in (caller_id, callee_id) and status in ('ringing', 'answered')
        returning id, tenant_id, caller_id, callee_id, status, duration_s`, [id, u.tid, u.mid, reason]);
    if (c) announce('update', c);
    return c ?? { status: 'ended' };
  }


  // ---- Group calls ---------------------------------------------------------------------------------
  /** Who a group call would ring: active people of these roles in the area (inside the caller's own area), not the caller. */
  async groupAudience(u: AuthUser, area: string, roles: string[], max = GROUP_MAX) {
    if (!GROUP_CALLERS.includes(u.role)) throw new ForbiddenException('Group calls and voice messages are for coordinators, supervisors and admins');
    const r = roles.filter((x) => GROUP_ROLES.includes(x));
    if (!r.length) throw new BadRequestException('Choose who to call');
    const [me] = await this.db.system(`select area_code from public.volunteers where id = $1`, [u.mid]);
    const mine = me?.area_code ?? 'NG';
    if (mine !== 'NG' && !(area === mine || area.startsWith(mine + '-'))) throw new ForbiddenException('That area is outside yours');
    const people = await this.db.system<{ id: string; full_name: string; phone: string; role: string; level: string; area_code: string }>(
      `select id, full_name, phone, role, level, area_code from public.volunteers
        where tenant_id = $1 and status = 'active' and id <> $2 and role = any($3)
          and ($4 = 'NG' or area_code = $4 or area_code like $4 || '-%')
        order by case role when 'coordinator' then 0 else 1 end, length(area_code), full_name limit ${max + 1}`,
      [u.tid, u.mid, r, area]);
    return { roles: r, people: people.slice(0, max), more: people.length > max };
  }

  /** Rings everyone in the app into one room. The caller joins at once. */
  async startGroup(u: AuthUser, area: string, roles: string[], title: string) {
    await requireCallMode(this.db, u.tid, 'inapp');
    this.providers.livekitReady();
    const a = await this.groupAudience(u, area, roles);
    if (!a.people.length) throw new BadRequestException('Nobody to call there');
    if (a.more) throw new BadRequestException(`Up to ${GROUP_MAX} people in one call. Choose a smaller area or fewer roles.`);
    const [me] = await this.db.system(`select full_name from public.volunteers where id = $1`, [u.mid]);
    const [g] = await this.db.system(
      `insert into public.group_calls (tenant_id, created_by, area_code, roles, title) values ($1, $2, $3, $4, $5) returning id`,
      [u.tid, u.mid, area, a.roles, title]);
    for (const p of a.people) {
      const busy = await this.busy(p.id);
      const [call] = await this.db.system(
        `insert into public.calls (tenant_id, caller_id, callee_id, route, status, reason, group_id, ended_at)
         values ($1, $2, $3, 'inapp', $4, $5, $6, case when $4 = 'busy' then now() end) returning id`,
        [u.tid, u.mid, p.id, busy ? 'busy' : 'ringing', title, g.id]);
      announce('insert', { id: call.id, tenant_id: u.tid, caller_id: u.mid, callee_id: p.id, status: busy ? 'busy' : 'ringing' });
      if (!busy) {
        await this.db.system(
          `insert into public.outbox (tenant_id, channel, to_volunteer, template, data) values ($1, 'push', $2, 'app_call', $3)`,
          [u.tid, p.id, JSON.stringify({ call_id: call.id, name: `${me?.full_name ?? ''} · ${title}`, group: true })]);
      }
    }
    return { groupId: g.id, url: this.providers.livekitUrl(), token: this.providers.livekitCallToken(u.mid, me?.full_name ?? '', groupRoom(g.id)),
      ringSeconds: RING_SECONDS, canPhone: this.canPhone() };
  }

  /** Phones into a group call are possible: Africa's Talking voice and the LiveKit SIP address are set up */
  canPhone() { return this.providers.atVoiceReady() && !!this.providers.livekitSipDial('x'); }

  /** The group call and where each person is: in the app, on the phone, ringing, not answered, busy */
  async group(u: AuthUser, id: string) {
    const [g] = await this.db.system(
      `select g.*, v.full_name as caller_name from public.group_calls g join public.volunteers v on v.id = g.created_by
        where g.id = $1 and g.tenant_id = $2`, [id, u.tid]);
    if (!g || (g.created_by !== u.mid && !['supervisor', 'admin'].includes(u.role))) throw new NotFoundException('Group call not found');
    const legs = await this.db.system(
      `select c.id, c.callee_id, c.route, c.status, c.started_at, v.full_name, v.role, v.area_code, v.phone
         from public.calls c join public.volunteers v on v.id = c.callee_id where c.group_id = $1 order by v.full_name, c.started_at`, [id]);
    const by = new Map<string, any>();
    for (const l of legs) {
      const ringing = l.status === 'ringing' && Date.now() - new Date(l.started_at).getTime() < RING_SECONDS * 1000;
      const status = l.status === 'ringing' && !ringing && l.route === 'inapp' ? 'no_answer' : l.status;
      const cur = by.get(l.callee_id) ?? { id: l.callee_id, full_name: l.full_name, role: l.role, area_code: l.area_code, app: null, phone: null };
      if (l.route === 'inapp') cur.app = status; else cur.phone = status;
      by.set(l.callee_id, cur);
    }
    return { id: g.id, title: g.title, status: g.status, area_code: g.area_code, roles: g.roles, started_at: g.started_at, caller: g.caller_name,
      canPhone: this.canPhone(), people: [...by.values()] };
  }

  /** Phones people who didn't pick up in the app (the caller has confirmed: minutes cost money). */
  async phoneGroup(u: AuthUser, id: string, ids: string[]) {
    const g = await this.group(u, id);
    if (g.status !== 'active') throw new ConflictException('This group call has ended');
    if (!g.canPhone) throw new ServiceUnavailableException("Phoning into a group call needs Africa's Talking voice and LiveKit SIP (LIVEKIT_SIP_DIAL) set up.");
    const want = g.people.filter((p: any) => ids.includes(p.id) && p.app !== 'answered' && !['ringing', 'answered'].includes(p.phone));
    let placed = 0;
    for (const p of want) {
      const [v] = await this.db.system(`select phone from public.volunteers where id = $1`, [p.id]);
      const [call] = await this.db.system(
        `insert into public.calls (tenant_id, caller_id, callee_id, to_phone, route, status, reason, group_id)
         values ($1, $2, $3, $4, 'group_phone', 'ringing', $5, $6) returning id`, [u.tid, u.mid, p.id, v.phone, g.title, id]);
      try {
        const session = await this.providers.atMakeCall(v.phone, call.id);
        if (session) await this.db.system(`update public.calls set provider_session_id = $2 where id = $1`, [call.id, session]);
        placed++;
      } catch {
        await this.db.system(`update public.calls set status = 'failed', ended_at = now() where id = $1`, [call.id]);
      }
    }
    return { placed, skipped: ids.length - placed };
  }

  /** The caller ends the group call: anyone still ringing stops; everyone is let go. */
  async endGroup(u: AuthUser, id: string) {
    const [g] = await this.db.system(
      `update public.group_calls set status = 'ended', ended_at = now() where id = $1 and tenant_id = $2 and status = 'active'
          and (created_by = $3 or $4) returning id`, [id, u.tid, u.mid, ['supervisor', 'admin'].includes(u.role)]);
    if (!g) return { status: 'ended' };
    const ended = await this.db.system(
      `update public.calls set
          status = case when status = 'answered' then 'completed' else 'no_answer' end,
          duration_s = case when status = 'answered' then greatest(0, extract(epoch from now() - started_at))::int end,
          ended_at = now()
        where group_id = $1 and status in ('ringing', 'answered', 'initiated')
        returning id, tenant_id, caller_id, callee_id, status`, [id]);
    for (const c of ended) announce('update', c);
    return { status: 'ended' };
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
