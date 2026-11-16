import { Component, computed, inject } from '@angular/core';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonProgressBar, IonTitle, IonToolbar } from '@ionic/angular';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { CHECKLIST, CHECKLIST_GROUPS, Checklist, type ChecklistItem } from '../core/checklist';

/**
 * Polling-unit checklist from arrival to result. Every item shows whether it is done, still to do, or a problem;
 * the progress at the top (and on the home screen) shows what is left.
 */
@Component({
  selector: 'page-checklist',
  imports: [IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonProgressBar, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Checklist') }}</ion-title></ion-toolbar>
    <ion-toolbar class="progress">
      <div class="sum">
        @if (cl.done() === cl.total) { <b class="ok">{{ t('All done') }}</b> }
        @else { <b>{{ cl.done() }} / {{ cl.total }}</b> {{ t('done') }} · {{ cl.total - cl.done() }} {{ t('left') }} }
        @if (cl.problems()) { <span class="probs">{{ cl.problems() }} {{ cl.problems() === 1 ? t('problem') : t('problems') }}</span> }
      </div>
      <ion-progress-bar [value]="cl.done() / cl.total" [color]="cl.done() === cl.total ? 'success' : 'primary'" />
    </ion-toolbar>
  </ion-header>
  <ion-content>
    @for (g of groups; track g) {
      <h3 class="group">{{ t(g) }} <span>{{ groupDone(g) }} / {{ itemsOf(g).length }}</span>
        @if (groupDone(g) === itemsOf(g).length) { <ion-icon name="checkmark-circle" color="success" /> }</h3>
      @for (i of itemsOf(g); track i.code) {
        <div class="item" [class]="cl.status(i)">
          @switch (cl.status(i)) {
            @case ('done') { <ion-icon class="st" name="checkmark-circle" [attr.aria-label]="t('Done')" /> }
            @case ('problem') { <ion-icon class="st" name="alert-circle" [attr.aria-label]="t('Problem')" /> }
            @default { <ion-icon class="st" name="ellipse-outline" [attr.aria-label]="t('To do')" /> }
          }
          <div class="body">
            <div class="q">{{ t(i.text) }}</div>
            @if (i.hint) { <div class="sub">{{ t(i.hint) }}</div> }
            @if (i.kind === 'yesno') {
              <div class="yn">
                <button [class.on]="cl.answers()[i.code] === 'yes'" class="yes" (click)="answer(i, 'yes')">{{ t('Yes') }}</button>
                <button [class.on]="cl.answers()[i.code] === 'no'" class="no" (click)="answer(i, 'no')">{{ t('No') }}</button>
              </div>
            } @else {
              <ion-input class="field" fill="outline" [type]="i.kind === 'time' ? 'time' : 'number'" inputmode="numeric"
                [placeholder]="i.kind === 'time' ? '' : t('Type the number')" [value]="cl.answers()[i.code]"
                (ionChange)="answer(i, $event.detail.value)" [attr.aria-label]="t(i.text)" />
            }
            @if (cl.status(i) === 'problem') { <div class="flag">{{ t('Problem noted. Report it if you have not already.') }}</div> }
          </div>
        </div>
      }
    }
    <p class="foot hint">{{ t('Answers save on this phone at once and send when there is internet. You can change an answer any time.') }}</p>
  </ion-content>`,
  styles: `
    .progress { --background: var(--ion-color-light); padding: 6px 12px 8px; }
    .sum { font-size: 14px; margin-bottom: 6px; display: flex; gap: 10px; align-items: center; } .sum b { font-size: 18px; }
    .ok { color: #0b6b3a; } .probs { margin-left: auto; color: #b45309; font-weight: 600; }
    .group { display: flex; align-items: center; gap: 8px; margin: 18px 16px 6px; font-size: 15px; text-transform: uppercase;
      letter-spacing: .6px; color: var(--ion-color-medium); }
    .group span { font-weight: 400; text-transform: none; letter-spacing: 0; }
    .item { display: flex; gap: 12px; margin: 8px 12px; padding: 12px; border-radius: 14px; background: var(--ion-color-light);
      border-left: 5px solid #cbd5e1; }
    .item.done { border-left-color: #16a34a; } .item.problem { border-left-color: #d97706; background: #fff7ed; }
    .st { font-size: 26px; flex: none; color: #94a3b8; margin-top: 1px; }
    .item.done .st { color: #16a34a; } .item.problem .st { color: #d97706; }
    .body { flex: 1; min-width: 0; }
    .q { font-size: 17px; line-height: 1.35; font-weight: 500; } .sub { font-size: 13px; color: var(--ion-color-medium); margin-top: 2px; }
    .yn { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    .yn button { min-height: 48px; border-radius: 12px; border: 2px solid #cbd5e1; background: #fff; font: inherit; font-size: 17px;
      font-weight: 600; color: var(--ion-text-color); touch-action: manipulation; }
    .yn .yes.on { background: #16a34a; border-color: #16a34a; color: #fff; }
    .yn .no.on { background: #d97706; border-color: #d97706; color: #fff; }
    .field { margin-top: 10px; --background: #fff; font-size: 18px; min-height: 48px; }
    .flag { margin-top: 8px; font-size: 13px; color: #b45309; }
    .foot { margin: 16px; }
  `,
})
export default class ChecklistPage {
  private api = inject(Api);
  private outbox = inject(Outbox);
  private ui = inject(Ui);
  private router = inject(Router);
  cl = inject(Checklist);
  t = inject(I18n).t;
  groups = CHECKLIST_GROUPS;
  itemsOf = (g: string) => CHECKLIST.filter((i) => i.group === g);
  private byGroup = computed(() => Object.fromEntries(this.groups.map((g) => [g, this.itemsOf(g).filter((i) => this.cl.status(i) !== 'todo').length])));
  groupDone = (g: string) => this.byGroup()[g];

  constructor() { void this.cl.load(); }


  async answer(i: ChecklistItem, value: any) {
    if (value === undefined || value === null || value === '' || this.cl.answers()[i.code] === value) return;
    this.cl.set(i.code, value);
    await this.outbox.add('checklist', { pu: this.api.me()!.area_code, item: i.code, answer: { value } }, `Checklist: ${i.text}`);
    if (value === 'no' && i.problem && await this.ui.confirm('Report this problem?', 'The situation room will be told straight away.', 'Report', 'Not now')) {
      await this.router.navigate(['/report'], { queryParams: { category: i.problem } });
    }
  }
}
