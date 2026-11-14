import { Injectable, computed, signal } from '@angular/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

declare global {
  interface Window { ALAWA_CONFIG: { supabaseUrl: string; supabaseAnonKey: string; smsNumber: string; helpline?: string } }
}

export interface Me {
  id: string; tenant_id: string; full_name: string; phone: string; role: string; level: string; area_code: string;
  agent_code: string | null; languages: string[]; network: string | null; onboarded_at: string | null; deputy_of: string | null;
}

@Injectable({ providedIn: 'root' })
export class Supa {
  readonly client: SupabaseClient = createClient(window.ALAWA_CONFIG.supabaseUrl, window.ALAWA_CONFIG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  readonly session = signal<Session | null>(null);
  readonly me = signal<Me | null>(this.cachedMe());
  readonly parties = signal<string[]>(JSON.parse(localStorage.getItem('alawa.parties') ?? '[]'));
  readonly isAgent = computed(() => this.me()?.role === 'agent');
  readonly isCoordinator = computed(() => this.me()?.role === 'coordinator');
  readonly atUnit = computed(() => this.me()?.level === 'pu');

  async init(): Promise<void> {
    const { data } = await this.client.auth.getSession();
    this.session.set(data.session);
    this.client.auth.onAuthStateChange((_e, s) => this.session.set(s));
    if (data.session) await this.refreshMe().catch(() => { /* offline: keep cached profile */ });
  }

  private cachedMe(): Me | null { try { return JSON.parse(localStorage.getItem('alawa.me') ?? 'null'); } catch { return null; } }

  async refreshMe(): Promise<void> {
    const uid = (await this.client.auth.getUser()).data.user?.id;
    if (!uid) return;
    const { data, error } = await this.client.from('volunteers')
      .select('id, tenant_id, full_name, phone, role, level, area_code, agent_code, languages, network, onboarded_at, deputy_of')
      .eq('user_id', uid).maybeSingle();
    if (error) throw error;
    this.me.set(data as Me | null);
    localStorage.setItem('alawa.me', JSON.stringify(data));
    // Ballot parties of the live election (cached for offline result entry)
    const { data: te } = await this.client.from('tenant_elections').select('election_id').eq('purpose', 'live').maybeSingle();
    if (te) {
      const { data: ps } = await this.client.from('election_parties').select('party').eq('election_id', te.election_id).order('ballot_order');
      const list = (ps ?? []).map((p) => p.party);
      this.parties.set(list);
      localStorage.setItem('alawa.parties', JSON.stringify(list));
    }
  }

  async rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw Object.assign(new Error(error.message), { business: !!error.code && error.code !== 'PGRST301' });
    return data as T;
  }

  async fn<T = any>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.functions.invoke(name, { body });
    if (error) throw error;
    return data as T;
  }

  async signOut() {
    await this.client.auth.signOut();
    localStorage.removeItem('alawa.me');
    localStorage.removeItem('alawa.pin');
    this.me.set(null);
  }
}
