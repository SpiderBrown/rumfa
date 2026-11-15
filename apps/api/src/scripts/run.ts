import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { rows } from '../database/db.service';

export type Q = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Runs a one-off script against the configured database (as the owner; no migrations). */
export async function withDb(fn: (q: Q) => Promise<void>): Promise<void> {
  const ds = new DataSource({ ...buildDataSourceOptions(), migrationsRun: false } as any);
  await ds.initialize();
  try {
    await fn(async (sql, params) => rows(await ds.query(sql, params)));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await ds.destroy();
  }
}

const args = process.argv.slice(2);
export const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
export const flag = (k: string) => args.includes(k);
export const log = (scope: string, msg: string, extra?: unknown) =>
  console.log(`${new Date().toISOString()} [${scope}] ${msg}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}`);
