import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent } from '@ionic/angular';
import { PinPad } from '../core/pin-pad';
import { normaliseNgPhone } from '@rumfa/shared';
import { Api, type Membership, type SignIn } from '../core/api';
import { Pin } from '../core/pin';
import { I18n, LANGUAGES } from '../core/i18n';
import { Ui } from '../core/ui';

type Step = 'phone' | 'code' | 'newpin' | 'repeat' | 'pin' | 'choose';

/**
 * First use of a phone: language, phone, then a code by SMS or WhatsApp (or an activation code from the
 * coordinator) and a new 6-digit PIN. Later sign-ins on the same phone only need the PIN. People who work
 * for several organisations pick one.
 */
@Component({
  selector: 'page-login',
  imports: [FormsModule, IonButton, IonContent, PinPad],
  template: `
  <ion-content class="ion-padding">
    <div class="wrap">
      <div class="langs" role="radiogroup" aria-label="Language">
        @for (l of langs; track l.code) { <button role="radio" [class.on]="i18n.lang() === l.code" (click)="i18n.set(l.code)">{{ l.name }}</button> }
      </div>
      <div class="mark">{{ (api.brand() || 'R')[0] }}</div>
      @switch (step()) {
        @case ('phone') {
          <h1>{{ api.brand() }} {{ t('agents') }}</h1>
          <p class="lede">{{ t("Enter the phone number your coordinator registered. We'll text you a code.") }}</p>
          <label class="lbl" for="ph">{{ t('Phone number') }}</label>
          <input id="ph" class="big-input" type="tel" inputmode="tel" [(ngModel)]="phone" placeholder="0803 123 4567" autocomplete="tel" />
          <ion-button expand="block" (click)="send('sms')" [disabled]="busy()">{{ t('Send code') }}</ion-button>
          <ion-button expand="block" fill="outline" (click)="send('whatsapp')" [disabled]="busy()">{{ t('Send code by WhatsApp') }}</ion-button>
          <ion-button expand="block" fill="clear" (click)="useActivationCode()">{{ t('I have an activation code') }}</ion-button>
        }
        @case ('code') {
          <h1>{{ byCoordinator ? t('Activation code') : t('Enter the code') }}</h1>
          <p class="lede">{{ byCoordinator ? t('Enter the activation code from your coordinator') : t('Enter the code we sent by SMS') }} · {{ e164 }}</p>
          <input class="big-input code" [attr.inputmode]="byCoordinator ? 'text' : 'numeric'" [attr.maxlength]="byCoordinator ? 9 : 6" [(ngModel)]="code" [attr.aria-label]="t('Code')" autocomplete="one-time-code" />
          <ion-button expand="block" (click)="codeEntered()" [disabled]="code.trim().length < 4">{{ t('Continue') }}</ion-button>
          <ion-button expand="block" fill="clear" (click)="step.set('phone')">{{ t('Use another number') }}</ion-button>
        }
        @case ('newpin') {
          <h1>{{ t('Create a 6-digit PIN') }}</h1>
          <p class="lede">{{ t('You will use this PIN every time you open the app.') }}</p>
          <app-pin-pad #pad (done)="pinCreated($event, pad)" />
        }
        @case ('repeat') {
          <h1>{{ t('Repeat the PIN') }}</h1>
          <p class="lede">{{ t('Enter the same 6 digits again.') }}</p>
          <app-pin-pad #pad2 (done)="pinRepeated($event, pad2)" [disabled]="busy()" />
          <ion-button expand="block" fill="clear" (click)="step.set('newpin')">{{ t('Start the PIN again') }}</ion-button>
        }
        @case ('pin') {
          <h1>{{ t('Welcome back') }}</h1>
          <p class="lede">{{ t('Enter your 6-digit PIN') }} · {{ api.devicePhone() }}</p>
          <app-pin-pad #pad3 (done)="signIn($event, pad3)" [disabled]="busy()" />
          <ion-button expand="block" fill="clear" (click)="restart()">{{ t('Forgot PIN? Activate this phone again') }}</ion-button>
        }
        @case ('choose') {
          <h1>{{ t('Which organisation are you working for?') }}</h1>
          @for (m of memberships(); track m.tid) {
            <button class="org card" (click)="choose(m)"><span class="av">{{ m.brand[0] }}</span><span><b>{{ m.brand }}</b><small>{{ m.role }} · {{ m.area }}</small></span></button>
          }
        }
      }
    </div>
  </ion-content>`,
  styles: `
    .wrap { max-width: 420px; margin: 0 auto; padding-top: 24px; }
    .langs { display: flex; gap: 6px; justify-content: flex-end; margin-bottom: 40px; }
    .langs button { border: 1px solid var(--r-line); background: #fff; border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 14px; font-weight: 700; color: var(--r-ink-2); }
    .langs button.on { background: var(--r-ink); border-color: var(--r-ink); color: #fff; }
    .mark { width: 56px; height: 56px; border-radius: 16px; background: var(--r-accent); color: #fff; display: grid; place-items: center; font-size: 28px; font-weight: 800; margin-bottom: 20px; }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 0 0 20px; color: var(--r-muted); font-size: 16px; line-height: 1.4; }
    .lbl { display: block; font-size: 15px; font-weight: 700; color: var(--r-ink-2); margin-bottom: 8px; }
    .big-input { margin-bottom: 16px; } .code { letter-spacing: .3em; font-size: 26px; text-align: center; }
    ion-button { margin: 6px 0; }
    .org { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; font: inherit; }
    .org b { display: block; font-size: 17px; } .org small { color: var(--r-muted); }
  `,
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

  codeEntered() { this.pin1 = this.pin2 = ''; this.step.set('newpin'); }
  pinCreated(pin: string, pad: PinPad) { this.pin1 = pin; pad.reset(); this.step.set('repeat'); }
  async pinRepeated(pin: string, pad: PinPad) {
    if (pin !== this.pin1) { pad.reset(true); await this.ui.error('The two PINs are different'); return; }
    this.pin2 = pin;
    await this.activate();
    if (this.step() === 'repeat') pad.reset();
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

  signIn(pin: string, pad?: PinPad) {
    return this.run(async () => {
      const r = await this.api.pinSignIn(pin);
      await this.pinSvc.set(pin);
      await this.next(r);
    }).then(() => { pad?.reset(this.step() === 'pin'); if (!this.api.hasDevice()) this.step.set('phone'); });
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
