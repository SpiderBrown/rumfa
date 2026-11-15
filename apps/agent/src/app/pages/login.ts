import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonSegment, IonSegmentButton, IonTitle, IonToolbar } from '@ionic/angular';
import { normaliseNgPhone } from '@rumfa/shared';
import { Api, type Membership, type SignIn } from '../core/api';
import { Pin } from '../core/pin';
import { I18n, LANGUAGES } from '../core/i18n';
import { Ui } from '../core/ui';

type Step = 'phone' | 'code' | 'pin' | 'choose';

/**
 * First use of a phone: language, phone, then a code by SMS or WhatsApp (or an activation code from the
 * coordinator) and a new 6-digit PIN. Later sign-ins on the same phone only need the PIN. People who work
 * for several organisations pick one.
 */
@Component({
  selector: 'page-login',
  imports: [FormsModule, IonButton, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonSegment, IonSegmentButton, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-title>{{ api.brand() }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    <ion-segment [value]="i18n.lang()" (ionChange)="i18n.set($any($event.detail.value))">
      @for (l of langs; track l.code) { <ion-segment-button [value]="l.code"><ion-label>{{ l.name }}</ion-label></ion-segment-button> }
    </ion-segment>
    @switch (step()) {
      @case ('phone') {
        <h2>{{ t('Sign in') }}</h2>
        <ion-list><ion-item><ion-input [label]="t('Phone number')" labelPlacement="stacked" type="tel" inputmode="tel" [(ngModel)]="phone" placeholder="0803 123 4567" /></ion-item></ion-list>
        <ion-button expand="block" (click)="send('sms')" [disabled]="busy()">{{ t('Send code') }}</ion-button>
        <ion-button expand="block" fill="outline" (click)="send('whatsapp')" [disabled]="busy()">{{ t('Send code by WhatsApp') }}</ion-button>
        <ion-button expand="block" fill="clear" (click)="useActivationCode()">{{ t('I have an activation code') }}</ion-button>
      }
      @case ('code') {
        <h2>{{ byCoordinator ? t('Enter the activation code from your coordinator') : t('Enter the code we sent by SMS') }}</h2>
        <ion-list>
          <ion-item><ion-input [label]="t('Code')" labelPlacement="stacked" [inputmode]="byCoordinator ? 'text' : 'numeric'" [maxlength]="byCoordinator ? 9 : 6" [(ngModel)]="code" /></ion-item>
          <ion-item><ion-input [label]="t('Create a 6-digit PIN')" labelPlacement="stacked" type="password" inputmode="numeric" maxlength="6" [(ngModel)]="pin1" /></ion-item>
          <ion-item><ion-input [label]="t('Repeat the PIN')" labelPlacement="stacked" type="password" inputmode="numeric" maxlength="6" [(ngModel)]="pin2" /></ion-item>
        </ion-list>
        <p class="hint">{{ t('You will use this PIN every time you open the app.') }}</p>
        <ion-button expand="block" (click)="activate()" [disabled]="busy()">{{ t('Continue') }}</ion-button>
        <ion-button expand="block" fill="clear" (click)="step.set('phone')">{{ t('Use another number') }}</ion-button>
      }
      @case ('pin') {
        <h2>{{ t('Enter your PIN') }}</h2>
        <p>{{ api.devicePhone() }}</p>
        <ion-list><ion-item><ion-input type="password" inputmode="numeric" maxlength="6" [(ngModel)]="pin1" (ionInput)="pin1.length === 6 && signIn()" aria-label="PIN" /></ion-item></ion-list>
        <ion-button expand="block" (click)="signIn()" [disabled]="busy()">{{ t('Continue') }}</ion-button>
        <ion-button expand="block" fill="clear" (click)="restart()">{{ t('Forgot PIN? Activate this phone again') }}</ion-button>
      }
      @case ('choose') {
        <h2>{{ t('Which organisation are you working for?') }}</h2>
        @for (m of memberships(); track m.tid) {
          <ion-button expand="block" color="light" class="org" (click)="choose(m)">{{ m.brand }}<br /><small>{{ m.role }} · {{ m.area }}</small></ion-button>
        }
      }
    }
  </ion-content>`,
  styles: `.org { height: auto; --padding-top: 12px; --padding-bottom: 12px; text-transform: none; } small { opacity: .7; }`,
})
export default class LoginPage {
  api = inject(Api);
  private pinSvc = inject(Pin);
  private router = inject(Router);
  private ui = inject(Ui);
  i18n = inject(I18n);
  t = this.i18n.t;
  langs = LANGUAGES;
  step = signal<Step>(this.api.hasDevice() ? 'pin' : 'phone');
  busy = signal(false);
  memberships = signal<Membership[]>([]);
  phone = '';
  e164 = '';
  code = '';
  pin1 = '';
  pin2 = '';
  byCoordinator = false;
  private selectToken = '';

  private async run(fn: () => Promise<unknown>) {
    this.busy.set(true);
    try { await fn(); } catch (e) { await this.ui.error(e); } finally { this.busy.set(false); }
  }

  private number(): boolean {
    const p = normaliseNgPhone(this.phone);
    if (!p) { void this.ui.error('Enter a valid Nigerian mobile number'); return false; }
    this.e164 = p;
    return true;
  }

  send(channel: 'sms' | 'whatsapp') {
    if (!this.number()) return;
    return this.run(async () => {
      await this.api.requestCode(this.e164, channel);
      this.byCoordinator = false;
      this.code = this.pin1 = this.pin2 = '';
      this.step.set('code');
    });
  }

  useActivationCode() {
    if (!this.number()) return;
    this.byCoordinator = true;
    this.code = this.pin1 = this.pin2 = '';
    this.step.set('code');
  }

  activate() {
    if (!/^\d{6}$/.test(this.pin1)) { void this.ui.error('The PIN must be 6 digits'); return; }
    if (this.pin1 !== this.pin2) { void this.ui.error('The two PINs are different'); return; }
    return this.run(async () => {
      const proof = this.byCoordinator ? { activationCode: this.code.trim() } : { code: this.code.trim() };
      const r = await this.api.activate(this.e164, this.pin1, proof);
      await this.pinSvc.set(this.pin1); // also unlocks the app offline
      await this.next(r);
    });
  }

  signIn() {
    const pin = this.pin1;
    this.pin1 = '';
    return this.run(async () => {
      const r = await this.api.pinSignIn(pin);
      await this.pinSvc.set(pin);
      await this.next(r);
    }).then(() => { if (!this.api.hasDevice()) this.step.set('phone'); });
  }

  choose(m: Membership) {
    return this.run(async () => { await this.api.selectTenant(this.selectToken, m.tid); await this.done(); });
  }

  restart() { this.api.forgetDevice(); this.step.set('phone'); }

  private async next(r: SignIn) {
    if (r.done) return this.done();
    this.selectToken = r.selectToken;
    this.memberships.set(r.memberships);
    this.step.set('choose');
  }

  private async done() {
    await this.router.navigateByUrl(this.api.me()?.onboarded_at ? '/' : '/onboarding');
  }
}
