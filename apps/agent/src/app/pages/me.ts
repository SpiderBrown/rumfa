import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AlertController, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonModal, IonTitle, IonToolbar } from '@ionic/angular';
import { PinPad } from '../core/pin-pad';
import { Pin } from '../core/pin';
import { Api, type Membership } from '../core/api';
import { AppBar } from '../core/app-bar';
import { I18n, LANGUAGES } from '../core/i18n';
import { Outbox } from '../core/outbox';
import { OutboxSheet } from '../core/outbox-sheet';
import { Ui } from '../core/ui';

const ROLE: Record<string, string> = { agent: 'Party agent', volunteer: 'Volunteer', coordinator: 'Coordinator' };
const LEVEL: Record<string, string> = { pu: 'Polling unit', ward: 'Ward', lga: 'LGA', state: 'State', national: 'National' };
const NETWORKS = [{ code: 'mtn', name: 'MTN' }, { code: 'airtel', name: 'Airtel' }, { code: 'glo', name: 'Glo' }, { code: '9mobile', name: '9mobile' }];
/** Languages people speak (for matching callers and voice messages), not the app's display language */
const SPOKEN = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }, { code: 'ff', name: 'Fulfulde' }, { code: 'kr', name: 'Kanuri' },
  { code: 'yo', name: 'Yoruba' }, { code: 'ig', name: 'Igbo' }, { code: 'pcm', name: 'Pidgin' }];

/**
 * Me: a short settings page. A profile card (editable), then small groups: activity (outbox), preferences
 * (language, organisation), coordinator tools, help, and sign out, always at the bottom.
 */
