import { Injectable, computed, signal } from '@angular/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

declare global {
  interface Window { ALAWA_CONFIG: { supabaseUrl: string; supabaseAnonKey: string; atWebrtcScript?: string } }
}

export interface Me {
  id: string; tenant_id: string; full_name: string; phone: string; role: string; level: string;
  area_code: string; languages: string[];
}

export const ROOM_ROLES = ['operator', 'supervisor', 'analyst', 'legal', 'security', 'admin'];

@Injectable({ providedIn: 'root' })
export class Supa {
  readonly client: SupabaseClient = createClient(window.ALAWA_CONFIG.supabaseUrl, window.ALAWA_CONFIG.supabaseAnonKey);
  readonly session = signal<Session | null>(null);
  readonly me = signal<Me | null>(null);
  readonly ready = signal(false);
  readonly liveElectionId = signal<string | null>(null);
  readonly baselineElectionId = signal<string | null>(null);

  readonly isSupervisor = computed(() => ['supervisor', 'admin'].includes(this.me()?.role ?? ''));
  readonly isAdmin = computed(() => this.me()?.role === 'admin');
  readonly isRoom = computed(() => ROOM_ROLES.includes(this.me()?.role ?? ''));

  constructor() {
    this.client.auth.onAuthStateChange((_e, s) => { this.session.set(s); void this.loadMe(); });
  }

  async init(): Promise<void> {
    const { data } = await this.client.auth.getSession();
    this.session.set(data.session);
    await this.loadMe();
    this.ready.set(true);
  }

  private async loadMe(): Promise<void> {
    const uid = this.session()?.user.id;
    if (!uid) { this.me.set(null); return; }
    const { data } = await this.client.from('volunteers')
      .select('id, tenant_id, full_name, phone, role, level, area_code, languages').eq('user_id', uid).maybeSingle();
    this.me.set(data as Me | null);
    const { data: te } = await this.client.from('tenant_elections').select('election_id, purpose');
    this.liveElectionId.set(te?.find((x) => x.purpose === 'live')?.election_id ?? null);
    this.baselineElectionId.set(te?.find((x) => x.purpose === 'baseline')?.election_id ?? null);
  }

  /** Call a Postgres function; throws with the database message on error. */
  async rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  }

  /** Call an Edge Function. */
  async fn<T = any>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.functions.invoke(name, { body });
    if (error) {
      let msg = error.message;
      try { msg = (await (error as any).context?.json())?.error ?? msg; } catch { /* keep message */ }
      throw new Error(msg);
    }
    return data as T;
  }

  async signedUrl(body: Record<string, unknown>): Promise<string> {
    return (await this.fn<{ url: string }>('media-url', body)).url;
  }
}
