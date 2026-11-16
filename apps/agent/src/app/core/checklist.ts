import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Api } from './api';
import { Outbox } from './outbox';

/** The polling-unit day in INEC's order. Every checklist question, figure and time belongs to one stage. */
export type DayStage = 'arrival' | 'setup' | 'voting' | 'close' | 'counting' | 'result' | 'after';
export const DAY_STAGES: { id: DayStage; title: string; when: string }[] = [
  { id: 'arrival', title: 'Arrival', when: 'When you reach the polling unit' },
  { id: 'setup', title: 'Setup', when: 'Officials open the materials, before voting starts' },
  { id: 'voting', title: 'Accreditation and voting', when: 'From the first voter until the last' },
  { id: 'close', title: 'Close of poll', when: 'Voting ends; the officer announces the closing figures' },
  { id: 'counting', title: 'Sorting and counting', when: 'Ballots are sorted and counted in public' },
  { id: 'result', title: 'Result announced', when: 'The officer announces and signs the result sheet (EC8A)' },
  { id: 'after', title: 'After the result', when: 'Before you leave the polling unit' },
];

export interface ChecklistItem {
  code: string; text: string; kind: 'yesno' | 'number' | 'time' | 'auto'; stage: DayStage; problem?: string; hint?: string;
  /** Group name for the full checklist list (the stage title) */
  group: string;
}

const STAGE_TITLE = Object.fromEntries(DAY_STAGES.map((s) => [s.id, s.title])) as Record<DayStage, string>;
const item = (i: Omit<ChecklistItem, 'group'>): ChecklistItem => ({ ...i, group: STAGE_TITLE[i.stage] });

// The party agent field checklist, asked at the moment each thing happens. A "No" on an item with `problem`
// is a problem and offers to report it straight away. "auto" items are answered by the app (arrival time from
// check-in). Figures (register, accreditation, ballot papers) are part of the same stages.
export const CHECKLIST: ChecklistItem[] = [
  item({ stage: 'arrival', code: 'arrived', text: 'I arrived at the polling unit by 7:30 am', kind: 'auto' }),
  item({ stage: 'arrival', code: 'agent_allowed', text: 'I was allowed in as party agent', kind: 'yesno', problem: 'agent_denied' }),
  item({ stage: 'setup', code: 'officials_present', text: 'All 4 polling officials are present', kind: 'yesno', problem: 'materials_late' }),
  item({ stage: 'setup', code: 'materials_present', text: 'Materials are present', hint: 'BVAS, ballot papers, EC8A forms, ballot box', kind: 'yesno', problem: 'materials_late' }),
  item({ stage: 'setup', code: 'security_present', text: 'Security officer is present', kind: 'yesno' }),
  item({ stage: 'voting', code: 'start_time', text: 'Accreditation started at', kind: 'time' }),
  item({ stage: 'voting', code: 'bvas_working', text: 'BVAS is working', kind: 'yesno', problem: 'bvas_failure' }),
  item({ stage: 'voting', code: 'voters_turned_away', text: 'No registered voters were turned away', kind: 'yesno', problem: 'voters_turned_away' }),
  item({ stage: 'voting', code: 'voting_started', text: 'Voting started at', hint: 'When voters start casting ballots', kind: 'time' }),
  item({ stage: 'close', code: 'voting_ended', text: 'Voting ended at', kind: 'time' }),
  item({ stage: 'counting', code: 'count_public', text: 'Counting is done in public', kind: 'yesno', problem: 'result_dispute' }),
  item({ stage: 'result', code: 'ec8a_signed', text: 'I signed the EC8A and received my copy', kind: 'yesno', problem: 'result_dispute' }),
  item({ stage: 'after', code: 'ec60e_posted', text: 'Result poster (EC60E) was put up', kind: 'yesno', problem: 'result_not_posted' }),
  item({ stage: 'after', code: 'irev_upload', text: 'I saw the result sheet uploaded with the BVAS', kind: 'yesno', problem: 'upload_failed' }),
];
export const CHECKLIST_GROUPS = DAY_STAGES.map((s) => s.title).filter((g) => CHECKLIST.some((i) => i.group === g));

export type ItemStatus = 'todo' | 'done' | 'problem';

/**
 * The signed-in person's checklist answers: kept on the phone per person (never shared between people on one
 * phone), sent through the outbox, and restored from the server after a reinstall.
 */
@Injectable({ providedIn: 'root' })
export class Checklist {
  private api = inject(Api);
  private outbox = inject(Outbox);
  readonly answers = signal<Record<string, any>>({});
  readonly done = computed(() => CHECKLIST.filter((i) => this.status(i) !== 'todo').length);
  readonly total = CHECKLIST.length;
  readonly problems = computed(() => CHECKLIST.filter((i) => this.status(i) === 'problem').length);
  private key = () => { const me = this.api.me(); return me ? `rumfa.checklist.${me.tenant_id}.${me.id}` : null; };

  constructor() {
    localStorage.removeItem('rumfa.checklist'); // old shared key from before answers were kept per person
    effect(() => {
      const k = this.key();
      if (!k) return;
      try { this.answers.set(JSON.parse(localStorage.getItem(k) ?? '{}')); } catch { this.answers.set({}); }
      void this.load();
    });
  }

  async load() {
    try {
      const server = await this.api.get<Record<string, any>>('/checklist/mine');
      this.save({ ...server, ...this.answers() }); // answers not yet sent win
    } catch { /* offline */ }
  }

  status(i: ChecklistItem): ItemStatus {
    const v = this.answers()[i.code];
    if (v === undefined || v === null || v === '') return 'todo';
    return v === 'no' && i.problem ? 'problem' : 'done';
  }

  set(code: string, value: any) { this.save({ ...this.answers(), [code]: value }); }

  /** Answers a question and sends it to the situation room (through the outbox). */
  async answer(code: string, value: any) {
    if (value === undefined || value === null || value === '' || this.answers()[code] === value) return;
    this.set(code, value);
    const i = CHECKLIST.find((x) => x.code === code);
    await this.outbox.add('checklist', { pu: this.api.me()!.area_code, item: code, answer: { value } }, `Checklist: ${i?.text ?? code}`);
  }

  itemsOf(stage: DayStage) { return CHECKLIST.filter((i) => i.stage === stage); }

  private save(a: Record<string, any>) {
    this.answers.set(a);
    const k = this.key();
    if (k) localStorage.setItem(k, JSON.stringify(a));
  }
}
