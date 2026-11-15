import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ProvidersService } from './providers.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [StorageService, ProvidersService],
  exports: [StorageService, ProvidersService],
})
export class CommonModule {}
