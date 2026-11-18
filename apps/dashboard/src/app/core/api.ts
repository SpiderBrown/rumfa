import { Injectable, computed, signal } from '@angular/core';
import { io, type Socket } from 'socket.io-client';

declare global {
  interface Window {
    RUMFA_CONFIG: { apiUrl: string; tenantId: string; brand?: string; atWebrtcScript?: string; mapTiles?: { url: string; attribution?: string } };
  }
}

export interface Me {
  id: string; tenant_id: string; full_name: string; phone: string; email: string | null; role: string; level: string;
  area_code: string; languages: string[]; brand: string;
}
export interface Change { t: string; op: string; id?: string; case_id?: string; channel_id?: string; status?: string; pu_code?: string }
interface Session { accessToken: string; refreshToken: string; expiresIn: number; membership: { mid: string; tid: string; brand: string; role: string } }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const ROOM_ROLES = ['operator', 'supervisor', 'analyst', 'legal', 'security', 'admin'];
const STORE = 'rumfa.room.session';

/**
 * The dashboard's only way to the backend: the Rumfa API (REST + Socket.IO live updates).
 * This site belongs to one client (RUMFA_CONFIG.tenantId); sign-in is refused for other clients' staff.
 */
@Injectable({ providedIn: 'root' })
export class Api {
  readonly config = window.RUMFA_CONFIG;
  private readonly base = this.config.apiUrl.replace(/\/+$/, '');
  private session: Session | null = null;
  private refreshing: Promise<boolean> | null = null;
  private socket: Socket | null = null;
  private listeners = new Set<(c: Change) => void>();
  private subscriptions = new Set<string>();

  readonly me = signal<Me | null>(null);
  readonly ready = signal(false);
  readonly brand = signal<string>(this.config.brand ?? 'Rumfa');
  readonly liveElectionId = signal<string | null>(null);
  readonly baselineElectionId = signal<string | null>(null);
  readonly parties = signal<string[]>([]);
  /** Party colours from Rumfa Console's Parties page */
  readonly partyColours = signal<Record<string, string>>({});
  readonly categories = signal<{ code: string; label: string; severity: string; queue_kind: string }[]>([]);
  readonly staffStatus = signal<string | null>(null);
  /** Calling options the organisation allows (dashboard → Settings). */
  /** Premium add-ons Rumfa has switched on for this organisation (Rumfa Console) */
  readonly addons = signal<{ voice: boolean; airtime: boolean }>({ voice: false, airtime: false });
  readonly callOptions = signal<{ phone: boolean; bridged: boolean; webrtc: boolean; inapp: boolean }>({ phone: true, bridged: true, webrtc: false, inapp: false });

  readonly isSupervisor = computed(() => ['supervisor', 'admin'].includes(this.me()?.role ?? ''));
  readonly isAdmin = computed(() => this.me()?.role === 'admin');
  readonly isRoom = computed(() => ROOM_ROLES.includes(this.me()?.role ?? ''));

