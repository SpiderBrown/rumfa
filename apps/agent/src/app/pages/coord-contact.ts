import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonSelect,
  IonSelectOption, IonTitle, IonToolbar } from '@ionic/angular';
import { normaliseNgPhone } from '@rumfa/shared';
import { Supa } from '../core/supa';
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
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
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
  private supa = inject(Supa);
  private ui = inject(Ui);
  t = inject(I18n).t;
  me = this.supa.me()!.id;
  agencies = ['INEC', 'Police', 'Army', 'NSCDC', 'DSS', 'Traditional ruler', 'Local government', 'Other'];
  contacts = signal<any[]>([]);
  n = { agency: 'INEC', title: '', person: '', phone: '' };

  constructor() { void this.load(); }

  status(s: string) { return ({ pending: 'needs a test call', call_tested: 'waiting for approval', verified: 'verified', stale: 'confirm again', rejected: 'rejected' } as Record<string, string>)[s] ?? s; }

  async load() {
    const me = this.supa.me()!;
    const { data } = await this.supa.client.from('authority_contacts').select('*').like('area_code', `${me.area_code}%`).order('created_at', { ascending: false });
    this.contacts.set(data ?? []);
  }

  async add() {
    const me = this.supa.me()!;
    const phone = normaliseNgPhone(this.n.phone);
    if (!this.n.title || !phone) { await this.ui.error('Title and a valid phone are required'); return; }
    try {
      await this.supa.rpc('add_authority_contact', { p_agency: this.n.agency, p_title: this.n.title, p_person: this.n.person || null,
        p_phone: phone, p_level: me.level === 'pu' ? 'ward' : me.level, p_area: me.area_code });
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
      await this.supa.rpc('mark_contact_call', { p_contact: k.id, p_ok: ok }).catch((e) => this.ui.error(e));
      await this.load();
    }, 4000);
  }

  async approve(k: any, ok: boolean) {
    await this.supa.rpc('approve_contact', { p_contact: k.id, p_approve: ok }).then(() => this.ui.toast('Approved')).catch((e) => this.ui.error(e));
    await this.load();
  }
}
