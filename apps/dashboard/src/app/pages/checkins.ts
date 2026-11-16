import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { Ui, AgoPipe } from '../core/ui';

interface Agg { agents: number; checkedIn: number; onTime: number; late: number; notYet: number; outside: number; units: number; unitsCovered: number }
interface Child extends Agg { code: string; name: string }
interface Person { id: string; name: string; phone: string; pu: string; unit: string; invited: boolean; first: string | null; arrival: string | null;
  count: number; onTime: boolean; outside: boolean; lastOutside: boolean; distance: number | null; against: string | null; note: string | null; unverified: boolean }
interface Summary extends Agg {
  area: string; onTimeBy: string; window: { opensAt: string; closesAt: string; anyDay: boolean; open: boolean };
  childLevel: 'state' | 'lga' | 'ward' | 'pu' | null; children: Child[]; people: Person[]; peopleTruncated: boolean; breadcrumb: { code: string; name: string }[];
}
type Filter = 'notyet' | 'late' | 'outside' | 'all';
const LEVEL_NAME: Record<string, string> = { state: 'State', lga: 'LGA', ward: 'Ward', pu: 'Polling unit' };

/**
 * Check-ins: which polling-unit agents are in place, for any area. The room uses it on election morning to find
 * uncovered units early (and call those agents or send a reserve) while there is still time to act.
 */