@Component({
  selector: 'page-me',
  imports: [FormsModule, RouterLink, AppBar, PinPad, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonModal, IonTitle, IonToolbar],
  template: `
  <app-bar [title]="t('Me')" [sos]="api.atUnit()" />
  <ion-content class="ion-padding">
    <!-- Who I am, where, and for which organisation -->
    <section class="card profile">
      <span class="av big">{{ initials() }}</span>
      <div class="who"><b>{{ api.me()?.full_name }}</b>
        <span>{{ t(role()) }} · {{ t(level()) }} {{ api.me()?.area_code }}</span>
        <span class="org"><ion-icon name="business" />{{ api.brand() }}</span></div>
      <button class="edit" (click)="openEdit()" [attr.aria-label]="t('Edit profile')"><ion-icon name="create-outline" /></button>
    </section>

    <!-- Is everything sent? -->
    <button class="card sync" [class.off]="!outbox.online()" [class.wait]="outbox.pending().length" (click)="sheet.open()">
      <span class="ico" [class.teal]="outbox.online() && !outbox.pending().length" [class.orange]="!outbox.online() || outbox.pending().length">
        <ion-icon [name]="outbox.online() ? (outbox.pending().length ? 'cloud-upload-outline' : 'cloud-done-outline') : 'cloud-offline-outline'" /></span>
      <span class="grow"><b>{{ t('Waiting to send') }}</b><small>{{ outboxLine() }}</small></span>
      @if (outbox.pending().length) { <span class="count">{{ outbox.pending().length }}</span> }
      <ion-icon name="chevron-forward" class="go" />
    </button>

    <p class="section-title">{{ t('Settings') }}</p>
    <div class="card flat">
      <button class="row-item" (click)="pickLanguage()"><span class="ico blue"><ion-icon name="language" /></span>
        <span class="grow">{{ t('App language') }}</span><span class="val">{{ langName() }}</span><ion-icon name="chevron-forward" class="go" /></button>
      <button class="row-item" (click)="pinOpen.set(true)"><span class="ico grey"><ion-icon name="lock-closed" /></span>
        <span class="grow">{{ t('Change PIN') }}</span><ion-icon name="chevron-forward" class="go" /></button>
      <button class="row-item" [disabled]="!api.otherMemberships().length" (click)="pickOrganisation()"><span class="ico teal"><ion-icon name="business" /></span>
        <span class="grow">{{ t('Organisation') }}</span><span class="val">{{ api.brand() }}</span>
        @if (api.otherMemberships().length) { <ion-icon name="chevron-forward" class="go" /> }</button>
      <button class="row-item" (click)="openEdit()"><span class="ico orange"><ion-icon name="phone-portrait" /></span>
        <span class="grow">{{ t('Network and languages') }}</span><span class="val">{{ networkName() }}</span><ion-icon name="chevron-forward" class="go" /></button>
    </div>

    @if (api.isCoordinator()) {
      <p class="section-title">{{ t('Coordinator tools') }}</p>
      <div class="card flat">
        <button class="row-item" routerLink="/tabs/tasks"><span class="ico orange"><ion-icon name="checkmark-done" /></span>
          <span class="grow">{{ t('Tasks') }}</span><ion-icon name="chevron-forward" class="go" /></button>
        <button class="row-item" routerLink="/coord/team"><span class="ico teal"><ion-icon name="people" /></span>
          <span class="grow">{{ t('My team') }}</span><small class="val">{{ t('add people, activation codes') }}</small><ion-icon name="chevron-forward" class="go" /></button>
        <button class="row-item" routerLink="/coord/contact"><span class="ico blue"><ion-icon name="shield-checkmark" /></span>
          <span class="grow">{{ t('Add authority contact') }}</span><ion-icon name="chevron-forward" class="go" /></button>
      </div>
    }

    <p class="section-title">{{ t('Help') }}</p>
    <div class="card flat">
      <button class="row-item" routerLink="/callback"><span class="ico teal"><ion-icon name="call" /></span>
        <span class="grow">{{ t('Ask my coordinator to call me') }}</span><ion-icon name="chevron-forward" class="go" /></button>
      <button class="row-item" (click)="howItWorks()"><span class="ico blue"><ion-icon name="help-circle" /></span>
        <span class="grow">{{ t('Help and how-tos') }}</span><ion-icon name="chevron-forward" class="go" /></button>
      @if (helpline) {
        <a class="row-item" [href]="'tel:' + helpline"><span class="ico grey"><ion-icon name="headset" /></span>
          <span class="grow">{{ t('Call the helpdesk') }}</span><ion-icon name="chevron-forward" class="go" /></a>
      }
      <div class="row-item"><span class="ico grey"><ion-icon name="key" /></span>
        <span class="grow">{{ t('Agent code') }}<small>{{ t('Used in SMS reports') }}</small></span><b class="code">{{ api.me()?.agent_code ?? '—' }}</b></div>
    </div>

    <button class="signout" (click)="signOut()"><ion-icon name="log-out" />{{ t('Sign out') }}</button>
    <p class="ver">Rumfa · {{ api.brand() }} · {{ api.me()?.phone }}</p>

    <!-- Change PIN: current, new, repeat -->
    <ion-modal [isOpen]="pinOpen()" (didDismiss)="closePin()">
      <ng-template>
        <ion-header><ion-toolbar>
          <ion-buttons slot="start"><ion-button (click)="closePin()">{{ t('Cancel') }}</ion-button></ion-buttons>
          <ion-title>{{ t('Change PIN') }}</ion-title>
        </ion-toolbar></ion-header>
        <ion-content class="ion-padding">
          <h2 class="pin-h">{{ t(pinTitle()) }}</h2>
          <p class="pin-s">{{ pinStep() === 'current' ? t('Enter the PIN you use now') : pinStep() === 'next' ? t('Choose 6 new digits') : t('Enter the same 6 digits again') }}</p>
          @switch (pinStep()) {
            @case ('current') { <app-pin-pad #p1 (done)="pinCurrent($event, p1)" [disabled]="saving()" /> }
            @case ('next') { <app-pin-pad #p2 (done)="pinNext($event, p2)" [disabled]="saving()" /> }
            @case ('repeat') { <app-pin-pad #p3 (done)="pinRepeat($event, p3)" [disabled]="saving()" /> }
          }
          @if (!outbox.online()) { <p class="pin-s warn">{{ t('Changing the PIN needs internet.') }}</p> }
        </ion-content>
      </ng-template>
    </ion-modal>

    <!-- Edit profile -->
    <ion-modal [isOpen]="editing()" (didDismiss)="editing.set(false)">
      <ng-template>
        <ion-header><ion-toolbar>
          <ion-buttons slot="start"><ion-button (click)="editing.set(false)">{{ t('Cancel') }}</ion-button></ion-buttons>
          <ion-title>{{ t('Edit profile') }}</ion-title>
          <ion-buttons slot="end"><ion-button strong (click)="save()" [disabled]="saving()">{{ t('Save') }}</ion-button></ion-buttons>
        </ion-toolbar></ion-header>
        <ion-content class="ion-padding">
          <label class="fl">{{ t('Full name') }}</label>
          <input class="big-input" [(ngModel)]="form.fullName" autocapitalize="words" />
          <label class="fl">{{ t('Email (optional)') }}</label>
          <input class="big-input" type="email" inputmode="email" [(ngModel)]="form.email" />
          <label class="fl">{{ t('Phone') }}</label>
          <div class="ro">{{ api.me()?.phone }}<small>{{ t('Your sign-in. Ask your coordinator to change it.') }}</small></div>
          <p class="section-title">{{ t('Mobile network') }} <span class="lc">· {{ t('for airtime and data') }}</span></p>
          <div class="chips">
            @for (n of networks; track n.code) { <button [class.on]="form.network === n.code" (click)="form.network = n.code">{{ n.name }}</button> }
          </div>
          <p class="section-title">{{ t('Languages you speak') }}</p>
          <div class="chips">
            @for (l of spoken; track l.code) { <button [class.on]="form.languages.has(l.code)" (click)="toggleLang(l.code)">{{ l.name }}</button> }
          </div>
        </ion-content>
      </ng-template>
    </ion-modal>
  </ion-content>`,
  styles: `
    .profile { display: flex; align-items: center; gap: 14px; }
    .av.big { width: 62px; height: 62px; font-size: 22px; background: linear-gradient(135deg, #0f766e, #115e59); }
    .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; } .who b { font-size: 19px; }
    .who span { font-size: 13px; color: var(--r-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .who .org { display: inline-flex; align-items: center; gap: 4px; color: var(--r-accent); font-weight: 700; }
    .edit { width: 42px; height: 42px; border-radius: 50%; border: 0; background: var(--r-accent-soft); color: var(--r-accent); font-size: 21px; display: grid; place-items: center; }
    .sync { width: 100%; display: flex; align-items: center; gap: 12px; text-align: left; font: inherit; color: var(--r-ink); }
    .sync.off, .sync.wait { border-color: #f6cfae; background: #fff8f1; }
    .grow { flex: 1; min-width: 0; text-align: left; } .grow b { display: block; } .grow small { display: block; color: var(--r-muted); font-size: 13px; }
    .count { background: var(--r-high); color: #fff; border-radius: 999px; padding: 2px 9px; font-size: 13px; font-weight: 800; }
    .row-item { width: 100%; background: #fff; border-left: 0; border-right: 0; border-top: 0; font: inherit; font-size: 16px; color: var(--r-ink); text-decoration: none; }
    .row-item:disabled { opacity: 1; }
    .ico { width: 38px; height: 38px; border-radius: 11px; } .ico ion-icon { font-size: 20px; }
    .val { color: var(--r-muted); font-size: 14px; white-space: nowrap; } .go { color: #b6bec9; font-size: 18px; flex: none; }
    .code { font-family: ui-monospace, monospace; font-size: 17px; letter-spacing: .08em; }
    .signout { width: 100%; margin-top: 22px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 15px; border-radius: 16px;
      border: 1.5px solid #f3c7c3; background: #fff; color: var(--r-urgent); font: inherit; font-size: 16px; font-weight: 800; }
    .ver { text-align: center; font-size: 12px; color: var(--r-muted); padding: 12px 0 24px; }
    .pin-h { text-align: center; margin: 18px 0 4px; font-size: 22px; } .pin-s { text-align: center; color: var(--r-muted); margin: 0 0 18px; } .warn { color: var(--r-high); margin-top: 16px; }
    .fl { display: block; font-size: 13px; font-weight: 700; color: var(--r-ink-2); margin: 14px 2px 6px; }
    .ro { padding: 14px 16px; border-radius: 14px; background: #eef1f4; font-size: 18px; } .ro small { display: block; font-size: 12px; color: var(--r-muted); margin-top: 2px; }
    .lc { text-transform: none; letter-spacing: 0; font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips button { padding: 10px 16px; border-radius: 999px; border: 1.5px solid #d5dae1; background: #fff; font: inherit; font-size: 15px; font-weight: 600; color: var(--r-ink); }
    .chips button.on { background: var(--r-accent-soft); border-color: var(--r-accent); color: var(--r-accent); }
  `,
})
export default class MePage {
  api = inject(Api);
  outbox = inject(Outbox);
  sheet = inject(OutboxSheet);
  i18n = inject(I18n);
  private ui = inject(Ui);
  private router = inject(Router);
  private alerts = inject(AlertController);
  t = this.i18n.t;
  helpline = window.RUMFA_CONFIG.helpline;
  networks = NETWORKS;
  spoken = SPOKEN;
  editing = signal(false);
  saving = signal(false);
  form = { fullName: '', email: '', network: '', languages: new Set<string>() };