  async init(): Promise<void> {
    try { this.session = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { this.session = null; }
    // A refused session signs out; a dropped connection or a server hiccup is tried again (it should not)
    for (let attempt = 1; this.session && !this.me(); attempt++) {
      try { await this.loadContext(); } catch (e) {
        const refused = e instanceof ApiError && (e.status === 401 || e.status === 403);
        if (refused || attempt >= 4) { if (refused) this.clear(); break; }
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    this.ready.set(true);
  }

  private save(s: Session | null) {
    this.session = s;
    if (s) localStorage.setItem(STORE, JSON.stringify(s)); else localStorage.removeItem(STORE);
  }
  private clear() { this.save(null); this.me.set(null); this.socket?.disconnect(); this.socket = null; }

  async loadContext(): Promise<void> {
    const ctx = await this.get<any>('/me/context');
    this.me.set(ctx.me);
    this.brand.set(ctx.me.brand);
    document.title = `${ctx.me.brand} · Rumfa Room`;
    this.liveElectionId.set(ctx.elections.live);
    this.baselineElectionId.set(ctx.elections.baseline);
    this.parties.set(ctx.parties);
    this.partyColours.set(ctx.partyColours ?? {});
    this.categories.set(ctx.categories);
    this.staffStatus.set(ctx.staffStatus);
    if (ctx.calls) this.callOptions.set(ctx.calls);
    this.addons.set(ctx.addons ?? { voice: false, airtime: false });
    this.connectLive();
  }

  // ---- Sign-in ------------------------------------------------------------------------------------
  /** Email + password (Rumfa owners and staff open this site's client as support). */
  async login(email: string, password: string) {
    await this.start((await this.post<any>('/auth/login', { email, password, tenantId: this.config.tenantId }, false)).session);
  }
  acceptInvite(token: string, password: string) { return this.post<{ email: string; existingAccount: boolean }>('/auth/invite/accept', { token, password }, false); }
  /** "Open dashboard as admin" from Rumfa Console: the one-time ticket from the address signs in as Rumfa support. */
  async supportTicket(ticket: string) {
    if (this.session) await this.signOut();
    await this.start((await this.post<any>('/auth/support/ticket', { ticket }, false)).session);
  }
  /** Signed in as Rumfa support (not one of the client's own people). */
  readonly isSupport = computed(() => (this.me()?.full_name ?? '').startsWith('Rumfa support'));

  private async start(s: Session) {
    this.save(s);
    await this.loadContext();
  }

  async signOut() {
    const s = this.session;
    if (this.isRoom()) await this.put('/me/status', { status: 'offline' }).catch(() => undefined);
    if (s) await this.post('/auth/logout', { refreshToken: s.refreshToken }, false).catch(() => undefined);
    this.clear();
  }

  // ---- HTTP ---------------------------------------------------------------------------------------
  get<T = any>(path: string, query?: Record<string, unknown>) { return this.request<T>('GET', path + qs(query)); }
  post<T = any>(path: string, body?: unknown, auth = true) { return this.request<T>('POST', path, body, auth); }
  put<T = any>(path: string, body?: unknown) { return this.request<T>('PUT', path, body); }
  patch<T = any>(path: string, body?: unknown) { return this.request<T>('PATCH', path, body); }
  del<T = any>(path: string) { return this.request<T>('DELETE', path); }

  private async request<T>(method: string, path: string, body?: unknown, auth = true, retried = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.session) headers['Authorization'] = `Bearer ${this.session.accessToken}`;
    const res = await fetch(`${this.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && auth && this.session && !retried) {
      if (await this.refresh()) return this.request<T>(method, path, body, auth, true);
      this.clear();
      if (!location.pathname.startsWith('/login')) location.assign('/'); // the app opens the sign-in page
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, Array.isArray(data?.message) ? data.message.join('; ') : data?.message ?? `Request failed (${res.status})`);
    return data as T;
  }

  /** One refresh at a time; the refresh token is single-use. */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const s = await this.request<Session>('POST', '/auth/refresh', { refreshToken: this.session!.refreshToken }, false, true);
        this.save(s);
        return true;
      } catch { return false; } finally { setTimeout(() => (this.refreshing = null)); }
    })();
    return this.refreshing;
  }

  // ---- Files --------------------------------------------------------------------------------------
  async viewUrl(body: Record<string, unknown>): Promise<string> {
    return (await this.post<{ url: string }>('/media/view-url', body)).url;
  }
  /** Uploads one file through a short-lived link; returns the stored path to attach to a record. */
  async upload(kind: string, file: Blob, ext: string, pu?: string): Promise<string> {
    const u = await this.post<{ path: string; url: string; method: string; headers: Record<string, string> }>('/media/upload-url', { kind, ext, pu });
    const res = await fetch(u.url, { method: u.method, headers: { 'Content-Type': file.type || 'application/octet-stream', ...u.headers }, body: file });
    if (!res.ok) throw new ApiError(res.status, 'Upload failed');
    return u.path;
  }

  // ---- Live updates -------------------------------------------------------------------------------
  private connectLive() {
    if (this.socket) return;
    this.socket = io(this.base, {
      path: '/live', transports: ['websocket'],
      auth: (cb) => cb({ token: this.session?.accessToken ?? '' }),
    });
    this.socket.on('change', (c: Change) => this.listeners.forEach((l) => l(c)));
    this.socket.on('connect', () => this.subscriptions.forEach((s) => this.socket!.emit('subscribe', JSON.parse(s))));
    // The server drops the connection when the token expires: refresh, then reconnect
    this.socket.on('disconnect', async (reason) => {
      if (!this.session) return;
      if (reason === 'io server disconnect') { await this.refresh(); this.socket?.connect(); }
    });
  }

  /** Listen to changes; returns a function that stops listening. */
  onChange(fn: (c: Change) => void, tables?: string[]): () => void {
    const l = (c: Change) => { if (!tables || tables.includes(c.t)) fn(c); };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** Receive a case's timeline or a conversation's messages (the server checks access). */
  follow(target: { case?: string; channel?: string }): () => void {
    const key = JSON.stringify(target);
    this.subscriptions.add(key);
    this.socket?.emit('subscribe', target);
    return () => { this.subscriptions.delete(key); this.socket?.emit('unsubscribe', target); };
  }
}

function qs(q?: Record<string, unknown>): string {
  if (!q) return '';
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
}
