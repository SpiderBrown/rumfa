import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

/** A fresh database per run: migrations through the app itself, then the dev seed. */
export async function createTestApp(): Promise<{ app: INestApplication; ds: DataSource }> {
  const db = process.env.DB_NAME ?? 'rumfa_e2e';
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_NAME: db, DB_RUN_MIGRATIONS: 'true', OTP_MODE: 'fixed', FIXED_OTP: '246810',
    JWT_SECRET: 'e2e-secret-that-is-long-enough-for-tests', DB_USER: process.env.DB_USER ?? process.env.USER,
    DB_PASSWORD: process.env.DB_PASSWORD ?? '',
    // Always the local throwaway database and local files, never a hosted one from the shell or .env
    DATABASE_URL: '', DB_HOST: 'localhost', DB_PORT: '5432', DB_SSL: 'false', STORAGE_DRIVER: 'local',
    SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', AT_API_KEY: '', WHATSAPP_TOKEN: '', VTPASS_API_KEY: '',
  });
  const admin = new Client({ database: 'postgres', user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: 'localhost' });
  await admin.connect();
  await admin.query(`drop database if exists ${db} with (force)`);
  await admin.query(`create database ${db}`);
  await admin.end();

  const { AppModule } = await import('../src/app.module');
  const { setupApp } = await import('../src/setup-app');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ rawBody: true });
  setupApp(app);
  await app.init();
  const ds = app.get(DataSource);
  await ds.query(readFileSync(resolve(__dirname, '../../../db/seed.sql'), 'utf8'));
  return { app, ds };
}

/** A signed-in session for a seeded membership, without going through SMS (sign-in has its own tests). */
export async function sessionFor(app: INestApplication, volunteerId: string): Promise<string> {
  const ds = app.get(DataSource);
  const [v] = await ds.query(`select phone, user_id from public.volunteers where id = $1`, [volunteerId]);
  let identity = v.user_id;
  if (!identity) {
    [{ id: identity }] = await ds.query(
      `insert into public.identities (phone) values ($1) on conflict (phone) do update set phone = excluded.phone returning id`, [v.phone]);
    await ds.query(`select app.link_identity($1)`, [identity]);
  }
  const { TokensService, MEMBERSHIP_SQL } = await import('../src/auth/tokens.service');
  const [m] = await ds.query(MEMBERSHIP_SQL + ' and v.id = $2', [identity, volunteerId]);
  return (await app.get(TokensService).issue(identity, m, null)).accessToken;
}
