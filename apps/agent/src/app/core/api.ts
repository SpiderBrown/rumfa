import { Injectable, computed, signal } from '@angular/core';
import { io, type Socket } from 'socket.io-client';

declare global {
  interface Window { RUMFA_CONFIG: { apiUrl: string; smsNumber: string; helpline?: string; brand?: string; atWebrtcScript?: string; partyLogos?: string; mapTiles?: { url: string; attribution?: string } } }
}

export interface Me {
  id: string; tenant_id: string; full_name: string; phone: string; role: string; level: string; area_code: string;
  agent_code: string | null; languages: string[]; network: string | null; onboarded_at: string | null; deputy_of: string | null; brand: string;
}
/** Ways the organisation lets people call from the app (its admins switch these on or off). */
export interface CallOptions { phone: boolean; bridged: boolean; webrtc: boolean; inapp: boolean }
export interface Membership { mid: string; tid: string; brand: string; name: string; role: string; level: string; area: string }
export interface Change { t: string; op: string; id?: string; case_id?: string; channel_id?: string; status?: string }
interface Session { accessToken: string; refreshToken: string; expiresIn: number; membership: Membership }
interface Device { phone: string; deviceId: string; deviceSecret: string }
export type SignIn = { done: true } | { done: false; selectToken: string; memberships: Membership[] };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
  get network() { return this.status === 0 || this.status >= 500; }
}

const K = { device: 'rumfa.device', session: 'rumfa.session', context: 'rumfa.context' };
const read = <T>(k: string): T | null => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };

/**
 * The agent app's only way to the backend: the Rumfa API. One app for every client: after activation the
 * person picks which organisation they work for (when they have several) and the session carries that one.
 * The profile is cached so the app keeps working offline.
 */
@Injectable({ providedIn: 'root' })
export class Api {
  readonly config = window.RUMFA_CONFIG;
  private readonly base = this.config.apiUrl.replace(/\/+$/, '');
  private device: Device | null = read<Device>(K.device);
  private sess: Session | null = read<Session>(K.session);
  private refreshing: Promise<boolean> | null = null;
  private socket: Socket | null = null;
  private listeners = new Set<(c: Change) => void>();
  private follows = new Set<string>();

  readonly session = signal<Session | null>(this.sess);
  readonly me = signal<Me | null>(read<any>(K.context)?.me ?? null);
  readonly parties = signal<string[]>(read<any>(K.context)?.parties ?? []);
  /** The organisation's own party on this ballot, if set (shown first and largest on the live count) */
  readonly ownParty = signal<string | null>(read<any>(K.context)?.ownParty ?? null);
  readonly otherMemberships = signal<Membership[]>(read<any>(K.context)?.otherMemberships ?? []);
  readonly callOptions = signal<CallOptions>(read<any>(K.context)?.calls ?? { phone: true, bridged: false, webrtc: false, inapp: false });
  readonly brand = signal<string>(this.me()?.brand ?? this.config.brand ?? 'Rumfa');
  readonly isAgent = computed(() => this.me()?.role === 'agent');
  readonly isCoordinator = computed(() => this.me()?.role === 'coordinator');
  readonly atUnit = computed(() => this.me()?.level === 'pu');

  /** Logo picture for a party, from the app's config (files you place in public/parties by default); '' for none */
  partyLogo(party: string): string {
    const pattern = this.config.partyLogos ?? 'parties/{party}.png';
    return pattern ? pattern.replace('{party}', party.toLowerCase()) : '';
  }

  hasDevice() { return !!this.device; }
  devicePhone() { return this.device?.phone ?? ''; }

  async init(): Promise<void> {
    if (this.sess) await this.refreshMe().catch(() => undefined); // offline: keep the cached profile
  }

  // ---- Activation and sign-in -----------------------------------------------------------------------
  requestCode(phone: string, channel: 'sms' | 'whatsapp') {
    return this.call<{ sent: boolean; expiresInMinutes: number }>('POST', '/auth/activate/request', { phone, channel }, false);
  }

  /** Activates this phone (code from SMS/WhatsApp, or a coordinator's activation code) and sets the PIN. */
  async activate(phone: string, pin: string, proof: { code?: string; activationCode?: string }): Promise<SignIn> {
    const r = await this.call<any>('POST', '/auth/activate/verify', { phone, pin, platform: 'android', deviceName: navigator.userAgent.slice(0, 80), ...proof }, false);
    this.device = { phone, deviceId: r.deviceId, deviceSecret: r.deviceSecret };
    localStorage.setItem(K.device, JSON.stringify(this.device));
    return this.after(r);
  }

  /** Daily sign-in on an activated phone. */
  async pinSignIn(pin: string, tenantId?: string): Promise<SignIn> {
    if (!this.device) throw new ApiError(401, 'Activate this phone first');
    try {
      return this.after(await this.call<any>('POST', '/auth/pin', { phone: this.device.phone, pin, ...this.deviceProof(), tenantId }, false));
    } catch (e) {
      // A revoked or locked phone must be activated again
      if (e instanceof ApiError && /Activate/.test(e.message)) this.forgetDevice();
      throw e;
    }
  }

  async selectTenant(selectToken: string, tenantId: string): Promise<void> {
    await this.after(await this.call<any>('POST', '/auth/select-tenant', { selectToken, tenantId }, false));
  }

