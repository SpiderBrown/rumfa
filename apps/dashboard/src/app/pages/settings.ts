import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

type Sev = 'critical' | 'high' | 'medium' | 'low';
type Kind = 'security' | 'legal' | 'state' | 'helpdesk' | 'national';
interface Timing { take: number; resolve: number; onMiss: 'up' | 'stay' }
interface Rules {
  cases: Record<Sev, Timing> & { reopenMin: number };
  routing: Record<string, { queue?: Kind; severity?: Sev }>;
  team: { silentMin: number; turnoutMin: number; snoozeMin: number };
  callbacks: { unitMin: number; otherMin: number; retryMin: number };
  alerts: { smsAfterMin: number };
  results: { estimateMinUnits: number; estimatePct: number };
}
interface Category { code: string; label: string; severity: Sev; queue: Kind }
interface CallSettings { phone: boolean; bridged: boolean; webrtc: boolean; inapp: boolean }
interface CheckinSettings { opens: string; anyDay: boolean }
/** Where the client's hierarchy ends: its seat's level and top room. Cases never move past it. */
interface Hierarchy { level: 'national' | 'state' | 'lga' | 'ward'; seat: string | null; topRoom: string | null }
interface AllSettings { calls: CallSettings; checkin: CheckinSettings; party: string | null; parties: string[]; rules: Rules; defaults: Rules; categories: Category[]; hierarchy: Hierarchy }
interface Change { at: string; by: string | null; changes: string[] }

const SEVS: Sev[] = ['critical', 'high', 'medium', 'low'];
const KINDS: { k: Kind; label: string }[] = [
  { k: 'security', label: 'Security' }, { k: 'legal', label: 'Legal' }, { k: 'state', label: 'State room' },
  { k: 'helpdesk', label: 'Helpdesk' }, { k: 'national', label: 'National room' }];
const SECTIONS = [
  { id: 'timings', icon: 'timer', text: 'Case timings' },
  { id: 'routing', icon: 'alt_route', text: 'Where reports go' },
  { id: 'team', icon: 'diversity_3', text: 'Field team' },
  { id: 'callbacks', icon: 'phone_callback', text: 'Callbacks and SMS' },
  { id: 'results', icon: 'bar_chart', text: 'Results' },
  { id: 'party', icon: 'flag', text: 'Our party' },
  { id: 'calls', icon: 'call', text: 'Calls in the app' },
];

