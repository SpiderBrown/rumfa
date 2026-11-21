import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonSpinner, IonTitle, IonToolbar } from '@ionic/angular';
import { UNIT_FIGURE_ITEMS, checkResult, figureFlags, partyColour, usedBallots, type ResultFigures, type UnitFigures } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { SheetCamera, type SheetShot } from '../core/sheet-camera';
import { IrevChecks } from '../core/irev-checks';
import { Originals } from '../core/originals';
import { UnitFiguresService } from '../core/unit-figures';

/**
 * EC8A result in the order the information arrives at the unit:
 * 1 the summary figures (registered, accredited, used, unused, spoiled, rejected, valid), 2 the votes for each party,
 * 3 a photo of the signed sheet (in-app camera), 4 read back and submit, then 5 the IReV check, which waits for INEC
 * to upload the sheet: the app looks every 5 minutes, and the agent can look now.
 * The arithmetic is checked before submitting; the agent can still submit what the sheet says.
 */
@Component({
  selector: 'page-result',
  imports: [FormsModule, RouterLink, IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonSpinner, IonTitle, IonToolbar, SheetCamera],
  template: `
  <ion-header><ion-toolbar>
    <ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Send result') }} · EC8A</ion-title></ion-toolbar>
    <div class="steps">
      @for (s of stepNames; track s; let i = $index) {
        <button class="st" [class.on]="step() === i" [class.done]="step() > i" [disabled]="!canGo(i)" (click)="go(i)">
          <span class="n">@if (step() > i) { <ion-icon name="checkmark" /> } @else { {{ i + 1 }} }</span><span class="l">{{ t(s) }}</span></button>
      }
    </div>
  </ion-header>
  <ion-content class="ion-padding">
    @switch (step()) {
      @case (0) {
        <p class="lede">{{ t('Polling unit') }} {{ pu }} · {{ t('copy the figures exactly as announced and written on the sheet.') }}</p>
        @if (prefilled) { <p class="note ok"><ion-icon name="checkmark-circle" /> {{ t('Figures you already sent are filled in. Check them against the sheet.') }}</p> }
        <div class="card flat">
          @for (f of header; track f.key) {
            <label class="fig"><span class="it">{{ f.item }}</span><span class="fl">{{ t(f.label) }}</span>
              <input type="number" inputmode="numeric" min="0" [(ngModel)]="figs[f.key]" (ngModelChange)="bump()" /></label>
          }
          <div class="fig calc"><span class="it">8</span><span class="fl">{{ t('Total used ballot papers') }}<small>{{ t('Spoiled + rejected + valid') }}</small></span>
            <b>{{ used() ?? '…' }}</b></div>
          <button class="link" (click)="usedDiffers = !usedDiffers; bump()">{{ usedDiffers ? t('Item 8 is the same as the sheet') : t('The sheet shows a different item 8') }}</button>
          @if (usedDiffers) {
            <label class="fig"><span class="it">8</span><span class="fl">{{ t('Item 8 as written on the sheet') }}</span>
              <input type="number" inputmode="numeric" min="0" [(ngModel)]="figs['used']" (ngModelChange)="bump()" /></label>
          }
        </div>
        @for (w of ballotIssues(); track w.flag) { <p class="warn"><ion-icon name="alert-circle" /> {{ w.message }}</p> }
      }
      @case (1) {
        <p class="lede">{{ t('Votes for each party, as called out and written on the sheet.') }}</p>
        <div class="card flat">
          @for (p of parties(); track p) {
            <label class="fig party"><span class="dot" [style.background]="colour(p)"></span><span class="fl"><b>{{ p }}</b></span>
              <input type="number" inputmode="numeric" min="0" [(ngModel)]="votes[p]" (ngModelChange)="bump()" /></label>
          }
        </div>
        <div class="sum" [class.bad]="sum() !== (figs['totalValid'] ?? 0)">
          <span>{{ t('Party votes add up to') }} <b>{{ sum() }}</b></span>
          <span>{{ t('Total valid on sheet') }} <b>{{ figs['totalValid'] ?? 0 }}</b></span>
        </div>
      }
      @case (2) {
        <p class="lede">{{ t('Now a photo of the signed and stamped sheet. Lay it flat in good light; all four corners and every figure must show.') }}</p>
        @if (photoUrl()) {
          <button class="shot" (click)="camera.set(true)"><img [src]="photoUrl()" alt="{{ t('Your photo of the sheet') }}" /><span><ion-icon name="refresh" /> {{ t('Retake') }}</span></button>
        } @else {
          <button class="snap" (click)="camera.set(true)"><span class="ico teal"><ion-icon name="camera" /></span>
            <b>{{ t('Take photo of signed sheet') }}</b><small>{{ t('Time and place are printed on the photo') }}</small></button>
        }
        <p class="hint">{{ t('A light copy is sent now; the full-size photo stays on your phone in case the room needs it.') }}</p>
      }
      @case (3) {
        <p class="lede">{{ t('Read everything back against the sheet before you send.') }}</p>
        @if (photoUrl()) { <button class="thumb" (click)="big.set(!big())"><img [src]="photoUrl()" [class.big]="big()" alt="" /><span>{{ big() ? t('Tap to make smaller') : t('Your photo: tap to make bigger') }}</span></button> }
        @else { <p class="warn"><ion-icon name="alert-circle" /> {{ t('No photo of the sheet. Go back and take one if you can.') }}</p> }
        <div class="card flat rb">
          <div class="rh"><span>{{ t('Summary') }}</span><button class="link" (click)="step.set(0)">{{ t('Edit') }}</button></div>
          @for (f of header; track f.key) { <div class="rr"><span>{{ f.item }} · {{ t(f.label) }}</span><b>{{ figs[f.key] ?? 0 }}</b></div> }
          <div class="rr"><span>8 · {{ t('Total used ballot papers') }}</span><b>{{ usedDiffers ? figs['used'] : used() }}</b></div>
          <div class="rh"><span>{{ t('Votes') }}</span><button class="link" (click)="step.set(1)">{{ t('Edit') }}</button></div>
          @for (p of parties(); track p) { <div class="rr"><span><i class="dot" [style.background]="colour(p)"></i>{{ p }}</span><b>{{ votes[p] ?? 0 }}</b></div> }
        </div>
        @for (i of issues(); track i.code) { <p class="warn"><ion-icon name="alert-circle" /> {{ i.message }}</p> }
        @for (w of ballotIssues(); track w.flag) { <p class="warn"><ion-icon name="alert-circle" /> {{ w.message }}</p> }
        @if (issues().length) { <p class="hint">{{ t('If the sheet itself has these figures, submit anyway: the situation room will look at it.') }}</p> }
      }
      @case (4) {
        <div class="sent"><ion-icon name="checkmark-circle" /><b>{{ t('Result saved') }}</b>
          <span>{{ outbox.online() ? t('It is on its way to the situation room.') : t('No internet: it will send by itself, or send it by SMS from the waiting list.') }}</span></div>
        <p class="section-title">{{ t('Last step: check IReV') }}</p>
        <div class="card irev">
          @if (irev.pending().length) {
            <span class="ico orange"><ion-icon name="document-text" /></span>
            <div><b>{{ t('Your sheet is on IReV') }}</b><small>{{ t('Compare it with the sheet you signed.') }}</small></div>
            <button class="go" routerLink="/irev-check">{{ t('Compare') }}</button>
          } @else if (irev.list().length) {
            <span class="ico teal"><ion-icon name="checkmark-done" /></span>
            <div><b>{{ t('IReV checked') }}</b><small>{{ irev.list()[0].status === 'matches' ? t('You said it matches.') : t('You said it is different. The legal desk has it.') }}</small></div>
            <button class="go ghost" routerLink="/irev-check">{{ t('Open') }}</button>
          } @else {
            <span class="ico grey"><ion-icon name="hourglass" /></span>
            <div><b>{{ t('Waiting for INEC to upload') }}</b><small>{{ t('The app looks every 5 minutes and tells you when it is there.') }}@if (irev.lastLook()) { {{ t('Last looked') }} {{ time(irev.lastLook()!) }}. }</small></div>
            <button class="go" (click)="checkIrev()" [disabled]="looking()">@if (looking()) { <ion-spinner name="dots" /> } @else { {{ t('Check now') }} }</button>
          }
        </div>
        <p class="hint">{{ t('If IReV shows different figures, say so on the next screen: a copy of the IReV sheet is kept with your report as evidence.') }}</p>
      }
    }
  </ion-content>
  <ion-footer class="ion-no-border"><div class="foot">
    @if (step() === 4) { <button class="primary" routerLink="/">{{ t('Done') }}</button> }
    @else {
      @if (step() > 0) { <button class="ghost" (click)="step.set(step() - 1)">{{ t('Back') }}</button> }
      @if (step() < 3) { <button class="primary" (click)="next()">{{ t('Next') }}</button> }
      @else { <button class="primary send" (click)="submit()"><ion-icon name="send" />{{ t('Submit result') }}</button> }
    }
  </div></ion-footer>
  @if (camera()) { <sheet-camera [label]="'PU ' + pu" (taken)="photoTaken($event)" (closed)="camera.set(false)" /> }`,
  styles: `
    .steps { display: flex; gap: 4px; padding: 6px 10px 10px; background: var(--ion-toolbar-background, #f3f4f6); overflow-x: auto; }
    .st { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; border: 0; background: none; font: inherit; color: var(--r-muted); padding: 0; min-width: 52px; }
    .st .n { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: #e5e7eb; font-size: 13px; font-weight: 800; }
    .st .l { font-size: 11px; font-weight: 700; }
    .st.on { color: var(--r-accent); } .st.on .n { background: var(--r-accent); color: #fff; }
    .st.done .n { background: #16a34a; color: #fff; } .st:disabled { opacity: .5; }
    .lede { margin: 4px 2px 12px; color: var(--r-ink-2); font-size: 15px; }
    .note { display: flex; gap: 6px; align-items: center; font-size: 14px; margin: 0 2px 10px; } .note.ok { color: #16a34a; }
    .fig { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--r-line-soft); }
    .it { width: 26px; height: 26px; border-radius: 8px; background: var(--r-accent-soft); color: var(--r-accent); display: grid; place-items: center; font-size: 13px; font-weight: 800; flex: none; }
    .fl { flex: 1; font-size: 15px; } .fl small { display: block; color: var(--r-muted); font-size: 12px; }
    .fig input { width: 112px; font: inherit; font-size: 22px; font-weight: 700; text-align: right; padding: 8px 10px; border: 1.5px solid #d5dae1; border-radius: 12px; background: #fff; }
    .fig input:focus { outline: none; border-color: var(--r-accent); box-shadow: 0 0 0 3px rgba(15,118,110,.15); }
    .fig.calc b { font-size: 22px; padding-right: 10px; }
    .dot { width: 14px; height: 14px; border-radius: 50%; flex: none; display: inline-block; margin-right: 6px; vertical-align: -1px; }
    .link { border: 0; background: none; color: var(--r-accent); font: inherit; font-weight: 700; font-size: 14px; padding: 10px 14px; }
    .sum { display: flex; justify-content: space-between; gap: 10px; padding: 12px 14px; border-radius: 14px; background: #e3f4ea; color: #146c3a; font-size: 14px; }
    .sum b { font-size: 18px; } .sum.bad { background: #fdecea; color: #b3261e; }
    .warn { display: flex; gap: 6px; align-items: flex-start; color: #b3261e; font-size: 14px; margin: 8px 2px; }
    .hint { color: var(--r-muted); font-size: 13px; margin: 10px 2px; }
    .snap { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 34px 16px; border: 2px dashed #c7cdd5; border-radius: 20px; background: #fff; font: inherit; color: var(--r-ink); }
    .snap .ico { width: 64px; height: 64px; border-radius: 20px; } .snap .ico ion-icon { font-size: 34px; } .snap b { font-size: 17px; } .snap small { color: var(--r-muted); }
    .shot { position: relative; width: 100%; border: 0; padding: 0; background: none; border-radius: 18px; overflow: hidden; }
    .shot img { width: 100%; display: block; } .shot span { position: absolute; right: 10px; bottom: 10px; background: rgba(0,0,0,.6); color: #fff; padding: 6px 12px; border-radius: 999px; font-weight: 700; font-size: 13px; display: flex; gap: 4px; align-items: center; }
    .thumb { display: flex; align-items: center; gap: 10px; width: 100%; border: 1px solid var(--r-line); background: #fff; border-radius: 14px; padding: 6px; margin-bottom: 10px; font: inherit; text-align: left; }
    .thumb img { width: 72px; height: 54px; object-fit: cover; border-radius: 10px; flex: none; } .thumb img.big { width: 100%; height: auto; }
    .thumb:has(img.big) { flex-direction: column; } .thumb span { font-size: 13px; color: var(--r-muted); }
    .rb .rh { display: flex; justify-content: space-between; align-items: center; padding: 4px 0 0 14px; background: #f8fafb; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; color: var(--r-muted); }
    .rr { display: flex; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--r-line-soft); font-size: 15px; } .rr b { font-size: 17px; font-variant-numeric: tabular-nums; }
    .sent { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; padding: 22px 12px; }
    .sent ion-icon { font-size: 56px; color: #16a34a; } .sent b { font-size: 22px; } .sent span { color: var(--r-muted); }
    .irev { display: flex; align-items: center; gap: 12px; } .irev > div { flex: 1; } .irev b { display: block; } .irev small { display: block; color: var(--r-muted); font-size: 13px; }
    .go { border: 0; border-radius: 12px; padding: 10px 14px; background: var(--r-accent); color: #fff; font: inherit; font-weight: 800; white-space: nowrap; }
    .go.ghost { background: var(--r-accent-soft); color: var(--r-accent); }
    .foot { display: flex; gap: 10px; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: var(--r-bg, #f3f4f6); }
    .foot button { flex: 1; border-radius: 16px; padding: 15px; font: inherit; font-size: 17px; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .primary { border: 0; background: var(--r-accent); color: #fff; } .primary.send { background: #16a34a; }
    .ghost { border: 1.5px solid #d5dae1; background: #fff; color: var(--r-ink); flex: 0 0 34% !important; }
  `,
})
export default class ResultPage {
  private api = inject(Api);
  outbox = inject(Outbox);
  irev = inject(IrevChecks);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  pu = this.api.me()!.area_code;
  parties = this.api.parties;
  private unitFigs = inject(UnitFiguresService);
  /** EC8A items 1 to 7 in sheet order (item 8 is worked out). `key` is the form field. */
  header = UNIT_FIGURE_ITEMS.filter((i) => i.item <= 7).map((i) => ({ ...i, key: i.key === 'total_valid' ? 'totalValid' : i.key }));
  readonly stepNames = ['Figures', 'Votes', 'Photo', 'Check', 'IReV'];
  step = signal(0);
  camera = signal(false);
  looking = signal(false);
  figs: Record<string, number | null> = this.prefill();
  usedDiffers = this.figs['used'] != null && this.figs['used'] !== usedBallots(this.unitFigures());
  prefilled = Object.values(this.figs).some((v) => v != null);
  votes: Record<string, number | null> = {};
  photoUrl = signal<string | null>(null);
  big = signal(false);
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

