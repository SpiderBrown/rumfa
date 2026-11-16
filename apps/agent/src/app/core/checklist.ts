import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Api } from './api';

export interface ChecklistItem { code: string; text: string; kind: 'yesno' | 'number' | 'time'; group: string; problem?: string; hint?: string }

// From the party agent field checklist (arrival to result). A "No" on an item with `problem` is a problem
// and offers to report it straight away.
export const CHECKLIST: ChecklistItem[] = [
  { group: 'Opening', code: 'arrived', text: 'I arrived at the polling unit by 7:30 am', kind: 'yesno' },
  { group: 'Opening', code: 'officials_present', text: 'All 4 polling officials are present', kind: 'yesno', problem: 'materials_late' },
  { group: 'Opening', code: 'materials_present', text: 'Materials are present', hint: 'BVAS, ballot papers, EC8A forms, ballot box', kind: 'yesno', problem: 'materials_late' },
  { group: 'Opening', code: 'agent_allowed', text: 'I was allowed in as party agent', kind: 'yesno', problem: 'agent_denied' },
  { group: 'Opening', code: 'security_present', text: 'Security officer is present', kind: 'yesno' },
  { group: 'Opening', code: 'start_time', text: 'Time accreditation and voting started', kind: 'time' },
  { group: 'Voting', code: 'bvas_working', text: 'BVAS is working', kind: 'yesno', problem: 'bvas_failure' },
  { group: 'Voting', code: 'voters_turned_away', text: 'No registered voters were turned away', kind: 'yesno', problem: 'voters_turned_away' },
  { group: 'Closing', code: 'bvas_registered', text: 'Registered voters', hint: 'From the BVAS', kind: 'number' },
  { group: 'Closing', code: 'bvas_accredited', text: 'Accredited voters', hint: 'From the BVAS', kind: 'number' },
  { group: 'Closing', code: 'count_public', text: 'Counting was done in public', kind: 'yesno', problem: 'result_dispute' },
  { group: 'Closing', code: 'ec8a_signed', text: 'I signed the EC8A and received my copy', kind: 'yesno', problem: 'result_dispute' },
  { group: 'Closing', code: 'ec60e_posted', text: 'Result poster (EC60E) was put up', kind: 'yesno', problem: 'result_not_posted' },
  { group: 'Closing', code: 'irev_upload', text: 'I saw the result sheet uploaded with the BVAS', kind: 'yesno', problem: 'upload_failed' },
];
export const CHECKLIST_GROUPS = [...new Set(CHECKLIST.map((i) => i.group))];

export type ItemStatus = 'todo' | 'done' | 'problem';

/**
 * The signed-in person's checklist answers: kept on the phone per person (never shared between people on one
 * phone), sent through the outbox, and restored from the server after a reinstall.
 */
@Injectable({ providedIn: 'root' })
export class Checklist {
  private api = inject(Api);
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

  private save(a: Record<string, any>) {
    this.answers.set(a);
    const k = this.key();
    if (k) localStorage.setItem(k, JSON.stringify(a));
  }
}
