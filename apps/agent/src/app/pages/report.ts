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
import { categoryIcon } from '../core/categories';

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
          <button class="cat" [class]="c.severity" (click)="cat.set(c)">
            <ion-icon [name]="icon(c.code)" /><span>{{ t(c.label) }}</span>
          </button>
        }
      </div>
    } @else {
      <h2 class="chosen"><ion-icon [name]="icon(cat()!.code)" />{{ t(cat()!.label) }}</h2>
      <ion-list>
        <ion-item><ion-textarea label="What happened? (optional)" labelPlacement="stacked" [autoGrow]="true" [(ngModel)]="note" /></ion-item>
      </ion-list>
      @if (photoUrl()) { <img [src]="photoUrl()" alt="Photo" class="preview" /> }
      <ion-button expand="block" fill="outline" (click)="photo()"><ion-icon slot="start" name="camera" />{{ photoUrl() ? 'Retake photo' : 'Add a photo (optional)' }}</ion-button>
      <ion-button expand="block" [color]="sos() ? 'danger' : 'primary'" (click)="send()">{{ t('Submit') }}</ion-button>
      <ion-button expand="block" fill="clear" (click)="cat.set(null)">{{ t('Back') }}</ion-button>
    }
  </ion-content>`,
  styles: `
    .cats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .cat { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 104px; padding: 10px;
      border: 0; border-radius: 16px; background: var(--ion-color-light); color: var(--ion-text-color); font: inherit; font-weight: 600;
      font-size: 15px; line-height: 1.25; text-align: center; touch-action: manipulation; }
    .cat ion-icon { font-size: 34px; color: var(--ion-color-primary); }
    .cat.high ion-icon { color: #c2410c; }
    .cat.critical { background: #b3261e; color: #fff; } .cat.critical ion-icon { color: #fff; }
    .cat:active { transform: scale(.97); }
    .chosen { display: flex; align-items: center; gap: 10px; } .chosen ion-icon { font-size: 30px; color: var(--ion-color-primary); }
    .preview { width: 100%; border-radius: 12px; margin: 8px 0; }`,
})
export default class ReportPage {
  sosParam = input<string | undefined>(undefined, { alias: 'sos' });
  /** Opens straight on one problem (e.g. from a "No" on the checklist) */
  categoryParam = input<string | undefined>(undefined, { alias: 'category' });
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

  constructor() {
    queueMicrotask(() => { const c = INCIDENT_CATEGORIES.find((x) => x.code === this.categoryParam()); if (c) this.cat.set(c); });
  }

  icon(code: string) { return categoryIcon(code); }

  async photo() { const p = await takePhoto(); if (p) { this.blob = p.blob; this.photoUrl.set(p.url); } }

  async send() {
    const c = this.cat()!;
    await this.outbox.add('incident', { pu: this.api.me()!.area_code, category: c.code, severity: this.sos() ? 'critical' : c.severity,
      description: this.note || null, sos: this.sos() }, `${this.sos() ? 'SOS: ' : ''}${c.label}`, this.blob);
    await this.ui.toast(this.sos() ? 'Emergency sent. Stay safe; the situation room will call you.' : 'Report saved. The situation room will follow up.');
    await this.router.navigateByUrl('/');
  }
}