  colour(p: string) { return partyColour(p, this.parties(), this.api.partyColours()); }
  private headerFilled() { return !this.header.some((f) => this.figs[f.key] === null || this.figs[f.key] === undefined || (this.figs[f.key] as unknown) === ''); }
  /** Earlier steps can always be reopened; later ones once the ones before are filled; IReV only after sending */
  canGo(i: number) { return i === 4 ? this.step() === 4 : this.step() === 4 ? false : i <= this.step() || (i <= 3 && this.headerFilled()); }
  go(i: number) { if (this.canGo(i)) this.step.set(i); }

  async next() {
    if (this.step() === 0 && !this.headerFilled()) { await this.ui.error('Fill in items 1 to 7 (write 0 if none)'); return; }
    if (this.step() === 2 && !this.photoUrl() && !(await this.ui.confirm('No photo yet', 'The photo is how the room checks your figures. Continue without it?', 'Continue'))) return;
    this.step.set(this.step() + 1);
  }

  private original: Blob | null = null;
  private originals = inject(Originals);
  /** Full resolution kept on the phone; the light copy goes with the result */
  photoTaken(p: SheetShot) { this.blob = p.small; this.original = p.original; this.photoUrl.set(p.url); this.camera.set(false); }

  async checkIrev() {
    this.looking.set(true);
    try { await this.ui.toast(this.t(await this.irev.checkNow()), 'medium'); await this.irev.load(); } catch (e) { await this.ui.error(e); }
    this.looking.set(false);
  }
  time(ms: number) { return new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }); }

  async submit() {
    const f = this.figures();
    const issues = this.issues();
    if (issues.length && !(await this.ui.confirm('Figures do not add up', 'Submit exactly as written on the sheet?', 'Submit'))) return;
    const version = Number(localStorage.getItem('rumfa.result.version') ?? '0') + 1;
    localStorage.setItem('rumfa.result.version', String(version));
    const item = await this.outbox.add('result', { pu: this.pu, version, registered: f.registered, accredited: f.accredited, rejected: f.rejected,
      total_valid: f.totalValid, votes: f.votes }, `Result for ${this.pu}`, this.blob);
    if (this.original) await this.originals.keep(item.id, this.pu, this.original).catch(() => undefined);
    // The summary figures (items 1 to 8) also go to "My polling unit", so the ballot checks run on the final sheet
    await this.unitFigs.send('result', this.unitFigures());
    // Last step: IReV, which waits for INEC; the app keeps looking every 5 minutes
    this.step.set(4);
    this.irev.watch(() => true);
    void this.irev.load();
  }
}
