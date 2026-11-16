import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { IonButton, IonContent, IonFab, IonIcon } from '@ionic/angular';
import { AppBar } from '../core/app-bar';
import { type UnitFigures, UNIT_FIGURE_ITEMS, figureFlags, usedBallots } from '@rumfa/shared';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { Outbox } from '../core/outbox';
import { Checkin } from '../core/checkin';
import { CheckinFlow } from '../core/checkin-flow';
import { Checklist, DAY_STAGES, type ChecklistItem, type DayStage } from '../core/checklist';
import { DayJourney } from '../core/day';
import { LiveCount } from '../core/live-count';
import { type Stage, UnitFiguresService } from '../core/unit-figures';

const ITEM = Object.fromEntries(UNIT_FIGURE_ITEMS.map((i) => [i.key, i]));

/**
 * My polling unit: the whole day in INEC's order, one stage after another. Each stage holds what happens in it:
 * the checklist questions, the times, the figures to send and the pages to open, so nothing is asked after the
 * moment has passed. The current stage is open; earlier ones can be reopened and show what is still unanswered.
 */
@Component({
  selector: 'page-unit',
  imports: [FormsModule, RouterLink, AppBar, IonButton, IonContent, IonFab, IonIcon],
  template: `
  <app-bar [title]="t('Today')" [sub]="api.brand() + ' · ' + (api.me()?.area_code ?? '')" [sos]="api.atUnit()" />
  <ion-content [scrollEvents]="true" (ionScroll)="onScroll($event)">
    @if (!api.atUnit()) {
      <div class="empty"><ion-icon name="today" /><b>{{ t('No polling unit assigned to you') }}</b>
        <p>{{ t('Your coordinator assigns polling units. Use Chats to reach them.') }}</p></div>
    } @else {
    <div class="top">
      <div class="prog"><span class="track"><i [style.width.%]="progress() * 100"></i></span> {{ doneStages() }} / {{ stages.length }} {{ t('stages') }}</div>
      @if (turnout() !== null) { <div class="turn"><b>{{ pct(turnout()!) }}</b> {{ t('turnout so far') }} · {{ latest().accredited }} / {{ latest().registered }}</div> }
      @if (figs.pendingCount()) { <div class="wait">{{ figs.pendingCount() }} {{ t('saved on phone, will send when there is signal') }}</div> }
    </div>

    @for (s of stages; track s.id; let i = $index) {
      <section class="step" [class.done]="stageDone(s.id)" [class.now]="current() === s.id" [class.locked]="locked(s.id)">
        <button class="head" (click)="toggle(s.id)">
          <span class="dot">@if (stageDone(s.id)) { <ion-icon name="checkmark" /> } @else if (locked(s.id)) { <ion-icon name="lock-closed" /> } @else { {{ i + 1 }} }</span>
          <span class="ht"><b>{{ t(s.title) }}</b><small>{{ summary(s.id) || t(s.when) }}</small></span>
          @if (current() === s.id && !stageDone(s.id)) { <span class="tag">{{ t('Now') }}</span> }
          @else if (left(s.id) && isBefore(s.id)) { <span class="tag left">{{ left(s.id) }} {{ t('left') }}</span> }
        </button>

        @if (isOpen(s.id)) {
          <div class="body">
            @if (locked(s.id)) { <p class="hint">{{ t('Check in first. It tells the situation room you are in place.') }}</p> }
            @else {
              @for (task of tasksOf(s.id); track $index) {
                @switch (task.kind) {
                  @case ('checkin') {
                    <div class="task" [class.ok]="ci.checkedIn() && !ci.onlyOutside()">
                      @if (ci.checkedIn()) {
                        <div class="q">{{ ci.onlyOutside() ? t('Checked in outside your area') : t('Checked in') }} · {{ time(ci.state().arrival ?? ci.state().first!) }}</div>
                        @if (arrivedNote()) { <div class="sub">{{ t(arrivedNote()) }}</div> }
                        @if (ci.onlyOutside()) { <ion-button size="small" (click)="checkIn()">{{ t('Check in again from your area') }}</ion-button> }
                      } @else {
                        <div class="q">{{ t('Check in when you reach your polling unit') }}</div>
                        <ion-button expand="block" (click)="checkIn()"><ion-icon slot="start" name="location-outline" />{{ t('Check in') }}</ion-button>
                      }
                    </div>
                  }
                  @case ('question') {
                    <div class="task" [class.ok]="cl.status(task.item) === 'done'" [class.bad]="cl.status(task.item) === 'problem'">
                      <div class="q">{{ t(task.item.text) }}</div>
                      @if (task.item.hint) { <div class="sub">{{ t(task.item.hint) }}</div> }
                      @if (task.item.kind === 'yesno') {
                        <div class="yn">
                          <button class="yes" [class.on]="answer(task.item) === 'yes'" (click)="setAnswer(task.item, 'yes')">{{ t('Yes') }}</button>
                          <button class="no" [class.on]="answer(task.item) === 'no'" (click)="setAnswer(task.item, 'no')">{{ t('No') }}</button>
                        </div>
                      } @else if (task.item.kind === 'time') {
                        @if (answer(task.item) && editing() !== task.item.code) {
                          <div class="timev"><b>{{ clock12(answer(task.item)) }}</b>
                            <button class="link" (click)="editing.set(task.item.code)">{{ t('Change') }}</button></div>
                        } @else {
                          <div class="timeset">
                            <button class="now" (click)="setAnswer(task.item, nowHHMM())">{{ t('Now') }} · {{ clock12(nowHHMM()) }}</button>
                            <input type="time" [value]="answer(task.item) ?? ''" (change)="setAnswer(task.item, $any($event.target).value)" [attr.aria-label]="t(task.item.text)" />
                          </div>
                          <div class="sub">{{ t('Tap Now, or set the time if you are recording it later.') }}</div>
                        }
                      }
                    </div>
                  }
                  @case ('figures') {
                    <div class="task" [class.ok]="figuresDone(task.stage)">
                      @for (k of task.fields; track k) {
                        <label class="field">
                          <span class="lbl"><span class="item">{{ t('Item') }} {{ item(k).item }}</span> {{ t(fieldLabel(task.stage, k)) }}</span>
                          <input type="number" inputmode="numeric" min="0" [ngModel]="draft[task.stage + k]" (ngModelChange)="setDraft(task.stage + k, $event)"
                            [placeholder]="placeholder(k)" />
                        </label>
                      }
                      @for (w of draftWarnings(task.stage, task.fields); track w.flag) { <p class="warn">⚠ {{ w.message }}</p> }
                      <ion-button expand="block" (click)="sendFigures(task.stage, task.fields)" [disabled]="!hasDraft(task.stage, task.fields)">{{ t('Send') }}</ion-button>
                      @if (figuresSentAt(task.stage); as at) { <div class="sub">{{ at }}</div> }
                    </div>
                  }
                  @case ('accreditation') {
                    <div class="task" [class.ok]="figs.accreditationUpdates().length">
                      <label class="field">
                        <span class="lbl"><span class="item">{{ t('Item') }} 2</span> {{ t('Accredited so far') }}</span>
                        <input type="number" inputmode="numeric" min="0" [ngModel]="draft['acc']" (ngModelChange)="setDraft('acc', $event)" />
                      </label>
                      @for (w of draftWarnings('accreditation', ['accredited']); track w.flag) { <p class="warn">⚠ {{ w.message }}</p> }
                      <ion-button expand="block" (click)="sendFigures('accreditation', ['accredited'])" [disabled]="draft['acc'] == null">{{ t('Send update') }}</ion-button>
                      <div class="sub">{{ t('Send as often as you can. The final number is sent at the close of poll.') }}</div>
                      @if (figs.accreditationUpdates().length) {
                        <div class="hist">
                          @for (u of accreditationLog(); track u.reported_at) {
                            <div><span>{{ time(u.reported_at) }}</span><b>{{ u.figures.accredited }}</b>
                              @if (latest().registered) { <span class="sub">{{ pct(u.figures.accredited! / latest().registered!) }}</span> }
                              <span class="sub">{{ figs.isPending(u) ? t('on phone') : t('sent') }}</span></div>
                          }
                        </div>
                      }
                    </div>
                  }
                  @case ('count') {
                    <div class="task" [class.ok]="countDone()">
                      <div class="q">{{ t('Tap each ballot as it is called') }}</div>
                      @if (lc.state(); as c) { @if (c.seq) { <div class="sub">{{ total() }} {{ t('ballots called') }}{{ c.done ? ' · ' + t('finished') : '' }}</div> } }
                      <ion-button expand="block" routerLink="/count"><ion-icon slot="start" name="speedometer" />{{ t('Open live count') }}</ion-button>
                    </div>
                  }
                  @case ('result') {
                    <div class="task" [class.ok]="resultSent()">
                      <div class="q">{{ t('The announced figures, the votes for each party and a photo of the signed sheet') }}</div>
                      <div class="sub">{{ resultSent() ? t('Result sent') : t('The figures you already sent are filled in for you.') }}</div>
                      <ion-button expand="block" [fill]="resultSent() ? 'outline' : 'solid'" routerLink="/result">
                        <ion-icon slot="start" name="document-text" />{{ resultSent() ? t('Correct the result') : t('Fill in the result sheet') }}</ion-button>
                    </div>
                  }

                }
              }
            }
          </div>
        }
      </section>
    }
    <p class="foot hint">{{ t('Copy each figure exactly as announced or written. If a figure does not add up, send it anyway: the situation room needs to know.') }}</p>
    }
    <!-- Report a problem, from anywhere in the day (after check-in) -->
    @if (api.atUnit()) {
      <ion-fab slot="fixed" vertical="bottom" horizontal="end">
        <button class="report" [class.compact]="compact()" (click)="report()" [attr.aria-label]="t('Report a problem')">
          <ion-icon name="warning" />@if (!compact()) { <span>{{ t('Report') }}</span> }
        </button>
      </ion-fab>
    }
  </ion-content>`,
  styles: `
    .top { padding: 14px 16px 6px; } .unit { color: var(--ion-color-medium); font-size: 13px; }
    .prog { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ion-color-medium); margin-top: 4px; }
    .track { flex: 1; height: 6px; border-radius: 3px; background: #e2e8f0; overflow: hidden; } .track i { display: block; height: 100%; background: #16a34a; transition: width .4s; }
    .turn { font-size: 15px; margin-top: 6px; } .turn b { font-size: 22px; color: var(--ion-color-primary); }
    .wait { margin-top: 4px; font-size: 13px; color: #b45309; }
    .step { margin: 8px 12px; border-radius: 14px; background: var(--ion-color-light); border: 2px solid transparent; }
    .step.now { border-color: var(--ion-color-primary); background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .step.locked { opacity: .6; }
    .head { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px; background: none; border: 0; text-align: left; font: inherit; color: inherit; }
    .dot { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; flex: none; font-weight: 700; background: #e2e8f0; color: #475569; }
    .step.done .dot { background: #16a34a; color: #fff; } .step.now .dot { background: var(--ion-color-primary); color: #fff; }
    .ht { flex: 1; display: flex; flex-direction: column; } .ht b { font-size: 16px; } .ht small { color: var(--ion-color-medium); font-size: 13px; margin-top: 2px; }
    .tag { font-size: 12px; font-weight: 700; color: #fff; background: var(--ion-color-primary); padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
    .tag.left { background: #f59e0b; color: #111; }
    .body { padding: 0 12px 12px; }
    .task { border-left: 4px solid #cbd5e1; padding: 8px 0 10px 12px; margin: 6px 0; }
    .task.ok { border-left-color: #16a34a; } .task.bad { border-left-color: #d97706; } .task.plain { border-left-color: transparent; padding-left: 0; }
    .q { font-size: 16px; font-weight: 500; line-height: 1.3; } .sub { font-size: 13px; color: var(--ion-color-medium); margin-top: 3px; }
    .yn { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
    .yn button { min-height: 46px; border-radius: 12px; border: 2px solid #cbd5e1; background: #fff; font: inherit; font-size: 17px; font-weight: 600; color: var(--ion-text-color); }
    .yn .yes.on { background: #16a34a; border-color: #16a34a; color: #fff; } .yn .no.on { background: #d97706; border-color: #d97706; color: #fff; }
    .timeset { display: flex; gap: 10px; margin-top: 8px; }
    .timeset .now { flex: 1; min-height: 46px; border-radius: 12px; border: 0; background: var(--ion-color-primary); color: #fff; font: inherit; font-weight: 600; font-size: 16px; }
    .timeset input { width: 130px; font-size: 18px; padding: 8px; border: 2px solid #cbd5e1; border-radius: 12px; background: #fff; }
    .timev { display: flex; align-items: baseline; gap: 12px; margin-top: 6px; } .timev b { font-size: 20px; }
    .link { background: none; border: 0; color: var(--ion-color-primary); font: inherit; font-weight: 600; padding: 0; }
    .field { display: block; margin: 10px 0; } .lbl { display: block; font-size: 14px; margin-bottom: 4px; }
    .item { font-size: 11px; font-weight: 700; color: var(--ion-color-primary); background: #e7f1ea; padding: 1px 6px; border-radius: 6px; margin-right: 4px; }
    .field input { width: 100%; font-size: 22px; padding: 10px 12px; border: 2px solid #cbd5e1; border-radius: 10px; background: #fff; }
    input:focus { outline: none; border-color: var(--ion-color-primary); }
    .warn { color: #b45309; font-size: 14px; margin: 6px 0; } .hint { color: var(--ion-color-medium); font-size: 13px; margin: 0 0 6px; }
    .hist { margin-top: 10px; font-size: 14px; } .hist div { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid #e5e7eb; }
    .hist b { min-width: 48px; } .foot { margin: 16px 16px 96px; }
    .empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 56px 32px; color: var(--ion-color-medium); }
    .empty ion-icon { font-size: 48px; color: var(--ion-color-primary); } .empty b { color: var(--ion-text-color); font-size: 17px; }
    .report { display: flex; align-items: center; gap: 8px; height: 54px; padding: 0 22px 0 18px; border: 0; border-radius: 27px; background: #ea580c;
      color: #fff; font: inherit; font-weight: 700; font-size: 16px; box-shadow: 0 4px 14px rgba(234,88,12,.4); transition: padding .2s, width .2s; }
    .report:active { background: #c2410c; transform: scale(.97); } .report ion-icon { font-size: 24px; }
    .report.compact { width: 54px; padding: 0; justify-content: center; }
  `,
})
export default class UnitPage {
  api = inject(Api);
  figs = inject(UnitFiguresService);
  cl = inject(Checklist);
  ci = inject(Checkin);
  lc = inject(LiveCount);
  private flow = inject(CheckinFlow);
  private outbox = inject(Outbox);
  private ui = inject(Ui);
  private router = inject(Router);
  t = inject(I18n).t;
  stages = DAY_STAGES;
  latest = this.figs.latest;
  draft: Record<string, number | null> = {};
  editing = signal<string | null>(null);
  private rev = signal(0);
  /** null: follow the current stage; 'none': all closed; otherwise the stage the agent opened */
  private opened = signal<DayStage | 'none' | null>(null);

