import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './data-source';
import { Db } from './db.service';

@Global()
@Module({
  imports: [TypeOrmModule.forRootAsync({ useFactory: () => buildDataSourceOptions() })],
  providers: [Db],
  exports: [Db],
})
export class DatabaseModule {}
