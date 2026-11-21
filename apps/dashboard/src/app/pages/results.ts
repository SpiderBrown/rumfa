import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { partyColour } from '@rumfa/shared';
import { Api } from '../core/api';
import { Ui } from '../core/ui';
import { UnitCompare } from '../core/unit-compare';

type Votes = Record<string, number>;
interface AreaRow { code: string; name: string; units: number; ours: number; irev: number; both_match: number; differences: number; missing: number; our_votes: Votes; irev_votes: Votes }
interface Tally { stage: 'quick' | 'ec8a' | 'irev'; party: string; votes: number; units: number }
interface Estimate { state_code: string; party: string; share: number; margin: number; units_reported: number; units_in_sample: number }
type Source = 'ours' | 'irev' | 'diff';

const LEVEL: Record<number, { one: string; many: string }> = {
  2: { one: 'State', many: 'states' }, 5: { one: 'LGA', many: 'LGAs' }, 8: { one: 'Ward', many: 'wards' }, 12: { one: 'Polling unit', many: 'polling units' },
};
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const sum = (v: Votes) => Object.values(v).reduce((a, b) => a + Number(b), 0);

/**
 * Results (internal): our agents' signed sheets (EC8A) against IReV, area by area, down to the polling unit.
 * Differences go to Sheet review. Also the early estimate from quick counts, and the sample estimate by state.
 */
