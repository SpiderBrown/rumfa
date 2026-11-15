import type { Query } from '../database/db.service';

/**
 * Calls a database function by name with named arguments. Function and argument names come from code,
 * never from the request; values are always bound parameters.
 */
export async function callFn<T = any>(q: Query, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const keys = Object.keys(args).filter((k) => args[k] !== undefined);
  if (!/^[a-z_]+$/.test(name) || keys.some((k) => !/^p_[a-z_]+$/.test(k))) throw new Error('bad function call');
  const [row] = await q(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => jsonParam(args[k])));
  return row?.r as T;
}

/** For functions returning a table or set of rows. */
export async function selectFn<T = any>(q: Query, name: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const keys = Object.keys(args).filter((k) => args[k] !== undefined);
  if (!/^[a-z_]+$/.test(name) || keys.some((k) => !/^p_[a-z_]+$/.test(k))) throw new Error('bad function call');
  return q(`select * from public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => jsonParam(args[k])));
}

/** Plain objects go to jsonb parameters as JSON; arrays stay Postgres arrays. */
const jsonParam = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v);

/** The tenant's live and baseline elections. */
export async function elections(q: Query, tenantId: string): Promise<{ live: string | null; baseline: string | null }> {
  const rows = await q(`select election_id, purpose from public.tenant_elections where tenant_id = $1`, [tenantId]);
  return { live: rows.find((r) => r.purpose === 'live')?.election_id ?? null, baseline: rows.find((r) => r.purpose === 'baseline')?.election_id ?? null };
}
