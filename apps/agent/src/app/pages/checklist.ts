import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonSegment,
  IonSegmentButton, IonTitle, IonToolbar } from '@ionic/angular';
import { Router } from '@angular/router';
import { Supa } from '../core/supa';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

interface Item { code: string; text: string; kind: 'yesno' | 'number' | 'time'; group: string; problem?: string }

// From the party agent field checklist (arrival to result). Answers marked "problem"
// offer to report an incident straight away.
const ITEMS: Item[] = [
  { group: 'Opening', code: 'arrived', text: 'I arrived at the polling unit by 7:30 am', kind: 'yesno' },
  { group: 'Opening', code: 'officials_present', text: 'All 4 polling officials are present', kind: 'yesno', problem: 'materials_late' },
  { group: 'Opening', code: 'materials_present', text: 'Materials are present (BVAS, ballot papers, EC8A, ballot box)', kind: 'yesno', problem: 'materials_late' },
  { group: 'Opening', code: 'agent_allowed', text: 'I was allowed in as party agent', kind: 'yesno', problem: 'agent_denied' },
  { group: 'Opening', code: 'security_present', text: 'Security officer is present', kind: 'yesno' },
  { group: 'Opening', code: 'start_time', text: 'Time accreditation and voting started', kind: 'time' },
  { group: 'Voting', code: 'bvas_working', text: 'BVAS is working', kind: 'yesno', problem: 'bvas_failure' },
  { group: 'Voting', code: 'voters_turned_away', text: 'No registered voters were turned away', kind: 'yesno', problem: 'voters_turned_away' },
  { group: 'Closing', code: 'bvas_registered', text: 'Registered voters (from BVAS)', kind: 'number' },
  { group: 'Closing', code: 'bvas_accredited', text: 'Accredited voters (from BVAS)', kind: 'number' },
  { group: 'Closing', code: 'count_public', text: 'Counting was done in public', kind: 'yesno', problem: 'result_dispute' },
  { group: 'Closing', code: 'ec8a_signed', text: 'I signed the EC8A and received my copy', kind: 'yesno', problem: 'result_dispute' },
  { group: 'Closing', code: 'ec60e_posted', text: 'Result poster (EC60E) was put up', kind: 'yesno', problem: 'result_not_posted' },
  { group: 'Closing', code: 'irev_upload', text: 'I saw the result sheet uploaded with the BVAS', kind: 'yesno', problem: 'upload_failed' },
];

@Component({
  selector: 'page-checklist',
  imports: [FormsModule, IonBackButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonListHeader, IonSegment,
    IonSegmentButton, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Checklist') }}</ion-title></ion-toolbar></ion-header>
  <ion-content>
    <ion-list>
      @for (g of groups; track g) {
        <ion-list-header>{{ g }}</ion-list-header>
        @for (i of itemsOf(g); track i.code) {
          <ion-item>
            <ion-label class="ion-text-wrap">{{ i.text }}</ion-label>
            @if (i.kind === 'yesno') {
              <ion-segment slot="end" [value]="answers()[i.code]" (ionChange)="answer(i, $event.detail.value)">
                <ion-segment-button value="yes">{{ t('Yes') }}</ion-segment-button>
                <ion-segment-button value="no">{{ t('No') }}</ion-segment-button>
              </ion-segment>
            } @else {
              <ion-input slot="end" class="num small" [type]="i.kind === 'time' ? 'time' : 'number'" [value]="answers()[i.code]"
                (ionChange)="answer(i, $event.detail.value)" aria-label="answer" />
            }
          </ion-item>
        }
      }
    </ion-list>
  </ion-content>`,
  styles: `ion-segment { width: 140px; } .small { max-width: 120px; }`,
})
export default class ChecklistPage {
  private supa = inject(Supa);
  private outbox = inject(Outbox);
  private ui = inject(Ui);
  private router = inject(Router);
  t = inject(I18n).t;
  groups = [...new Set(ITEMS.map((i) => i.group))];
  answers = signal<Record<string, any>>(JSON.parse(localStorage.getItem('rumfa.checklist') ?? '{}'));
  itemsOf = (g: string) => ITEMS.filter((i) => i.group === g);

  async answer(i: Item, value: any) {
    if (value === undefined || value === null || value === '') return;
    const a = { ...this.answers(), [i.code]: value };
    this.answers.set(a);
    localStorage.setItem('rumfa.checklist', JSON.stringify(a));
    await this.outbox.add('checklist', { pu: this.supa.me()!.area_code, item: i.code, answer: { value } }, `Checklist: ${i.text}`);
    if (value === 'no' && i.problem && await this.ui.confirm('Report this problem?', 'The situation room will be told straight away.', 'Report')) {
      await this.router.navigate(['/report']);
    }
  }
}
