import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonList, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** Quick count during counting: rough votes for the main parties, sent early for the estimate. */
@Component({
  selector: 'page-quick',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonList, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Quick count') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    <p class="hint">Send the votes as they are counted aloud at your unit. You can send again as counting goes on. The signed EC8A result comes later.</p>
    <ion-list>
      @for (p of parties(); track p) {
        <ion-item><ion-input class="num" type="number" inputmode="numeric" min="0" [label]="p" [(ngModel)]="votes[p]" /></ion-item>
      }
    </ion-list>
    <ion-button expand="block" (click)="send()">{{ t('Submit') }}</ion-button>
  </ion-content>`,
})
export default class QuickPage {
  private api = inject(Api);
  private outbox = inject(Outbox);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  parties = this.api.parties;
  votes: Record<string, number | null> = {};

  async send() {
    const v = Object.fromEntries(Object.entries(this.votes).filter(([, n]) => n !== null && n !== undefined).map(([k, n]) => [k, Number(n)]));
    if (!Object.keys(v).length) { await this.ui.error('Enter at least one party'); return; }
    await this.outbox.add('quick', { pu: this.api.me()!.area_code, votes: v }, 'Quick count');
    await this.ui.toast('Quick count saved');
    await this.router.navigateByUrl('/');
  }
}
