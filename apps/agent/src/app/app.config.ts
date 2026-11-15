import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';
import { routes } from './app.routes';
import { Api } from './core/api';
import { Outbox } from './core/outbox';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideIonicAngular({ mode: 'md' }),
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
    provideAppInitializer(() => {
      const api = inject(Api), outbox = inject(Outbox);   // inject before any await
      return api.init().then(() => outbox.init());
    }),
  ],
};