  /** Same phone, another organisation (people recruited by more than one client). */
  async switchTenant(tenantId: string): Promise<void> {
    await this.after(await this.call<any>('POST', '/auth/switch-tenant', { tenantId }));
  }

  private deviceProof() { return { deviceId: this.device!.deviceId, deviceSecret: this.device!.deviceSecret }; }

  private async after(r: any): Promise<SignIn> {
    if (r.chooseTenant) return { done: false, selectToken: r.selectToken, memberships: r.memberships };
    this.saveSession(r.session);
    await this.refreshMe();
    return { done: true };
  }

  private saveSession(s: Session | null) {
    this.sess = s;
    this.session.set(s);
    if (s) localStorage.setItem(K.session, JSON.stringify(s)); else localStorage.removeItem(K.session);
  }

  async refreshMe(): Promise<void> {
    const [ctx, me] = await Promise.all([this.call<any>('GET', '/me/context'), this.call<any>('GET', '/auth/me')]);
    const cache = { me: ctx.me, parties: ctx.parties, categories: ctx.categories, otherMemberships: me.otherMemberships, calls: ctx.calls, ownParty: ctx.ownParty ?? null };
    localStorage.setItem(K.context, JSON.stringify(cache));
    this.me.set(ctx.me);
    this.parties.set(ctx.parties);
    this.ownParty.set(ctx.ownParty ?? null);
    if (ctx.calls) this.callOptions.set(ctx.calls);
    this.otherMemberships.set(me.otherMemberships);
    this.brand.set(ctx.me.brand);
    this.connectLive();
  }

  /** Ends the session; the phone stays activated, so the PIN signs in again. */
  async signOut() {
    if (this.sess) await this.call('POST', '/auth/logout', { refreshToken: this.sess.refreshToken }, false).catch(() => undefined);
    this.saveSession(null);
    this.me.set(null);
    localStorage.removeItem(K.context);
    this.socket?.disconnect();
    this.socket = null;
  }

  forgetDevice() {
    this.device = null;
    localStorage.removeItem(K.device);
  }

  // ---- HTTP -------------------------------------------------------------------------------------
  get<T = any>(path: string, query?: Record<string, unknown>) { return this.call<T>('GET', path + qs(query)); }
  post<T = any>(path: string, body?: unknown) { return this.call<T>('POST', path, body); }
  put<T = any>(path: string, body?: unknown) { return this.call<T>('PUT', path, body); }

  private async call<T>(method: string, path: string, body?: unknown, auth = true, retried = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.sess) headers['Authorization'] = `Bearer ${this.sess.accessToken}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'No connection');
    }
    if (res.status === 401 && auth && this.sess && !retried) {
      if (await this.refresh()) return this.call<T>(method, path, body, auth, true);
      this.saveSession(null); // the app asks for the PIN again
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, Array.isArray(data?.message) ? data.message.join('; ') : data?.message ?? `Request failed (${res.status})`);
    return data as T;
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try { this.saveSession(await this.call<Session>('POST', '/auth/refresh', { refreshToken: this.sess!.refreshToken }, false, true)); return true; }
      catch (e) { return e instanceof ApiError && e.network ? true : false; } // offline: keep the session for later
      finally { setTimeout(() => (this.refreshing = null)); }
    })();
    return this.refreshing;
  }

  // ---- Files ------------------------------------------------------------------------------------
  async upload(kind: string, blob: Blob, ext: string, pu?: string): Promise<string> {
    const u = await this.post<{ path: string; url: string; method: string; headers: Record<string, string> }>('/media/upload-url', { kind, ext, pu });
    let res: Response;
    try {
      res = await fetch(u.url, { method: u.method, headers: { 'Content-Type': blob.type || 'application/octet-stream', ...u.headers }, body: blob });
    } catch { throw new ApiError(0, 'No connection'); }
    if (!res.ok) throw new ApiError(res.status >= 500 ? res.status : 0, 'Upload failed');
    return u.path;
  }

  // ---- Live updates -----------------------------------------------------------------------------
  private connectLive() {
    if (this.socket || !this.sess) return;
    this.socket = io(this.base, { path: '/live', transports: ['websocket'], auth: (cb) => cb({ token: this.sess?.accessToken ?? '' }) });
    this.socket.on('change', (c: Change) => this.listeners.forEach((l) => l(c)));
    this.socket.on('connect', () => this.follows.forEach((f) => this.socket!.emit('subscribe', JSON.parse(f))));
    this.socket.on('disconnect', async (reason) => {
      if (this.sess && reason === 'io server disconnect') { await this.refresh(); this.socket?.connect(); }
    });
  }
  onChange(fn: (c: Change) => void, tables?: string[]): () => void {
    const l = (c: Change) => { if (!tables || tables.includes(c.t)) fn(c); };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  follow(target: { case?: string; channel?: string }): () => void {
    const key = JSON.stringify(target);
    this.follows.add(key);
    this.socket?.emit('subscribe', target);
    return () => { this.follows.delete(key); this.socket?.emit('unsubscribe', target); };
  }
}

function qs(q?: Record<string, unknown>): string {
  if (!q) return '';
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
}
