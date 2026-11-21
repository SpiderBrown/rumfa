import { Module } from '@nestjs/common';
import { MessageAlerts } from './message-alerts';
import { SearchController } from './search.controller';
import { AnnouncementsController } from './announcements.controller';
import { AppCallsService } from './app-calls.service';
import { ShiftsController, TopupsController, VoiceController } from './admin.controller';
import { CallbacksController } from './callbacks.controller';
import { CallsController } from './calls.controller';
import { CasesController } from './cases.controller';
import { ContactsController } from './contacts.controller';
import { ContextController } from './context.controller';
import { FieldController } from './field.controller';
import { LiveViewController } from './live.controller';
import { LiveCountsController } from './live-counts.controller';
import { CheckinsController } from './checkins.controller';
import { UnitFiguresController } from './unit-figures.controller';
import { MapController } from './map.controller';
import { TeamController } from './team.controller';
import { TasksController } from './tasks.controller';
import { MediaController } from './media.controller';
import { MessagesController } from './messages.controller';
import { PeopleController } from './people.controller';
import { ResultsController } from './results.controller';
import { SettingsController } from './settings.controller';
import { WebhooksController } from '../webhooks/webhooks.controller';

@Module({
  controllers: [AnnouncementsController, SearchController, 
    ContextController, PeopleController, CasesController, FieldController, ResultsController, CallbacksController,
    ContactsController, MessagesController, ShiftsController, TopupsController, VoiceController, MediaController,
    LiveViewController, CallsController, SettingsController, MapController, TeamController, TasksController, LiveCountsController, CheckinsController, UnitFiguresController, WebhooksController,
  ],
  providers: [AppCallsService, MessageAlerts],
})
export class DomainModule {}
