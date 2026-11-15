import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonCheckbox, IonContent, IonHeader, IonItem, IonList, IonListHeader, IonRadio, IonRadioGroup, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** One-time setup: confirm details, network (for airtime/data) and languages. */
@Component({
  selector: 'page-onboarding',
  imports: [FormsModule, IonButton, IonCheckbox, IonContent, IonHeader, IonItem, IonList, IonListHeader, IonRadio, IonRadioGroup, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-title>Welcome</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (api.me(); as me) {
      <p><b>{{ me.full_name }}</b><br />{{ me.role }} · {{ me.area_code }}</p>
      <p class="hint">If these details are wrong, tell your coordinator.</p>
      <ion-list>
        <ion-list-header>Your mobile network</ion-list-header>
        <ion-radio-group [(ngModel)]="network">
          @for (n of networks; track n.code) { <ion-item><ion-radio [value]="n.code">{{ n.name }}</ion-radio></ion-item> }
        </ion-radio-group>
        <ion-list-header>Languages you speak</ion-list-header>
        @for (l of langs; track l.code) {
          <ion-item><ion-checkbox [checked]="languages.has(l.code)" (ionChange)="toggle(l.code, $event.detail.checked)">{{ l.name }}</ion-checkbox></ion-item>
        }
      </ion-list>
      <ion-button expand="block" (click)="save()" [disabled]="!network">{{ t('Continue') }}</ion-button>
    }
  </ion-content>`,
})
export default class OnboardingPage {
  api = inject(Api);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  networks = [{ code: 'mtn', name: 'MTN' }, { code: 'airtel', name: 'Airtel' }, { code: 'glo', name: 'Glo' }, { code: '9mobile', name: '9mobile' }];
  langs = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }, { code: 'ff', name: 'Fulfulde' }, { code: 'kr', name: 'Kanuri' },
    { code: 'yo', name: 'Yoruba' }, { code: 'ig', name: 'Igbo' }, { code: 'tiv', name: 'Tiv' }, { code: 'nup', name: 'Nupe' }];
  network = this.api.me()?.network ?? '';
  languages = new Set(this.api.me()?.languages ?? ['en']);

  toggle(code: string, on: boolean) { if (on) this.languages.add(code); else this.languages.delete(code); }

  async save() {
    try {
      await this.api.post('/me/onboarding', { network: this.network, languages: [...this.languages] });
      await this.api.refreshMe();
      await this.router.navigateByUrl('/');
    } catch (e) { await this.ui.error(e); }
  }
}
