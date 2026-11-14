import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonSegment, IonSegmentButton, IonTitle, IonToolbar } from '@ionic/angular';
import { normaliseNgPhone } from '@alawa/shared';
import { Supa } from '../core/supa';
import { Pin } from '../core/pin';
import { I18n, LANGUAGES } from '../core/i18n';
import { Ui } from '../core/ui';

/** First sign-in: language, phone, SMS code, then create a PIN for quick unlock. */
@Component({
  selector: 'page-login',
  imports: [FormsModule, IonButton, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonSegment, IonSegmentButton, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-title>ALAWA</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    <ion-segment [value]="i18n.lang()" (ionChange)="i18n.set($any($event.detail.value))">
      @for (l of langs; track l.code) { <ion-segment-button [value]="l.code"><ion-label>{{ l.name }}</ion-label></ion-segment-button> }
    </ion-segment>
    @switch (step()) {
      @case ('phone') {
        <h2>{{ t('Sign in') }}</h2>
        <ion-list><ion-item><ion-input [label]="t('Phone number')" labelPlacement="stacked" type="tel" inputmode="tel" [(ngModel)]="phone" placeholder="0803 123 4567" /></ion-item></ion-list>
        <ion-button expand="block" (click)="send()" [disabled]="busy()">{{ t('Send code') }}</ion-button>
      }
      @case ('code') {
        <h2>{{ t('Enter the code we sent by SMS') }}</h2>
        <ion-list><ion-item><ion-input label="Code" labelPlacement="stacked" inputmode="numeric" maxlength="6" [(ngModel)]="code" /></ion-item></ion-list>
        <ion-button expand="block" (click)="verify()" [disabled]="busy()">{{ t('Continue') }}</ion-button>
        <ion-button expand="block" fill="clear" (click)="step.set('phone')">{{ t('Back') }}</ion-button>
      }
      @case ('pin') {
        <h2>{{ t('Create a 4-digit PIN') }}</h2>
        <p class="hint">You will use this PIN to open the app. Do not share it.</p>
        <ion-list>
          <ion-item><ion-input label="PIN" labelPlacement="stacked" type="password" inputmode="numeric" maxlength="4" [(ngModel)]="pin1" /></ion-item>
          <ion-item><ion-input label="PIN again" labelPlacement="stacked" type="password" inputmode="numeric" maxlength="4" [(ngModel)]="pin2" /></ion-item>
        </ion-list>
        <ion-button expand="block" (click)="savePin()">{{ t('Save') }}</ion-button>
      }
    }
  </ion-content>`,
  styles: `h2 { margin-top: 28px; }`,
})
export default class LoginPage {
  private supa = inject(Supa);
  private pin = inject(Pin);
  private router = inject(Router);
  private ui = inject(Ui);
  i18n = inject(I18n);
  t = this.i18n.t;
  langs = LANGUAGES;
  step = signal<'phone' | 'code' | 'pin'>(this.supa.session() && this.supa.me() ? 'pin' : 'phone');
  busy = signal(false);
  phone = ''; code = ''; pin1 = ''; pin2 = '';
  private e164 = '';

  async send() {
    const p = normaliseNgPhone(this.phone);
    if (!p) { await this.ui.error('Enter a valid Nigerian mobile number'); return; }
    this.busy.set(true);
    const { error } = await this.supa.client.auth.signInWithOtp({ phone: p });
    this.busy.set(false);
    if (error) { await this.ui.error(error.message); return; }
    this.e164 = p; this.step.set('code');
  }

  async verify() {
    this.busy.set(true);
    const { error } = await this.supa.client.auth.verifyOtp({ phone: this.e164, token: this.code.trim(), type: 'sms' });
    if (!error) await this.supa.refreshMe().catch(() => {});
    this.busy.set(false);
    if (error) { await this.ui.error(error.message); return; }
    if (!this.supa.me()) {
      await this.ui.error('This number is not registered. Ask your coordinator to add you.');
      await this.supa.signOut(); this.step.set('phone'); return;
    }
    this.step.set('pin');
  }

  async savePin() {
    if (!/^\d{4}$/.test(this.pin1) || this.pin1 !== this.pin2) { await this.ui.error('Enter the same 4 digits twice'); return; }
    await this.pin.set(this.pin1);
    await this.router.navigateByUrl(this.supa.me()?.onboarded_at ? '/' : '/onboarding');
  }
}
