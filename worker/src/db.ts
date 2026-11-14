import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.ts';

let client: SupabaseClient | null = null;

/** Service-role client (bypasses RLS). The worker is trusted server code. */
export function db(): SupabaseClient {
  client ??= createClient(config.supabaseUrl(), config.serviceKey(), { auth: { persistSession: false } });
  return client;
}

/** Throw on Supabase errors so callers can use plain async/await. */
export function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

export const log = (scope: string, msg: string, extra?: unknown) =>
  console.log(`${new Date().toISOString()} [${scope}] ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`);
