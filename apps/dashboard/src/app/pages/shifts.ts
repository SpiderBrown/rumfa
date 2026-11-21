import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { Ui, label } from '../core/ui';
import { kindOf } from '../core/queues';

interface Staff { id: string; full_name: string; role: string; area_code: string; status: string; open_cases: number; on_shift: boolean;
  next_shift_at: string | null; queues: string[]; languages: string[] }
interface Queue { id: string; name: string; kind: string; state_code: string | null; overflow_limit: number }
interface Shift { id: string; volunteer_id: string; queue_id: string; starts_at: string; ends_at: string; role: string; full_name: string; queue_name: string }

const HOUR = 3_600_000;
/** Midnight in Lagos for a day offset from today (the room runs on Lagos time) */
function lagosDay(offset: number): Date {
  const now = new Date(Date.now() + HOUR);                       // Lagos is UTC+1 all year
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset) - HOUR);
}
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Shifts and queues: who works which queue and when, as a day timeline. Shifts are optional (Settings → Shifts and
 * assigning): when off, each queue's people are everyone whose role fits it. Either way, people with no shift are
 * listed so nobody is forgotten.
 */
@Component({
  selector: 'app-shifts',
  imports: [DatePipe, FormsModule, RouterLink, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="eyebrow">Who is on which queue, and when</p>
        <h1>Shifts and queues</h1>
        <p class="lede">@if (useShifts()) { Cases are offered to people on shift for that queue. Nobody on shift? They wait for a supervisor or move up when time runs out. }
          @else { Shifts are off: everyone whose role fits works the queue. You can still plan shifts here; they count once shifts are on. }</p>
      </div>
      <button mat-flat-button (click)="openAdd()"><mat-icon>add</mat-icon> Add shift</button>
    </header>

    @if (!useShifts() || !autoAssign()) {
      <div class="note r-card">
        <mat-icon aria-hidden="true">info</mat-icon>
        <span>
          @if (!useShifts()) { <b>Shifts are off.</b> Security staff work the Security desk, Legal the Legal desk, operators the rooms and Helpdesk; supervisors and admins all of them. }
          @if (!autoAssign()) { <b>Automatic assigning is off.</b> Cases wait until a supervisor assigns them or someone presses Take next. }
        </span>
        @if (api.isAdmin()) { <a mat-button routerLink="/settings" fragment="staffing">Change in Settings</a> }
      </div>
    }

    <section class="stats" aria-label="Summary">
      <div class="stat r-card"><span class="s-l">On shift now</span><b>{{ onShiftNow().length }}</b><span class="s-h">of {{ staff().length }} room staff</span></div>
      <div class="stat r-card"><span class="s-l">Available now</span><b>{{ availableNow() }}</b><span class="s-h">taking cases at this moment</span></div>
      <button class="stat r-card r-focus" [class.warn]="noShift().length" (click)="showNoShift()">
        <span class="s-l">Not on any shift</span><b>{{ noShift().length }}</b><span class="s-h">no shift now or later · see who</span></button>
      <div class="stat r-card" [class.warn]="emptyQueues().length">
        <span class="s-l">Queues with nobody</span><b>{{ emptyQueues().length }}</b>
        <span class="s-h">{{ emptyQueues().length ? emptyQueues().join(', ') : 'every queue has someone now' }}</span></div>
    </section>

    @if (adding()) {
      <section class="r-card add" aria-label="Add a shift">
        <div class="a-head"><h2>Add a shift</h2><button mat-icon-button (click)="adding.set(false)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="form">
          <label><span>Person</span><select [(ngModel)]="n.volunteer">
            <option value="" disabled>Choose…</option>
            @for (s of staff(); track s.id) { <option [value]="s.id">{{ s.full_name }} · {{ label(s.role) }}</option> }</select></label>
          <label><span>Queue</span><select [(ngModel)]="n.queue">
            <option value="" disabled>Choose…</option>
            @for (q of queues(); track q.id) { <option [value]="q.id">{{ q.name }}</option> }</select></label>
          <label><span>As</span><select [(ngModel)]="n.role">
            <option value="operator">Operator</option><option value="supervisor">Supervisor</option><option value="overflow">Overflow (helps any busy queue)</option></select></label>
          <label><span>Day</span><select [(ngModel)]="n.day">
            @for (d of days; track d.offset) { <option [ngValue]="d.offset">{{ d.date | date: 'EEE d MMM' : '+0100' }}</option> }</select></label>
          <label><span>From</span><input type="time" [(ngModel)]="n.from" /></label>
          <label><span>To</span><input type="time" [(ngModel)]="n.to" /></label>
        </div>
        <div class="a-foot">
          <span class="muted sm">{{ addHint() }}</span>
          <button mat-flat-button (click)="addShift()" [disabled]="!n.volunteer || !n.queue">Add shift</button>
        </div>
      </section>
    }

    <section class="r-card tl" aria-label="Shifts by queue">
      <div class="tl-head">
        <h2>{{ dayDate() | date: 'EEEE d MMMM' : '+0100' }}</h2>
        <div class="r-seg" role="tablist" aria-label="Day">
          @for (d of days; track d.offset) {
            <button role="tab" [class.on]="day() === d.offset" [attr.aria-selected]="day() === d.offset" (click)="day.set(d.offset)">
              {{ d.offset === 0 ? 'Today' : (d.date | date: 'EEE d' : '+0100') }}@if (d.count) { <span class="cnt">{{ d.count }}</span> }</button>
          }
        </div>
      </div>
      <div class="lanes">
        @for (q of lanes(); track q.id) {
          <div class="lane">
            <div class="l-name"><span class="dot" [style.background]="q.colour"></span><b>{{ q.name }}</b>
              <span class="muted xs">{{ q.now ? q.now + ' on now' : (day() === 0 ? 'nobody on now' : '') }}</span></div>
            <div class="l-track">
              @if (day() === 0) { <span class="nowline" [style.left.%]="nowPct()" aria-hidden="true"></span> }
              @for (b of q.bars; track b.id) {
                <button class="bar r-focus" [style.left.%]="b.left" [style.width.%]="b.width" [style.top.px]="b.row * 26"
                  [style.--k]="q.colour" [style.--s]="q.soft" [class.now]="b.now" [matMenuTriggerFor]="m"
                  [matTooltip]="b.full_name + ' · ' + b.time + (b.role !== 'operator' ? ' · ' + label(b.role) : '')">
                  {{ short(b.full_name) }} · {{ b.time }}@if (b.role !== 'operator') { · {{ label(b.role) }} }</button>
                <mat-menu #m><button mat-menu-item (click)="remove(b)"><mat-icon>delete</mat-icon> Remove this shift</button></mat-menu>
              }
              @if (!q.bars.length) { <span class="empty muted xs">No shifts this day</span> }
              <span class="spacer" [style.height.px]="q.rows * 26"></span>
            </div>
          </div>
        }
        <div class="axis" aria-hidden="true"><span></span>
          <div class="ticks">@for (h of [0,3,6,9,12,15,18,21,24]; track h) { <span [style.left.%]="h / 24 * 100">{{ h }}:00</span> }</div></div>
      </div>
    </section>

    <div class="cols">
      <section class="r-card list" id="noshift" aria-label="Not on any shift">
        <div class="l-head"><h2>Not on any shift</h2><span class="muted sm">No shift now or later</span></div>
        @for (s of noShift(); track s.id) {
          <div class="prow">
            <span class="av">{{ s.full_name[0] }}</span>
            <div class="grow"><b>{{ s.full_name }}</b><div class="muted xs">{{ label(s.role) }} · {{ s.area_code }} · {{ label(s.status) }}
              @if (!useShifts() && s.queues.length) { · works {{ queueNames(s.queues) }} } </div></div>
            <button mat-stroked-button (click)="openAdd(s.id)"><mat-icon>add</mat-icon> Shift</button>
          </div>
        } @empty { <p class="calm"><mat-icon>verified</mat-icon> Everyone has a shift.</p> }
      </section>

      <section class="r-card list" aria-label="Queues">
        <div class="l-head"><h2>Queues</h2><span class="muted sm">Who works each one now</span></div>
        @for (q of queueRows(); track q.id) {
          <div class="qrow">
            <span class="dot" [style.background]="q.colour"></span>
            <div class="grow"><b>{{ q.name }}</b>
              <div class="muted xs">{{ q.people.length ? q.people.join(', ') : 'Nobody right now' }}</div></div>
            <label class="ovf" matTooltip="When more than this many cases wait, people on an Overflow shift help here">
              <span class="xs muted">Overflow after</span>
              <input type="number" min="1" [value]="q.overflow_limit" (change)="setOverflow(q.id, $any($event.target).value)" [attr.aria-label]="q.name + ': overflow after'" />
            </label>
          </div>
        }
      </section>
    </div>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); max-width: 760px; }
    h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; } .grow { flex: 1; min-width: 0; }
    .note { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #f3f7fb; font-size: 13.5px; }
    .note mat-icon { color: var(--r-medium); flex: none; }
    .note span { flex: 1; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .stat { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; text-align: left; font: inherit; color: var(--r-ink); }
    button.stat { cursor: pointer; } button.stat:hover { border-color: #9aa6b6; }
    .stat b { font-size: 26px; font-weight: 800; }
    .s-l { font-size: 13px; font-weight: 600; color: var(--r-ink-2); } .s-h { font-size: 12px; color: var(--r-muted); }
    .stat.warn { border-color: #f0c9a8; background: #fffaf5; } .stat.warn b { color: var(--r-high); }
    .add { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .a-head, .a-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--r-ink-2); }
    select, input[type=time], input[type=number] { border: 1px solid var(--r-line); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13.5px; background: #fff; color: var(--r-ink); }
    .tl { overflow: hidden; }
    .tl-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 18px; border-bottom: 1px solid var(--r-line-soft); }
    .cnt { margin-left: 5px; font-size: 11px; color: var(--r-muted); }
    .lanes { padding: 8px 18px 14px; }
    .lane { display: grid; grid-template-columns: 200px 1fr; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--r-line-soft); }
    .l-name { display: flex; flex-direction: column; gap: 2px; padding-left: 16px; position: relative; font-size: 14px; }
    .l-name .dot { position: absolute; left: 0; top: 6px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
    .l-track { position: relative; min-height: 26px; background: repeating-linear-gradient(90deg, transparent 0 calc(12.5% - 1px), var(--r-line-soft) calc(12.5% - 1px) 12.5%); }
    .spacer { display: block; }
    .bar { position: absolute; height: 22px; border: 0; border-left: 3px solid var(--k); background: var(--s); border-radius: 4px; padding: 0 8px; font: inherit;
      font-size: 12px; font-weight: 700; color: var(--r-ink); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .bar.now { box-shadow: 0 0 0 1px var(--k) inset; }
    .nowline { position: absolute; top: -6px; bottom: -6px; width: 2px; background: var(--r-urgent); z-index: 1; }
    .empty { position: absolute; left: 0; top: 4px; }
    .axis { display: grid; grid-template-columns: 200px 1fr; gap: 12px; padding-top: 8px; }
    .ticks { position: relative; height: 16px; font-size: 11.5px; color: var(--r-muted); }
    .ticks span { position: absolute; transform: translateX(-50%); }
    .ticks span:first-child { transform: none; } .ticks span:last-child { transform: translateX(-100%); }
    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; align-items: start; }
    .list { padding-bottom: 6px; }
    .l-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 18px 10px; border-bottom: 1px solid var(--r-line-soft); }
    .prow, .qrow { display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--r-line-soft); }
    .prow:last-child, .qrow:last-child { border-bottom: 0; }
    .av { width: 30px; height: 30px; border-radius: 50%; background: #1f4e8c; color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 700; flex: none; }
    .ovf { display: flex; align-items: center; gap: 6px; }
    .ovf input { width: 64px; padding: 6px 8px; }
    .calm { display: flex; align-items: center; gap: 8px; padding: 14px 18px; margin: 0; color: var(--r-accent-strong); }
    @media (max-width: 800px) { .lane, .axis { grid-template-columns: 1fr; } .axis > span { display: none; } }
  `,
})
export class ShiftsPage {
  api = inject(Api);
  private ui = inject(Ui);
  label = label;
  staff = signal<Staff[]>([]);
  queues = signal<Queue[]>([]);
  shifts = signal<Shift[]>([]);
  day = signal(0);
  adding = signal(false);
  n = { volunteer: '', queue: '', role: 'operator', day: 0, from: '06:00', to: '14:00' };
  readonly useShifts = computed(() => this.api.staffing().useShifts);
  readonly autoAssign = computed(() => this.api.staffing().autoAssign);
  private tick = signal(0);

  /** Today and the next six days, with how many shifts each has */
  get days() {
    return Array.from({ length: 7 }, (_, offset) => {
      const from = lagosDay(offset).getTime(), to = from + 24 * HOUR;
      return { offset, date: new Date(from), count: this.shifts().filter((s) => +new Date(s.starts_at) < to && +new Date(s.ends_at) > from).length };
    });
  }
  dayDate = computed(() => lagosDay(this.day()));

  onShiftNow = computed(() => this.staff().filter((s) => s.on_shift));
  availableNow = computed(() => this.staff().filter((s) => s.status === 'available' && (!this.useShifts() || s.on_shift)).length);
  /** Analysts don't work cases, so they need no shift */
  noShift = computed(() => this.staff().filter((s) => s.role !== 'analyst' && !s.on_shift && !s.next_shift_at));
  /** Queues nobody works right now */
  emptyQueues = computed(() => this.queueRows().filter((q) => !q.people.length).map((q) => q.name));

  queueRows = computed(() => {
    const staff = this.staff();
    return [...this.queues()].sort((a, b) => kindOf(a.kind).order - kindOf(b.kind).order || a.name.localeCompare(b.name)).map((q) => ({
      ...q, colour: kindOf(q.kind).colour,
      people: staff.filter((s) => s.queues.includes(q.id)).map((s) => s.full_name + (s.status === 'available' ? '' : ` (${label(s.status).toLowerCase()})`)),
    }));
  });

  /** One lane per queue, its shifts that day laid out in rows so they don't overlap */
  lanes = computed(() => {
    this.tick();
    const from = lagosDay(this.day()).getTime(), to = from + 24 * HOUR, now = Date.now();
    return this.queueRows().map((q) => {
      const rows: number[] = [];
      const bars = this.shifts().filter((s) => s.queue_id === q.id && +new Date(s.starts_at) < to && +new Date(s.ends_at) > from)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
        .map((s) => {
          const a = Math.max(+new Date(s.starts_at), from), b = Math.min(+new Date(s.ends_at), to);
          let row = rows.findIndex((end) => end <= a);
          if (row < 0) { row = rows.length; rows.push(b); } else rows[row] = b;
          return { ...s, row, left: (a - from) / (24 * HOUR) * 100, width: Math.max((b - a) / (24 * HOUR) * 100, 2),
            now: +new Date(s.starts_at) <= now && now < +new Date(s.ends_at), time: `${this.hm(s.starts_at)}–${this.hm(s.ends_at)}` };
        });
      return { ...q, soft: kindOf(q.kind).soft, bars, rows: Math.max(rows.length, 1), now: bars.filter((b) => b.now).length };
    });
  });
  nowPct = computed(() => { this.tick(); return (Date.now() - lagosDay(0).getTime()) / (24 * HOUR) * 100; });

  constructor() {
    void this.load();
    setInterval(() => this.tick.update((n) => n + 1), 60_000);
  }

  async load() {
    const [s, q, sh] = await Promise.all([
      this.api.get<Staff[]>('/people/room-staff').catch(() => []),
      this.api.get<Queue[]>('/queues').catch(() => []),
      this.api.get<Shift[]>('/shifts').catch(() => []),
    ]);
    this.staff.set(s); this.queues.set(q); this.shifts.set(sh);
  }

  hm(iso: string) { const d = new Date(+new Date(iso) + HOUR); return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`; }
  short(name: string) { const [a, b] = name.split(' '); return b ? `${a} ${b[0]}.` : a; }
  queueNames(ids: string[]) { return this.queues().filter((q) => ids.includes(q.id)).map((q) => q.name).join(', '); }
  showNoShift() { document.getElementById('noshift')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  openAdd(person?: string) {
    const s = person ? this.staff().find((x) => x.id === person) : undefined;
    const q = s ? s.queues[0] ?? this.fitting(s)?.id : '';
    this.n = { ...this.n, volunteer: person ?? '', queue: q ?? this.n.queue, day: this.day() };
    this.adding.set(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  /** The queue that suits someone's role and area (as when shifts are off) */
  private fitting(s: Staff) {
    const kind = s.role === 'security' ? 'security' : s.role === 'legal' ? 'legal' : 'state';
    const qs = this.queues().filter((q) => q.kind === kind);
    return qs.find((q) => q.state_code && (s.area_code === q.state_code || s.area_code.startsWith(q.state_code + '-'))) ?? qs[0]
      ?? this.queues().find((q) => q.kind === 'national');
  }
  /** The shift as times: an end before the start runs past midnight */
  private span() {
    const base = lagosDay(this.n.day).getTime();
    const at = (t: string) => { const [h, m] = t.split(':').map(Number); return base + (h * 60 + m) * 60_000; };
    const a = at(this.n.from); let b = at(this.n.to);
    if (b <= a) b += 24 * HOUR;
    return { a, b };
  }
  addHint() {
    if (!this.n.from || !this.n.to) return 'Choose the times';
    const { a, b } = this.span();
    const h = (b - a) / HOUR;
    return `${h % 1 ? h.toFixed(1) : h} hours${new Date(b + HOUR).getUTCDate() !== new Date(a + HOUR).getUTCDate() ? ', ending the next day' : ''} · Lagos time`;
  }
  async addShift() {
    if (!this.n.from || !this.n.to) { this.ui.error('Choose the times'); return; }
    const { a, b } = this.span();
    const ok = await this.ui.run(() => this.api.post('/shifts', { volunteerId: this.n.volunteer, queueId: this.n.queue, role: this.n.role,
      startsAt: new Date(a).toISOString(), endsAt: new Date(b).toISOString() }), 'Shift added');
    if (ok) { this.adding.set(false); this.day.set(this.n.day); await this.load(); }
  }
  async remove(s: Shift) {
    if (!await this.ui.confirm('Remove this shift?', `${s.full_name} on ${s.queue_name}, ${this.hm(s.starts_at)}–${this.hm(s.ends_at)}.`, 'Remove')) return;
    await this.ui.run(() => this.api.del(`/shifts/${s.id}`), 'Shift removed');
    await this.load();
  }
  async setOverflow(id: string, v: string) {
    await this.ui.run(() => this.api.patch(`/queues/${id}`, { overflowLimit: Number(v) }), 'Saved');
  }
}
