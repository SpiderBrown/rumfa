import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonList, IonSpinner, IonTextarea, IonTitle, IonToolbar } from '@ionic/angular';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { IrevChecks, type Figures, type IrevCheck } from '../core/irev-checks';

const ITEMS: { key: keyof Omit<Figures, 'votes' | 'status'>; label: string }[] = [
  { key: 'registered', label: 'Registered voters' }, { key: 'accredited', label: 'Accredited voters' },
  { key: 'rejected', label: 'Rejected ballots' }, { key: 'total_valid', label: 'Total valid votes' },
];

/**
 * My sheet against IReV: open INEC's sheet for my unit, compare it with the one I signed, then say "It matches" (my
 * figures stand for IReV's too, nobody in the room needs to type it in) or "It is different" (the legal desk gets a case).
 */
@Component({
  selector: 'page-irev-check',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonList, IonSpinner, IonTextarea, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar>
    <ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Check IReV') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (cur(); as c) {
      <h2>{{ c.pu_name }}</h2>
      <p class="hint">{{ c.election_name }} · {{ c.pu_code }}</p>
      <p>{{ t('INEC has put the result sheet for your polling unit on IReV. Open it and check every figure against the sheet you signed.') }}</p>
      <!-- The sheet itself, in the app, so it can be read next to the figures -->
      @if (sheet(); as u) {
        @if (!sheetFailed()) {
          <button class="sheet" (click)="zoom.set(!zoom())"><img [src]="u" [class.zoom]="zoom()" alt="{{ t('IReV sheet') }}" (error)="sheetFailed.set(true)" />
            <span>{{ zoom() ? t('Tap to make smaller') : t('Tap to make bigger') }}</span></button>
        }
      }
      <ion-button expand="block" fill="outline" (click)="open(c)" [disabled]="opening()">
        @if (opening()) { <ion-spinner name="dots" /> } @else { <ion-icon slot="start" name="document-text" />{{ sheet() && !sheetFailed() ? t('Open full size') : t('Open the IReV sheet') }} }</ion-button>

      <h3>{{ t('Your sheet') }}@if (c.irev) { · IReV }</h3>
      @if (c.mine) {
        <table class="cmp">
          <tr><th></th><th>{{ t('Yours') }}</th>@if (c.irev) { <th>IReV</th> }</tr>
          @for (i of items; track i.key) {
            <tr [class.diff]="differs(c, i.key)"><td>{{ t(i.label) }}</td><td>{{ c.mine[i.key] ?? '—' }}</td>@if (c.irev) { <td>{{ c.irev[i.key] ?? '—' }}</td> }</tr>
          }
          @for (p of parties(c); track p) {
            <tr [class.diff]="differsVote(c, p)"><td><b>{{ p }}</b></td><td>{{ c.mine.votes[p] ?? 0 }}</td>@if (c.irev) { <td>{{ c.irev.votes[p] ?? 0 }}</td> }</tr>
          }
        </table>
        @if (c.irev && diffCount(c)) { <p class="warn">{{ diffCount(c) }} {{ t('figures look different (highlighted). Check them on the sheet.') }}</p> }
        @if (!c.irev) { <p class="hint">{{ t('Rumfa has not read the IReV sheet yet, so compare it yourself.') }}</p> }
      } @else {
        <p class="warn">{{ t('You have not sent your result yet. Send it first, then compare.') }}</p>
      }

      @if (c.status === 'asked') {
        @if (!differ()) {
          <div class="acts">
            <ion-button expand="block" color="success" (click)="answer(c, true)" [disabled]="busy() || !c.mine"><ion-icon slot="start" name="checkmark-circle" />{{ t('It matches my sheet') }}</ion-button>
            <ion-button expand="block" color="danger" fill="outline" (click)="differ.set(true)" [disabled]="busy()"><ion-icon slot="start" name="alert-circle" />{{ t('It is different') }}</ion-button>
          </div>
        } @else {
          <ion-list><ion-item>
            <ion-textarea [label]="t('What is different?')" labelPlacement="stacked" [autoGrow]="true" [(ngModel)]="note"
              [placeholder]="t('e.g. APC is 212 on my sheet but 312 on IReV')" />
          </ion-item></ion-list>
          <div class="acts">
            <ion-button expand="block" color="danger" (click)="answer(c, false)" [disabled]="busy() || note.trim().length < 3">{{ t('Send to the legal desk') }}</ion-button>
            <ion-button expand="block" fill="clear" (click)="differ.set(false)">{{ t('Back') }}</ion-button>
          </div>
        }
      } @else {
        <p class="done" [class.bad]="c.status === 'differs'">{{ c.status === 'matches' ? t('You said it matches. Thank you.') : t('You said it is different. The legal desk has it.') }}
          @if (c.note) { <br><i>{{ c.note }}</i> }</p>
      }
      @if (others().length) { <p class="hint">{{ others().length }} {{ t('more to check') }}: <a (click)="idx.set(idx() + 1)">{{ t('next') }}</a></p> }
    } @else {
      <p>{{ t('Your polling unit\\'s sheet is not on IReV yet. You will get a notification when it is.') }}</p>
      <ion-button expand="block" fill="outline" (click)="checkNow()"><ion-icon slot="start" name="refresh" />{{ t('Look on IReV now') }}</ion-button>
    }
  </ion-content>`,
  styles: `
    .sheet { display: block; width: 100%; border: 1px solid var(--r-line); background: #fff; border-radius: 14px; padding: 6px; margin: 10px 0; font: inherit; }
    .sheet img { width: 100%; max-height: 260px; object-fit: contain; display: block; } .sheet img.zoom { max-height: none; }
    .sheet span { display: block; font-size: 12px; color: var(--r-muted); margin-top: 4px; }
    h2 { margin: 0; } h3 { margin: 20px 0 6px; font-size: 1rem; } .hint { color: var(--ion-color-medium); font-size: .9rem; }
    .cmp { width: 100%; border-collapse: collapse; font-size: 1rem; }
    .cmp th { text-align: right; font-size: .8rem; color: var(--ion-color-medium); padding: 4px 8px; } .cmp th:first-child { text-align: left; }
    .cmp td { padding: 8px; border-bottom: 1px solid var(--ion-color-light); text-align: right; font-variant-numeric: tabular-nums; } .cmp td:first-child { text-align: left; }
    .cmp tr.diff td { background: #fde7e4; font-weight: 700; }
    .warn { color: #b3261e; } .acts { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
    .done { margin-top: 16px; padding: 12px; border-radius: 12px; background: #e3f4ea; } .done.bad { background: #fde7e4; }
  `,
})
export default class IrevCheckPage {
  private checks = inject(IrevChecks);
  private ui = inject(Ui);
  private router = inject(Router);
  t = inject(I18n).t;
  readonly items = ITEMS;
  idx = signal(0);
  busy = signal(false);
  opening = signal(false);
  differ = signal(false);
  note = '';
  /** Waiting ones first; then the latest answered one */
  private ordered = computed(() => this.checks.pending().length ? this.checks.pending() : this.checks.list().slice(0, 1));
  cur = computed(() => this.ordered()[this.idx() % Math.max(1, this.ordered().length)] ?? null);
  others = computed(() => this.checks.pending().filter((c) => c.id !== this.cur()?.id));

  /** The sheet, loaded once per check (if INEC's copy is a PDF the image fails and the button opens it instead) */
  sheet = signal<string | null>(null);
  sheetFailed = signal(false);
  zoom = signal(false);
  private sheetFor: string | null = null;

  constructor() {
    void this.checks.load();
    effect(() => {
      const c = this.cur();
      if (!c || c.id === this.sheetFor) return;
      this.sheetFor = c.id; this.sheet.set(null); this.sheetFailed.set(false);
      void this.checks.sheetUrl(c).then((u) => { if (this.sheetFor === c.id) this.sheet.set(u); }).catch(() => undefined);
    });
  }

  parties(c: IrevCheck) { return [...new Set([...Object.keys(c.mine?.votes ?? {}), ...Object.keys(c.irev?.votes ?? {})])].sort((a, b) => (c.mine?.votes[b] ?? 0) - (c.mine?.votes[a] ?? 0)); }
  differs(c: IrevCheck, k: keyof Omit<Figures, 'votes' | 'status'>) { return !!c.irev && !!c.mine && c.irev[k] != null && c.mine[k] != null && Number(c.irev[k]) !== Number(c.mine[k]); }
  differsVote(c: IrevCheck, p: string) { return !!c.irev && !!c.mine && Number(c.irev.votes[p] ?? 0) !== Number(c.mine.votes[p] ?? 0); }
  diffCount(c: IrevCheck) { return ITEMS.filter((i) => this.differs(c, i.key)).length + this.parties(c).filter((p) => this.differsVote(c, p)).length; }

  async open(c: IrevCheck) {
    this.opening.set(true);
    try { window.open(await this.checks.sheetUrl(c), '_blank'); } catch (e) { await this.ui.error(e); }
    this.opening.set(false);
  }
  async answer(c: IrevCheck, matches: boolean) {
    this.busy.set(true);
    try {
      await this.checks.answer(c.id, matches, matches ? undefined : this.note.trim());
      await this.ui.toast(matches ? this.t('Thank you. Your unit is verified.') : this.t('Sent. The legal desk will look into it and may call you.'));
      this.differ.set(false); this.note = '';
      if (!this.checks.pending().length) await this.router.navigateByUrl('/');
    } catch (e) { await this.ui.error(e); }
    this.busy.set(false);
  }
  async checkNow() {
    try { await this.ui.toast(this.t(await this.checks.checkNow()), 'medium'); } catch (e) { await this.ui.error(e); }
  }
}