@Component({
  selector: 'app-results',
  imports: [DecimalPipe, RouterLink, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="eyebrow">Internal only · {{ path() }}</p>
        <h1>Results</h1>
        <p class="lede">Our agents' sheets against IReV, area by area. Differences go to <a routerLink="/irev/review">Sheet review</a>.</p>
      </div>
      <div class="head-r">
        <span class="muted sm">Updated {{ updated() }}</span>
        <button mat-stroked-button (click)="export()" [disabled]="!rows().length"><mat-icon>download</mat-icon> Export</button>
      </div>
    </header>

    <nav class="crumbs" aria-label="Area">
      @for (b of stack(); track b.code; let last = $last) {
        @if (!last) { <button class="crumb" (click)="back(b.code)">{{ b.name }}</button><span aria-hidden="true">›</span> }
        @else { <b>{{ b.name }}</b> }
      }
    </nav>

    <section class="stats" aria-label="Summary">
      <div class="stat r-card"><span class="s-l">Units with our sheet</span><b>{{ tot().ours | number }}</b><span class="s-h">{{ pct(tot().ours, tot().units) }}% of {{ tot().units | number }}</span></div>
      <div class="stat r-card"><span class="s-l">On IReV</span><b>{{ tot().irev | number }}</b><span class="s-h">{{ pct(tot().irev, tot().units) }}% readable</span></div>
      <div class="stat r-card"><span class="s-l">Both, matching</span><b>{{ tot().both_match | number }}</b><span class="s-h">{{ pct(tot().both_match, tot().both_match + tot().differences) }}% of units with both</span></div>
      <div class="stat r-card" [class.warn]="tot().differences"><span class="s-l">Differences</span><b>{{ tot().differences | number }}</b><span class="s-h">our sheet and IReV disagree</span></div>
      <div class="stat r-card" [class.warn]="tot().missing"><span class="s-l">Missing sheet</span><b>{{ tot().missing | number }}</b><span class="s-h">count done, no EC8A from us</span></div>
    </section>

    <div class="two">
      <!-- Votes in this area from each source, side by side -->
      <section class="r-card card" aria-label="Votes by source">
        <div class="c-head"><h2>Votes in {{ stack().at(-1)?.name }}</h2>
          <div class="key xs"><span><i class="k-ours"></i>Our sheets</span><span><i class="k-irev"></i>IReV</span>@if (hasQuick()) { <span><i class="k-quick"></i>Early estimate</span> }</div></div>
        @for (p of compare(); track p.party) {
          <div class="cmp-row">
            <span class="pname"><i [style.background]="p.colour"></i>{{ p.party }}</span>
            <div class="cmp-bars">
              <div class="cb"><span class="fill ours" [style.width.%]="p.oursW" [style.background]="p.colour"></span><span class="v">{{ p.ours | number }} · {{ p.oursS }}%</span></div>
              <div class="cb"><span class="fill irev" [style.width.%]="p.irevW" [style.--c]="p.colour"></span><span class="v">{{ p.irev | number }} · {{ p.irevS }}%</span></div>
              @if (hasQuick()) { <div class="cb thin"><span class="fill quick" [style.width.%]="p.quickW"></span><span class="v">{{ p.quickS }}%</span></div> }
            </div>
          </div>
        } @empty { <p class="muted pad">No votes in yet for {{ stack().at(-1)?.name }}.</p> }
      </section>

      @if (area() === 'NG' && estimateRows().length) {
        <section class="r-card card" aria-label="Sample estimate by state">
          <div class="c-head"><h2>Sample estimate by state</h2><span class="muted xs">from sample units' quick counts</span></div>
          <table class="mini">
            <thead><tr><th>State</th><th>Leading</th><th>Share</th><th>Sample in</th></tr></thead>
            <tbody>
              @for (e of estimateRows(); track e.state) {
                <tr><td>{{ e.state }}</td><td><span class="dot" [style.background]="colour(e.party)"></span>{{ e.party }}</td>
                  <td>{{ e.share }}% ± {{ e.margin }}</td><td class="muted">{{ e.reported }} / {{ e.sample }}</td></tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>

    <section class="r-card tbl" aria-label="By area">
      <div class="t-head">
        <h2>By {{ level().one }}</h2>
        <span class="grow"></span>
        @if (area() === 'NG') {
          <div class="r-seg" role="tablist" aria-label="Show Nigeria as">
            <button role="tab" [class.on]="!zones()" (click)="setZones(false)">States</button>
            <button role="tab" [class.on]="zones()" (click)="setZones(true)">Zones</button>
          </div>
        }
        @if (isState()) {
          <div class="r-seg" role="tablist" aria-label="Show the state as">
            <button role="tab" [class.on]="!senatorial()" (click)="setSenatorial(false)">LGAs</button>
            <button role="tab" [class.on]="senatorial()" (click)="setSenatorial(true)">Senatorial districts</button>
          </div>
        }
        <div class="r-seg" role="tablist" aria-label="Show">
          <button role="tab" [class.on]="source() === 'ours'" (click)="source.set('ours')">Our sheets</button>
          <button role="tab" [class.on]="source() === 'irev'" (click)="source.set('irev')">IReV</button>
          <button role="tab" [class.on]="source() === 'diff'" (click)="source.set('diff')">Difference</button>
        </div>
      </div>
      <div class="scroll">
        <table>
          <thead><tr>
            <th>{{ level().one }}</th><th>Units in</th>
            @for (p of topParties(); track p) { <th class="num"><span class="dot" [style.background]="colour(p)"></span>{{ p }}</th> }
            <th class="num">Others</th><th>Differences</th><th>Missing</th><th></th>
          </tr></thead>
          <tbody>
            @for (r of sorted(); track r.code) {
              <tr [class.click]="canDrill()" (click)="canDrill() && go(r)">
                <td><b>{{ r.name }}</b>@if (level().one === 'Polling unit') { <div class="muted xs">{{ r.code }}</div> }</td>
                <td><div class="unitsin"><span class="mbar"><span [style.width.%]="unitsPct(r)"></span></span>{{ unitsPct(r) }}%</div></td>
                @for (p of topParties(); track p) { <td class="num" [class.neg]="source() === 'diff' && cell(r, p) < 0" [class.pos]="source() === 'diff' && cell(r, p) > 0">{{ fmt(cell(r, p)) }}</td> }
                <td class="num">{{ fmt(others(r)) }}</td>
                <td>@if (r.differences) { <a class="pill hot" routerLink="/irev/review" (click)="$event.stopPropagation()">{{ r.differences }} to review</a> } @else if (r.both_match) { <span class="pill ok">all match</span> }</td>
                <td>@if (r.missing) { <span class="pill warn" [matTooltip]="'Counting finished at ' + r.missing + ' units but we have no signed sheet yet'">{{ r.missing }}</span> }</td>
                <td class="go">@if (canDrill()) { <mat-icon>chevron_right</mat-icon> }
                  @else { <button mat-stroked-button class="pv" (click)="$event.stopPropagation(); preview(r)" [disabled]="!r.ours && !r.irev"><mat-icon>compare</mat-icon> Preview</button> }</td>
              </tr>
            } @empty { <tr><td [attr.colspan]="topParties().length + 6"><p class="muted pad">{{ loading() ? 'Loading…' : 'Nothing here yet.' }}</p></td></tr> }
          </tbody>
        </table>
      </div>
      <p class="muted xs foot">{{ source() === 'diff' ? 'Difference is our sheets minus IReV, for units where we have both.' : source() === 'irev' ? 'IReV figures confirmed in Sheet review, or read with high confidence.' : 'From the latest signed sheet each agent sent.' }}
        Most differences first, then the areas with the most sheets in.</p>
    </section>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .head-r { display: flex; align-items: center; gap: 12px; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); }
    h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; }
    .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 14px; margin-top: -6px; }
    .crumb { border: 0; background: none; color: #0f5e8c; font: inherit; font-weight: 600; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
    .crumb:hover { background: #eaf2f8; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .stat { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; }
    .stat b { font-size: 26px; font-weight: 800; }
    .s-l { font-size: 13px; font-weight: 600; color: var(--r-ink-2); } .s-h { font-size: 12px; color: var(--r-muted); }
    .stat.warn { border-color: #f0c9a8; background: #fffaf5; } .stat.warn b { color: var(--r-high); }
    .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; align-items: start; }
    .card { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
    .c-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .key { display: flex; gap: 12px; color: var(--r-ink-2); } .key span { display: inline-flex; align-items: center; gap: 5px; }
    .key i { width: 16px; height: 10px; border-radius: 3px; display: inline-block; }
    .k-ours { background: var(--r-ink-2); } .k-irev { border: 1px solid var(--r-ink-2); background: repeating-linear-gradient(135deg, var(--r-ink-2) 0 2px, transparent 2px 6px); }
    .k-quick { background: #c7cdd6; }
    .cmp-row { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; align-items: center; }
    .pname { display: flex; align-items: center; gap: 6px; font-weight: 800; font-size: 14px; }
    .pname i, .dot { width: 9px; height: 9px; border-radius: 3px; display: inline-block; margin-right: 4px; box-shadow: inset 0 0 0 1px rgba(20,23,31,.2); }
    .cmp-bars { display: flex; flex-direction: column; gap: 3px; }
    .cb { position: relative; height: 16px; background: #f0f2f5; border-radius: 4px; overflow: hidden; }
    .cb.thin { height: 8px; } .cb.thin .v { display: none; }
    .fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px; }
    .fill.irev { background: repeating-linear-gradient(135deg, var(--c) 0 2px, transparent 2px 6px); border: 1px solid var(--c); box-sizing: border-box; }
    .fill.quick { background: #c7cdd6; }
    .v { position: absolute; right: 6px; top: 0; font-size: 11.5px; font-weight: 700; line-height: 16px; color: var(--r-ink); }
    .pad { margin: 0; padding: 14px 0; }
    .mini { width: 100%; border-collapse: collapse; font-size: 13px; }
    .mini th { text-align: left; font-size: 12px; color: var(--r-muted); padding: 4px 6px; } .mini td { padding: 5px 6px; border-top: 1px solid var(--r-line-soft); }
    .tbl { overflow: hidden; }
    .t-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; flex-wrap: wrap; }
    .scroll { overflow-x: auto; }
    table:not(.mini) { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 760px; }
    table:not(.mini) th { text-align: left; font-size: 12px; font-weight: 600; color: var(--r-muted); padding: 10px 14px; background: #fafbfc; border-top: 1px solid var(--r-line-soft); border-bottom: 1px solid var(--r-line); white-space: nowrap; }
    table:not(.mini) td { padding: 10px 14px; border-bottom: 1px solid var(--r-line-soft); }
    th:first-child, td:first-child { padding-left: 18px; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    td.neg { color: var(--r-urgent); font-weight: 700; } td.pos { color: #146c3a; font-weight: 700; }
    tr.click { cursor: pointer; } tr.click:hover td { background: #fafbfc; }
    .unitsin { display: flex; align-items: center; gap: 8px; }
    .mbar { width: 60px; height: 6px; border-radius: 999px; background: var(--r-line-soft); overflow: hidden; }
    .mbar span { display: block; height: 100%; background: var(--r-accent); }
    .pill { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px; text-decoration: none; white-space: nowrap; }
    .pill.hot { background: var(--r-high-bg); color: #7a2e0b; } .pill.ok { background: #e3f4ea; color: #146c3a; } .pill.warn { background: var(--r-low-bg); color: var(--r-ink-2); }
    .go { width: 24px; color: var(--r-muted); white-space: nowrap; text-align: right; } .grow { flex: 1; }
    .pv { --mdc-outlined-button-container-height: 30px; }
    .foot { padding: 10px 18px; margin: 0; border-top: 1px solid var(--r-line-soft); }
  `,
})
export class ResultsPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  private unitCompare = inject(UnitCompare);
  stack = signal<{ code: string; name: string }[]>([{ code: 'NG', name: 'Nigeria' }]);
  area = computed(() => this.stack().at(-1)!.code);
  rows = signal<AreaRow[]>([]);
  tallies = signal<Tally[]>([]);
  estimate = signal<Estimate[]>([]);
  source = signal<Source>('ours');
  loading = signal(true);
  updated = signal('');
  private timer = setInterval(() => void this.load(), 60_000);

  /** Grouping, shared with Election day and the full map: Nigeria by zone, a state by senatorial district */
  zones = signal(read('rumfa.map.zones') === '1');
  senatorial = signal(read('rumfa.map.group') === 'senatorial');
  isState = computed(() => /^\d{2}$/.test(this.area()));
  /** What the rows are, from the area shown and the grouping */
  level = computed(() => {
    const a = this.area();
    if (a === 'NG') return this.zones() ? { one: 'Zone', many: 'zones' } : LEVEL[2];
    if (a.startsWith('Z-')) return LEVEL[2];
    if (/^\d{2}$/.test(a)) return this.senatorial() ? { one: 'Senatorial district', many: 'senatorial districts' } : LEVEL[5];
    if (a.includes('-SD')) return LEVEL[5];
    return LEVEL[({ 5: 8, 8: 12 } as Record<number, number>)[a.length]] ?? LEVEL[12];
  });
  canDrill = computed(() => !/^\d{2}-\d{2}-\d{2}$/.test(this.area()));
  private group = computed(() => this.area() === 'NG' ? (this.zones() ? 'zone' : undefined) : this.isState() && this.senatorial() ? 'senatorial' : undefined);
  path = computed(() => this.stack().map((s) => s.name).join(' › '));
  tot = computed(() => this.rows().reduce((t, r) => ({ units: t.units + r.units, ours: t.ours + r.ours, irev: t.irev + r.irev, both_match: t.both_match + r.both_match,
    differences: t.differences + r.differences, missing: t.missing + r.missing }), { units: 0, ours: 0, irev: 0, both_match: 0, differences: 0, missing: 0 }));
  private totalVotes = computed(() => {
    const ours: Votes = {}, irev: Votes = {};
    for (const r of this.rows()) {
      for (const [p, n] of Object.entries(r.our_votes)) ours[p] = (ours[p] ?? 0) + Number(n);
      for (const [p, n] of Object.entries(r.irev_votes)) irev[p] = (irev[p] ?? 0) + Number(n);
    }
    return { ours, irev };
  });
  private quick = computed(() => Object.fromEntries(this.tallies().filter((t) => t.stage === 'quick').map((t) => [t.party, Number(t.votes)])) as Votes);
  hasQuick = computed(() => sum(this.quick()) > 0);
  /** The parties that matter most here (by our sheets, else IReV), for the columns */
  topParties = computed(() => {
    const { ours, irev } = this.totalVotes(), base = sum(ours) ? ours : irev;
    return Object.entries(base).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p]) => p);
  });
  compare = computed(() => {
    const { ours, irev } = this.totalVotes(), quick = this.quick();
    const so = sum(ours) || 1, si = sum(irev) || 1, sq = sum(quick) || 1;
    const parties = [...new Set([...Object.keys(ours), ...Object.keys(irev)])].sort((a, b) => (ours[b] ?? irev[b] ?? 0) - (ours[a] ?? irev[a] ?? 0)).slice(0, 6);
    const max = Math.max(1, ...parties.map((p) => Math.max((ours[p] ?? 0) / so, (irev[p] ?? 0) / si)));
    return parties.map((p) => {
      const o = (ours[p] ?? 0) / so, i = (irev[p] ?? 0) / si, q = (quick[p] ?? 0) / sq;
      return { party: p, colour: this.colour(p), ours: ours[p] ?? 0, irev: irev[p] ?? 0,
        oursS: Math.round(o * 1000) / 10, irevS: Math.round(i * 1000) / 10, quickS: Math.round(q * 1000) / 10,
        oursW: o / max * 100, irevW: i / max * 100, quickW: q / max * 100 };
    });
  });
  sorted = computed(() => [...this.rows()].sort((a, b) => b.differences - a.differences || b.missing - a.missing || (b.ours + b.irev) - (a.ours + a.irev) || a.name.localeCompare(b.name)));
  /** Leading party per state in the sample estimate */
  estimateRows = computed(() => {
    const by = new Map<string, Estimate>();
    for (const e of this.estimate()) { const cur = by.get(e.state_code); if (!cur || e.share > cur.share) by.set(e.state_code, e); }
    const names = new Map(this.rows().map((r) => [r.code, r.name]));
    return [...by.values()].map((e) => ({ state: names.get(e.state_code) ?? e.state_code, party: e.party, share: Math.round(e.share * 1000) / 10,
      margin: Math.round(e.margin * 1000) / 10, reported: e.units_reported, sample: e.units_in_sample }));
  });

  constructor() { void this.load(); }
  ngOnDestroy() { clearInterval(this.timer); }

  async load() {
    const e = this.api.liveElectionId();
    if (!e) { this.loading.set(false); return; }
    const area = this.area();
    try {
      const [rows, t, est] = await Promise.all([
        this.api.get<AreaRow[]>('/results/by-area', { election: e, area, group: this.group() }),
        area === 'NG' || /^\d{2}(-\d{2})?$/.test(area) ? this.api.get<Tally[]>('/results/tallies', { election: e, area }) : Promise.resolve([] as Tally[]),
        area === 'NG' ? this.api.get<Estimate[]>('/results/sample-estimate', { election: e }).catch(() => [] as Estimate[]) : Promise.resolve([] as Estimate[]),
      ]);
      if (area !== this.area()) return;
      this.rows.set(rows); this.tallies.set(t); this.estimate.set(est);
      this.updated.set(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    } catch (err) { this.ui.error(err); }
    this.loading.set(false);
  }
  go(r: AreaRow) { this.stack.update((s) => [...s, { code: r.code, name: r.name }]); this.rows.set([]); this.loading.set(true); void this.load(); }
  back(code: string) { this.stack.update((s) => s.slice(0, s.findIndex((x) => x.code === code) + 1)); this.rows.set([]); this.loading.set(true); void this.load(); }

  setZones(on: boolean) { this.zones.set(on); write('rumfa.map.zones', on ? '1' : '0'); this.reload(); }
  setSenatorial(on: boolean) { this.senatorial.set(on); write('rumfa.map.group', on ? 'senatorial' : 'lga'); this.reload(); }
  private reload() { this.rows.set([]); this.loading.set(true); void this.load(); }
  preview(r: AreaRow) { const e = this.api.liveElectionId(); if (e) this.unitCompare.open(e, r.code); }

  colour(p: string) { return partyColour(p, this.api.parties(), this.api.partyColours()); }
  pct(a: number, b: number) { return b ? Math.round(a / b * 100) : 0; }
  unitsPct(r: AreaRow) { return this.pct(this.source() === 'irev' ? r.irev : r.ours, r.units); }
  cell(r: AreaRow, p: string): number {
    const s = this.source();
    if (s === 'ours') return Number(r.our_votes[p] ?? 0);
    if (s === 'irev') return Number(r.irev_votes[p] ?? 0);
    return Number(r.our_votes[p] ?? 0) - Number(r.irev_votes[p] ?? 0);
  }
  others(r: AreaRow) {
    const top = this.topParties(), s = this.source();
    const part = (v: Votes) => Object.entries(v).filter(([p]) => !top.includes(p)).reduce((a, [, n]) => a + Number(n), 0);
    return s === 'ours' ? part(r.our_votes) : s === 'irev' ? part(r.irev_votes) : part(r.our_votes) - part(r.irev_votes);
  }
  fmt(n: number) { return this.source() === 'diff' ? (n > 0 ? '+' : '') + n.toLocaleString() : n ? n.toLocaleString() : '—'; }

  /** The table as a CSV file */
  export() {
    const top = this.topParties();
    const head = [this.level().one, 'Code', 'Units', 'With our sheet', 'On IReV', 'Matching', 'Differences', 'Missing sheet',
      ...top.flatMap((p) => [`${p} (ours)`, `${p} (IReV)`])];
    const lines = this.sorted().map((r) => [r.name, r.code, r.units, r.ours, r.irev, r.both_match, r.differences, r.missing,
      ...top.flatMap((p) => [r.our_votes[p] ?? 0, r.irev_votes[p] ?? 0])]);
    const csv = [head, ...lines].map((l) => l.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `results-${this.path().replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
