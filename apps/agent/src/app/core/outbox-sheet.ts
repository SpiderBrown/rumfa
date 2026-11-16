import { Component, Injectable, computed, inject } from '@angular/core';
import { IonButton, IonContent, IonFooter, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader, ModalController } from '@ionic/angular';
import { Clock } from './clock';
import { I18n } from './i18n';
import { Outbox, type OutItem } from './outbox';

/**
 * What the phone has sent today and what is still waiting, as a sheet that slides up from the top bar.
 * Waiting items come first (with Send by SMS when there is no data); sent ones below, newest first.
 */
@Component({
  selector: 'outbox-sheet',
  imports: [IonButton, IonContent, IonFooter, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader],
  template: `
  <!-- Fixed top: handle, title, connection; only the lists below scroll -->
  <ion-header class="ion-no-border">
    <div class="top">
      <div class="grip"></div>
      <div class="head">
        <h2>{{ t('Outbox') }}</h2>
        <span class="state" [class.off]="!outbox.online()">
          <ion-icon [name]="outbox.online() ? 'cloud-done' : 'cloud-offline'" />{{ outbox.online() ? t('Online') : t('Offline') }}</span>
      </div>
      @if (!outbox.online()) { <p class="note off">{{ t('No internet. Everything is saved on this phone and will send by itself when there is signal.') }}</p> }
      @else if (!waiting().length) { <p class="note ok"><ion-icon name="checkmark-circle" /> {{ t('Nothing waiting. Everything you sent has arrived.') }}</p> }
    </div>
  </ion-header>

  <ion-content>
    @if (waiting().length) {
      <ion-list lines="full">
        <ion-list-header>{{ t('Waiting to send') }} ({{ waiting().length }})</ion-list-header>
        @for (i of waiting(); track i.id) {
          <ion-item>
            <ion-icon slot="start" [name]="i.status === 'failed' ? 'close-circle' : 'time-outline'" [color]="i.status === 'failed' ? 'danger' : 'warning'" />
            <ion-label class="ion-text-wrap">{{ t(i.label) }}<p>{{ statusText(i) }}</p>
              <!-- An SMS can carry the figures, never the photo: say so, so nobody thinks the photo went -->
              @if (outbox.smsOffer(i) && i.photo) { <p class="sms">{{ t('SMS sends the figures only. The photo needs internet and will upload by itself.') }}</p> }
            </ion-label>
            <div slot="end" class="acts">
              @if (i.status === 'failed') { <ion-button size="small" fill="outline" (click)="outbox.retry(i)">{{ t('Try again') }}</ion-button> }
              @if (outbox.smsOffer(i)) {
                <ion-button size="small" (click)="outbox.sendBySms(i)">{{ i.kind === 'result' ? t('Send figures by SMS') : t('Send by SMS') }}</ion-button>
              }
            </div>
          </ion-item>
        }
      </ion-list>
    }

    @if (sent().length) {
      <ion-list lines="full">
        <ion-list-header>{{ t('Sent') }}</ion-list-header>
        @for (i of sent(); track i.id) {
          <ion-item>
            <ion-icon slot="start" name="checkmark-circle" color="success" />
            <ion-label class="ion-text-wrap">{{ t(i.label) }}<p>{{ statusText(i) }} · {{ time(i.createdAt) }}</p></ion-label>
          </ion-item>
        }
      </ion-list>
    }
  </ion-content>

  <!-- Fixed bottom -->
  <ion-footer class="ion-no-border">
    <p class="note foot"><ion-icon name="information-circle-outline" />{{ t('If something has not gone after 2 minutes, a Send by SMS button appears here. The app writes the SMS for you.') }}</p>
  </ion-footer>`,
  styles: `
    ion-header, ion-footer { background: var(--ion-background-color, #fff); }
    .top { padding: 10px 0 6px; border-bottom: 1px solid #e5e7eb; }
    .foot { margin: 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid #e5e7eb; align-items: flex-start; }
    .foot ion-icon { flex: none; font-size: 17px; margin-top: 1px; }
    .acts { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
    .sms { color: #b45309 !important; font-size: 12px !important; }
    .grip { width: 40px; height: 5px; border-radius: 3px; background: #cbd5e1; margin: 0 auto 10px; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 0 16px; } h2 { margin: 0; font-size: 20px; }
    .state { display: flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; color: #16a34a; } .state.off { color: #b45309; }
    .note { padding: 0 16px; font-size: 13px; color: var(--ion-color-medium); display: flex; align-items: center; gap: 6px; }
    .note.off { color: #b45309; font-weight: 600; margin: 8px 0 0; } .note.ok { color: #15803d; font-size: 14px; margin: 8px 0 0; }
  `,
})
export class OutboxSheetPage {
  outbox = inject(Outbox);
  private clock = inject(Clock);
  t = inject(I18n).t;
  waiting = computed(() => this.outbox.items().filter((i) => i.status !== 'sent'));
  sent = computed(() => this.outbox.items().filter((i) => i.status === 'sent').slice(0, 40));

  statusText(i: OutItem) {
    this.clock.min();
    if (i.status === 'sent') return this.t(i.smsSentAt ? 'Sent by SMS' : 'Sent');
    if (i.status === 'failed') return `${this.t('Not accepted')}: ${i.error}`;
    if (i.smsSentAt) return this.t('SMS sent; photo will upload when there is internet');
    return this.t(this.outbox.online() ? 'Sending…' : 'Saved on this phone; will send when there is internet');
  }
  time(ms: number) { return new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }); }
}

/** Opens the outbox sheet from anywhere (the top bar's sync button, or Me). */
@Injectable({ providedIn: 'root' })
export class OutboxSheet {
  private modal = inject(ModalController);
  async open() {
    // Opens nearly full height; the list scrolls inside the sheet at any height (not only when fully expanded)
    const m = await this.modal.create({ component: OutboxSheetPage, breakpoints: [0, 0.5, 0.92], initialBreakpoint: 0.92,
      expandToScroll: false, handle: false });
    await m.present();
  }
}
