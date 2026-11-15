// Rumfa worker: the same codebase as the API, started as a separate process (node dist/worker.main).
// Runs deadlines, notifications, top-ups, OCR, the voice dialer, trend checks and IReV fetch jobs.
// It does not apply migrations (the API does) and serves no HTTP.
process.env.DB_RUN_MIGRATIONS ??= 'false';

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
