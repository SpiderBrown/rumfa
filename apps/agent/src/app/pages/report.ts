import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';
import { INCIDENT_CATEGORIES, type IncidentCategory } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { takePhoto } from '../core/photo';
import { categoryColour, categoryIcon } from '../core/categories';

const MAX_PHOTOS = 4;

/** Report a problem: pick a category (big, colourful buttons), add photos and a note if you can, send. */
@Component({
  selector: 'page-report',
  imports: [FormsModule, RouterLink, IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar>
    <ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Report a problem') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (!cat()) {
      <!-- Every problem is here, emergencies first: nothing can only be reached through SOS -->
      <p class="group danger">{{ t('Danger') }}</p>
      <div class="cats">
        @for (c of danger; track c.code) {
          <button class="cat" [class.critical]="c.severity === 'critical'" [style.--c]="colour(c.code)" (click)="cat.set(c)">
            <span class="ci"><ion-icon [name]="icon(c.code)" /></span><span>{{ t(c.label) }}</span></button>
        }
      </div>
      <p class="sos-hint"><ion-icon name="alert-circle" /> {{ t('In danger right now? Hold the SOS button at the top: it sends at once.') }}</p>
      <p class="group">{{ t('Other problems') }}</p>
      <div class="cats">
        @for (c of others; track c.code) {
          <button class="cat" [style.--c]="colour(c.code)" (click)="cat.set(c)">
            <span class="ci"><ion-icon [name]="icon(c.code)" /></span><span>{{ t(c.label) }}</span></button>
        }
      </div>
      <!-- Talking is often easier than a report: the coordinator rings back on a normal line (no airtime needed) -->
      <button class="callme" routerLink="/callback">
        <span class="ico teal"><ion-icon name="call" /></span>
        <span><b>{{ t('Rather talk to someone?') }}</b>{{ t('Ask my coordinator to call me') }}</span>
        <ion-icon name="chevron-forward" class="go" />
      </button>
    } @else {
      <button class="chosen" [style.--c]="colour(cat()!.code)" (click)="cat.set(null)">
        <span class="ci"><ion-icon [name]="icon(cat()!.code)" /></span>
        <span><small>{{ t('Problem') }}</small><b>{{ t(cat()!.label) }}</b></span>
        <span class="change">{{ t('Change') }}</span>
      </button>

      <p class="section-title">{{ t('Photos') }} <span class="opt">· {{ t('optional') }}</span></p>
      <div class="photos">
        @for (p of photos(); track p.url; let i = $index) {
          <div class="ph"><img [src]="p.url" alt="" /><button class="rm" (click)="remove(i)" [attr.aria-label]="t('Remove photo')"><ion-icon name="close" /></button></div>
        }
        @if (photos().length < max) {
          <button class="add" (click)="photo('camera')"><ion-icon name="camera" /><span>{{ t('Take photo') }}</span></button>
          <button class="add" (click)="photo('gallery')"><ion-icon name="image" /><span>{{ t('From gallery') }}</span></button>
        }
      </div>

      <p class="section-title">{{ t('More information for the room') }} <span class="opt">· {{ t('optional') }}</span></p>
      <textarea class="note" rows="4" [(ngModel)]="note" [placeholder]="t('What happened? Who, where, how many?')"></textarea>

      <button class="callme" routerLink="/callback">
        <span class="ico teal"><ion-icon name="call" /></span>
        <span><b>{{ t('Need to explain?') }}</b>{{ t('Ask my coordinator to call me') }}</span>
        <ion-icon name="chevron-forward" class="go" />
      </button>
    }
  </ion-content>
  @if (cat()) {
    <ion-footer class="ion-no-border"><div class="foot">
      <button class="send" [class.urgent]="cat()!.severity === 'critical'" (click)="send()"><ion-icon name="send" />{{ t('Send to the room') }}</button>
    </div></ion-footer>
  }`,
  styles: `
    .cats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .cat { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 128px; padding: 12px;
      border: 1.5px solid color-mix(in srgb, var(--c) 25%, #fff); border-radius: 20px; background: color-mix(in srgb, var(--c) 9%, #fff);
      color: var(--r-ink); font: inherit; font-weight: 700; font-size: 15px; line-height: 1.25; text-align: center; touch-action: manipulation; }
    .ci { width: 60px; height: 60px; border-radius: 18px; display: grid; place-items: center; background: var(--c); color: #fff; flex: none; }
    .ci ion-icon { font-size: 34px; }
    .cat.critical { background: var(--c); color: #fff; border-color: var(--c); } .cat.critical .ci { background: rgba(255,255,255,.2); }
    .cat:active { transform: scale(.97); }
    .callme { display: flex; align-items: center; gap: 12px; width: 100%; margin-top: 18px; padding: 12px 14px; border: 1px solid var(--r-line);
      border-radius: 18px; background: #fff; color: var(--r-ink); font: inherit; text-align: left; }
    .callme > span:nth-child(2) { flex: 1; display: flex; flex-direction: column; gap: 2px; font-size: 14px; color: var(--r-muted); }
    .callme b { color: var(--r-ink); font-size: 15px; } .callme .go { font-size: 20px; opacity: .5; }
    .group { margin: 4px 2px 10px; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; color: var(--r-muted); }
    .group.danger { color: #b3261e; }
    .sos-hint { display: flex; gap: 6px; align-items: center; margin: 10px 2px 20px; font-size: 13px; color: #b3261e; }
    .chosen { display: flex; align-items: center; gap: 14px; width: 100%; padding: 14px; border-radius: 20px; font: inherit; text-align: left;
      border: 1.5px solid color-mix(in srgb, var(--c) 30%, #fff); background: color-mix(in srgb, var(--c) 9%, #fff); color: var(--r-ink); }
    .chosen > span:nth-child(2) { flex: 1; } .chosen small { display: block; color: var(--r-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .chosen b { font-size: 19px; } .change { font-weight: 700; color: var(--r-accent); font-size: 14px; }
    .opt { text-transform: none; letter-spacing: 0; font-weight: 600; }
    .photos { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .ph { position: relative; aspect-ratio: 1; border-radius: 14px; overflow: hidden; background: #e5e7eb; }
    .ph img { width: 100%; height: 100%; object-fit: cover; }
    .rm { position: absolute; top: 4px; right: 4px; width: 28px; height: 28px; border-radius: 50%; border: 0; background: rgba(0,0,0,.6); color: #fff; display: grid; place-items: center; }
    .add { aspect-ratio: 1; border-radius: 14px; border: 2px dashed #c7cdd5; background: #fff; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 6px; font: inherit; font-size: 12px; font-weight: 700; color: var(--r-ink-2); }
    .add ion-icon { font-size: 28px; color: var(--r-accent); }
    .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; padding: 12px 14px; border: 1.5px solid #d5dae1; border-radius: 14px; background: #fff; resize: vertical; }
    .note:focus { outline: none; border-color: var(--r-accent); box-shadow: 0 0 0 3px rgba(15,118,110,.15); }
    .foot { padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: var(--r-bg, #f3f4f6); }
    .send { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 16px; padding: 16px;
      background: var(--r-accent); color: #fff; font: inherit; font-size: 17px; font-weight: 800; }
    .send.urgent { background: #b3261e; }`,
})
export default class ReportPage {
  /** Opens straight on one problem (e.g. from a "No" on the checklist) */
  categoryParam = input<string | undefined>(undefined, { alias: 'category' });
  private api = inject(Api);
  private outbox = inject(Outbox);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  readonly max = MAX_PHOTOS;
  cat = signal<IncidentCategory | null>(null);
  photos = signal<{ blob: Blob; url: string }[]>([]);
  note = '';
  // "Emergency (SOS)" is only for the SOS button, which sends before asking
  private readonly reportable = INCIDENT_CATEGORIES.filter((c) => c.code !== 'sos');
  readonly danger = this.reportable.filter((c) => c.queue === 'security');
  readonly others = this.reportable.filter((c) => c.queue !== 'security');

  constructor() {
    queueMicrotask(() => { const c = INCIDENT_CATEGORIES.find((x) => x.code === this.categoryParam()); if (c) this.cat.set(c); });
  }

  icon(code: string) { return categoryIcon(code); }
  colour(code: string) { return categoryColour(code); }

  async photo(from: 'camera' | 'gallery') {
    const p = await takePhoto(from);
    if (p) this.photos.update((l) => [...l, p].slice(0, MAX_PHOTOS));
  }
  remove(i: number) { this.photos.update((l) => l.filter((_, j) => j !== i)); }

  async send() {
    const c = this.cat()!;
    await this.outbox.add('incident', { pu: this.api.me()!.area_code, category: c.code, severity: c.severity,
      description: this.note.trim() || null }, c.label, this.photos().map((p) => p.blob));
    await this.ui.toast(c.severity === 'critical' ? 'Sent as urgent. Stay safe; the situation room will call you.' : 'Report saved. The situation room will follow up.');
    await this.router.navigateByUrl('/');
  }
}
