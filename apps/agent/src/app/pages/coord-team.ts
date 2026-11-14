import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonSelect, IonSelectOption, IonTitle, IonToolbar } from '@ionic/angular';
import { normaliseNgPhone, normalisePuCode } from '@rumfa/shared';
import { Supa } from '../core/supa';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** Coordinator: people in my area, and add agents/volunteers below me. */
@Component({
  selector: 'page-coord-team',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonListHeader,
    IonSelect, IonSelectOption, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('My team') }}</ion-title></ion-toolbar></ion-header>
  <ion-content>
    <ion-list>
      <ion-list-header>Add a person</ion-list-header>
      <ion-item><ion-input label="Full name" labelPlacement="stacked" [(ngModel)]="n.name" /></ion-item>
      <ion-item><ion-input label="Phone" labelPlacement="stacked" type="tel" [(ngModel)]="n.phone" /></ion-item>
      <ion-item><ion-select label="Role" [(ngModel)]="n.role">
        <ion-select-option value="agent">Polling agent</ion-select-option><ion-select-option value="volunteer">Volunteer</ion-select-option>
        <ion-select-option value="coordinator">Ward coordinator</ion-select-option></ion-select></ion-item>
      <ion-item><ion-input [label]="n.role === 'coordinator' ? 'Ward code (e.g. 19-28-02)' : 'Polling unit code (e.g. 19-28-02-003)'" labelPlacement="stacked" [(ngModel)]="n.area" /></ion-item>
      <ion-button expand="block" class="ion-margin" (click)="add()"><ion-icon slot="start" name="person-add" />{{ t('Save') }}</ion-button>
      <ion-list-header>People ({{ people().length }})</ion-list-header>
      @for (p of people(); track p.id) {
        <ion-item>
          <ion-label><h2>{{ p.full_name }}</h2><p>{{ p.role }} · {{ p.area_code }} @if (!p.onboarded_at) { · not signed in yet }</p></ion-label>
          <ion-button slot="end" fill="clear" [href]="'tel:' + p.phone"><ion-icon slot="icon-only" name="call" /></ion-button>
        </ion-item>
      }
    </ion-list>
  </ion-content>`,
})
export default class CoordTeamPage {
  private supa = inject(Supa);
  private ui = inject(Ui);
  t = inject(I18n).t;
  people = signal<any[]>([]);
  n = { name: '', phone: '', role: 'agent', area: this.supa.me()!.area_code + '-' };

  constructor() { void this.load(); }

  async load() {
    const me = this.supa.me()!;
    const { data } = await this.supa.client.from('volunteers').select('*').like('area_code', `${me.area_code}%`).neq('id', me.id)
      .neq('status', 'removed').order('area_code');
    this.people.set(data ?? []);
  }

  async add() {
    const me = this.supa.me()!;
    const phone = normaliseNgPhone(this.n.phone);
    const level = this.n.role === 'coordinator' ? 'ward' : 'pu';
    const area = level === 'pu' ? normalisePuCode(this.n.area) : this.n.area.trim();
    if (!this.n.name || !phone || !area) { await this.ui.error('Check the name, phone and code'); return; }
    const { error } = await this.supa.client.from('volunteers').insert({
      tenant_id: me.tenant_id, full_name: this.n.name, phone, role: this.n.role, level, area_code: area, created_by: me.id,
      agent_code: this.n.role === 'agent' ? Math.random().toString(36).slice(2, 6).toUpperCase() : null,
    });
    if (error) { await this.ui.error(error.message.includes('row-level') ? 'You can only add people inside your own area.' : error.message); return; }
    await this.ui.toast(`${this.n.name} added. They sign in with an SMS code to ${phone}.`);
    this.n = { name: '', phone: '', role: 'agent', area: me.area_code + '-' };
    await this.load();
  }
}