  networkName() { return NETWORKS.find((n) => n.code === this.api.me()?.network)?.name ?? this.t('Not set'); }

  // ---- Change PIN (checked on the server, then saved on this phone for offline unlock) ----
  private pin = inject(Pin);
  pinOpen = signal(false);
  pinStep = signal<'current' | 'next' | 'repeat'>('current');
  private pinOld = ''; private pinNew = '';
  pinTitle() { return this.pinStep() === 'current' ? 'Current PIN' : this.pinStep() === 'next' ? 'New PIN' : 'Repeat the new PIN'; }
  closePin() { this.pinOpen.set(false); this.pinStep.set('current'); this.pinOld = this.pinNew = ''; }
  async pinCurrent(p: string, pad: PinPad) {
    if ((await this.pin.check(p)) !== 'ok') { pad.reset(true); await this.ui.error('That is not your current PIN'); return; }
    this.pinOld = p; this.pinStep.set('next');
  }
  pinNext(p: string, pad: PinPad) {
    if (p === this.pinOld) { pad.reset(true); void this.ui.error('Choose a PIN different from the old one'); return; }
    this.pinNew = p; this.pinStep.set('repeat');
  }
  async pinRepeat(p: string, pad: PinPad) {
    if (p !== this.pinNew) { pad.reset(true); await this.ui.error('The PINs do not match. Try again.'); this.pinStep.set('next'); return; }
    this.saving.set(true);
    try {
      await this.api.post('/auth/pin/change', { current: this.pinOld, pin: this.pinNew });
      await this.pin.set(this.pinNew);
      this.closePin();
      await this.ui.toast('PIN changed');
    } catch (e) { pad.reset(true); await this.ui.error(e); } finally { this.saving.set(false); }
  }