  constructor() { if (this.api.isAgent()) void this.lc.open(); }

  /** The Report button shrinks to an icon while scrolling down, so it never covers what the agent is reading */
  compact = signal(false);
  onScroll(ev: CustomEvent) { this.compact.set((ev.detail as { scrollTop: number }).scrollTop > 120); }

  async report() {
    if (this.ci.required()) {
      if (!(await this.ui.confirm('Check in first', 'Check in at your polling unit before you start. It tells the situation room you are in place.', 'Check in now', 'Cancel'))) return;
      if (!(await this.flow.run())) return;
    }
    await this.router.navigateByUrl('/report');
  }

  day = inject(DayJourney);
  turnout = computed(() => { const l = this.latest(); return l.registered && l.accredited != null ? l.accredited / l.registered : null; });
  resultSent = this.day.resultSent;
  countDone = this.day.countDone;
  total = computed(() => { const c = this.lc.state(); return c ? Object.values(c.counts).reduce((a, b) => a + b, 0) + c.invalid : 0; });
  tasksOf(id: DayStage) { return this.day.tasksOf(id); }
  left(id: DayStage) { this.rev(); return this.day.left(id); }
  stageDone(id: DayStage) { return this.left(id) === 0; }
  doneStages = this.day.doneStages;
  progress = computed(() => this.doneStages() / DAY_STAGES.length);
  current = this.day.current;
  isBefore(id: DayStage) { const c = this.current(); return !!c && DAY_STAGES.findIndex((s) => s.id === id) < DAY_STAGES.findIndex((s) => s.id === c); }
  locked(id: DayStage) { return id !== 'arrival' && this.ci.required(); }
  isOpen(id: DayStage) { this.rev(); return (this.opened() ?? this.current()) === id; }
  toggle(id: DayStage) { this.opened.set(this.isOpen(id) ? 'none' : id); }

