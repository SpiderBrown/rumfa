import 'reflect-metadata';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DataSource, DataSourceOptions, MigrationInterface, QueryRunner } from 'typeorm';
import configuration from '../config/configuration';

/**
 * The schema is written in plain SQL (db/migrations/*.sql, one source for the API, the worker and the
 * database tests). Each file becomes a TypeORM migration, applied in file order and recorded in the
 * `migrations` table like any other.
 */
export function migrationsDir(): string {
  const candidates = [
    process.env.DB_MIGRATIONS_DIR,
    resolve(__dirname, '../../../../db/migrations'), // apps/api/{src,dist}/database → repo/db
    resolve(process.cwd(), 'db/migrations'),
  ].filter(Boolean) as string[];
  const dir = candidates.find((d) => existsSync(d));
  if (!dir) throw new Error(`db/migrations not found (looked in ${candidates.join(', ')})`);
  return dir;
}

export function sqlMigrations(dir = migrationsDir()): (new () => MigrationInterface)[] {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      // TypeORM reads the last 13 characters of the name as the timestamp
      const name = `Sql_${file.slice(15, -4)}${file.slice(1, 14)}`;
      return class implements MigrationInterface {
        name = name;
        async up(qr: QueryRunner): Promise<void> {
          const [{ v }] = await qr.query(`select current_setting('server_version_num')::int as v`);
          // Supabase runs Postgres 15+; a local Postgres 14 lacks security_invoker views
          await qr.query(v < 150000 ? sql.replace(/ with \(security_invoker = true\)/g, '') : sql);
        }
        async down(): Promise<void> {
          throw new Error(`${file}: migrations are forward-only; restore from backup instead`);
        }
      };
    });
}

export function buildDataSourceOptions(): DataSourceOptions {
  const { db } = configuration();
  if (db.url && !/^postgres(ql)?:\/\//i.test(db.url)) {
    throw new Error(
      'DATABASE_URL must be a PostgreSQL connection string. For Supabase use Connect → "Session pooler", ' +
        'not the https://<ref>.supabase.co project URL.',
    );
  }
  const connection = db.url
    ? { url: db.url }
    : { host: db.host, port: db.port, username: db.username, password: db.password, database: db.database };
  return {
    type: 'postgres',
    ...connection,
    ssl: db.ssl ? { rejectUnauthorized: false } : false,
    extra: { max: db.poolMax },
    entities: [],
    migrations: sqlMigrations(),
    migrationsTransactionMode: 'each',
    migrationsRun: db.runMigrations,
    synchronize: false,
    logging: db.logging,
  };
}

export default new DataSource(buildDataSourceOptions());