  role() { return ROLE[this.api.me()?.role ?? ''] ?? this.api.me()?.role ?? ''; }
  level() { return LEVEL[this.api.me()?.level ?? ''] ?? ''; }
  initials() { return (this.api.me()?.full_name ?? '?').replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  langName = computed(() => LANGUAGES.find((l) => l.code === this.i18n.lang())?.name ?? 'English');
  outboxLine = computed(() => {
    const n = this.outbox.pending().length;
    if (!this.outbox.online()) return this.t('Offline · everything is saved on this phone');
    return n ? `${n} ${this.t('waiting to send')}` : this.t('Everything sent');
  });

  async pickLanguage() {
    const a = await this.alerts.create({
      header: this.t('App language'),
      inputs: LANGUAGES.map((l) => ({ type: 'radio' as const, label: l.name, value: l.code, checked: l.code === this.i18n.lang() })),
      buttons: [{ text: this.t('Cancel'), role: 'cancel' }, { text: this.t('OK'), handler: (v: string) => { if (v) this.i18n.set(v); } }],
    });
    await a.present();
  }

  async pickOrganisation() {
    const others = this.api.otherMemberships();
    if (!others.length) return;
    const a = await this.alerts.create({
      header: this.t('Switch organisation'), message: `${this.t('Now working for')} ${this.api.brand()}`,
      inputs: others.map((m) => ({ type: 'radio' as const, label: `${m.brand} · ${m.role}`, value: m.tid })),
      buttons: [{ text: this.t('Cancel'), role: 'cancel' }, { text: this.t('Switch'), handler: (tid: string) => { const m = others.find((x) => x.tid === tid); if (m) void this.switchTo(m); } }],
    });
    await a.present();
  }

  async howItWorks() {
    const a = await this.alerts.create({ header: this.t('How the app works'), cssClass: 'pre-line', buttons: [this.t('OK')], message: [
      'Everything you send is saved on your phone first. When there is no internet, it sends later by itself.',
      'If something has not gone after 2 minutes, a Send by SMS button appears in the Outbox. The app writes the SMS for you.',
      'For danger, hold the red SOS button at the top of the screen.',
    ].map((x) => '• ' + this.t(x)).join('\n\n') });
    await a.present();
  }

  openEdit() {
    const me = this.api.me();
    this.form = { fullName: me?.full_name ?? '', email: me?.email ?? '', network: me?.network ?? '', languages: new Set(me?.languages ?? []) };
    this.editing.set(true);
  }
  toggleLang(code: string) { if (this.form.languages.has(code)) this.form.languages.delete(code); else this.form.languages.add(code); }

  async save() {
    const name = this.form.fullName.trim();
    if (name.length < 3) { await this.ui.error('Write your full name'); return; }
    const email = this.form.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { await this.ui.error('That email does not look right'); return; }
    this.saving.set(true);
    try {
      await this.api.patch('/me/profile', { fullName: name, email: email || null, languages: [...this.form.languages],
        ...(this.form.network ? { network: this.form.network } : {}) });
      await this.api.refreshMe();
      this.editing.set(false);
      await this.ui.toast('Profile saved');
    } catch (e) { await this.ui.error(e); } finally { this.saving.set(false); }
  }

  async signOut() {
    const waiting = this.outbox.pending().length;
    const msg = waiting ? 'Some things have not been sent yet. They stay on this phone and send after you sign in again.' : 'You will need your PIN to sign in again.';
    if (!(await this.ui.confirm('Sign out?', msg, 'Sign out', 'Cancel'))) return;
    await this.api.signOut(); await this.router.navigateByUrl('/login');
  }

  async switchTo(m: Membership) {
    if (this.outbox.waitingHere().length) { await this.ui.error(`Some reports for ${this.api.brand()} have not gone yet. Send them first.`); return; }
    try {
      await this.api.switchTenant(m.tid);
      await this.ui.toast(`Now working for ${m.brand}`);
      await this.router.navigateByUrl(this.api.me()?.onboarded_at ? '/' : '/onboarding');
    } catch (e) { await this.ui.error(e); }
  }
}
