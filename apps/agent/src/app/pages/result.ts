import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonNote,
  IonProgressBar, IonTitle, IonToolbar } from '@ionic/angular';
import { UNIT_FIGURE_ITEMS, checkResult, figureFlags, usedBallots, type ResultFigures, type UnitFigures } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { takePhoto } from '../core/photo';
import { UnitFiguresService } from '../core/unit-figures';

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
        @if (prefilled) { <p class="hint ok">{{ t('Figures you already sent are filled in. Check them against the sheet.') }}</p> }
        <ion-list>
          @for (f of header; track f.key) {
            <ion-item><ion-input class="num" type="number" inputmode="numeric" min="0" [label]="t('Item') + ' ' + f.item + ' · ' + t(f.label)" labelPlacement="stacked" [(ngModel)]="figs[f.key]" (ngModelChange)="bump()" /></ion-item>
          }
          <ion-item>
            <ion-label class="ion-text-wrap">{{ t('Item') }} 8 · {{ t('Total used ballot papers') }}
              <p>{{ t('Spoiled + rejected + valid') }} = <b>{{ used() ?? '…' }}</b></p></ion-label>
            <ion-button slot="end" fill="clear" size="small" (click)="usedDiffers = !usedDiffers; bump()">{{ usedDiffers ? t('Same as sheet') : t('Sheet differs') }}</ion-button>
          </ion-item>
          @if (usedDiffers) {
            <ion-item><ion-input class="num" type="number" inputmode="numeric" min="0" [label]="t('Item 8 as written on the sheet')" labelPlacement="stacked" [(ngModel)]="figs['used']" (ngModelChange)="bump()" /></ion-item>
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
          @for (f of header; track f.key) { <ion-item><ion-label>{{ f.item }} · {{ t(f.label) }}</ion-label><ion-note slot="end" class="big">{{ figs[f.key] ?? 0 }}</ion-note></ion-item> }
          <ion-item><ion-label>8 · {{ t('Total used ballot papers') }}</ion-label><ion-note slot="end" class="big">{{ usedDiffers ? figs['used'] : used() }}</ion-note></ion-item>
          @for (p of parties(); track p) { <ion-item><ion-label>{{ p }}</ion-label><ion-note slot="end" class="big">{{ votes[p] ?? 0 }}</ion-note></ion-item> }
        </ion-list>
        @for (i of issues(); track i.code) { <p class="warn">⚠ {{ i.message }}</p> }
        @for (w of ballotIssues(); track w.flag) { <p class="warn">⚠ {{ w.message }}</p> }
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
  private api = inject(Api);
  private outbox = inject(Outbox);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  pu = this.api.me()!.area_code;
  parties = this.api.parties;
  private unitFigs = inject(UnitFiguresService);
  /** EC8A items 1 to 7 in sheet order (item 8 is worked out). `key` is the form field. */
  header = UNIT_FIGURE_ITEMS.filter((i) => i.item <= 7).map((i) => ({ ...i, key: i.key === 'total_valid' ? 'totalValid' : i.key }));
  step = signal(0);
  figs: Record<string, number | null> = this.prefill();
  usedDiffers = this.figs['used'] != null && this.figs['used'] !== usedBallots(this.unitFigures());
  prefilled = Object.values(this.figs).some((v) => v != null);
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
  used = computed(() => { this.rev(); return usedBallots(this.unitFigures()); });
  /** Ballot-paper checks the room also runs (balance with papers issued, item 8, over the register) */
  ballotIssues = computed(() => { this.rev(); return figureFlags(this.unitFigures()).filter((f) => f.flag !== 'over_registered' && f.flag !== 'over_accredited'); });

  /** Starts from the figures already sent today (setup, accreditation, close of poll) */
  private prefill(): Record<string, number | null> {
    const l = inject(UnitFiguresService).latest();
    return { registered: l.registered ?? null, accredited: l.accredited ?? null, ballots_received: l.ballots_received ?? null,
      unused: l.unused ?? null, spoiled: l.spoiled ?? null, rejected: l.rejected ?? null, totalValid: l.total_valid ?? null, used: l.used ?? null };
  }

  /** The form as EC8A summary figures */
  unitFigures(): UnitFigures {
    const n = (k: string) => (this.figs[k] === null || this.figs[k] === undefined || (this.figs[k] as unknown) === '' ? undefined : Number(this.figs[k]));
    const f: UnitFigures = { registered: n('registered'), accredited: n('accredited'), ballots_received: n('ballots_received'), unused: n('unused'),
      spoiled: n('spoiled'), rejected: n('rejected'), total_valid: n('totalValid') };
    if (this.usedDiffers && n('used') !== undefined) f.used = n('used');
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as UnitFigures;
  }

  async next() {
    if (this.step() === 0 && this.header.some((f) => this.figs[f.key] === null || this.figs[f.key] === undefined)) {
      await this.ui.error('Fill in items 1 to 7 (write 0 if none)'); return;
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
    // The summary figures (items 1 to 8) also go to "My polling unit", so the ballot checks run on the final sheet
    await this.unitFigs.send('result', this.unitFigures());
    await this.ui.toast('Result saved. It will send now, or you can send it by SMS if there is no internet.');
    await this.router.navigateByUrl('/');
  }
}
