import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { judgeCheckin } from '@rumfa/shared';
import { Geolocation } from '@capacitor/geolocation';
import { IonBadge, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonRefresher,
  IonRefresherContent, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { Outbox, type OutItem } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { Checkin } from '../core/checkin';
import { Checklist } from '../core/checklist';
import { Clock } from '../core/clock';

const PLACE: Record<string, string> = { ward: 'your ward', unit: 'your polling unit', lga: 'your LGA', state: 'your state' };
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
const dayTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

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
    <div class="who"><b>{{ api.brand() }}</b> · {{ me()?.full_name }} · {{ me()?.area_code }}
      @if (!outbox.online()) { <span class="off">{{ t('No internet') }}</span> }</div>

    <div class="big-grid">
      @if (atUnit()) {
        <button class="tile" [class.done]="ci.checkedIn() && !ci.onlyOutside()" [class.attn]="ci.onlyOutside() || mustCheckIn()" (click)="checkIn()">
          @if (ci.onlyOutside()) { <ion-icon name="warning" /> } @else if (ci.checkedIn()) { <ion-icon name="checkmark-circle" /> } @else { <ion-icon name="location-outline" /> }
          {{ ci.onlyOutside() ? t('Checked in outside your area') : ci.checkedIn() ? t('Checked in') : t('Check in') }}
          <span class="state" [class.good]="ci.checkedIn() && !ci.onlyOutside()" [class.warn]="ci.onlyOutside()">{{ checkinNote() }}</span>
        </button>
        <!-- Field work starts with check-in (SOS never waits) -->
        <button class="tile" [class.done]="cl.done() === cl.total" [class.locked]="mustCheckIn()" (click)="go('/checklist')">
          @if (cl.done() === cl.total) { <ion-icon name="checkmark-circle" /> } @else { <ion-icon name="list" /> }{{ t('Checklist') }}
          <span class="state" [class.good]="cl.done() === cl.total" [class.warn]="cl.problems()">
            @if (mustCheckIn()) { {{ t('Check in first') }} }
            @else { {{ cl.done() === cl.total ? t('All done') : cl.done() + ' / ' + cl.total + ' ' + t('done') }}@if (cl.problems()) { · {{ cl.problems() }} ⚠ } }
          </span>
        </button>
        <button class="tile" [class.locked]="mustCheckIn()" (click)="go('/report')"><ion-icon name="warning" />{{ t('Report a problem') }}
          @if (mustCheckIn()) { <span class="state">{{ t('Check in first') }}</span> }</button>
        <a class="tile sos" routerLink="/report" [queryParams]="{ sos: 1 }"><ion-icon name="alert-circle" />{{ t('SOS') }}</a>
        @if (api.isAgent()) {
          <button class="tile" [class.locked]="mustCheckIn()" (click)="go('/count')"><ion-icon name="speedometer" />{{ t('Live count') }}
            @if (mustCheckIn()) { <span class="state">{{ t('Check in first') }}</span> }</button>
          <button class="tile" [class.locked]="mustCheckIn()" (click)="go('/result')"><ion-icon name="document-text" />{{ t('Submit result (EC8A)') }}
            @if (mustCheckIn()) { <span class="state">{{ t('Check in first') }}</span> }</button>
        }
      }
      <a class="tile" routerLink="/callback"><ion-icon name="call" />{{ t('Ask my coordinator to call me') }}</a>
      <a class="tile" routerLink="/messages"><ion-icon name="chatbubbles" />{{ t('Messages') }}</a>
      @if (api.isCoordinator()) {
        <a class="tile" routerLink="/coord/callbacks"><ion-icon name="call-outline" />{{ t('Callback requests') }}</a>
        <a class="tile" routerLink="/coord/map"><ion-icon name="map" />{{ t('My area map') }}</a>
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
           .state { font-size: 12px; font-weight: 500; color: var(--ion-color-medium); margin-top: -2px; }
           .state.good { color: #0b6b3a; } .state.warn { color: #b45309; }
           .tile.locked { opacity: .55; } .tile.attn { outline: 2px solid #d97706; outline-offset: -2px; }
           button.tile { border: none; font-family: inherit; font-size: inherit; cursor: pointer; } a.tile { text-decoration: none; }`,
})
export default class HomePage {
  api = inject(Api);
  outbox = inject(Outbox);
  private ui = inject(Ui);
  t = inject(I18n).t;
  me = this.api.me;
  atUnit = this.api.atUnit;
  ci = inject(Checkin);
  cl = inject(Checklist);
  private clock = inject(Clock);
  private router = inject(Router);
  /** At a polling unit and not checked in while check-in is open (or opening later today): field work waits */
  mustCheckIn = computed(() => { this.clock.min(); this.ci.state(); return this.atUnit() && this.ci.required(); });
  /** Under the Check in tile: the arrival time, or when check-in opens */
  checkinNote = computed(() => {
    this.clock.min();
    const s = this.ci.state();
    if (this.ci.onlyOutside()) return this.t('Tap to check in again from your area');
    if (s.first) return this.t('at') + ' ' + time(s.arrival ?? s.first);
    const w = s.window;
    if (!w || w.anyDay) return '';
    if (Date.now() < Date.parse(w.opensAt)) return this.t('Opens') + ' ' + dayTime(w.opensAt);
    if (Date.now() >= Date.parse(w.closesAt)) return this.t('Closed');
    return this.t('Open now');
  });

  statusText = (i: OutItem) => {
    this.clock.min();
    if (i.status === 'sent') return i.smsSentAt ? 'Sent by SMS' : 'Sent';
    if (i.status === 'failed') return `Not accepted: ${i.error}`;
    if (i.smsSentAt) return 'SMS sent; photo will upload when there is internet';
    return this.outbox.online() ? 'Sending…' : 'Saved on this phone; will send when there is internet';
  };

  async refresh(ev: CustomEvent) { await this.outbox.sync(); await this.api.refreshMe().catch(() => {}); (ev.target as any).complete(); }

  /** Opens a field page, asking to check in first when that is still needed. */
  async go(path: string) {
    if (this.mustCheckIn()) {
      const now = await this.ui.confirm('Check in first', 'Check in at your polling unit before you start. It tells the situation room you are in place.', 'Check in now', 'Cancel');
      if (!now || !(await this.checkIn())) return;
    }
    await this.router.navigateByUrl(path);
  }

  /** Returns true when a check-in was recorded. */
  async checkIn(): Promise<boolean> {
    const open = this.ci.openNow();
    const s = this.ci.state();
    if (open === 'early' && s.window) {
      await this.ui.alert('Not yet', `${this.t('Check-in opens at')} ${dayTime(s.window.opensAt)} ${this.t('on election day. Check in when you reach your polling unit.')}`);
      return false;
    }
    if (open === 'closed') { await this.ui.alert('Check-in has closed', 'Check-in is closed for this election.'); return false; }
    const ok = this.ci.onlyOutside()
      ? await this.ui.confirm('Check in again?', 'Your last check-in was outside your area. Check in again now that you are there. The earlier one is kept.', 'Check in again', 'Cancel')
      : s.first
        ? await this.ui.confirm('Check in again?', `${this.t('You checked in at')} ${time(s.arrival ?? s.first)}. ${this.t('Only check in again if you left and came back, or your unit moved to a new place.')}`, 'Check in again', 'Cancel')
        : await this.ui.confirm('Check in now?', `${this.t('Only check in when you are at your polling unit')} (${this.me()!.area_code}). ${this.t('The situation room sees the time and your location.')}`, 'I am here', 'Cancel');
    if (!ok) return false;
    const at = new Date();
    let pos: { lat?: number; lng?: number; accuracy?: number } = {};
    try {
      const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    } catch { /* no location: asked for a reason below */ }

    // Within their own area? (the server checks again). Outside, or no location: allowed, with a reason
    const fence = s.fence ?? null;
    const j = judgeCheckin(fence, pos);
    let note: string | null = null;
    if (fence && pos.lat == null) {
      note = await this.ui.prompt('No location', 'We could not get your location. Turn on location and try again, or check in now and say why.',
        { placeholder: 'Reason', ok: 'Check in anyway', required: true });
      if (note === null) return false;
    } else if (j.inside === false) {
      const where = `${fence!.name} (${this.t(PLACE[fence!.level])})`;
      const away = j.distance != null ? ` ${this.t('about')} ${km(j.distance)} ${this.t('from it')}` : '';
      note = await this.ui.prompt('Outside your area',
        `${this.t('You seem to be outside')} ${where}${away}. ${this.t('You can still check in, but tell the situation room why (for example, the unit was moved).')}`,
        { placeholder: 'Reason', ok: 'Check in anyway', required: true });
      if (note === null) return false;
    }
    await this.outbox.add('checkin', { pu: this.me()!.area_code, ...pos, at: at.toISOString(), note }, 'Check in');
    this.ci.recorded(at, j.inside);
    await this.ui.toast(j.inside === false ? 'Checked in outside your area. Check in again when you get there.' : 'Checked in',
      j.inside === false ? 'medium' : 'success');
    return true;
  }

  async sms(i: OutItem) { await this.outbox.sendBySms(i); }
}
