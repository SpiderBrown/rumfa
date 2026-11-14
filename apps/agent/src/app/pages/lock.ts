import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonInput, IonItem, IonList } from '@ionic/angular';
import { Pin } from '../core/pin';
import { Supa } from '../core/supa';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

@Component({
  selector: 'page-lock',
  imports: [FormsModule, IonButton, IonContent, IonInput, IonItem, IonList],
  template: `
  <ion-content class="ion-padding">
    <h1>ALAWA</h1>
    <p>{{ supa.me()?.full_name }}</p>
    <h2>{{ t('Enter your PIN') }}</h2>
    <ion-list><ion-item><ion-input type="password" inputmode="numeric" maxlength="4" [(ngModel)]="pin" (ionInput)="maybe()" aria-label="PIN" /></ion-item></ion-list>
    <ion-button expand="block" (click)="unlock()">{{ t('Continue') }}</ion-button>
    <ion-button expand="block" fill="clear" (click)="forgot()">Forgot PIN? Sign in again by SMS</ion-button>
  </ion-content>`,
  styles: `h1 { color: var(--ion-color-primary); margin-top: 48px; }`,
})
export default class LockPage {
  supa = inject(Supa);
  private pinSvc = inject(Pin);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  pin = '';

  maybe() { if (this.pin.length === 4) void this.unlock(); }

  async unlock() {
    const r = await this.pinSvc.check(this.pin);
    this.pin = '';
    if (r === 'ok') await this.router.navigateByUrl('/');
    else if (r === 'wrong') await this.ui.error('Wrong PIN');
    else { await this.ui.error('Too many wrong tries. Sign in again by SMS.'); await this.supa.signOut(); await this.router.navigateByUrl('/login'); }
  }
  async forgot() { await this.supa.signOut(); await this.router.navigateByUrl('/login'); }
}