@Component({
  selector: 'app-checkins',
  imports: [DecimalPipe, MatButtonModule, MatButtonToggleModule, MatIconModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="head">
    <h1>Check-ins</h1>
    <nav class="crumbs">
      @for (b of s()?.breadcrumb ?? []; track b.code; let last = $last) {
        @if (last) { <b>{{ b.name }}</b> } @else { <a (click)="open(b.code)">{{ b.name }}</a><mat-icon>chevron_right</mat-icon> }
      }
    </nav>
    <span class="spacer"></span>
    @if (s(); as d) { <span class="win" [class.on]="d.window.open">{{ windowText(d) }}</span> }
  </div>

  @if (s(); as d) {
    <section class="kpis">
      <div class="main"><b>{{ d.checkedIn | number }} <small>/ {{ d.agents | number }}</small></b><span>agents checked in</span>
        <span class="track"><span class="fill" [style.width.%]="share(d.checkedIn, d.agents) * 100"></span></span></div>
      <div class="bad"><b>{{ d.notYet | number }}</b><span>not checked in yet</span></div>
      <div><b>{{ d.onTime | number }}</b><span>on time (by {{ time12(d.onTimeBy) }})</span></div>
      <div class="warn"><b>{{ d.late | number }}</b><span>checked in late</span></div>
      <div class="warn"><b>{{ d.outside | number }}</b><span>checked in outside their area</span></div>
      <div><b>{{ d.unitsCovered | number }} <small>/ {{ d.units | number }}</small></b><span>units with an agent in place</span></div>
    </section>

    <div class="cols" [class.two]="d.childLevel && d.children.length">
      @if (d.childLevel && d.children.length) {
        <table class="areas">
          <thead><tr><th>{{ level(d.childLevel) }}</th><th>Checked in</th><th class="n">Not yet</th><th class="n">Late</th><th class="n">Outside</th></tr></thead>
          <tbody>
            @for (c of rows(); track c.code) {
              <tr [class.click]="d.childLevel !== 'pu'" (click)="d.childLevel !== 'pu' && open(c.code)">
                <td>{{ c.name }} <span class="code">{{ c.code }}</span></td>
                <td><span class="mini"><span class="bar"><i [style.width.%]="share(c.checkedIn, c.agents) * 100"></i></span>
                  {{ c.checkedIn }}/{{ c.agents }}</span></td>
                <td class="n" [class.bad]="c.notYet">{{ c.notYet || '' }}</td>
                <td class="n" [class.warn]="c.late">{{ c.late || '' }}</td>
                <td class="n" [class.warn]="c.outside">{{ c.outside || '' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }

      <section class="people">
        <div class="ph">
          <h2>Agents</h2>
          <mat-button-toggle-group [value]="filter()" (change)="filter.set($event.value)" hideSingleSelectionIndicator>
            <mat-button-toggle value="notyet">Not yet ({{ d.notYet }})</mat-button-toggle>
            <mat-button-toggle value="late">Late ({{ d.late }})</mat-button-toggle>
            <mat-button-toggle value="outside">Outside ({{ d.outside }})</mat-button-toggle>
            <mat-button-toggle value="all">All</mat-button-toggle>
          </mat-button-toggle-group>
        </div>
        @for (p of shown(); track p.id) {
          <div class="person">
            <mat-icon class="st" [class]="status(p)">{{ icon(p) }}</mat-icon>
            <div class="who">
              <b>{{ p.name }}</b> @if (p.invited) { <span class="tag" matTooltip="Has not activated the app yet">not activated</span> }
              <div class="sub">{{ p.unit }} <span class="code">{{ p.pu }}</span></div>
              @if (p.note) { <div class="note">“{{ p.note }}”</div> }
            </div>
            <div class="when">
              @if (p.first) {
                {{ clock(p.arrival ?? p.first) }} <span class="sub">({{ (p.arrival ?? p.first) | ago }})</span>
                @if (p.outside) { <div class="sub warn">outside their {{ placeName(p.against) }}@if (p.distance != null) { , {{ km(p.distance) }} away }</div> }
                @else if (p.unverified) { <div class="sub" matTooltip="No location from the phone, or no outline for this area">location not checked</div> }
                @if (p.count > 1) { <div class="sub">checked in {{ p.count }} times</div> }
              } @else { <span class="sub bad">not yet</span> }
            </div>
            <button mat-icon-button matTooltip="Call {{ p.name }}" (click)="call(p)"><mat-icon>call</mat-icon></button>
          </div>
        } @empty { <p class="none">{{ emptyText() }}</p> }
        @if (d.peopleTruncated) { <p class="sub">Showing the first {{ d.people.length }} who need attention. Open a smaller area to see everyone.</p> }
      </section>
    </div>
  } @else { <p>Loading…</p> }`,
  styles: `
    .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    h1 { font: var(--mat-sys-headline-small); margin: 0; } h2 { font: var(--mat-sys-title-medium); margin: 0; }
    .crumbs { display: flex; align-items: center; flex-wrap: wrap; } .crumbs a { cursor: pointer; color: var(--mat-sys-primary); }
    .crumbs mat-icon { font-size: 18px; height: 18px; width: 18px; color: var(--mat-sys-outline); }
    .spacer { flex: 1; }
    .win { font-size: 13px; padding: 3px 10px; border-radius: 12px; background: var(--mat-sys-surface-container-high); }
    .win.on { background: #dcfce7; color: #14532d; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .kpis div { background: var(--mat-sys-surface-container); border-radius: 12px; padding: 10px 12px; }
    .kpis b { display: block; font: var(--mat-sys-headline-small); } .kpis small { font-size: 15px; color: var(--mat-sys-on-surface-variant); }
    .kpis span { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .kpis .bad b { color: #b3261e; } .kpis .warn b { color: #b45309; }
    .track { display: block; height: 6px; margin-top: 6px; background: var(--mat-sys-surface-container-high); border-radius: 3px; overflow: hidden; }
    .fill { display: block; height: 100%; background: #16a34a; transition: width .6s; }
    /* Two columns only when there is a sub-area table; otherwise the agents list uses the full width */
    .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; margin-top: 16px; align-items: start; }
    @media (min-width: 1100px) { .cols.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
    .note { font-size: 13px; font-style: italic; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-weight: 500; color: var(--mat-sys-on-surface-variant); border-bottom: 1px solid var(--mat-sys-outline-variant); padding: 6px; }
    td { padding: 6px; border-bottom: 1px solid var(--mat-sys-outline-variant); } .n { text-align: right; width: 64px; }
    td.bad { color: #b3261e; font-weight: 600; } td.warn { color: #b45309; font-weight: 600; }
    tr.click { cursor: pointer; } tr.click:hover { background: var(--mat-sys-surface-container); }
    .code { font-size: 11px; color: var(--mat-sys-outline); margin-left: 4px; }
    .mini { display: flex; align-items: center; gap: 8px; } .bar { width: 90px; height: 8px; border-radius: 4px; background: var(--mat-sys-surface-container-high); overflow: hidden; }
    .bar i { display: block; height: 100%; background: #16a34a; }
    .ph { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
    .person { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .st { flex: none; } .st.ok { color: #16a34a; } .st.late, .st.far { color: #d97706; } .st.notyet { color: #b3261e; }
    .who { flex: 1; min-width: 0; } .when { text-align: right; font-size: 14px; }
    .sub { font-size: 12px; color: var(--mat-sys-on-surface-variant); } .sub.warn { color: #b45309; } .sub.bad { color: #b3261e; font-weight: 600; }
    .tag { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--mat-sys-surface-container-high); margin-left: 4px; }
    .none { color: var(--mat-sys-on-surface-variant); }
  `,
})
export class CheckinsPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  private calls = inject(Calls);
  s = signal<Summary | null>(null);
  filter = signal<Filter>('notyet');
  private area: string | null = null;
  private timer = setInterval(() => void this.load(), 30_000);
  private stopLive = this.api.onChange(() => this.soon(), ['checkins']);
  private pending: ReturnType<typeof setTimeout> | null = null;

  rows = computed(() => [...(this.s()?.children ?? [])].sort((a, b) => b.notYet - a.notYet || a.name.localeCompare(b.name)));
  shown = computed(() => {
    const ps = this.s()?.people ?? [];
    switch (this.filter()) {
      case 'notyet': return ps.filter((p) => !p.first);
      case 'late': return ps.filter((p) => p.first && !p.onTime);
      case 'outside': return ps.filter((p) => p.outside);
      default: return ps;
    }
  });

  constructor() { void this.load(); }
  ngOnDestroy() { clearInterval(this.timer); this.stopLive(); if (this.pending) clearTimeout(this.pending); }

  /** Many agents check in within minutes of each other: reload at most every 3 seconds. */
  private soon() { if (!this.pending) this.pending = setTimeout(() => { this.pending = null; void this.load(); }, 3000); }

  async load() {
    try {
      const d = await this.api.get<Summary>('/checkins/summary', { area: this.area ?? undefined });
      this.s.set(d);
      this.area = d.area;
    } catch (e) { this.ui.error(e); clearInterval(this.timer); }
  }

  open(code: string) { this.area = code; void this.load(); }
  level(l: string) { return LEVEL_NAME[l] ?? l; }
  share(n: number, of: number) { return of ? n / of : 0; }
  call(p: Person) { void this.calls.call('volunteer', p.id, p.name); }

  status(p: Person) { return !p.first ? 'notyet' : p.outside ? 'far' : !p.onTime ? 'late' : 'ok'; }
  icon(p: Person) { return ({ notyet: 'person_off', far: 'wrong_location', late: 'schedule', ok: 'check_circle' } as const)[this.status(p)]; }
  emptyText() {
    return ({ notyet: 'Every agent here has checked in.', late: 'No late check-ins.', outside: 'No check-ins outside their area.', all: 'No agents in this area.' } as const)[this.filter()];
  }

  windowText(d: Summary) {
    if (d.window.anyDay) return 'Practice mode: check-in open any day';
    if (d.window.open) return 'Check-in open now';
    return Date.now() < Date.parse(d.window.opensAt) ? `Check-in opens ${dayTime(d.window.opensAt)}` : 'Check-in closed';
  }
  clock(iso: string) { return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', hour12: true }); }
  time12(hhmm: string) { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; }
  placeName(a: string | null) { return ({ ward: 'ward', unit: 'polling unit area', lga: 'LGA', state: 'state' } as Record<string, string>)[a ?? ''] ?? 'area'; }
  km(m: number) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`; }
}

const dayTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
