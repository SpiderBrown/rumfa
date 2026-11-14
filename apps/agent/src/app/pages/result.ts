import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonNote,
  IonProgressBar, IonTitle, IonToolbar } from '@ionic/angular';
import { checkResult, type ResultFigures } from '@rumfa/shared';
import { Supa } from '../core/supa';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { takePhoto } from '../core/photo';

/**
 * EC8A result in four steps (one screen each because the form is long):
 * 1 header figures, 2 votes per party, 3 photo of the signed sheet, 4 read back and submit.
 * The arithmetic is checked before submitting; the agent can still submit what the sheet says.
 */
@Component({
  selector: 'page-result',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonListHeader,
    IonNote, IonProgressBar, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary">
    <ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Submit result (EC8A)') }}</ion-title></ion-toolbar>
    <ion-progress-bar [value]="(step() + 1) / 4" /></ion-header>
  <ion-content class="ion-padding">
    <p class="hint">Polling unit {{ pu }} · copy the figures exactly as written on the signed sheet.</p>
    @switch (step()) {
      @case (0) {
        <ion-list>
          @for (f of header; track f.key) {
            <ion-item><ion-input class="num" type="number" inputmode="numeric" min="0" [label]="t(f.label)" labelPlacement="stacked" [(ngModel)]="figs[f.key]" (ngModelChange)="bump()" /></ion-item>
          }
        </ion-list>
      }
      @case (1) {
        <ion-list>
          <ion-list-header>{{ t('Votes') }}</ion-list-header>
          @for (p of parties(); track p) {
            <ion-item><ion-input class="num" type="number" inputmode="numeric" min="0" [label]="p" [(ngModel)]="votes[p]" (ngModelChange)="bump()" /></ion-item>
          }
        </ion-list>
        <p>Total of party votes: <b>{{ sum() }}</b> · total valid votes on sheet: <b>{{ figs['totalValid'] ?? 0 }}</b></p>
      }
      @case (2) {
        @if (photoUrl()) { <img [src]="photoUrl()" alt="EC8A photo" class="preview" /> }
        <ion-button expand="block" (click)="photo()"><ion-icon slot="start" name="camera" />{{ photoUrl() ? 'Retake photo' : t('Take photo of signed sheet') }}</ion-button>
        <p class="hint">Lay the sheet flat in good light. All four corners and every figure must be visible.</p>
      }
      @case (3) {
        <ion-list>
          @for (f of header; track f.key) { <ion-item><ion-label>{{ t(f.label) }}</ion-label><ion-note slot="end" class="big">{{ figs[f.key] ?? 0 }}</ion-note></ion-item> }
          @for (p of parties(); track p) { <ion-item><ion-label>{{ p }}</ion-label><ion-note slot="end" class="big">{{ votes[p] ?? 0 }}</ion-note></ion-item> }
        </ion-list>
        @for (i of issues(); track i.code) { <p class="warn">⚠ {{ i.message }}</p> }
        @if (issues().length) { <p class="hint">If the sheet itself has these figures, submit anyway: the situation room will look at it.</p> }
        @if (!photoUrl()) { <p class="warn">No photo of the sheet. Please go back and take one if you can.</p> }
      }
    }
    <div class="nav">
      @if (step() > 0) { <ion-button fill="outline" (click)="step.set(step() - 1)">{{ t('Back') }}</ion-button> }
      @if (step() < 3) { <ion-button (click)="next()">{{ t('Next') }}</ion-button> }
      @else { <ion-button color="success" (click)="submit()">{{ t('Submit') }}</ion-button> }
    </div>
  </ion-content>`,
  styles: `.preview { width: 100%; border-radius: 12px; margin-bottom: 8px; } .nav { display: flex; gap: 8px; justify-content: space-between; margin-top: 16px; }
           .nav ion-button { flex: 1; } .warn { color: #b3261e; } .big { font-size: 1.2rem; color: var(--ion-text-color); }`,
})
export default class ResultPage {
  private supa = inject(Supa);
  private outbox = inject(Outbox);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  pu = this.supa.me()!.area_code;
  parties = this.supa.parties;
  header = [
    { key: 'registered', label: 'Registered voters' }, { key: 'accredited', label: 'Accredited voters' },
    { key: 'rejected', label: 'Rejected ballots' }, { key: 'totalValid', label: 'Total valid votes' },
  ] as const;
  step = signal(0);
  figs: Record<string, number | null> = {};
  votes: Record<string, number | null> = {};
  photoUrl = signal<string | null>(null);
  private blob: Blob | null = null;
  private rev = signal(0);    // bumped on every edit so the totals and checks recompute
  bump() { this.rev.update((x) => x + 1); }

  sum = computed(() => { this.rev(); return Object.values(this.votes).reduce<number>((a, b) => a + (Number(b) || 0), 0); });
  figures = (): ResultFigures => ({
    registered: Number(this.figs['registered'] ?? 0), accredited: Number(this.figs['accredited'] ?? 0),
    rejected: Number(this.figs['rejected'] ?? 0), totalValid: Number(this.figs['totalValid'] ?? 0),
    votes: Object.fromEntries(this.parties().map((p) => [p, Number(this.votes[p] ?? 0)])),
  });
  issues = computed(() => { this.rev(); return checkResult(this.figures()); });

  async next() {
    if (this.step() === 0 && this.header.some((f) => this.figs[f.key] === null || this.figs[f.key] === undefined)) {
      await this.ui.error('Fill in all four figures (write 0 if none)'); return;
    }
    this.step.set(this.step() + 1);
  }

  async photo() { const p = await takePhoto(); if (p) { this.blob = p.blob; this.photoUrl.set(p.url); } }

  async submit() {
    const f = this.figures();
    const issues = this.issues();
    if (issues.length && !(await this.ui.confirm('Figures do not add up', 'Submit exactly as written on the sheet?', 'Submit'))) return;
    const version = Number(localStorage.getItem('rumfa.result.version') ?? '0') + 1;
    localStorage.setItem('rumfa.result.version', String(version));
    await this.outbox.add('result', { pu: this.pu, version, registered: f.registered, accredited: f.accredited, rejected: f.rejected,
      total_valid: f.totalValid, votes: f.votes }, `Result for ${this.pu}`, this.blob);
    await this.ui.toast('Result saved. It will send now, or you can send it by SMS if there is no internet.');
    await this.router.navigateByUrl('/');
  }
}
