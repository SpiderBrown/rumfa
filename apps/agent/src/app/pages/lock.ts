import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent } from '@ionic/angular';
import { PinPad } from '../core/pin-pad';
import { Pin } from '../core/pin';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** Unlocks the app when it is opened again. Works offline (checked on the phone); online, an expired session is renewed with the same PIN. */
@Component({
  selector: 'page-lock',
  imports: [FormsModule, IonButton, IonContent, PinPad],
  template: `
  <ion-content class="ion-padding">
    <div class="wrap">
      <span class="av big">{{ initials() }}</span>
      <h1>{{ t('Welcome back') }}, {{ first() }}</h1>
      <p class="lede">{{ t('Enter your 6-digit PIN') }}</p>
      <app-pin-pad #pad (done)="unlock($event, pad)" />
      <ion-button expand="block" fill="clear" (click)="forgot()">{{ t('Forgot PIN? Activate this phone again') }}</ion-button>
      <p class="brand">{{ api.brand() }}</p>
    </div>
  </ion-content>`,
  styles: `
    .wrap { max-width: 420px; margin: 0 auto; padding-top: 72px; text-align: center; }
    .av.big { width: 72px; height: 72px; font-size: 26px; margin: 0 auto 18px; }
    h1 { margin: 0; font-size: 26px; font-weight: 800; } .lede { margin: 6px 0 0; color: var(--r-muted); }
    .brand { margin-top: 28px; color: var(--r-muted); font-size: 13px; font-weight: 600; }
  `,
})
export default class LockPage {
  api = inject(Api);
  private pinSvc = inject(Pin);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  first() { return (this.api.me()?.full_name ?? '').split(' ')[0]; }
  initials() { return (this.api.me()?.full_name ?? '').replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }

  async unlock(pin: string, pad: PinPad) {
    const r = await this.pinSvc.check(pin);
    pad.reset(r !== 'ok');
    if (r === 'wrong') { await this.ui.error('Wrong PIN'); return; }
    if (r === 'locked') { await this.ui.error('Too many wrong tries. Activate this phone again.'); return this.forgot(); }
    if (!this.api.session()) {
      // Session ended while the app was closed: sign in again with the same PIN (needs a connection)
      try {
        const res = await this.api.pinSignIn(pin);
        if (!res.done) return this.router.navigateByUrl('/login');
      } catch (e) { await this.ui.error(e); if (!this.api.hasDevice()) return this.forgot(); return; }
    }
    await this.router.navigateByUrl('/');
  }
  async forgot() {
    await this.api.signOut();
    this.api.forgetDevice();
    localStorage.removeItem('rumfa.pin');
    await this.router.navigateByUrl('/login');
  }
}
