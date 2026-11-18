import { Injectable, signal } from '@angular/core';

declare global {
  interface Window { RUMFA_CONSOLE: { apiUrl: string; dashboardUrl: string } }
}

export interface Staff { id: string; email: string; full_name: string; role: 'owner' | 'staff' | 'support' }
interface Session { accessToken: string; refreshToken: string; expiresIn: number }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const STORE = 'rumfa.console.session';

/**
 * The console's only way to the backend: the Rumfa API's /platform endpoints, with a console session (Rumfa staff,
 * never a client's). Kept in this tab only: closing the browser signs out.
 */
@Injectable({ providedIn: 'root' })
export class Api {
  readonly config = window.RUMFA_CONSOLE;
  private readonly base = this.config.apiUrl.replace(/\/+$/, '');
  private session: Session | null = null;
  private refreshing: Promise<boolean> | null = null;
  readonly me = signal<Staff | null>(null);

  get canEdit() { return this.me()?.role === 'owner' || this.me()?.role === 'staff'; }
  get isOwner() { return this.me()?.role === 'owner'; }

  async init() {
    try { this.session = JSON.parse(sessionStorage.getItem(STORE) ?? 'null'); } catch { this.session = null; }
    if (this.session) await this.loadMe().catch(() => this.clear());
  }
  private async loadMe() { this.me.set(await this.get<Staff>('/platform/auth/me')); }
  private save(s: Session | null) {
    this.session = s;
    try { if (s) sessionStorage.setItem(STORE, JSON.stringify(s)); else sessionStorage.removeItem(STORE); } catch { /* private mode */ }
  }
  private clear() { this.save(null); this.me.set(null); }

  // ---- Sign-in: email and password ----------------------------------------------------------------
  async login(email: string, password: string) { await this.start((await this.post<any>('/platform/auth/login', { email, password }, false)).session); }
  acceptInvite(token: string, password: string) { return this.post<{ email: string }>('/platform/auth/invite/accept', { token, password }, false); }
  private async start(s: Session) { this.save(s); await this.loadMe(); }
  async signOut() {
    if (this.session) await this.post('/platform/auth/logout', { refreshToken: this.session.refreshToken }, false).catch(() => undefined);
    this.clear();
  }

  /** A client's dashboard address: its own if it has one, else the shared one from config.js. */
  dashboardBase(domains: string[] = []) {
    const d = domains[0];
    return d ? `${/^(localhost|127\.)/.test(d) ? 'http' : 'https'}://${d}` : this.config.dashboardUrl.replace(/\/+$/, '');
  }
  /** A client dashboard invite link. */
  dashboardInvite(token: string, domains: string[] = []) { return `${this.dashboardBase(domains)}/login?invite=${encodeURIComponent(token)}`; }
  consoleInvite(token: string) { return `${location.origin}/invite?token=${encodeURIComponent(token)}`; }
  /** A party logo address from the API (relative to the API). */
  asset(path: string | null | undefined) { return path ? this.base + path : null; }

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
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new ApiError(0, 'No connection to the Rumfa API'); }
    if (res.status === 401 && auth && this.session && !retried) {
      if (await this.refresh()) return this.request<T>(method, path, body, auth, true);
      this.clear();
      location.assign('/login');
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, Array.isArray(data.message) ? data.message.join('; ') : data.message ?? `Error ${res.status}`);
    return data as T;
  }

  /** One refresh at a time; the refresh token is single-use. */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        this.save(await this.request<Session>('POST', '/platform/auth/refresh', { refreshToken: this.session!.refreshToken }, false, true));
        return true;
      } catch { return false; } finally { setTimeout(() => (this.refreshing = null)); }
    })();
    return this.refreshing;
  }
}

function qs(q?: Record<string, unknown>): string {
  const e = Object.entries(q ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? '?' + e.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
}
