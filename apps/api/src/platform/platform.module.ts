import { PlatformContactsController } from './platform-contacts.controller';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformClientsController } from './platform-clients.controller';
import { PartyLogoController, PlatformDataController } from './platform-data.controller';
import { PlatformJobs, PlatformPlacesController } from './platform-places.controller';

/** The Rumfa Console's API (/platform/...): Rumfa staff only, separate from every client's data access. */
@Module({
  imports: [AuthModule],
  controllers: [PlatformAuthController, PlatformClientsController, PlatformDataController, PartyLogoController, PlatformPlacesController, PlatformContactsController],
  providers: [PlatformJobs],
})
export class PlatformModule {}
