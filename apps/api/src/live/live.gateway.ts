import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Client, type ClientConfig } from 'pg';
import type { Server, Socket } from 'socket.io';
import { TokensService } from '../auth/tokens.service';
import type { AuthUser } from '../auth/auth.types';
import configuration from '../config/configuration';
import { Db } from '../database/db.service';
import { chainOf } from '../domain/cases.controller';
import { ROOM } from '../domain/roles';

/** What a change event may tell a client: ids and status only. */
const PUBLIC_KEYS = ['t', 'op', 'id', 'case_id', 'channel_id', 'status', 'pu_code', 'election_id', 'volunteer_id'];
const pick = (e: Record<string, any>) => Object.fromEntries(PUBLIC_KEYS.filter((k) => e[k] !== undefined && e[k] !== null).map((k) => [k, e[k]]));

const rooms = {
  staff: (tid: string) => `t:${tid}:staff`,
  area: (tid: string, code: string) => `t:${tid}:area:${code}`,
  member: (mid: string) => `m:${mid}`,
  case: (id: string) => `case:${id}`,
  channel: (id: string) => `ch:${id}`,
};

/**
 * Live updates over Socket.IO at /live. Clients connect with their access token. Each connection joins
 * rooms for what it may see: its own membership; area rooms for room staff and coordinators; and, on
 * request after an access check, one case or conversation. Events come from Postgres NOTIFY, so every
 * API instance hears every change and forwards it to its own connections.
 */
@WebSocketGateway({ path: '/live', cors: { origin: true } })
@Injectable()
export class LiveGateway implements OnGatewayConnection, OnApplicationBootstrap, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly log = new Logger('Live');
  private pg: Client | null = null;
  private stopped = false;

  constructor(private readonly tokens: TokensService, private readonly db: Db) {}

  handleConnection(socket: Socket) {
    let user: AuthUser & { exp?: number };
    try {
      user = this.tokens.verifyAccess(String(socket.handshake.auth?.token ?? '')) as any;
    } catch {
      socket.emit('error', { message: 'Sign in again' });
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;
    socket.join(rooms.member(user.mid));
    if (ROOM.includes(user.role)) socket.join(rooms.staff(user.tid));
    if (ROOM.includes(user.role) || user.role === 'coordinator') socket.join(rooms.area(user.tid, user.level === 'national' ? 'NG' : user.area));
    // The token is short-lived: drop the connection when it expires so the app reconnects with a fresh one
    const exp = (this.tokens.expiryOf(socket.handshake.auth?.token) ?? 0) * 1000 - Date.now();
    if (exp > 0) setTimeout(() => socket.disconnect(true), Math.min(exp, 2 ** 31 - 1)).unref();
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { case?: string; channel?: string }) {
    const user: AuthUser = socket.data.user;
    if (!user) return { ok: false };
    const uuid = /^[0-9a-f-]{36}$/;
    if (body?.case && uuid.test(body.case)) {
      const ok = (await this.db.asUser(user, (q) => q(`select 1 from public.cases where id = $1`, [body.case]))).length > 0;
      if (ok) socket.join(rooms.case(body.case));
      return { ok };
    }
    if (body?.channel && uuid.test(body.channel)) {
      const [{ ok }] = await this.db.asUser(user, (q) => q(`select app.can_access_channel($1) as ok`, [body.channel]));
      if (ok) socket.join(rooms.channel(body.channel));
      return { ok: !!ok };
    }
    return { ok: false };
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { case?: string; channel?: string }) {
    if (body?.case) socket.leave(rooms.case(body.case));
    if (body?.channel) socket.leave(rooms.channel(body.channel));
    return { ok: true };
  }

  /** Decides which rooms hear a change. Unknown tables go nowhere. */
  route(e: Record<string, any>) {
    const to = new Set<string>();
    const tid = e.tenant_id as string | undefined;
    if (!tid) return;
    switch (e.t) {
      case 'cases':
        for (const code of ['NG', ...chainOf(e.area_code ?? ''), e.area_code]) if (code) to.add(rooms.area(tid, code));
        if (e.assigned_to) to.add(rooms.member(e.assigned_to));
        to.add(rooms.case(e.id));
        break;
      case 'case_events': to.add(rooms.case(e.case_id)); break;
      case 'messages': to.add(rooms.channel(e.channel_id)); break;
      case 'callback_requests':
        if (e.requester_id) to.add(rooms.member(e.requester_id));
        if (e.assigned_to) to.add(rooms.member(e.assigned_to));
        if (e.status === 'escalated') to.add(rooms.staff(tid));
        break;
      case 'live_view_requests':
        for (const m of [e.agent_id, e.requested_by]) if (m) to.add(rooms.member(m));
        if (e.case_id) to.add(rooms.case(e.case_id));
        break;
      case 'live_counts': case 'checkins': case 'unit_figure_updates':
        to.add(rooms.staff(tid));
        for (const code of chainOf(e.pu_code ?? '')) to.add(rooms.area(tid, code));
        break;
      case 'calls':
        for (const m of [e.caller_id, e.callee_id]) if (m) to.add(rooms.member(m));
        break;
      case 'irev_fetch_jobs': case 'verifications': case 'staff_status':
        to.add(rooms.staff(tid));
        break;
      default: return;
    }
    if (to.size) this.server.to([...to]).emit('change', pick(e));
  }

  // ---- Postgres LISTEN ------------------------------------------------------------------------------
  async onApplicationBootstrap() {
    if (process.env.LIVE_UPDATES === 'off') return;
    await this.listen();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.pg?.end().catch(() => undefined);
  }

  private async listen(attempt = 0): Promise<void> {
    if (this.stopped) return;
    const { db } = configuration();
    const cfg: ClientConfig = db.url
      ? { connectionString: db.url, ssl: db.ssl ? { rejectUnauthorized: false } : false }
      : { host: db.host, port: db.port, user: db.username, password: db.password, database: db.database, ssl: db.ssl ? { rejectUnauthorized: false } : false };
    const client = new Client(cfg);
    const retry = () => {
      if (this.stopped) return;
      this.pg = null;
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      this.log.warn(`Lost the change feed; reconnecting in ${wait / 1000}s`);
      setTimeout(() => void this.listen(attempt + 1), wait).unref();
    };
    try {
      await client.connect();
      client.on('notification', (n) => {
        if (n.channel !== 'rumfa_changes' || !n.payload) return;
        try { this.route(JSON.parse(n.payload)); } catch (e) { this.log.error(`Bad change event: ${(e as Error).message}`); }
      });
      client.on('error', () => { client.end().catch(() => undefined); retry(); });
      await client.query('listen rumfa_changes');
      this.pg = client;
      attempt = 0;
    } catch (e) {
      this.log.error(`Change feed: ${(e as Error).message}`);
      await client.end().catch(() => undefined);
      retry();
    }
  }
}
