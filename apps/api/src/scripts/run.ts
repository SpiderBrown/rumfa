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
    // Long imports survive short network drops (e.g. a phone hotspot): connection errors are retried
    // for up to ~20 minutes. Statements are single upserts, so a retry never duplicates anything.
    await fn(async (sql, params) => {
      for (let attempt = 1; ; attempt++) {
        try { return rows(await ds.query(sql, params)); } catch (e) {
          const code = (e as any)?.code ?? (e as any)?.driverError?.code;
          const network = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', '57P01'].includes(code)
            || /Connection terminated|connection timeout/i.test((e as Error).message);
          if (!network || attempt > 80) throw e;
          console.log(`${new Date().toISOString()} [db] ${code ?? 'connection lost'}; retrying in 15 s (${attempt}/80)`);
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    });
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
