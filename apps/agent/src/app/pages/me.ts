import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AlertController, IonBadge, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonModal,
  IonNote, IonTitle, IonToolbar } from '@ionic/angular';
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
  imports: [FormsModule, RouterLink, AppBar, IonBadge, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList,
    IonListHeader, IonModal, IonNote, IonTitle, IonToolbar],
  template: `
  <app-bar [title]="t('Me')" [sos]="api.atUnit()" />
  <ion-content class="bg">
    <section class="card">
      <div class="avatar">{{ initials() }}</div>
      <div class="who"><b>{{ api.me()?.full_name }}</b>
        <span>{{ t(role()) }} · {{ t(level()) }} {{ api.me()?.area_code }}</span>
        <span>{{ api.me()?.phone }}@if (api.me()?.email) { · {{ api.me()?.email }} }</span></div>
      <button class="edit" (click)="openEdit()" [attr.aria-label]="t('Edit profile')"><ion-icon name="create-outline" /></button>
    </section>

    <ion-list inset lines="full">
      <ion-item button detail (click)="sheet.open()">
        <ion-icon slot="start" [name]="outbox.online() ? 'cloud-done-outline' : 'cloud-offline-outline'" [color]="outbox.online() ? 'success' : 'warning'" />
        <ion-label>{{ t('Outbox') }}<p>{{ outboxLine() }}</p></ion-label>
        @if (outbox.pending().length) { <ion-badge slot="end" color="warning">{{ outbox.pending().length }}</ion-badge> }
      </ion-item>
    </ion-list>

    <ion-list inset lines="full">
      <ion-list-header>{{ t('Preferences') }}</ion-list-header>
      <ion-item button detail (click)="pickLanguage()">
        <ion-icon slot="start" name="language" color="primary" /><ion-label>{{ t('App language') }}</ion-label>
        <ion-note slot="end">{{ langName() }}</ion-note>
      </ion-item>
      <ion-item [button]="api.otherMemberships().length > 0" [detail]="api.otherMemberships().length > 0" (click)="pickOrganisation()">
        <ion-icon slot="start" name="business" color="primary" /><ion-label>{{ t('Organisation') }}</ion-label>
        <ion-note slot="end">{{ api.brand() }}</ion-note>
      </ion-item>
    </ion-list>

    @if (api.isCoordinator()) {
      <ion-list inset lines="full">
        <ion-list-header>{{ t('Coordinator tools') }}</ion-list-header>
        <ion-item button routerLink="/coord/team" detail><ion-icon slot="start" name="people" color="primary" /><ion-label>{{ t('My team') }}</ion-label></ion-item>
        <ion-item button routerLink="/coord/contact" detail><ion-icon slot="start" name="shield-checkmark" color="primary" /><ion-label>{{ t('Add authority contact') }}</ion-label></ion-item>
      </ion-list>
    }

    <ion-list inset lines="full">
      <ion-list-header>{{ t('Help') }}</ion-list-header>
      <ion-item button detail routerLink="/callback"><ion-icon slot="start" name="phone-portrait" color="primary" /><ion-label>{{ t('Ask my coordinator to call me') }}</ion-label></ion-item>
      <ion-item button detail (click)="howItWorks()"><ion-icon slot="start" name="help-circle" color="primary" /><ion-label>{{ t('How the app works') }}</ion-label></ion-item>
      @if (helpline) { <ion-item button detail [href]="'tel:' + helpline"><ion-icon slot="start" name="call" color="primary" /><ion-label>{{ t('Call the helpdesk') }}</ion-label></ion-item> }
      <ion-item><ion-icon slot="start" name="key" color="medium" /><ion-label>{{ t('Agent code') }}</ion-label><ion-note slot="end">{{ api.me()?.agent_code ?? '—' }}</ion-note></ion-item>
    </ion-list>

    <ion-list inset lines="none">
      <ion-item button (click)="signOut()"><ion-icon slot="start" name="log-out" color="danger" /><ion-label color="danger">{{ t('Sign out') }}</ion-label></ion-item>
    </ion-list>
    <p class="ver">Rumfa · {{ api.brand() }}</p>

    <!-- Edit profile -->
    <ion-modal [isOpen]="editing()" (didDismiss)="editing.set(false)">
      <ng-template>
        <ion-header><ion-toolbar>
          <ion-buttons slot="start"><ion-button (click)="editing.set(false)">{{ t('Cancel') }}</ion-button></ion-buttons>
          <ion-title>{{ t('Edit profile') }}</ion-title>
          <ion-buttons slot="end"><ion-button strong (click)="save()" [disabled]="saving()">{{ t('Save') }}</ion-button></ion-buttons>
        </ion-toolbar></ion-header>
        <ion-content class="bg">
          <ion-list inset lines="full">
            <ion-item><ion-input [label]="t('Full name')" labelPlacement="stacked" [(ngModel)]="form.fullName" autocapitalize="words" /></ion-item>
            <ion-item><ion-input [label]="t('Email (optional)')" labelPlacement="stacked" type="email" inputmode="email" [(ngModel)]="form.email" /></ion-item>
            <ion-item><ion-label>{{ t('Phone') }}<p>{{ t('Your sign-in. Ask your coordinator to change it.') }}</p></ion-label><ion-note slot="end">{{ api.me()?.phone }}</ion-note></ion-item>
          </ion-list>
          <div class="group">
            <div class="gl">{{ t('Mobile network') }} <span>{{ t('for airtime and data') }}</span></div>
            <div class="chips">
              @for (n of networks; track n.code) { <button [class.on]="form.network === n.code" (click)="form.network = n.code">{{ n.name }}</button> }
            </div>
          </div>
          <div class="group">
            <div class="gl">{{ t('Languages you speak') }}</div>
            <div class="chips">
              @for (l of spoken; track l.code) { <button [class.on]="form.languages.has(l.code)" (click)="toggleLang(l.code)">{{ l.name }}</button> }
            </div>
          </div>
        </ion-content>
      </ng-template>
    </ion-modal>
  </ion-content>`,
  styles: `
    .bg { --background: #f3f4f6; }
    .card { display: flex; align-items: center; gap: 14px; margin: 16px; padding: 16px; border-radius: 18px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    .avatar { width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center; flex: none; font-weight: 800; font-size: 22px;
      background: linear-gradient(135deg, #e7f1ea, #cfe6d6); color: var(--ion-color-primary); }
    .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; } .who b { font-size: 18px; }
    .who span { font-size: 13px; color: var(--ion-color-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .edit { width: 42px; height: 42px; border-radius: 50%; border: 0; background: #f1f5f9; color: var(--ion-color-primary); font-size: 22px; display: grid; place-items: center; }
    ion-list[inset] { border-radius: 14px; margin-top: 0; } ion-list-header { font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: var(--ion-color-medium); }
    .ver { text-align: center; font-size: 12px; color: var(--ion-color-medium); padding-bottom: 24px; }
    .group { margin: 8px 16px 16px; } .gl { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--ion-color-medium); margin-bottom: 8px; }
    .gl span { text-transform: none; letter-spacing: 0; font-weight: 400; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips button { padding: 10px 16px; border-radius: 22px; border: 1.5px solid #cbd5e1; background: #fff; font: inherit; font-size: 15px; color: var(--ion-text-color); }
    .chips button.on { background: var(--ion-color-primary); border-color: var(--ion-color-primary); color: #fff; font-weight: 600; }
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

  role() { return ROLE[this.api.me()?.role ?? ''] ?? this.api.me()?.role ?? ''; }
  level() { return LEVEL[this.api.me()?.level ?? ''] ?? ''; }
  initials() { return (this.api.me()?.full_name ?? '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
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
