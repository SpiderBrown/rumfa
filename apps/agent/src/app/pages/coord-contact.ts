import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonSelect,
  IonSelectOption, IonTitle, IonToolbar } from '@ionic/angular';
import { normaliseNgPhone } from '@rumfa/shared';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/**
 * Onboarding task: add the authorities for my area (INEC electoral officer, DPO, etc.).
 * Each contact needs a test call, then approval by the coordinator above me.
 */
@Component({
  selector: 'page-coord-contact',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonListHeader,
    IonSelect, IonSelectOption, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Add authority contact') }}</ion-title></ion-toolbar></ion-header>
  <ion-content>
    <ion-list>
      <ion-item><ion-select label="Agency" [(ngModel)]="n.agency">
        @for (a of agencies; track a) { <ion-select-option [value]="a">{{ a }}</ion-select-option> }</ion-select></ion-item>
      <ion-item><ion-input label="Title (e.g. Electoral Officer, DPO)" labelPlacement="stacked" [(ngModel)]="n.title" /></ion-item>
      <ion-item><ion-input label="Name (optional)" labelPlacement="stacked" [(ngModel)]="n.person" /></ion-item>
      <ion-item><ion-input label="Phone" labelPlacement="stacked" type="tel" [(ngModel)]="n.phone" /></ion-item>
      <ion-button expand="block" class="ion-margin" (click)="add()">{{ t('Save') }}</ion-button>

      <ion-list-header>Contacts in my area</ion-list-header>
      @for (k of contacts(); track k.id) {
        <ion-item>
          <ion-label class="ion-text-wrap"><h2>{{ k.agency }} · {{ k.title }}</h2><p>{{ k.person_name }} · {{ status(k.status) }}</p></ion-label>
          @if (['pending','stale'].includes(k.status) && k.phone) {
            <ion-button slot="end" (click)="testCall(k)">Test call</ion-button>
          }
          @if (k.status === 'call_tested' && k.added_by !== me) {
            <ion-button slot="end" color="success" (click)="approve(k, true)">Approve</ion-button>
          }
        </ion-item>
      }
    </ion-list>
  </ion-content>`,
})
export default class CoordContactPage {
  private api = inject(Api);
  private ui = inject(Ui);
  t = inject(I18n).t;
  me = this.api.me()!.id;
  agencies = ['INEC', 'Police', 'Army', 'NSCDC', 'DSS', 'Traditional ruler', 'Local government', 'Other'];
  contacts = signal<any[]>([]);
  n = { agency: 'INEC', title: '', person: '', phone: '' };

  constructor() { void this.load(); }

  status(s: string) { return ({ pending: 'needs a test call', call_tested: 'waiting for approval', verified: 'verified', stale: 'confirm again', rejected: 'rejected' } as Record<string, string>)[s] ?? s; }

  async load() {
    const me = this.api.me()!;
    const rows = await this.api.get<any[]>('/contacts', { area: me.area_code }).catch(() => this.contacts());
    this.contacts.set([...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }

  async add() {
    const me = this.api.me()!;
    const phone = normaliseNgPhone(this.n.phone);
    if (!this.n.title || !phone) { await this.ui.error('Title and a valid phone are required'); return; }
    try {
      await this.api.post('/contacts', { agency: this.n.agency, title: this.n.title, person: this.n.person || undefined,
        phone, level: me.level === 'pu' ? 'ward' : me.level, areaCode: me.level === 'pu' ? me.area_code.slice(0, 8) : me.area_code });
      await this.ui.toast('Saved. Now make a test call.');
      this.n = { agency: 'INEC', title: '', person: '', phone: '' };
      await this.load();
    } catch (e) { await this.ui.error(e); }
  }

  /** Dial from the phone, then ask whether they answered. */
  async testCall(k: any) {
    window.location.href = `tel:${k.phone}`;
    setTimeout(async () => {
      const ok = await this.ui.confirm('Test call', `Did ${k.title} answer?`, 'Yes, answered');
      await this.api.post(`/contacts/${k.id}/call-result`, { ok }).catch((e) => this.ui.error(e));
      await this.load();
    }, 4000);
  }

  async approve(k: any, ok: boolean) {
    await this.api.post(`/contacts/${k.id}/approve`, { approve: ok }).then(() => this.ui.toast(ok ? 'Approved' : 'Rejected')).catch((e) => this.ui.error(e));
    await this.load();
  }
}
