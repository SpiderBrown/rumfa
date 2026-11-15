import { Component, OnDestroy, inject, signal } from '@angular/core';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { CALLBACK_REASONS } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** "Ask my coordinator to call me": they call back on a normal phone line. */
@Component({
  selector: 'page-callback',
  imports: [IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Ask my coordinator to call me') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (open(); as r) {
      <h2>{{ statusText(r.status) }}</h2>
      <p class="hint">Keep your phone with you. If nobody calls within a few minutes, the request goes to the next coordinator automatically.</p>
      @if (['waiting','no_answer','escalated'].includes(r.status)) { <ion-button expand="block" fill="outline" (click)="cancel(r.id)">Cancel request</ion-button> }
    } @else {
      <p class="hint">For an emergency, use SOS instead. Why do you need a call?</p>
      @for (r of reasons; track r.code) { <ion-button expand="block" color="light" (click)="ask(r.code)">{{ r.label }}</ion-button> }
    }
  </ion-content>`,
})
export default class CallbackPage implements OnDestroy {
  private api = inject(Api);
  private outbox = inject(Outbox);
  private ui = inject(Ui);
  t = inject(I18n).t;
  reasons = CALLBACK_REASONS;
  open = signal<any | null>(null);
  private stopLive: () => void;

  constructor() {
    void this.load();
    this.stopLive = this.api.onChange(() => void this.load(), ['callback_requests']);
  }
  ngOnDestroy() { this.stopLive(); }

  statusText(s: string) {
    return ({ waiting: this.t('Your coordinator will call you'), escalated: 'Passed to the situation room; they will call you',
      calling: 'Calling you now…', no_answer: 'We could not reach you; we will try again in 5 minutes' } as Record<string, string>)[s] ?? s;
  }

  async load() {
    const r = await this.api.get<any>('/callbacks/mine').catch(() => undefined);
    if (r !== undefined) this.open.set(r && r.id ? r : null);
  }

  async ask(reason: string) {
    await this.outbox.add('callback', { reason }, 'Call request');
    await this.ui.toast(this.outbox.online() ? 'Request sent' : 'No internet: send it by SMS from the home screen');
    setTimeout(() => void this.load(), 1500);
  }

  async cancel(id: string) { await this.api.post(`/callbacks/${id}/cancel`).catch((e) => this.ui.error(e)); await this.load(); }
}
