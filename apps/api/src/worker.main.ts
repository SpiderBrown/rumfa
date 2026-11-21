// Rumfa worker: the same codebase as the API, started as a separate process (node dist/worker.main).
// Runs deadlines, notifications, top-ups, OCR, the voice dialer, trend checks and IReV fetch jobs.
// It does not apply migrations (the API does) and serves no HTTP.
process.env.DB_RUN_MIGRATIONS ??= 'false';
// Its own, smaller pool (WORKER_DB_POOL_MAX, default 4): it runs one task at a time plus the IReV jobs, and shares
// the database's connection limit with the API (Supabase's pooler allows 15 in session mode).
process.env.DB_POOL_MAX = process.env.WORKER_DB_POOL_MAX ?? '4';
// The worker's timers hold advisory locks, which need a session connection: use it when the API is on the transaction pooler
if (process.env.DATABASE_SESSION_URL?.trim()) process.env.DATABASE_URL = process.env.DATABASE_SESSION_URL;

import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { CommonModule } from './common/common.module';
import { StorageService } from './common/storage.service';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { Db } from './database/db.service';
import { setWorkerContext } from './worker/context';
import { startWorker } from './worker/runner';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] }), DatabaseModule, CommonModule] })
class WorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  setWorkerContext({ db: app.get(Db), storage: app.get(StorageService) });
  const worker = startWorker(app.get(DataSource));
  new Logger('Worker').log('started');
  const stop = async () => { await worker.stop(); await app.close(); process.exit(0); };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}
void main();
