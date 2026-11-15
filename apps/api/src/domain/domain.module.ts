import { Module } from '@nestjs/common';
import { ShiftsController, TopupsController, VoiceController } from './admin.controller';
import { CallbacksController } from './callbacks.controller';
import { CallsController } from './calls.controller';
import { CasesController } from './cases.controller';
import { ContactsController } from './contacts.controller';
import { ContextController } from './context.controller';
import { FieldController } from './field.controller';
import { LiveViewController } from './live.controller';
import { MediaController } from './media.controller';
import { MessagesController } from './messages.controller';
import { PeopleController } from './people.controller';
import { ResultsController } from './results.controller';
import { WebhooksController } from '../webhooks/webhooks.controller';

@Module({
  controllers: [
    ContextController, PeopleController, CasesController, FieldController, ResultsController, CallbacksController,
    ContactsController, MessagesController, ShiftsController, TopupsController, VoiceController, MediaController,
    LiveViewController, CallsController, WebhooksController,
  ],
})
export class DomainModule {}
