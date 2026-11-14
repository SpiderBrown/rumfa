import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';
import { routes } from './app.routes';
import { Supa } from './core/supa';
import { Outbox } from './core/outbox';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideIonicAngular({ mode: 'md' }),
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
    provideAppInitializer(() => {
      const supa = inject(Supa), outbox = inject(Outbox);   // inject before any await
      return supa.init().then(() => outbox.init());
    }),
  ],
};