  // ---- arrival ----
  async checkIn() { if (await this.flow.run()) this.rev.update((x) => x + 1); }
  arrivedNote() { const a = this.cl.answers()['arrived']; return a === 'yes' ? 'Arrived by 7:30 am' : a === 'no' ? 'Arrived after 7:30 am' : ''; }

  // ---- questions ----
  answer(i: ChecklistItem) { return this.cl.answers()[i.code] ?? null; }
  async setAnswer(i: ChecklistItem, value: string) {
    if (!value) return;
    this.editing.set(null);
    await this.cl.answer(i.code, value);
    this.rev.update((x) => x + 1);
    if (value === 'no' && i.problem && await this.ui.confirm('Report this problem?', 'The situation room will be told straight away.', 'Report', 'Not now')) {
      await this.router.navigate(['/report'], { queryParams: { category: i.problem } });
    }
  }
  nowHHMM() { return new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false }); }
  clock12(hhmm: string) { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; }

  // ---- figures ----
  item(k: keyof UnitFigures) { return ITEM[k]; }
  fieldLabel(stage: Stage, k: keyof UnitFigures) { return k === 'accredited' && stage === 'close' ? 'Accredited voters (final)' : ITEM[k].label; }
  placeholder(k: keyof UnitFigures) { const v = this.latest()[k]; return v != null ? String(v) : ''; }
  setDraft(key: string, v: unknown) { this.draft[key] = v === '' || v === null ? null : Number(v); this.rev.update((x) => x + 1); }
  private key(stage: Stage, k: keyof UnitFigures) { return stage === 'accreditation' ? 'acc' : stage + k; }
  hasDraft(stage: Stage, fields: (keyof UnitFigures)[]) { this.rev(); return fields.some((k) => this.draft[this.key(stage, k)] != null); }
  figuresDone(stage: Stage) { return this.day.figuresDone(stage); }
  figuresSentAt(stage: Stage) {
    const last = [...this.figs.history()].reverse().find((u) => u.stage === stage);
    return last ? (this.figs.isPending(last) ? this.t('Saved on phone, will send when there is signal') : `${this.t('Sent')} ${this.time(last.reported_at)}`) : '';
  }
  private values(stage: Stage, fields: (keyof UnitFigures)[]): UnitFigures {
    const out: UnitFigures = {};
    for (const k of fields) { const v = this.draft[this.key(stage, k)]; if (v != null && Number.isFinite(v) && v >= 0) out[k] = Math.round(v); }
    return out;
  }
  draftWarnings(stage: Stage, fields: (keyof UnitFigures)[]) {
    this.rev();
    const values = this.values(stage, fields);
    if (!Object.keys(values).length) return [];
    return figureFlags({ ...this.latest(), ...values }, { final: stage === 'close' || this.figs.final(),
      previousAccredited: values.accredited != null ? this.latest().accredited ?? null : null });
  }
  async sendFigures(stage: Stage, fields: (keyof UnitFigures)[]) {
    const values = this.values(stage, fields);
    if (stage === 'close' && values.accredited == null) {
      if (this.latest().accredited == null) { await this.ui.alert('Final accredited needed', 'Enter the final number of accredited voters announced at the close of poll.'); return; }
      values.accredited = this.latest().accredited!; // the last figure counts as final
    }
    if (!Object.keys(values).length) return;
    const flags = this.draftWarnings(stage, fields);
    if (flags.length && !(await this.ui.confirm('Figures do not add up', `${flags.map((f) => f.message).join('. ')}. ${this.t('Send exactly as announced?')}`, 'Send', 'Check again'))) return;
    await this.figs.send(stage, values);
    for (const k of fields) this.draft[this.key(stage, k)] = null;
    this.rev.update((x) => x + 1);
    await this.ui.toast(this.outbox.online() ? 'Sent to the situation room' : 'Saved on phone. It will send when there is signal.');
  }
  accreditationLog() { return [...this.figs.accreditationUpdates()].reverse(); }

  // ---- summaries on the stage headers ----
  summary(id: DayStage): string {
    this.rev();
    const l = this.latest(), a = this.cl.answers();
    const n = this.tasksOf(id).filter((t) => this.day.taskDone(t) === true).length, all = this.tasksOf(id).filter((t) => this.day.taskDone(t) !== null).length;
    const parts: string[] = [];
    switch (id) {
      case 'arrival': if (this.ci.checkedIn()) parts.push(`${this.t('Checked in')} ${this.time(this.ci.state().arrival ?? this.ci.state().first!)}`); break;
      case 'setup': if (l.registered != null) parts.push(`${l.registered} ${this.t('on register')} · ${l.ballots_received ?? '?'} ${this.t('ballot papers')}`); break;
      case 'voting': if (a['start_time']) parts.push(`${this.t('started')} ${this.clock12(a['start_time'])}`);
        if (l.accredited != null) parts.push(`${l.accredited} ${this.t('accredited')}`); break;
      case 'close': if (a['voting_ended']) parts.push(`${this.t('ended')} ${this.clock12(a['voting_ended'])}`);
        if (this.figuresDone('close')) parts.push(`${l.unused} ${this.t('unused')} · ${l.spoiled} ${this.t('spoiled')}`); break;
      case 'counting': if (this.total()) parts.push(`${this.total()} ${this.t('ballots called')}`); break;
      case 'result': if (l.total_valid != null) parts.push(`${l.total_valid} ${this.t('valid')} · ${this.t('used')} ${usedBallots(l) ?? '?'}`); break;
    }
    if (!parts.length && !n) return '';
    if (n < all) parts.push(`${n}/${all}`);
    return parts.join(' · ');
  }

  pct(x: number) { return `${Math.round(x * 100)}%`; }
  time(iso: string) { return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }); }
}
