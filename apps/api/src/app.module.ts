import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { AuthModule } from './auth/auth.module';
import { Public } from './auth/decorators';
import { CasesController } from './cases/cases.controller';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';

@ApiTags('Health')
@Controller('health')
class HealthController {
  constructor(private readonly ds: DataSource) {}

  @Public() @Get()
  async health() {
    await this.ds.query('select 1');
    return { status: 'ok', time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }]),
    DatabaseModule,
    AuthModule,
  ],
  controllers: [HealthController, CasesController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