/** How the organisation runs: case timings, routing, field-team thresholds, callbacks, results; party, check-in, calls. Admins only. */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, DatePipe, MatButtonModule, MatIconModule, MatSlideToggleModule],
  template: `
  <header class="head">
    <div>
      <p class="eyebrow">Admins only · every change is logged</p>
      <h1>Settings</h1>
      <p class="lede">How your room runs: how fast cases must move, where each report goes, when people in the field need a call.</p>
    </div>
    <button mat-stroked-button (click)="toggleLog()"><mat-icon>history</mat-icon> Change log</button>
  </header>

  @if (showLog()) {
    <section class="r-card log" aria-label="Change log">
      <h2>Recent changes</h2>
      @for (c of log(); track c.at) {
        <div class="logrow"><span class="when">{{ c.at | date: 'd MMM, HH:mm' }}</span><b>{{ c.by ?? 'Someone' }}</b>
          <span class="what">{{ c.changes.map(plain).join(' · ') }}</span></div>
      } @empty { <p class="muted">No changes to these rules yet. Rumfa's defaults are in use.</p> }
    </section>
  }

  @if (all(); as a) {
  @if (draft(); as r) {
  <div class="layout">
    <nav class="r-card toc" aria-label="Settings sections">
      @for (s of sections; track s.id) {
        <button type="button" class="r-focus" (click)="go(s.id)"><mat-icon aria-hidden="true">{{ s.icon }}</mat-icon>{{ s.text }}</button>
      }
    </nav>

    <div class="sections">
      <section class="r-card" id="timings">
        <div class="sh"><div><h2>Case timings</h2>
          <p class="hint">How long the person given a case has to take it, and how long until it must be resolved. Not taken in time: it goes to someone else on shift and supervisors are told.</p>
          <p class="hint top"><mat-icon aria-hidden="true">vertical_align_top</mat-icon> Your seat is at <b>{{ levelName(a.hierarchy.level) }}</b> level, so cases go no higher than <b>{{ a.hierarchy.topRoom ?? 'your room' }}</b>.</p></div>
          <button mat-button (click)="resetGroup('cases')">Use Rumfa defaults</button></div>
        <table class="grid">
          <thead><tr><th>Severity</th><th>Take it within</th><th>Resolve within</th><th>If not resolved in time</th></tr></thead>
          <tbody>
          @for (s of sevs; track s) {
            <tr>
              <td><span class="r-pill" [class]="s">{{ cap(s) }}</span></td>
              <td><label class="num"><input type="number" min="1" max="240" [attr.aria-label]="cap(s) + ': take within, minutes'"
                    [ngModel]="r.cases[s].take" (ngModelChange)="setCase(s, 'take', $event)" /><span>min</span></label></td>
              <td><label class="num"><input type="number" min="1" max="1440" [attr.aria-label]="cap(s) + ': resolve within, minutes'"
                    [ngModel]="r.cases[s].resolve" (ngModelChange)="setCase(s, 'resolve', $event)" /><span>min</span></label>
                  @if (r.cases[s].resolve < r.cases[s].take) { <div class="err">Shorter than the take time</div> }</td>
              <td><select [attr.aria-label]="cap(s) + ': if not resolved in time'" [ngModel]="r.cases[s].onMiss" (ngModelChange)="setCase(s, 'onMiss', $event)">
                    <option value="up">Move up to {{ a.hierarchy.topRoom ?? 'your top room' }}</option>
                    <option value="stay">Keep it where it is, alert supervisors</option></select></td>
            </tr>
          }
          </tbody>
        </table>
        <div class="rows">
          <div class="row"><div><b>Reopen a resolved case if a new report comes within</b>
            <p class="hint">Same problem at the same unit: the case reopens and goes back to whoever handled it. 0 means always open a new case.</p></div>
            <label class="num"><input type="number" min="0" max="1440" aria-label="Reopen window, minutes" [ngModel]="r.cases.reopenMin" (ngModelChange)="set('cases', 'reopenMin', $event)" /><span>min</span></label></div>
        </div>
      </section>

      <section class="r-card" id="routing">
        <div class="sh"><div><h2>Where reports go</h2>
          <p class="hint">Which team gets each kind of report, and how urgent it starts. The urgency sets its timings above. SOS always goes to Security as critical.</p></div>
          <button mat-button (click)="resetGroup('routing')">Use Rumfa defaults</button></div>
        <table class="grid">
          <thead><tr><th>Report</th><th>Goes to</th><th>Starts as</th><th></th></tr></thead>
          <tbody>
          @for (c of a.categories; track c.code) {
            <tr [class.changed]="!!r.routing[c.code]">
              <td><b>{{ c.label }}</b></td>
              <td><select [attr.aria-label]="c.label + ': goes to'" [ngModel]="r.routing[c.code]?.queue ?? c.queue" (ngModelChange)="route(c, 'queue', $event)">
                @for (k of kindsFor(a.hierarchy); track k.k) { <option [value]="k.k">{{ k.label }}{{ k.k === c.queue ? ' (default)' : '' }}</option> }</select></td>
              <td><select [attr.aria-label]="c.label + ': starts as'" [ngModel]="r.routing[c.code]?.severity ?? c.severity" (ngModelChange)="route(c, 'severity', $event)">
                @for (s of sevs; track s) { <option [value]="s">{{ cap(s) }}{{ s === c.severity ? ' (default)' : '' }}</option> }</select></td>
              <td class="end">@if (r.routing[c.code]) { <button mat-button (click)="unroute(c.code)">Default</button> }</td>
            </tr>
          }
          </tbody>
        </table>
      </section>

      <section class="r-card" id="team">
        <div class="sh"><div><h2>Field team</h2><p class="hint">When someone shows up on My field team as needing a call.</p></div>
          <button mat-button (click)="resetGroup('team')">Use Rumfa defaults</button></div>
        <div class="rows">
          <div class="row"><div><b>Silent after</b><p class="hint">No report, message or app activity for this long.</p></div>
            <label class="num"><input type="number" min="10" max="600" aria-label="Silent after, minutes" [ngModel]="r.team.silentMin" (ngModelChange)="set('team', 'silentMin', $event)" /><span>min</span></label></div>
          <div class="row"><div><b>No turnout update after</b><p class="hint">For agents checked in at their unit, between accreditation figures.</p></div>
            <label class="num"><input type="number" min="30" max="720" aria-label="No turnout update after, minutes" [ngModel]="r.team.turnoutMin" (ngModelChange)="set('team', 'turnoutMin', $event)" /><span>min</span></label></div>
          <div class="row"><div><b>Followed-up people come back after</b><p class="hint">Done on My field team hides them for this long; if the problem is still there, they come back.</p></div>
            <label class="num"><input type="number" min="10" max="480" aria-label="Followed-up people come back after, minutes" [ngModel]="r.team.snoozeMin" (ngModelChange)="set('team', 'snoozeMin', $event)" /><span>min</span></label></div>
          <div class="row"><div><b>Check-in opens on election day at</b><p class="hint">Lagos time; closes at midnight. INEC officials arrive about 7:30 am. Saved straight away.</p></div>
            <input class="time" type="time" aria-label="Check-in opens at" [ngModel]="a.checkin.opens" (change)="setCheckin({ opens: $any($event.target).value })" /></div>
          <div class="row"><div><b>Practice: allow check-in on any day</b><p class="hint">For training and mock drills. Turn it off before election day so early taps aren't taken as arrivals. Saved straight away.</p></div>
            <mat-slide-toggle aria-label="Allow check-in on any day" [checked]="a.checkin.anyDay" (change)="setCheckin({ anyDay: $event.checked })" /></div>
        </div>
      </section>

      <section class="r-card" id="callbacks">
        <div class="sh"><div><h2>Callbacks and SMS</h2><p class="hint">When someone in the field asks to be called.</p></div>
          <button mat-button (click)="resetGroup('callbacks'); resetGroup('alerts')">Use Rumfa defaults</button></div>
        <div class="rows">
          <div class="row"><div><b>Call back about a polling unit problem within</b><p class="hint">Then it goes to the next coordinator up, then the room.</p></div>
            <label class="num"><input type="number" min="1" max="120" aria-label="Polling unit callbacks, minutes" [ngModel]="r.callbacks.unitMin" (ngModelChange)="set('callbacks', 'unitMin', $event)" /><span>min</span></label></div>
          <div class="row"><div><b>Call back about anything else within</b></div>
            <label class="num"><input type="number" min="1" max="120" aria-label="Other callbacks, minutes" [ngModel]="r.callbacks.otherMin" (ngModelChange)="set('callbacks', 'otherMin', $event)" /><span>min</span></label></div>
          <div class="row"><div><b>Try again after a missed call</b><p class="hint">The person gets an SMS saying when. After two missed calls the request closes.</p></div>
            <label class="num"><input type="number" min="1" max="120" aria-label="Retry after, minutes" [ngModel]="r.callbacks.retryMin" (ngModelChange)="set('callbacks', 'retryMin', $event)" /><span>min</span></label></div>
          <div class="row"><div><b>Also send announcements by SMS when the app hasn't been seen for</b></div>
            <label class="num"><input type="number" min="5" max="240" aria-label="SMS after, minutes" [ngModel]="r.alerts.smsAfterMin" (ngModelChange)="set('alerts', 'smsAfterMin', $event)" /><span>min</span></label></div>
        </div>
      </section>

      <section class="r-card" id="results">
        <div class="sh"><div><h2>Results</h2><p class="hint">The vote estimate on Election day appears only once enough units are in, so a handful of early units can't mislead.</p></div>
          <button mat-button (click)="resetGroup('results')">Use Rumfa defaults</button></div>
        <div class="rows">
          <div class="row"><div><b>Units needed before showing an estimate</b></div>
            <label class="num"><input type="number" min="1" max="1000" aria-label="Units needed" [ngModel]="r.results.estimateMinUnits" (ngModelChange)="set('results', 'estimateMinUnits', $event)" /><span>units</span></label></div>
          <div class="row"><div><b>And at least this share of the area's units</b><p class="hint">Whichever is more.</p></div>
            <label class="num"><input type="number" min="0" max="50" aria-label="Share of units, percent" [ngModel]="r.results.estimatePct" (ngModelChange)="set('results', 'estimatePct', $event)" /><span>%</span></label></div>
        </div>
      </section>

      <section class="r-card" id="party">
        <div class="sh"><div><h2>Our party</h2><p class="hint">Your party's button comes first and largest on the agents' live count. The others follow in ballot order. Saved straight away.</p></div></div>
        <div class="rows"><div class="row"><b>Party</b>
          <select aria-label="Our party" [ngModel]="a.party" (ngModelChange)="setParty($event)">
            <option [ngValue]="null">None (ballot order only)</option>
            @for (p of a.parties; track p) { <option [ngValue]="p">{{ p }}</option> }
          </select></div></div>
      </section>

      <section class="r-card" id="calls">
        <div class="sh"><div><h2>Calls in the agent app</h2><p class="hint">How people in the field call each other from a chat. Room staff always have phone calling here. Saved straight away.</p></div></div>
        @if (calls(); as c) {
          <div class="rows">
            <div class="row"><div><b>App call (free)</b><p class="hint">Over the internet between the Rumfa apps, including this dashboard. Both people need data. Needs LiveKit set up.</p></div>
              <mat-slide-toggle aria-label="App call" [checked]="c.inapp" (change)="setCall('inapp', $event.checked)" /></div>
            <div class="row"><div><b>Rumfa call</b><p class="hint">Rumfa rings the caller, then connects the other person. You pay the minutes; nobody sees the other's number.</p></div>
              <mat-slide-toggle aria-label="Rumfa call" [checked]="c.bridged" (change)="setCall('bridged', $event.checked)" /></div>
            <div class="row"><div><b>Internet call</b><p class="hint">The caller uses data; the other person gets a normal call. Cheaper, but breaks up on weak data.</p></div>
              <mat-slide-toggle aria-label="Internet call" [checked]="c.webrtc" (change)="setCall('webrtc', $event.checked)" /></div>
            <div class="row"><div><b>Phone call</b><p class="hint">The phone's own dialler. Works on the weakest signal; uses the caller's airtime and shows the number.</p></div>
              <mat-slide-toggle aria-label="Phone call" [checked]="c.phone" (change)="setCall('phone', $event.checked)" /></div>
          </div>
          @if (!c.phone && !c.bridged && !c.webrtc && !c.inapp) { <p class="warn">All calling is off: the call button is hidden in the agent app.</p> }
        }
      </section>
    </div>
  </div>

  @if (dirty()) {
    <div class="savebar" role="region" aria-label="Unsaved changes">
      <mat-icon aria-hidden="true">edit_note</mat-icon>
      <span>{{ problems().length ? problems()[0] : 'You have unsaved changes to the rules.' }}</span>
      <span class="grow"></span>
      <button mat-button (click)="discard()">Discard</button>
      <button mat-flat-button (click)="save()" [disabled]="saving() || problems().length > 0">Save changes</button>
    </div>
  }
  }
  }`,
  styles: `
    :host { display: block; padding-bottom: 80px; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); max-width: 720px; }
    h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .hint { margin: 2px 0 0; font-size: 12.5px; color: var(--r-muted); max-width: 620px; }
    .hint.top { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--r-ink-2); }
    .hint.top mat-icon { font-size: 18px; width: 18px; height: 18px; color: var(--r-accent); }
    .muted { color: var(--r-muted); }
    .layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 20px; align-items: start; }
    .toc { position: sticky; top: 16px; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
    .toc button { display: flex; align-items: center; gap: 10px; border: 0; background: none; padding: 8px 10px; border-radius: 8px; font: inherit; font-size: 13.5px; color: var(--r-ink-2); cursor: pointer; text-align: left; }
    .toc button:hover { background: var(--r-ground); color: var(--r-ink); }
    .toc mat-icon { font-size: 20px; width: 20px; height: 20px; color: var(--r-muted); }
    .sections { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    section { scroll-margin-top: 16px; overflow: hidden; }
    .sh { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 16px 18px 12px; border-bottom: 1px solid var(--r-line-soft); }
    .grid { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    .grid th { text-align: left; font-size: 12px; font-weight: 600; color: var(--r-muted); padding: 10px 18px; background: #fafbfc; border-bottom: 1px solid var(--r-line); }
    .grid td { padding: 9px 18px; border-bottom: 1px solid var(--r-line-soft); vertical-align: middle; }
    .grid tr:last-child td { border-bottom: 0; }
    .grid tr.changed td:first-child { box-shadow: inset 3px 0 0 var(--r-accent); }
    .grid .end { text-align: right; }
    .rows { padding: 0 18px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 13px 0; border-bottom: 1px solid var(--r-line-soft); }
    .rows .row:last-child { border-bottom: 0; }
    .num { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--r-line); border-radius: 9px; padding: 0 10px 0 0; background: #fff; flex: none; }
    .num:focus-within, select:focus, .time:focus { outline: 2px solid var(--r-accent); outline-offset: 1px; }
    .num input { width: 64px; border: 0; padding: 8px 4px 8px 11px; font: inherit; font-size: 14px; background: none; outline: none; }
    .num span { font-size: 12px; color: var(--r-muted); }
    select, .time { border: 1px solid var(--r-line); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13.5px; background: #fff; color: var(--r-ink); min-width: 170px; }
    .time { min-width: 0; }
    .err { color: var(--r-urgent); font-size: 12px; margin-top: 4px; font-weight: 600; }
    .warn { color: var(--r-urgent); padding: 0 18px 14px; }
    .log { padding: 16px 18px; margin-bottom: 18px; }
    .logrow { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--r-line-soft); font-size: 13px; }
    .logrow:last-child { border-bottom: 0; }
    .logrow .when { color: var(--r-muted); width: 110px; flex: none; }
    .logrow b { width: 160px; flex: none; }
    .savebar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 20px; z-index: 20; display: flex; align-items: center; gap: 10px;
      width: min(760px, calc(100vw - 340px)); background: var(--r-nav); color: #fff; padding: 10px 12px 10px 16px; border-radius: 12px; box-shadow: 0 12px 30px rgba(0,0,0,.25); }
    .savebar .grow { flex: 1; }
    .savebar button[mat-button] { color: #fff; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .toc { display: none; } .savebar { width: calc(100vw - 32px); } }
  `,
})
export class SettingsPage {
  private api = inject(Api);
  private ui = inject(Ui);
  readonly sevs = SEVS;
  readonly kinds = KINDS;
  readonly sections = SECTIONS;
  all = signal<AllSettings | null>(null);
  calls = signal<CallSettings | null>(null);
  draft = signal<Rules | null>(null);
  saving = signal(false);
  showLog = signal(false);
  log = signal<Change[]>([]);

