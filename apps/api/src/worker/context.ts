import type { Db } from '../database/db.service';
import type { StorageService } from '../common/storage.service';

/**
 * The worker's jobs are plain functions; the NestJS entry point (worker.main.ts) hands them the database
 * and storage services once at start. The worker runs as the database owner: it works across clients.
 */
let ctx: { db: Db; storage: StorageService } | null = null;
export function setWorkerContext(c: { db: Db; storage: StorageService }) { ctx = c; }

export function q<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
  if (!ctx) throw new Error('worker context not set');
  return ctx.db.system<T>(sql, params);
}
export async function one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}
export function storage(): StorageService {
  if (!ctx) throw new Error('worker context not set');
  return ctx.storage;
}
export const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export const log = (scope: string, msg: string, extra?: unknown) =>
  console.log(`${new Date().toISOString()} [${scope}] ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`);

/** Insert or update one row; table and column names come from code only. */
export async function upsert(table: string, row: Record<string, unknown>, conflict: string[]): Promise<void> {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  if (![table, ...cols, ...conflict].every((n) => /^[a-z_]+$/.test(n))) throw new Error('bad identifier');
  const updates = cols.filter((c) => !conflict.includes(c)).map((c) => `${c} = excluded.${c}`);
  await q(
    `insert into public.${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     on conflict (${conflict.join(', ')}) do ${updates.length ? `update set ${updates.join(', ')}` : 'nothing'}`,
    cols.map((c) => row[c]));
}
