import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { AgoPipe, SEVERITY_COLOR, Ui } from '../core/ui';

interface Agg { unitsReporting: number; unitsWithTurnout: number; unitsClosed: number; registered: number; accredited: number;
  turnout: number | null; baselineTurnout: number | null; baselineUnits: number; flags: number; lastAt: string | null }
interface Child extends Agg { code: string; name: string }
interface Summary extends Agg { area: string; unitsWithAgent: number; childLevel: string | null; children: Child[]; breadcrumb: { code: string; name: string }[] }
interface Update { id: string; pu_code: string; unit: string; agent: string; stage: string; figures: Record<string, number>; created_at: string; registered: number | null }
interface Flag { id: string; rule: string; label: string; severity: string; pu_code: string; unit: string | null; details: any; created_at: string; case_id: string | null; case_status: string | null }

const LEVEL: Record<string, string> = { state: 'State', lga: 'LGA', ward: 'Ward', pu: 'Polling unit' };
const STAGE: Record<string, string> = { setup: 'Setup', accreditation: 'Accreditation', close: 'Close of poll', result: 'Result sheet' };
const FIELD: Record<string, string> = { registered: 'register', accredited: 'accredited', ballots_received: 'ballot papers issued', unused: 'unused',
  spoiled: 'spoiled', rejected: 'rejected', total_valid: 'valid votes', used: 'used (announced)' };

/**
 * Polling day: the EC8A summary figures agents send stage by stage (register, accreditation through the day,
 * close of poll, result), summed for any area with turnout against last election, and a live feed of the
 * figures and of the flags they raise. Flags also open cases on the desk that handles them.
 */
