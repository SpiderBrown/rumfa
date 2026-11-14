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
  });
  const admin = new Client({ database: 'postgres', user: process.env.DB_USER, password: process.env.DB_PASSWORD, host: 'localhost' });
  await admin.connect();
  await admin.query(`drop database if exists ${db} with (force)`);
  await admin.query(`create database ${db}`);
  await admin.end();

  const { AppModule } = await import('../src/app.module');
  const { setupApp } = await import('../src/setup-app');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  setupApp(app);
  await app.init();
  const ds = app.get(DataSource);
  await ds.query(readFileSync(resolve(__dirname, '../../../db/seed.sql'), 'utf8'));
  return { app, ds };
}
