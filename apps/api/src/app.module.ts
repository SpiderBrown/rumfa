import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerModule } from '@nestjs/throttler';
import { HttpThrottlerGuard } from './auth/guards';
import { DataSource } from 'typeorm';
import { AuthModule } from './auth/auth.module';
import { Public } from './auth/decorators';
import { CommonModule } from './common/common.module';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { DomainModule } from './domain/domain.module';
import { LiveGateway } from './live/live.gateway';

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
    CommonModule,
    AuthModule,
    DomainModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: HttpThrottlerGuard }, LiveGateway],
})
export class AppModule {}
