import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { CALLBACK_REASONS } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { AgoPipe } from '../core/clock';

/** "Ask my coordinator to call me": they call back on a normal phone line. */
@Component({
  selector: 'page-callback',
  imports: [IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar, AgoPipe],
  styles: `.meta { font-weight: 600; margin: 0 0 8px; }`,
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Ask my coordinator to call me') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (loading()) {
      <p class="hint">{{ t('Loading…') }}</p>
    } @else if (sending()) {
      <h2>{{ t('Sending your request…') }}</h2>
      <p class="hint">{{ t('It will go as soon as there is internet. You can also send it by SMS from the home screen.') }}</p>
    } @else if (open(); as r) {
      <!-- A request already open (possibly made earlier): show it, never a new one by itself -->
      <h2>{{ statusText(r.status) }}</h2>
      <p class="meta">{{ reasonLabel(r.reason) }} · {{ t('asked') }} {{ r.created_at | ago }}</p>
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
  loading = signal(true);
  /** A request still in the outbox (no signal yet) */
  sending = computed(() => this.outbox.items().some((i) => i.kind === 'callback' && i.status === 'waiting' && !i.smsSentAt));
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
    this.loading.set(false);
  }

  reasonLabel(code: string) { return this.t(CALLBACK_REASONS.find((r) => r.code === code)?.label ?? code); }

  async ask(reason: string) {
    if (!(await this.ui.confirm('Ask for a call?', `${this.t('Your coordinator will call you about')}: ${this.reasonLabel(reason)}.`, 'Send request', 'Cancel'))) return;
    await this.outbox.add('callback', { reason }, 'Call request');
    await this.ui.toast(this.outbox.online() ? 'Request sent' : 'No internet: send it by SMS from the home screen');
    setTimeout(() => void this.load(), 1500);
  }

  async cancel(id: string) { await this.api.post(`/callbacks/${id}/cancel`).catch((e) => this.ui.error(e)); await this.load(); }
}
