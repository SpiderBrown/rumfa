import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';

/** Channels: my ward, LGA and state teams, cases I reported, and direct messages. */
@Component({
  selector: 'page-messages',
  imports: [RouterLink, IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Messages') }}</ion-title></ion-toolbar></ion-header>
  <ion-content>
    <ion-list>
      <ion-list-header>Teams</ion-list-header>
      @for (c of area(); track c.id) { <ion-item [routerLink]="['/chat', c.id]" detail><ion-icon slot="start" name="people" /><ion-label>{{ c.name }}</ion-label></ion-item> }
      @if (others().length) {
        <ion-list-header>Cases and direct</ion-list-header>
        @for (c of others(); track c.id) { <ion-item [routerLink]="['/chat', c.id]" detail><ion-icon slot="start" [name]="c.kind === 'case' ? 'warning' : 'mail'" /><ion-label>{{ c.name }}</ion-label></ion-item> }
      }
    </ion-list>
  </ion-content>`,
})
export default class MessagesPage {
  private api = inject(Api);
  t = inject(I18n).t;
  area = signal<any[]>([]);
  others = signal<any[]>([]);

  constructor() { void this.load(); }

  async load() {
    const a = await this.api.get<any[]>('/channels/area').catch(() => []);
    this.area.set(a.sort((x, y) => (y.area_code?.length ?? 0) - (x.area_code?.length ?? 0)));
    const all = await this.api.get<any[]>('/channels').catch(() => []);
    this.others.set(all.filter((c) => ['case', 'direct'].includes(c.kind)).slice(0, 50));
  }
}
