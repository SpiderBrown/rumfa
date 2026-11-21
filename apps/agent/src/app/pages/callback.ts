import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';
import { CALLBACK_REASONS } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { AgoPipe } from '../core/clock';

interface Coordinator { id: string; full_name: string; level: string; area_code: string }
const ICONS: Record<string, string> = { form: 'help-circle', unit: 'location', app: 'phone-portrait', other: 'ellipsis-horizontal' };

/** "Ask my coordinator to call me": they call back on a normal phone line. Works by SMS when there is no data. */
@Component({
  selector: 'page-callback',
  imports: [FormsModule, IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonTitle, IonToolbar, AgoPipe],
  template: `
  <ion-header><ion-toolbar><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Ask to be called') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (coordinator(); as c) {
      <div class="card who"><span class="av">{{ initials(c.full_name) }}</span>
        <div><b>{{ c.full_name }}</b><small>{{ t('Your coordinator') }} · {{ t(levelName(c.level)) }}</small></div></div>
    }
    @if (loading()) {
      <p class="hint">{{ t('Loading…') }}</p>
    } @else if (sending()) {
      <div class="state"><ion-icon name="cloud-offline" /><b>{{ t('Sending your request…') }}</b>
        <span>{{ t('It will go as soon as there is internet. You can also send it by SMS from the waiting list.') }}</span></div>
    } @else if (open(); as r) {
      <!-- A request already open (possibly made earlier): show it, never a new one by itself -->
      <div class="state on"><ion-icon name="call" /><b>{{ statusText(r.status) }}</b>
        <span>{{ reasonLabel(r.reason) }} · {{ t('asked') }} {{ r.created_at | ago }}</span>
        @if (r.note) { <i>“{{ r.note }}”</i> }</div>
      <p class="hint">{{ t('Keep your phone with you. If nobody calls within a few minutes, the request goes to the next coordinator automatically.') }}</p>
      @if (['waiting','no_answer','escalated'].includes(r.status)) { <button class="ghost" (click)="cancel(r.id)">{{ t('Cancel request') }}</button> }
    } @else {
      <p class="section-title">{{ t('What is it about?') }}</p>
      <div class="card flat">
        @for (r of reasons; track r.code) {
          <button class="row-item opt" [class.on]="reason() === r.code" (click)="reason.set(r.code)">
            <span class="ico" [class.teal]="reason() === r.code" [class.grey]="reason() !== r.code"><ion-icon [name]="icon(r.code)" /></span>
            <span class="grow">{{ t(r.label) }}</span>
            <ion-icon class="radio" [name]="reason() === r.code ? 'radio-button-on' : 'radio-button-off'" />
          </button>
        }
      </div>
      <p class="section-title">{{ t('Anything to add?') }} <span class="opt-t">· {{ t('optional') }}</span></p>
      <textarea class="note" rows="3" [(ngModel)]="note" maxlength="300" [placeholder]="t('e.g. They are not allowing our agent to sign.')"></textarea>
      <p class="hint center">{{ t('For an emergency, hold SOS instead.') }}</p>
    }
  </ion-content>
  @if (!loading() && !sending() && !open()) {
    <ion-footer class="ion-no-border"><div class="foot">
      <button class="primary" [disabled]="!reason()" (click)="ask()"><ion-icon name="call" />
        {{ coordinator() ? t('Ask') + ' ' + first(coordinator()!.full_name) + ' ' + t('to call me') : t('Ask to be called') }}</button>
      <small>{{ t('No data? It goes by SMS.') }}</small>
    </div></ion-footer>
  }`,
  styles: `
    .who { display: flex; align-items: center; gap: 12px; } .who b { display: block; font-size: 17px; } .who small { color: var(--r-muted); }
    .opt { width: 100%; background: #fff; border-left: 0; border-right: 0; border-top: 0; font: inherit; text-align: left; color: var(--r-ink); }
    .opt.on { background: var(--r-accent-soft); } .grow { flex: 1; font-weight: 600; } .radio { font-size: 22px; color: var(--r-accent); }
    .opt-t { text-transform: none; letter-spacing: 0; font-weight: 600; }
    .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; padding: 12px 14px; border: 1.5px solid #d5dae1; border-radius: 14px; background: #fff; resize: none; }
    .note:focus { outline: none; border-color: var(--r-accent); }
    .state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 24px 12px; }
    .state ion-icon { font-size: 44px; color: var(--r-muted); } .state.on ion-icon { color: var(--r-accent); } .state b { font-size: 20px; } .state span { color: var(--r-muted); }
    .hint { color: var(--r-muted); font-size: 13px; } .center { text-align: center; margin-top: 16px; }
    .ghost { width: 100%; padding: 14px; border-radius: 14px; border: 1.5px solid #d5dae1; background: #fff; font: inherit; font-weight: 700; }
    .foot { padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: var(--r-bg, #f3f4f6); text-align: center; }
    .foot small { display: block; color: var(--r-muted); margin-top: 6px; }
    .primary { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 16px; padding: 16px;
      background: var(--r-accent); color: #fff; font: inherit; font-size: 17px; font-weight: 800; } .primary:disabled { opacity: .45; }
  `,
})
export default class CallbackPage implements OnDestroy {
  private api = inject(Api);
  private outbox = inject(Outbox);
  private ui = inject(Ui);
  t = inject(I18n).t;
  reasons = CALLBACK_REASONS;
  reason = signal<string | null>(null);
  note = '';
  open = signal<any | null>(null);
  loading = signal(true);
  coordinator = signal<Coordinator | null>(null);
  /** A request still in the outbox (no signal yet) */
  sending = computed(() => this.outbox.items().some((i) => i.kind === 'callback' && i.status === 'waiting' && !i.smsSentAt));
  private stopLive: () => void;

  constructor() {
    void this.load();
    void this.api.get<Coordinator | null>('/me/coordinator').then((c) => this.coordinator.set(c && c.id ? c : null)).catch(() => undefined);
    this.stopLive = this.api.onChange(() => void this.load(), ['callback_requests']);
  }
  ngOnDestroy() { this.stopLive(); }

  icon(code: string) { return ICONS[code] ?? 'call'; }
  initials(n: string) { return n.replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  first(n: string) { return n.split(' ')[0]; }
  levelName(l: string) { return ({ ward: 'Ward coordinator', lga: 'LGA coordinator', state: 'State coordinator' } as Record<string, string>)[l] ?? 'Coordinator'; }
  statusText(s: string) {
    return this.t(({ waiting: 'Your coordinator will call you', escalated: 'Passed to the situation room; they will call you',
      calling: 'Calling you now…', no_answer: 'We could not reach you; we will try again in 5 minutes' } as Record<string, string>)[s] ?? s);
  }

  async load() {
    const r = await this.api.get<any>('/callbacks/mine').catch(() => undefined);
    if (r !== undefined) this.open.set(r && r.id ? r : null);
    this.loading.set(false);
  }

  reasonLabel(code: string) { return this.t(CALLBACK_REASONS.find((r) => r.code === code)?.label ?? code); }

  async ask() {
    const reason = this.reason();
    if (!reason) return;
    await this.outbox.add('callback', { reason, note: this.note.trim() || null }, 'Call request');
    await this.ui.toast(this.outbox.online() ? 'Request sent' : 'No internet: send it by SMS from the waiting list');
    this.note = ''; this.reason.set(null);
    setTimeout(() => void this.load(), 1500);
  }

  async cancel(id: string) { await this.api.post(`/callbacks/${id}/cancel`).catch((e) => this.ui.error(e)); await this.load(); }
}
