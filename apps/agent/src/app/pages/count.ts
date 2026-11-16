import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonItem, IonList, IonTitle, IonToolbar } from '@ionic/angular';
import { partyColour } from '@rumfa/shared';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { INVALID, LiveCount } from '../core/live-count';
import { Ui } from '../core/ui';
import { Clock } from '../core/clock';

/**
 * Live count while ballots are sorted: the INEC official calls each ballot ("APC!", "Invalid!") and the
 * agent taps that button. Totals go to the situation room every few seconds.
 */
@Component({
  selector: 'page-count',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonItem, IonList, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Live count') }}</ion-title>
    <span slot="end" class="link" [class]="lc.link()">{{ linkText() }}</span>
  </ion-toolbar></ion-header>

  <ion-content class="ion-padding">
    @if (lc.state(); as s) {
      @if (lc.error()) { <p class="err">{{ lc.error() }}</p> }
      <div class="total"><b>{{ lc.total() }}</b> {{ t('ballots called') }} · {{ t('Unit') }} {{ s.pu }}</div>
      <!-- Always the same height, so the buttons never move under the agent's thumb -->
      <p class="hint">{{ s.done ? t('Sorting finished. These totals were sent. Submit the signed EC8A result when it is ready.')
        : t('When the INEC official calls out a ballot, tap that party. Tap Invalid for a rejected ballot.') }}</p>

      @if (!editing()) {
        <!-- Fixed order for the whole count (own party first, then ballot order), so a party is always in the same place -->
        <div class="grid">
          @for (p of order(); track p; let first = $first) {
            <button class="party" [class.own]="p === own()" [style.background]="colour(p)" [disabled]="s.done" (click)="tap(p)"
              [attr.aria-label]="p + ', ' + (s.counts[p] ?? 0)">
              @if (logo(p); as src) { <img class="logo" [src]="src" alt="" (error)="noLogo(p)" /> }
              <span class="pn">{{ p }}</span>
              @if (p === own()) { <span class="ours">{{ t('Our party') }}</span> }
              <span class="pc">{{ s.counts[p] ?? 0 }}</span>
            </button>
          }
          <button class="party invalid" [disabled]="s.done" (click)="tap(invalid)" [attr.aria-label]="t('Invalid') + ', ' + s.invalid">
            <span class="pn">{{ t('Invalid') }}</span><span class="pc">{{ s.invalid }}</span>
          </button>
        </div>
      } @else {
        <p class="hint">{{ t('Correct a number if you missed calls or started late.') }}</p>
        <ion-list>
          @for (p of order(); track p) {
            <ion-item><ion-input type="number" inputmode="numeric" min="0" [label]="p" [ngModel]="s.counts[p] ?? 0" (ngModelChange)="lc.setCount(p, $event)" /></ion-item>
          }
          <ion-item><ion-input type="number" inputmode="numeric" min="0" [label]="t('Invalid')" [ngModel]="s.invalid" (ngModelChange)="lc.setCount(invalid, $event)" /></ion-item>
        </ion-list>
      }
    } @else { <p>{{ t('Loading…') }}</p> }
  </ion-content>

  @if (lc.state(); as s) {
    <ion-footer><ion-toolbar>
      @if (!s.done) {
        <ion-buttons slot="start">
          <ion-button [disabled]="!s.history.length || editing()" (click)="undo()"><ion-icon slot="start" name="arrow-undo" />{{ t('Undo') }} {{ lastLabel() }}</ion-button>
        </ion-buttons>
        <ion-buttons slot="end">
          <ion-button (click)="editing.set(!editing())">{{ editing() ? t('Done') : t('Correct') }}</ion-button>
          <ion-button fill="solid" color="success" (click)="finish()">{{ t('Finish') }}</ion-button>
        </ion-buttons>
      } @else {
        <ion-buttons slot="end"><ion-button (click)="lc.reopen()">{{ t('Reopen to correct') }}</ion-button></ion-buttons>
      }
    </ion-toolbar></ion-footer>
  }`,
  styles: `
    .total { font-size: 16px; margin-bottom: 6px; } .total b { font-size: 34px; }
    .hint { color: var(--ion-color-medium); font-size: 13px; margin: 4px 0 10px; min-height: 3.2em; }
    .err { color: var(--ion-color-danger); font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-bottom: 8px; }
    .party { position: relative; min-height: 112px; border: 0; border-radius: 16px; color: #fff; display: grid; justify-items: center;
      align-content: center; gap: 2px; padding: 8px; touch-action: manipulation; user-select: none; -webkit-tap-highlight-color: transparent;
      box-shadow: 0 2px 6px rgba(0,0,0,.2); transition: transform .06s; font-family: inherit; }
    .party:active { transform: scale(.96); filter: brightness(1.1); }
    .party:disabled { opacity: .55; }
    .logo { width: 44px; height: 44px; object-fit: contain; background: #fff; border-radius: 50%; padding: 3px; }
    .pn { font-size: 20px; font-weight: 700; letter-spacing: .5px; } .pc { font-size: 30px; font-weight: 800; line-height: 1.1; }
    /* Own party: full width, taller, logo beside the name; the button agents press most and must never miss */
    .party.own { grid-column: 1 / -1; min-height: 132px; grid-template-columns: auto 1fr auto; grid-template-rows: auto auto;
      justify-items: start; align-items: center; column-gap: 14px; padding: 12px 18px; outline: 3px solid #fff; outline-offset: -7px; }
    .party.own .logo { grid-column: 1; grid-row: 1 / 3; width: 72px; height: 72px; }
    .party.own .pn { grid-column: 2; grid-row: 1; font-size: 26px; align-self: end; }
    .party.own .ours { grid-column: 2; grid-row: 2; font-size: 13px; opacity: .9; align-self: start; }
    .party.own .pc { grid-column: 3; grid-row: 1 / 3; font-size: 44px; }
    .party.invalid { grid-column: 1 / -1; background: #4b5563; min-height: 80px; }
    .link { font-size: 12px; padding: 3px 8px; border-radius: 10px; margin-right: 10px; background: rgba(255,255,255,.2); }
    .link.waiting { background: #f59e0b; color: #111; }
  `,
})
export default class CountPage {
  lc = inject(LiveCount);
  private api = inject(Api);
  private ui = inject(Ui);
  t = inject(I18n).t;
  readonly invalid = INVALID;
  parties = this.api.parties;
  editing = signal(false);
  own = this.api.ownParty;
  /** Own party first, then the rest in ballot order. Never re-sorted by votes: buttons must not move while counting. */
  order = computed(() => { const o = this.own(); const ps = this.parties(); return o && ps.includes(o) ? [o, ...ps.filter((p) => p !== o)] : ps; });
  private missingLogos = signal(new Set<string>());
  private clock = inject(Clock);

  lastLabel = computed(() => { const l = this.lc.state()?.history.at(-1); return l ? (l === INVALID ? this.t('Invalid') : l) : ''; });
  linkText = computed(() => {
    const l = this.lc.link();
    if (l === 'waiting') return this.t('Saved on phone · waiting for signal');
    if (l === 'sending') return this.t('Sending…');
    const at = this.lc.lastSentAt();
    return at ? `${this.t('Live')} · ${Math.max(0, Math.round((this.clock.sec() - at) / 1000))}s` : this.t('Live');
  });

  constructor() { void this.lc.open(); }

  colour(p: string) { return partyColour(p, this.parties()); }
  logo(p: string) { return this.missingLogos().has(p) ? '' : this.api.partyLogo(p); }
  noLogo(p: string) { this.missingLogos.update((m) => new Set(m).add(p)); }

  tap(p: string) {
    this.lc.tap(p);
    navigator.vibrate?.(12);
  }

  undo() {
    const last = this.lc.undo();
    if (last) navigator.vibrate?.([8, 40, 8]);
  }

  async finish() {
    const s = this.lc.state();
    if (!s) return;
    const lines = [...this.order().map((p) => `${p}: ${s.counts[p] ?? 0}`), `${this.t('Invalid')}: ${s.invalid}`].join(', ');
    if (!(await this.ui.confirm('Finish counting?', `${lines}. ${this.t('Total')}: ${this.lc.total()}.`, 'Finish'))) return;
    this.editing.set(false);
    this.lc.finish();
    await this.ui.toast('Counting finished and sent');
  }
}
