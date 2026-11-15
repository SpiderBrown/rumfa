import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonList, IonTextarea, IonTitle, IonToolbar } from '@ionic/angular';
import { INCIDENT_CATEGORIES, type IncidentCategory } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { takePhoto } from '../core/photo';

/** Report a problem: pick a category (big buttons), optionally add a note and photo, send. */
@Component({
  selector: 'page-report',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonList, IonTextarea, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar [color]="sos() ? 'danger' : 'primary'">
    <ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ sos() ? t('SOS') : t('Report a problem') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (!cat()) {
      <p class="hint">{{ sos() ? 'What is happening? This goes to the situation room as an emergency.' : 'What is the problem?' }}</p>
      <div class="cats">
        @for (c of categories(); track c.code) {
          <ion-button expand="block" [color]="c.severity === 'critical' ? 'danger' : 'light'" (click)="cat.set(c)">{{ c.label }}</ion-button>
        }
      </div>
    } @else {
      <h2>{{ cat()!.label }}</h2>
      <ion-list>
        <ion-item><ion-textarea label="What happened? (optional)" labelPlacement="stacked" [autoGrow]="true" [(ngModel)]="note" /></ion-item>
      </ion-list>
      @if (photoUrl()) { <img [src]="photoUrl()" alt="Photo" class="preview" /> }
      <ion-button expand="block" fill="outline" (click)="photo()"><ion-icon slot="start" name="camera" />{{ photoUrl() ? 'Retake photo' : 'Add a photo (optional)' }}</ion-button>
      <ion-button expand="block" [color]="sos() ? 'danger' : 'primary'" (click)="send()">{{ t('Submit') }}</ion-button>
      <ion-button expand="block" fill="clear" (click)="cat.set(null)">{{ t('Back') }}</ion-button>
    }
  </ion-content>`,
  styles: `.cats { display: flex; flex-direction: column; gap: 4px; } .preview { width: 100%; border-radius: 12px; margin: 8px 0; }`,
})
export default class ReportPage {
  sosParam = input<string | undefined>(undefined, { alias: 'sos' });
  private api = inject(Api);
  private outbox = inject(Outbox);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  cat = signal<IncidentCategory | null>(null);
  photoUrl = signal<string | null>(null);
  private blob: Blob | null = null;
  note = '';
  sos = () => this.sosParam() === '1';
  categories = () => this.sos() ? INCIDENT_CATEGORIES.filter((c) => ['violence', 'ballot_snatching', 'thugs'].includes(c.code))
    : INCIDENT_CATEGORIES;

  async photo() { const p = await takePhoto(); if (p) { this.blob = p.blob; this.photoUrl.set(p.url); } }

  async send() {
    const c = this.cat()!;
    await this.outbox.add('incident', { pu: this.api.me()!.area_code, category: c.code, severity: this.sos() ? 'critical' : c.severity,
      description: this.note || null, sos: this.sos() }, `${this.sos() ? 'SOS: ' : ''}${c.label}`, this.blob);
    await this.ui.toast(this.sos() ? 'Emergency sent. Stay safe; the situation room will call you.' : 'Report saved. The situation room will follow up.');
    await this.router.navigateByUrl('/');
  }
}
