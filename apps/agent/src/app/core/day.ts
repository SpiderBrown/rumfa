import { Injectable, computed, inject } from '@angular/core';
import type { UnitFigures } from '@rumfa/shared';
import { Api } from './api';
import { Checkin } from './checkin';
import { CHECKLIST, Checklist, DAY_STAGES, type ChecklistItem, type DayStage } from './checklist';
import { LiveCount } from './live-count';
import { Outbox } from './outbox';
import { type Stage, UnitFiguresService } from './unit-figures';

/** One thing to do in a stage: a check-in, a question, a time, figures to send, or a page to open. */
export type Task =
  | { kind: 'checkin' }
  | { kind: 'question'; item: ChecklistItem }
  | { kind: 'figures'; stage: Stage; fields: (keyof UnitFigures)[] }
  | { kind: 'accreditation' }
  | { kind: 'count' }
  | { kind: 'result' }
  | { kind: 'report' };

const Q = (code: string): Task => ({ kind: 'question', item: CHECKLIST.find((i) => i.code === code)! });

/** What each stage asks, in the order it happens at the polling unit. */
const TASKS: Record<DayStage, Task[]> = {
  arrival: [{ kind: 'checkin' }, Q('agent_allowed')],
  setup: [Q('officials_present'), Q('materials_present'), Q('security_present'), { kind: 'figures', stage: 'setup', fields: ['registered', 'ballots_received'] }],
  // Accreditation first (start time, counts, its checks), then voting once accreditation is under way
  voting: [Q('start_time'), { kind: 'accreditation' }, Q('bvas_working'), Q('voters_turned_away'), Q('voting_started')],
  close: [Q('voting_ended'), { kind: 'figures', stage: 'close', fields: ['accredited', 'unused', 'spoiled'] }],
  counting: [Q('count_public'), { kind: 'count' }],
  result: [{ kind: 'result' }, Q('ec8a_signed')],
  after: [Q('ec60e_posted'), Q('irev_upload')],
};
const AGENT_ONLY = new Set(['figures', 'accreditation', 'count', 'result']);


/**
 * Where the agent is in the polling-unit day: which tasks of each stage are done, what is left, and the stage
 * they are in now (the first unfinished one after the furthest they have started). Shared by the home screen
 * and "My polling unit".
 */
@Injectable({ providedIn: 'root' })
export class DayJourney {
  private api = inject(Api);
  private ci = inject(Checkin);
  private cl = inject(Checklist);
  private figs = inject(UnitFiguresService);
  private lc = inject(LiveCount);
  private outbox = inject(Outbox);

  readonly resultSent = computed(() => this.outbox.items().some((i) => i.kind === 'result') || this.figs.latest().total_valid != null);
  readonly countDone = computed(() => !!this.lc.state()?.done || this.resultSent());

  tasksOf(id: DayStage): Task[] { return TASKS[id].filter((t) => this.api.isAgent() || !AGENT_ONLY.has(t.kind)); }

  figuresDone(stage: Stage) {
    const l = this.figs.latest();
    return stage === 'setup' ? l.registered != null && l.ballots_received != null : this.figs.final() && l.unused != null && l.spoiled != null;
  }

  /** Done, not done, or null for optional tasks */
  taskDone(task: Task): boolean | null {
    switch (task.kind) {
      case 'checkin': return this.ci.checkedIn() && !this.ci.onlyOutside();
      case 'question': return this.cl.status(task.item) !== 'todo';
      case 'figures': return this.figuresDone(task.stage);
      case 'accreditation': return this.figs.accreditationUpdates().length > 0;
      case 'count': return this.countDone();
      case 'result': return this.resultSent();
      case 'report': return null;
    }
  }
  left(id: DayStage) { return this.tasksOf(id).filter((t) => this.taskDone(t) === false).length; }
  stageDone(id: DayStage) { return this.left(id) === 0; }
  progressed(id: DayStage) { return this.tasksOf(id).some((t) => this.taskDone(t) === true); }

  readonly current = computed<DayStage | null>(() => {
    this.cl.answers(); this.figs.history(); this.ci.state(); this.lc.state(); this.resultSent();
    let furthest = -1;
    DAY_STAGES.forEach((s, i) => { if (this.progressed(s.id)) furthest = i; });
    const after = DAY_STAGES.slice(Math.max(0, furthest)).find((s) => !this.stageDone(s.id));
    return (after ?? DAY_STAGES.find((s) => !this.stageDone(s.id)))?.id ?? null;
  });
  readonly doneStages = computed(() => { this.cl.answers(); this.figs.history(); this.ci.state(); this.lc.state(); this.resultSent();
    return DAY_STAGES.filter((s) => this.stageDone(s.id)).length; });
  /** Unanswered tasks in stages before the current one (asked about on the home screen) */
  readonly leftBehind = computed(() => {
    const c = this.current(); this.cl.answers(); this.figs.history();
    const ci = DAY_STAGES.findIndex((s) => s.id === c);
    return DAY_STAGES.slice(0, ci < 0 ? DAY_STAGES.length : ci).reduce((n, s) => n + this.left(s.id), 0);
  });
}

export { CHECKLIST };
export type { ChecklistItem };
