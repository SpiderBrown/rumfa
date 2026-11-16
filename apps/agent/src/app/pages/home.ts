import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { IonBadge, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonRefresher,
  IonRefresherContent, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { Outbox, type OutItem } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { Checkin } from '../core/checkin';
import { Clock } from '../core/clock';
import { UnitFiguresService } from '../core/unit-figures';
import { CheckinFlow } from '../core/checkin-flow';
import { DayJourney } from '../core/day';
import { DAY_STAGES } from '../core/checklist';


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

    @if (atUnit()) {
      <!-- The polling-unit day: one place, in INEC's order. Shows where the agent is and what comes next. -->
      <button class="day" (click)="router.navigateByUrl('/unit')">
        <span class="ring">{{ day.doneStages() }}/{{ stageCount }}</span>
        <span class="dt"><b>{{ t('My polling unit') }}</b><small>{{ dayLine() }}</small>
          @if (day.leftBehind()) { <small class="behind">{{ day.leftBehind() }} {{ t('earlier questions unanswered') }}</small> }</span>
        @if (figs.pendingCount()) { <span class="pend">{{ figs.pendingCount() }}</span> }
        <ion-icon name="chevron-forward" class="chev" />
      </button>
    }
    <div class="big-grid">
      @if (atUnit()) {
        <button class="tile" [class.locked]="mustCheckIn()" (click)="go('/report')"><ion-icon name="warning" />{{ t('Report a problem') }}
          @if (mustCheckIn()) { <span class="state">{{ t('Check in first') }}</span> }</button>
        <a class="tile sos" routerLink="/report" [queryParams]="{ sos: 1 }"><ion-icon name="alert-circle" />{{ t('SOS') }}</a>
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
           .day { display: flex; align-items: center; gap: 14px; width: calc(100% - 24px); margin: 12px 12px 0; padding: 16px; border: 0;
             border-radius: 18px; background: var(--ion-color-primary); color: #fff; font: inherit; text-align: left; box-shadow: 0 3px 10px rgba(0,0,0,.15); }
           .ring { width: 48px; height: 48px; border-radius: 50%; border: 3px solid rgba(255,255,255,.85); display: grid; place-items: center;
             font-weight: 700; font-size: 14px; flex: none; }
           .behind { color: #fde68a; } .dt { flex: 1; display: flex; flex-direction: column; }
           .dt b { font-size: 17px; } .dt small { opacity: .9; font-size: 13px; margin-top: 2px; } .chev { font-size: 20px; }
           .pend { background: #f59e0b; color: #111; font-weight: 700; font-size: 12px; border-radius: 10px; padding: 1px 7px; }
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
  private clock = inject(Clock);
  router = inject(Router);
  private flow = inject(CheckinFlow);
  figs = inject(UnitFiguresService);
  day = inject(DayJourney);
  stageCount = DAY_STAGES.length;
  /** Under "My polling unit": the stage now, and its next step */
  dayLine = computed(() => {
    this.clock.min();
    if (!this.ci.checkedIn()) {
      const o = this.ci.openNow(), w = this.ci.state().window;
      return o === 'early' && w ? `${this.t('Check-in opens')} ${dayTime(w.opensAt)}` : this.t('Start here: check in at your polling unit');
    }
    const c = this.day.current();
    if (!c) return this.t('All done for today. Thank you!');
    const st = DAY_STAGES.find((s) => s.id === c)!;
    const l = this.figs.latest();
    const extra = c === 'voting' && l.accredited != null && l.registered ? ` · ${l.accredited} ${this.t('accredited')} (${Math.round((l.accredited / l.registered) * 100)}%)` : '';
    return `${this.t('Now')}: ${this.t(st.title)}${extra}`;
  });
  /** At a polling unit and not checked in while check-in is open (or opening later today): field work waits */
  mustCheckIn = computed(() => { this.clock.min(); this.ci.state(); return this.atUnit() && this.ci.required(); });
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

  async checkIn() { return this.flow.run(); }

  async sms(i: OutItem) { await this.outbox.sendBySms(i); }
}