@Component({
  selector: 'app-polling-day',
  imports: [DecimalPipe, RouterLink, MatButtonToggleModule, MatIconModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="head">
    <h1>Polling day</h1>
    <nav class="crumbs">
      @for (b of s()?.breadcrumb ?? []; track b.code; let last = $last) {
        @if (last) { <b>{{ b.name }}</b> } @else { <a (click)="open(b.code)">{{ b.name }}</a><mat-icon>chevron_right</mat-icon> }
      }
    </nav>
    <span class="spacer"></span>
    @if (s()?.lastAt) { <span class="upd"><span class="dot"></span>Last figure {{ s()!.lastAt | ago }}</span> }
  </div>

  @if (s(); as d) {
    <section class="kpis">
      <div><b>{{ d.unitsReporting }} <small>/ {{ d.unitsWithAgent }}</small></b><span>units sending figures</span></div>
      <div><b>{{ d.registered | number }}</b><span>on the register (units with figures)</span></div>
      <div><b>{{ d.accredited | number }}</b><span>accredited so far</span></div>
      <div class="main"><b>{{ pct(d.turnout) }}</b><span>turnout
        @if (d.baselineTurnout !== null) { · <span [class]="cmpClass(d)">2023: {{ pct(d.baselineTurnout) }}</span> at {{ d.baselineUnits }} of these units }</span>
        <span class="bar"><i [style.width.%]="(d.turnout ?? 0) * 100"></i>@if (d.baselineTurnout !== null) { <em [style.left.%]="d.baselineTurnout * 100"></em> }</span></div>
      <div><b>{{ d.unitsClosed }}</b><span>units closed (final accreditation)</span></div>
      <div [class.bad]="d.flags"><b>{{ d.flags }}</b><span>open flags</span></div>
    </section>

    <div class="cols" [class.two]="d.childLevel && d.children.length">
      @if (d.childLevel && d.children.length) {
        <table>
          <thead><tr><th>{{ level(d.childLevel) }}</th><th class="n">Units</th><th>Turnout <span class="sub">(vs 2023)</span></th><th class="n">Accredited</th><th class="n">Flags</th></tr></thead>
          <tbody>
            @for (c of rows(); track c.code) {
              <tr [class.click]="d.childLevel !== 'pu'" (click)="d.childLevel !== 'pu' && open(c.code)">
                <td>{{ c.name }} <span class="code">{{ c.code }}</span></td>
                <td class="n">{{ c.unitsReporting }}</td>
                <td><span class="mini"><span class="bar"><i [style.width.%]="(c.turnout ?? 0) * 100"></i>
                  @if (c.baselineTurnout !== null) { <em [style.left.%]="c.baselineTurnout * 100" [matTooltip]="'2023: ' + pct(c.baselineTurnout)"></em> }</span>
                  <span [class]="cmpClass(c)">{{ pct(c.turnout) }}</span></span></td>
                <td class="n">{{ c.accredited | number }} <span class="sub">/ {{ c.registered | number }}</span></td>
                <td class="n" [class.bad]="c.flags">{{ c.flags || '' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }

      <section class="feed">
        <div class="fh"><h2>As it comes in</h2>
          <mat-button-toggle-group [value]="tab()" (change)="tab.set($event.value)" hideSingleSelectionIndicator>
            <mat-button-toggle value="flags">Flags ({{ flags().length }})</mat-button-toggle>
            <mat-button-toggle value="updates">All figures</mat-button-toggle>
          </mat-button-toggle-group></div>
        @if (tab() === 'flags') {
          @for (f of flags(); track f.id) {
            <div class="item flag">
              <span class="sev" [style.background]="sevColor[f.severity]">{{ f.severity }}</span>
              <div class="what"><b>{{ f.label }}</b>
                <div class="sub">{{ f.unit ?? f.pu_code }} <span class="code">{{ f.pu_code }}</span> · {{ f.created_at | ago }}</div>
                @if (f.details?.message) { <div class="msg">{{ f.details.message }}</div> }</div>
              @if (f.case_id) { <a [routerLink]="['/room/case', f.case_id]" class="case" [class.closed]="!open_(f)">{{ open_(f) ? 'Open case' : 'Case closed' }}</a> }
            </div>
          } @empty { <p class="none">No flags in this area.</p> }
        } @else {
          @for (u of updates(); track u.id) {
            <div class="item">
              <span class="stage">{{ stage(u.stage) }}</span>
              <div class="what"><b>{{ describe(u) }}</b>
                <div class="sub">{{ u.unit }} <span class="code">{{ u.pu_code }}</span> · {{ u.agent }} · {{ u.created_at | ago }}</div></div>
            </div>
          } @empty { <p class="none">No figures yet. They appear here as agents send them.</p> }
        }
      </section>
    </div>
  } @else { <p>Loading…</p> }`,
  styles: `
    .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    h1 { font: var(--mat-sys-headline-small); margin: 0; } h2 { font: var(--mat-sys-title-medium); margin: 0; }
    .crumbs { display: flex; align-items: center; flex-wrap: wrap; } .crumbs a { cursor: pointer; color: var(--mat-sys-primary); }
    .crumbs mat-icon { font-size: 18px; height: 18px; width: 18px; color: var(--mat-sys-outline); }
    .spacer { flex: 1; } .upd { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; animation: pulse 1.6s infinite; } @keyframes pulse { 50% { opacity: .3; } }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .kpis > div { background: var(--mat-sys-surface-container); border-radius: 12px; padding: 10px 12px; }
    .kpis b { display: block; font: var(--mat-sys-headline-small); } .kpis small { font-size: 15px; color: var(--mat-sys-on-surface-variant); }
    .kpis span { font-size: 12px; color: var(--mat-sys-on-surface-variant); } .kpis .bad b { color: #b3261e; }
    .bar { position: relative; display: block; height: 8px; margin-top: 6px; background: var(--mat-sys-surface-container-high); border-radius: 4px; overflow: visible; }
    .bar i { display: block; height: 100%; background: #2563eb; border-radius: 4px; transition: width .6s; }
    .bar em { position: absolute; top: -3px; width: 2px; height: 14px; background: #111827; }
    .lower { color: #b45309; font-weight: 600; } .higher { color: #1d4ed8; font-weight: 600; }
    .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; margin-top: 16px; align-items: start; }
    @media (min-width: 1100px) { .cols.two { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); } }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-weight: 500; color: var(--mat-sys-on-surface-variant); border-bottom: 1px solid var(--mat-sys-outline-variant); padding: 6px; }
    td { padding: 6px; border-bottom: 1px solid var(--mat-sys-outline-variant); } .n { text-align: right; } td.bad { color: #b3261e; font-weight: 600; }
    tr.click { cursor: pointer; } tr.click:hover { background: var(--mat-sys-surface-container); }
    .mini { display: flex; align-items: center; gap: 8px; } .mini .bar { width: 110px; margin: 0; }
    .code { font-size: 11px; color: var(--mat-sys-outline); margin-left: 4px; } .sub { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .fh { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
    .item { display: flex; gap: 10px; align-items: flex-start; padding: 8px 4px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .what { flex: 1; min-width: 0; } .msg { font-size: 13px; margin-top: 2px; }
    .sev { color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 6px; text-transform: capitalize; flex: none; }
    .stage { font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 6px; background: var(--mat-sys-surface-container-high); flex: none; }
    .case { font-size: 13px; color: var(--mat-sys-primary); white-space: nowrap; } .case.closed { color: var(--mat-sys-outline); }
    .none { color: var(--mat-sys-on-surface-variant); }
  `,
})
export class PollingDayPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  s = signal<Summary | null>(null);
  updates = signal<Update[]>([]);
  flags = signal<Flag[]>([]);
  tab = signal<'flags' | 'updates'>('flags');
  sevColor = SEVERITY_COLOR;
  private area: string | null = null;
  private timer = setInterval(() => void this.load(), 30_000);
  private stopLive = this.api.onChange(() => this.soon(), ['unit_figure_updates', 'cases']);
  private pending: ReturnType<typeof setTimeout> | null = null;

  rows = computed(() => [...(this.s()?.children ?? [])].sort((a, b) => b.flags - a.flags || (a.turnout ?? 1) - (b.turnout ?? 1)));

  constructor() { void this.load(); }
  ngOnDestroy() { clearInterval(this.timer); this.stopLive(); if (this.pending) clearTimeout(this.pending); }
  /** Figures arrive in bursts (many units at once): reload at most every 2 seconds */
  private soon() { if (!this.pending) this.pending = setTimeout(() => { this.pending = null; void this.load(); }, 2000); }

  async load() {
    try {
      const params = { area: this.area ?? undefined };
      const [d, f] = await Promise.all([this.api.get<Summary>('/unit-figures/summary', params), this.api.get<{ updates: Update[]; flags: Flag[] }>('/unit-figures/feed', params)]);
      this.s.set(d); this.area = d.area; this.updates.set(f.updates); this.flags.set(f.flags);
    } catch (e) { this.ui.error(e); clearInterval(this.timer); }
  }

  open(code: string) { this.area = code; void this.load(); }
  level(l: string) { return LEVEL[l] ?? l; }
  stage(s: string) { return STAGE[s] ?? s; }
  open_(f: Flag) { return ['queued', 'assigned', 'in_progress', 'escalated'].includes(f.case_status ?? ''); }
  pct(x: number | null) { return x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`; }
  /** Turnout well below (amber) or above (blue) last election at the same units */
  cmpClass(a: Agg) {
    if (a.turnout === null || a.baselineTurnout === null) return '';
    return a.turnout < a.baselineTurnout * 0.75 ? 'lower' : a.turnout > a.baselineTurnout * 1.25 ? 'higher' : '';
  }
  describe(u: Update) {
    const order = Object.keys(FIELD); // EC8A item order
    return Object.entries(u.figures).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([k, v]) => {
      const turnout = k === 'accredited' && u.registered ? ` (${Math.round((v / u.registered) * 100)}%)` : '';
      return `${v.toLocaleString()} ${FIELD[k] ?? k}${turnout}`;
    }).join(' · ');
  }
}
