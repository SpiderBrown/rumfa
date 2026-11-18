import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
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
  imports: [FormsModule, RouterLink, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonList, IonTextarea, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary">
    <ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Report a problem') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (!cat()) {
      <!-- Every problem is here, emergencies first: nothing can only be reached through SOS -->
      <p class="group danger">{{ t('Danger') }}</p>
      <div class="cats">
        @for (c of danger; track c.code) {
          <button class="cat" [class]="c.severity" (click)="cat.set(c)"><ion-icon [name]="icon(c.code)" /><span>{{ t(c.label) }}</span></button>
        }
      </div>
      <p class="hint sos-hint">{{ t('In danger right now? Hold the SOS button at the top: it sends at once.') }}</p>
      <p class="group">{{ t('Other problems') }}</p>
      <div class="cats">
        @for (c of others; track c.code) {
          <button class="cat" [class]="c.severity" (click)="cat.set(c)"><ion-icon [name]="icon(c.code)" /><span>{{ t(c.label) }}</span></button>
        }
      </div>
      <!-- Talking is often easier than a report: the coordinator rings back on a normal line (no airtime needed) -->
      <button class="callme" routerLink="/callback">
        <ion-icon name="phone-portrait" />
        <span><b>{{ t('Rather talk to someone?') }}</b>
          {{ t('Ask my coordinator to call me') }}</span>
        <ion-icon name="chevron-forward" class="go" />
      </button>
    } @else {
      <h2 class="chosen"><ion-icon [name]="icon(cat()!.code)" />{{ t(cat()!.label) }}</h2>
      <ion-list>
        <ion-item><ion-textarea label="What happened? (optional)" labelPlacement="stacked" [autoGrow]="true" [(ngModel)]="note" /></ion-item>
      </ion-list>
      @if (photoUrl()) { <img [src]="photoUrl()" alt="Photo" class="preview" /> }
      <ion-button expand="block" fill="outline" (click)="photo()"><ion-icon slot="start" name="camera" />{{ photoUrl() ? 'Retake photo' : 'Add a photo (optional)' }}</ion-button>
      <ion-button expand="block" [color]="cat()!.severity === 'critical' ? 'danger' : 'primary'" (click)="send()">{{ t('Submit') }}</ion-button>
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
    .callme { display: flex; align-items: center; gap: 12px; width: 100%; margin-top: 16px; padding: 14px; border: 1px solid #d5eadb;
      border-radius: 16px; background: #f1f8f3; color: var(--ion-text-color); font: inherit; text-align: left; }
    .callme span { flex: 1; display: flex; flex-direction: column; gap: 2px; font-size: 15px; }
    .callme > ion-icon:first-child { font-size: 28px; color: var(--ion-color-primary); } .callme .go { font-size: 20px; opacity: .5; }
    .group { margin: 4px 0 8px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--ion-color-medium); }
    .group.danger { color: #b3261e; } .sos-hint { margin: 8px 0 18px; font-size: 13px; }
    .chosen { display: flex; align-items: center; gap: 10px; } .chosen ion-icon { font-size: 30px; color: var(--ion-color-primary); }
    .preview { width: 100%; border-radius: 12px; margin: 8px 0; }`,
})
export default class ReportPage {
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
  // "Emergency (SOS)" is only for the SOS button, which sends before asking
  private readonly reportable = INCIDENT_CATEGORIES.filter((c) => c.code !== 'sos');
  readonly danger = this.reportable.filter((c) => c.queue === 'security');
  readonly others = this.reportable.filter((c) => c.queue !== 'security');

  constructor() {
    queueMicrotask(() => { const c = INCIDENT_CATEGORIES.find((x) => x.code === this.categoryParam()); if (c) this.cat.set(c); });
  }

  icon(code: string) { return categoryIcon(code); }

  async photo() { const p = await takePhoto(); if (p) { this.blob = p.blob; this.photoUrl.set(p.url); } }

  async send() {
    const c = this.cat()!;
    await this.outbox.add('incident', { pu: this.api.me()!.area_code, category: c.code, severity: c.severity,
      description: this.note || null }, c.label, this.blob);
    await this.ui.toast(c.severity === 'critical' ? 'Sent as urgent. Stay safe; the situation room will call you.' : 'Report saved. The situation room will follow up.');
    await this.router.navigateByUrl('/');
  }
}
