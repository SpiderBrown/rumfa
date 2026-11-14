import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Geolocation } from '@capacitor/geolocation';
import { IonBadge, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonRefresher,
  IonRefresherContent, IonTitle, IonToolbar } from '@ionic/angular';
import { Supa } from '../core/supa';
import { Outbox, type OutItem } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** Today: the main actions as large tiles, plus anything waiting to send. */
@Component({
  selector: 'page-home',
  imports: [RouterLink, IonBadge, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonRefresher, IonRefresherContent, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary">
    <ion-title>{{ t('Today') }}</ion-title>
    <ion-buttons slot="end"><ion-button routerLink="/help"><ion-icon slot="icon-only" name="help-circle" /></ion-button></ion-buttons>
  </ion-toolbar></ion-header>
  <ion-content>
    <ion-refresher slot="fixed" (ionRefresh)="refresh($event)"><ion-refresher-content /></ion-refresher>
    <div class="who">{{ me()?.full_name }} · {{ me()?.area_code }}
      @if (!outbox.online()) { <span class="off">{{ t('No internet') }}</span> }</div>

    <div class="big-grid">
      @if (atUnit()) {
        <button class="tile" [class.done]="checkedIn()" (click)="checkIn()"><ion-icon name="location-outline" />{{ t('Check in') }}</button>
        <a class="tile" routerLink="/checklist"><ion-icon name="list" />{{ t('Checklist') }}</a>
        <a class="tile" routerLink="/report"><ion-icon name="warning" />{{ t('Report a problem') }}</a>
        <a class="tile sos" routerLink="/report" [queryParams]="{ sos: 1 }"><ion-icon name="alert-circle" />{{ t('SOS') }}</a>
        <a class="tile" routerLink="/quick"><ion-icon name="speedometer" />{{ t('Quick count') }}</a>
        @if (supa.isAgent()) { <a class="tile" routerLink="/result"><ion-icon name="document-text" />{{ t('Submit result (EC8A)') }}</a> }
      }
      <a class="tile" routerLink="/callback"><ion-icon name="call" />{{ t('Ask my coordinator to call me') }}</a>
      <a class="tile" routerLink="/messages"><ion-icon name="chatbubbles" />{{ t('Messages') }}</a>
      @if (supa.isCoordinator()) {
        <a class="tile" routerLink="/coord/callbacks"><ion-icon name="call-outline" />{{ t('Callback requests') }}</a>
        <a class="tile" routerLink="/coord/team"><ion-icon name="people" />{{ t('My team') }}</a>
        <a class="tile" routerLink="/coord/contact"><ion-icon name="shield-checkmark" />{{ t('Add authority contact') }}</a>
      }
    </div>

    @if (outbox.items().length) {
      <ion-list>
        <ion-list-header>{{ t('Waiting to send') }} @if (outbox.pending().length) { <ion-badge color="warning">{{ outbox.pending().length }}</ion-badge> }</ion-list-header>
        @for (i of outbox.items().slice(0, 15); track i.id) {
          <ion-item>
            <ion-icon slot="start" [name]="i.status === 'sent' ? 'checkmark-circle' : i.status === 'failed' ? 'close-circle' : 'time-outline'"
              [color]="i.status === 'sent' ? 'success' : i.status === 'failed' ? 'danger' : 'warning'" />
            <ion-label>{{ i.label }}<p>{{ statusText(i) }}</p></ion-label>
            @if (outbox.smsOffer(i)) { <ion-button slot="end" (click)="sms(i)">{{ t('Send by SMS') }}</ion-button> }
          </ion-item>
        }
      </ion-list>
    }
  </ion-content>`,
  styles: `.who { padding: 12px 16px 0; color: var(--ion-color-medium); } .off { color: #b3261e; font-weight: 600; margin-left: 8px; }
           button.tile { border: none; font-family: inherit; font-size: inherit; cursor: pointer; } a.tile { text-decoration: none; }`,
})
export default class HomePage {
  supa = inject(Supa);
  outbox = inject(Outbox);
  private ui = inject(Ui);
  t = inject(I18n).t;
  me = this.supa.me;
  atUnit = this.supa.atUnit;
  checkedIn = signal(!!localStorage.getItem('rumfa.checkin.' + new Date().toDateString()));
  private tick = signal(0);

  constructor() { setInterval(() => this.tick.update((x) => x + 1), 30_000); }

  statusText = (i: OutItem) => {
    this.tick();
    if (i.status === 'sent') return i.smsSentAt ? 'Sent by SMS' : 'Sent';
    if (i.status === 'failed') return `Not accepted: ${i.error}`;
    if (i.smsSentAt) return 'SMS sent; photo will upload when there is internet';
    return this.outbox.online() ? 'Sending…' : 'Saved on this phone; will send when there is internet';
  };

  async refresh(ev: CustomEvent) { await this.outbox.sync(); await this.supa.refreshMe().catch(() => {}); (ev.target as any).complete(); }

  async checkIn() {
    let pos: { lat?: number; lng?: number; accuracy?: number } = {};
    try {
      const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    } catch { /* location is optional */ }
    await this.outbox.add('checkin', { pu: this.me()!.area_code, ...pos }, 'Check in');
    localStorage.setItem('rumfa.checkin.' + new Date().toDateString(), '1');
    this.checkedIn.set(true);
    await this.ui.toast('Checked in');
  }

  async sms(i: OutItem) { await this.outbox.sendBySms(i); }
}