  dirty = computed(() => { const a = this.all(), d = this.draft(); return !!a && !!d && JSON.stringify(a.rules) !== JSON.stringify(d); });
  problems = computed(() => {
    const d = this.draft(); if (!d) return [];
    const out: string[] = [];
    for (const s of SEVS) {
      const t = d.cases[s];
      if (!Number.isInteger(t.take) || !Number.isInteger(t.resolve)) out.push(`${this.cap(s)}: enter whole minutes`);
      else if (t.resolve < t.take) out.push(`${this.cap(s)}: resolve time can't be shorter than take time`);
    }
    return out;
  });

  constructor() { void this.load(); }

  async load() {
    try {
      const a = await this.api.get<AllSettings>('/settings');
      this.all.set(a); this.calls.set(a.calls); this.draft.set(structuredClone(a.rules));
    } catch (e) { this.ui.error(e); }
  }

  cap(s: string) { return s[0].toUpperCase() + s.slice(1); }
  levelName(l: string) { return ({ national: 'national', state: 'state', lga: 'LGA', ward: 'ward' } as Record<string, string>)[l] ?? l; }
  /** Teams a report can go to: no national room below a national seat ("State room" is the client's own room) */
  kindsFor(h: Hierarchy) { return KINDS.filter((k) => k.k !== 'national' || h.level === 'national'); }
  go(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  /** "cases.high.take: 5 → 4" in words */
  plain = (c: string) => {
    const words: Record<string, string> = {
      take: 'take within', resolve: 'resolve within', onMiss: 'if not resolved', reopenMin: 'reopen window', queue: 'goes to', severity: 'starts as',
      silentMin: 'silent after', turnoutMin: 'no turnout after', snoozeMin: 'come back after', unitMin: 'unit callbacks', otherMin: 'other callbacks',
      retryMin: 'retry after', smsAfterMin: 'SMS after', estimateMinUnits: 'units for estimate', estimatePct: 'share for estimate',
      national: 'move up', up: 'move up', stay: 'keep and alert', default: 'default',
    };
    const label = (this.all()?.categories ?? []).reduce((m, x) => ({ ...m, [x.code]: x.label }), {} as Record<string, string>);
    const [path, val] = c.split(': ');
    const parts = path.split('.').filter((p) => !['cases', 'routing', 'team', 'callbacks', 'alerts', 'results'].includes(p));
    const v = (val ?? '').split(' → ').map((x) => words[x] ?? x).join(' → ');
    return `${parts.map((p) => label[p] ?? words[p] ?? this.cap(p)).join(', ')}: ${v}`;
  };

  private edit(fn: (r: Rules) => void) { this.draft.update((r) => { if (!r) return r; const n = structuredClone(r); fn(n); return n; }); }
  setCase(s: Sev, k: keyof Timing, v: any) { this.edit((r) => { (r.cases[s] as any)[k] = k === 'onMiss' ? v : Number(v); }); }
  set(group: 'cases' | 'team' | 'callbacks' | 'alerts' | 'results', k: string, v: any) { this.edit((r) => { (r[group] as any)[k] = Number(v); }); }
  route(c: Category, k: 'queue' | 'severity', v: any) {
    this.edit((r) => {
      const o = { ...(r.routing[c.code] ?? {}), [k]: v };
      if (o.queue === c.queue) delete o.queue;
      if (o.severity === c.severity) delete o.severity;
      if (o.queue || o.severity) r.routing[c.code] = o; else delete r.routing[c.code];
    });
  }
  unroute(code: string) { this.edit((r) => { delete r.routing[code]; }); }
  resetGroup(g: keyof Rules) { const d = this.all()?.defaults; if (d) this.edit((r) => { (r as any)[g] = structuredClone(d[g]); }); }
  discard() { const a = this.all(); if (a) this.draft.set(structuredClone(a.rules)); }

  async save() {
    const d = this.draft(); if (!d) return;
    this.saving.set(true);
    const r = await this.ui.run(() => this.api.put<Rules>('/settings/rules', d), 'Saved. New cases and timers follow the new rules straight away.');
    this.saving.set(false);
    if (r) { this.all.update((a) => a && { ...a, rules: r }); this.draft.set(structuredClone(r)); if (this.showLog()) void this.loadLog(); }
  }

  async toggleLog() { this.showLog.update((v) => !v); if (this.showLog()) await this.loadLog(); }
  async loadLog() { try { this.log.set(await this.api.get<Change[]>('/settings/rules/history')); } catch (e) { this.ui.error(e); } }

  async setCall(k: keyof CallSettings, on: boolean) {
    const r = await this.ui.run(() => this.api.patch<CallSettings>('/settings/calls', { [k]: on }), 'Saved. Agents see it next time the app refreshes.');
    if (r) this.calls.set(r); else await this.load();
  }

  async setParty(party: string | null) {
    const r = await this.ui.run(() => this.api.patch('/settings/party', { party }), 'Saved. Agents see it next time the app refreshes.');
    if (r) this.all.update((a) => a && { ...a, party });
  }

  async setCheckin(d: Partial<CheckinSettings>) {
    if (d.opens === '') return;
    const r = await this.ui.run(() => this.api.patch<CheckinSettings>('/settings/checkin', d), 'Saved.');
    if (r) this.all.update((a) => a && { ...a, checkin: r });
  }
}
