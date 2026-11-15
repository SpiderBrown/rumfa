import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonInput, IonItem, IonList } from '@ionic/angular';
import { Pin } from '../core/pin';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** Unlocks the app when it is opened again. Works offline (checked on the phone); online, an expired session is renewed with the same PIN. */
@Component({
  selector: 'page-lock',
  imports: [FormsModule, IonButton, IonContent, IonInput, IonItem, IonList],
  template: `
  <ion-content class="ion-padding">
    <h1>{{ api.brand() }}</h1>
    <p>{{ api.me()?.full_name }}</p>
    <h2>{{ t('Enter your PIN') }}</h2>
    <ion-list><ion-item><ion-input type="password" inputmode="numeric" maxlength="6" [(ngModel)]="pin" (ionInput)="maybe()" aria-label="PIN" /></ion-item></ion-list>
    <ion-button expand="block" (click)="unlock()">{{ t('Continue') }}</ion-button>
    <ion-button expand="block" fill="clear" (click)="forgot()">{{ t('Forgot PIN? Activate this phone again') }}</ion-button>
  </ion-content>`,
  styles: `h1 { color: var(--ion-color-primary); margin-top: 48px; }`,
})
export default class LockPage {
  api = inject(Api);
  private pinSvc = inject(Pin);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  pin = '';

  maybe() { if (this.pin.length === 6) void this.unlock(); }

  async unlock() {
    const pin = this.pin;
    this.pin = '';
    const r = await this.pinSvc.check(pin);
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
