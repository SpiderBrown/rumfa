import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ISSUE_BANDS, REPORTING_BANDS, partyColour, type MapLayer } from '@rumfa/shared';
import { Api } from '../core/api';
import { AgoPipe, Ui, placeLine } from '../core/ui';
import { AreaMap, type MapArea, type MapData } from '../core/area-map';
import type { CaseRow } from './room/queue';

type Votes = Record<string, number>;
interface DayArea extends MapArea {
  confirmed: Votes; counted: Votes; estimate: Votes;
  checked_in: number; turnout_units: number; accredited: number; turnout_registered: number;
}
interface Totals {
  units: number; reported: number; ec8a: number; irev: number; quick: number; live: number; mismatch: number; open: number; critical: number;
  agents: number; checked_in: number; turnout_units: number; accredited: number; turnout_registered: number;
  confirmed: Votes; counted: Votes; estimate: Votes;
}
interface DayData extends MapData { children: DayArea[]; totals: Totals }
type StageId = 'checkin' | 'accreditation' | 'count' | 'ec8a' | 'irev';

/** The stages of the day, in order; each says how far it has got for the area shown */
const STAGES: { id: StageId; name: string; when: string; layer: MapLayer }[] = [
  { id: 'checkin', name: 'Check-in', when: 'from 6:00', layer: 'reporting' },
  { id: 'accreditation', name: 'Accreditation', when: 'from 8:30', layer: 'reporting' },
  { id: 'count', name: 'Sorting count', when: 'after voting', layer: 'votes' },
  { id: 'ec8a', name: 'EC8A results', when: 'after counting', layer: 'votes' },
  { id: 'irev', name: 'IReV', when: 'as INEC uploads', layer: 'votes' },
];
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Election day: one page for what comes from the field through the day. The stage strip says where the day is;
 * the map, the votes and the table follow the area picked (click to go down, the path to go back up).
 */
@Component({
  selector: 'app-election-day',
  imports: [DecimalPipe, RouterLink, MatButtonModule, MatIconModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="page">
    <header class="head">
      <div class="title">
        <h1>Election day</h1>
        <nav class="crumbs" aria-label="Area">
          @for (b of data()?.breadcrumb ?? []; track b.code; let last = $last) {
            @if (!last) { <button class="crumb" (click)="open(b.code)">{{ b.name }}</button><span class="sep" aria-hidden="true">›</span> }
            @else { <b>{{ b.name }}</b> }
          }
        </nav>
      </div>
      <div class="live" [class.stale]="stale()" [matTooltip]="'Refreshes by itself as reports come in'">
        <span class="dot" aria-hidden="true"></span>{{ loadedAt() ? 'Updated ' + (loadedAt()! | ago) : 'Loading…' }}
      </div>
    </header>

    <!-- Where the day is: each stage's progress for this area; picking one sets what the map shows -->
    <div class="stages" role="tablist" aria-label="Stage of the day">
      @for (s of stageCards(); track s.id) {
        <button class="stage r-focus" role="tab" [class.on]="stage() === s.id" [attr.aria-selected]="stage() === s.id" (click)="pickStage(s.id)">
          <span class="s-top"><b>{{ s.name }}</b><span class="muted">{{ s.when }}</span></span>
          <span class="s-pct">{{ s.label }}</span>
          <span class="bar" aria-hidden="true"><span [style.width.%]="s.pct"></span></span>
          <span class="muted sm">{{ s.caption }}</span>
        </button>
      }
    </div>

    <div class="body">
      <section class="main">
        <!-- The map: one picture, three layers; the layer follows the stage unless someone picks one -->
        <div class="r-card card">
          <div class="card-head">
            <div>
              <h2>Map of {{ areaName() }}</h2>
              <p class="muted sm">{{ layerNote() }}</p>
            </div>
            <div class="r-seg" role="tablist" aria-label="Map layer">
              @for (l of layers; track l.id) {
                <button role="tab" [class.on]="layer() === l.id" [attr.aria-selected]="layer() === l.id" (click)="pickLayer(l.id)">{{ l.name }}</button>
              }
            </div>
          </div>
          <div #map class="map" role="img" [attr.aria-label]="'Map of ' + areaName() + ' by ' + layer()"></div>
          <div class="legend">
            @for (g of legend(); track g.label) { <span><i [style.background]="g.colour" aria-hidden="true"></i>{{ g.label }}</span> }
            <span class="muted hint">Click an area to go into it</span>
          </div>
        </div>

        <!-- Votes: solid is confirmed from result sheets, hatched is the estimate for units not confirmed yet -->
        @if (layer() === 'votes') {
          <div class="r-card card">
            <div class="card-head">
              <h2>Votes in {{ areaName() }}</h2>
              <div class="key sm">
                <span><i class="solid" aria-hidden="true"></i>Confirmed (EC8A, IReV)</span>
                <span><i class="hatch" aria-hidden="true"></i>@if (canEstimate()) { Estimate for units not confirmed yet } @else { Agents’ counts, not confirmed yet }</span>
              </div>
            </div>
            @if (parties().length) {
              <div class="bars">
                @for (p of parties(); track p.party) {
                  <div class="bar-row">
                    <span class="pname"><i [style.background]="p.colour" aria-hidden="true"></i>{{ p.party }}</span>
                    <div>
                      <div class="track" role="img" [attr.aria-label]="p.party + ': ' + p.conf + ' confirmed, about ' + p.est + ' expected'">
                        <div class="est" [style.width.%]="p.estW" [style.--c]="p.colour"></div>
                        <div class="conf" [style.width.%]="p.confW" [style.background]="p.colour"></div>
                      </div>
                      <div class="sm"><b>{{ p.conf | number }}</b> confirmed ·
                        @if (canEstimate()) { about <b>{{ p.est | number }}</b> expected · <b>{{ p.share }}%</b> of the estimate }
                        @else { <b>{{ p.est | number }}</b> with agents' counts · <b>{{ p.share }}%</b> so far }</div>
                    </div>
                  </div>
                }
              </div>
              @if (canEstimate()) {
                <p class="muted sm note">Confirmed from result sheets for <b>{{ share(t().ec8a + t().irev, t().units) }}</b> of units.
                  The estimate adds our agents' counts ({{ share(t().quick + t().live, t().units) }} of units) and scales up to all {{ t().units | number }} units.
                  As sheets arrive, the hatched part fills in.</p>
              } @else {
                <p class="muted sm note">Only <b>{{ t().reported | number }}</b> of {{ t().units | number }} units have votes in, too few to estimate the final result.
                  The estimate appears once {{ neededForEstimate() | number }} units are in. Go into a smaller area to see it sooner.</p>
              }
            } @else {
              <p class="muted empty">No votes yet. They appear as agents send their sorting counts and result sheets.</p>
            }
          </div>
        }

        <!-- By area: the same numbers as the map; a row goes into that area -->
        <div class="r-card card table-card">
          <div class="card-head pad">
            <h2>{{ kidsTitle() }}</h2>
            <span class="muted sm">Sorted by {{ sortNote() }}</span>
          </div>
          <div class="scroll">
            <table>
              <thead><tr><th>Area</th><th>{{ cols()[0] }}</th><th>{{ cols()[1] }}</th>@if (layer() !== 'issues') { <th>Open cases</th> }<th><span class="visually-hidden">Open</span></th></tr></thead>
              <tbody>
                @for (r of rows(); track r.code) {
                  <tr>
                    <td class="aname">{{ r.name }}</td>
                    <td class="metric"><div class="minner"><span class="mbar" aria-hidden="true"><span [style.width.%]="r.pct"></span></span><span class="num">{{ r.a }}</span></div></td>
                    <td>@if (r.leadColour) { <span class="lead" [style.background]="r.leadColour">{{ r.b }}</span> } @else { {{ r.b }} }</td>
                    @if (layer() !== 'issues') { <td>@if (r.open) { <span class="r-pill" [class.critical]="r.critical" [class.medium]="!r.critical">{{ r.open }}</span> }</td> }
                    <td class="go">@if (canDrill()) { <button mat-button (click)="open(r.code)" [attr.aria-label]="'Open ' + r.name">Open <mat-icon iconPositionEnd>chevron_right</mat-icon></button> }</td>
                  </tr>
                } @empty { <tr><td colspan="5" class="muted empty">Nothing to show here yet.</td></tr> }
              </tbody>
            </table>
          </div>
        </div>
        <p class="more muted sm">More detail:
          <a routerLink="/checkins">Check-ins</a> · <a routerLink="/polling-day">Polling day figures</a> · <a routerLink="/live-count">Live count</a>
          · <a routerLink="/results">Results</a> · <a routerLink="/map">Full map</a></p>
      </section>

      <!-- Flags and open cases in this area: always beside the numbers; each opens in the situation room -->
      <aside class="r-card flags" aria-label="Flags and open cases">
        <div class="card-head"><h2>Flags and cases</h2><span class="muted sm">{{ areaCases().length }} open</span></div>
        @for (c of areaCases().slice(0, 12); track c.id) {
          <a class="flag r-focus" [routerLink]="['/room/case', c.id]">
            <span class="f-top"><span class="r-pill" [class]="c.severity">{{ sevName(c.severity) }}</span><span class="muted sm">{{ c.created_at | ago }}</span></span>
            <span class="f-title">{{ c.what ?? c.title }}</span>
            <span class="muted sm">{{ place(c) }}</span>
          </a>
        } @empty {
          @if (data()) { <div class="calm"><mat-icon>verified</mat-icon><span>No open cases in {{ areaName() }}.</span></div> }
        }
        @if (areaCases().length > 12) { <a routerLink="/room" class="sm">All {{ areaCases().length }} in the situation room</a> }
      </aside>
    </div>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1600px; }
    .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    h2 { margin: 0; font-size: 17px; font-weight: 700; }
    .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 14px; margin-top: 4px; }
    .crumb { border: 0; background: none; color: #0f5e8c; font: inherit; font-weight: 600; padding: 2px 4px; border-radius: 4px; cursor: pointer; }
    .crumb:hover { background: #eaf2f8; } .sep { color: #9aa6b6; padding: 0 2px; }
    .live { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--r-ink-2); background: #fff; border: 1px solid var(--r-line); border-radius: 999px; padding: 6px 12px; }
    .live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--r-accent); } .live.stale .dot { background: var(--r-high); }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } p { margin: 0; }

    .stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .stage { display: flex; flex-direction: column; gap: 6px; text-align: left; font: inherit; color: var(--r-ink); cursor: pointer;
      background: #fff; border: 1px solid var(--r-line); border-radius: 12px; padding: 12px 14px; }
    .stage:hover { border-color: #9aa6b6; }
    .stage.on { border: 2px solid var(--r-accent); background: var(--r-accent-soft); padding: 11px 13px; }
    .s-top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
    .s-pct { font-size: 24px; font-weight: 800; }
    .bar { display: block; height: 6px; border-radius: 3px; background: #e7ebf0; overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--r-accent); }

    .body { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
    .main { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
    .card { padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
    .card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; }
    .card-head p { margin-top: 2px; }
    .map { height: 420px; border-radius: 10px; }
    .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; font-size: 12px; color: var(--r-ink-2); }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { width: 20px; height: 12px; border-radius: 3px; border: 1px solid rgba(0,0,0,.08); }
    .legend .hint { margin-left: auto; }

    .key { display: flex; flex-wrap: wrap; gap: 16px; color: var(--r-ink-2); }
    .key span { display: inline-flex; align-items: center; gap: 6px; }
    .key i { width: 18px; height: 12px; border-radius: 3px; } .key .solid { background: var(--r-ink-2); }
    .key .hatch { border: 1px solid var(--r-ink-2); background: repeating-linear-gradient(135deg, var(--r-ink-2) 0 2px, transparent 2px 6px); }
    .bars { display: flex; flex-direction: column; gap: 14px; }
    .bar-row { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; align-items: center; }
    .pname { display: flex; align-items: center; gap: 6px; font-weight: 800; font-size: 15px; }
    .pname i { width: 10px; height: 10px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(20, 23, 31, .25); }
    .track { position: relative; height: 26px; background: #f0f2f5; border-radius: 6px; overflow: hidden; margin-bottom: 5px; }
    .est { position: absolute; inset: 0 auto 0 0; border: 1.5px solid var(--c); border-radius: 6px; box-sizing: border-box; opacity: .55;
      background: repeating-linear-gradient(135deg, var(--c) 0 2px, transparent 2px 7px); }
    .conf { position: absolute; inset: 0 auto 0 0; border-radius: 6px 0 0 6px; box-shadow: inset 0 0 0 1px rgba(20, 23, 31, .18); }
    .note { line-height: 1.5; } .empty { padding: 16px 0; }

    .table-card { padding: 16px 0 6px; } .pad { padding: 0 20px; }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 560px; }
    th { text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--r-muted); padding: 8px 12px; }
    th:first-child, td:first-child { padding-left: 20px; } td { padding: 8px 12px; border-top: 1px solid var(--r-line-soft); }
    .aname { font-weight: 600; } .metric { width: 34%; }
    .minner { display: flex; align-items: center; gap: 10px; }
    .mbar { flex: 1; height: 8px; border-radius: 4px; background: #e7ebf0; overflow: hidden; }
    .mbar span { display: block; height: 100%; background: var(--r-accent); }
    .num { min-width: 48px; text-align: right; font-variant-numeric: tabular-nums; }
    .lead { color: #fff; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 999px; text-shadow: 0 0 2px rgba(0,0,0,.45); box-shadow: inset 0 0 0 1px rgba(20, 23, 31, .2); }
    .go { text-align: right; padding-right: 12px; }
    .more a { font-weight: 600; }

    .flags { flex: 1 1 300px; padding: 16px; display: flex; flex-direction: column; gap: 10px; position: sticky; top: 72px; max-height: calc(100vh - 88px); overflow: auto; box-sizing: border-box; }
    .flag { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--r-line-soft); border-radius: 10px; color: var(--r-ink); text-decoration: none; }
    .flag:hover { border-color: #9aa6b6; background: #fafbfc; }
    .f-top { display: flex; align-items: center; gap: 8px; } .f-title { font-weight: 600; font-size: 14px; line-height: 1.35; }
    .calm { display: flex; align-items: center; gap: 8px; color: var(--r-accent-strong); padding: 12px 4px; font-size: 14px; }
    @media (max-width: 1000px) { .flags { position: static; max-height: none; } }
  `,
})
export class ElectionDayPage implements AfterViewInit, OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  readonly layers: { id: MapLayer; name: string }[] = [{ id: 'reporting', name: 'Reporting' }, { id: 'issues', name: 'Issues' }, { id: 'votes', name: 'Votes' }];

  data = signal<DayData | null>(null);
  cases = signal<CaseRow[]>([]);
  loadedAt = signal<string | null>(null);
  /** The stage picked; null follows the day (the furthest stage with anything in it) */
  private pickedStage = signal<StageId | null>(null);
  /** The map layer picked; null follows the stage */
  private pickedLayer = signal<MapLayer | null>(null);
  private tick = signal(0);
  private parent: string | undefined;
  private el = viewChild.required<ElementRef<HTMLElement>>('map');
  private areaMap: AreaMap | null = null;
  private stopLive: () => void = () => undefined;
  private timers: ReturnType<typeof setInterval>[] = [];

  t = computed(() => this.data()?.totals ?? ({ units: 0, reported: 0, ec8a: 0, irev: 0, quick: 0, live: 0, mismatch: 0, open: 0, critical: 0, agents: 0,
    checked_in: 0, turnout_units: 0, accredited: 0, turnout_registered: 0, confirmed: {}, counted: {}, estimate: {} } as Totals));
  areaName = computed(() => this.data()?.breadcrumb.at(-1)?.name ?? '…');
  stale = computed(() => { this.tick(); const at = this.loadedAt(); return !!at && Date.now() - new Date(at).getTime() > 3 * 60_000; });

  /** How far each stage has got, as a share */
  private stageValue(id: StageId, x: { units: number; checked_in: number; accredited: number; turnout_registered: number; quick: number; live: number; ec8a: number; irev: number }) {
    switch (id) {
      case 'checkin': return this.pct(x.checked_in, x.units);
      case 'accreditation': return this.pct(x.accredited, x.turnout_registered);
      case 'count': return this.pct(x.quick + x.live + x.ec8a + x.irev, x.units);
      case 'ec8a': return this.pct(x.ec8a + x.irev, x.units);
      case 'irev': return this.pct(x.irev, x.units);
    }
  }
  /** The exact share (for labels: "<1%" when something has started but rounds to 0) */
  private stageRaw(id: StageId, x: Totals) {
    const r = (a: number, b: number) => (b ? a / b : 0);
    return { checkin: r(x.checked_in, x.units), accreditation: r(x.accredited, x.turnout_registered), count: r(x.quick + x.live + x.ec8a + x.irev, x.units),
      ec8a: r(x.ec8a + x.irev, x.units), irev: r(x.irev, x.units) }[id];
  }
  pctLabel(share: number) { return share > 0 && share < 0.005 ? '<1%' : Math.round(Math.min(1, share) * 100) + '%'; }
  stage = computed<StageId>(() => {
    const p = this.pickedStage();
    if (p) return p;
    const t = this.t();
    // The day so far: the furthest stage with anything in it
    const reached = [...STAGES].reverse().find((s) => this.stageRaw(s.id, t) > 0);
    return reached?.id ?? 'checkin';
  });
  layer = computed<MapLayer>(() => this.pickedLayer() ?? STAGES.find((s) => s.id === this.stage())!.layer);

  stageCards = computed(() => {
    const t = this.t();
    const n = (x: number) => x.toLocaleString();
    const caption: Record<StageId, string> = {
      checkin: `${n(t.checked_in)} of ${n(t.units)} units have an agent in place`,
      accreditation: t.turnout_units ? `turnout so far, from ${n(t.turnout_units)} unit${t.turnout_units === 1 ? '' : 's'}` : 'no accreditation figures yet',
      count: `${n(t.quick + t.live + t.ec8a + t.irev)} of ${n(t.units)} units counted`,
      ec8a: `${n(t.ec8a + t.irev)} of ${n(t.units)} units with a result sheet`,
      irev: `${n(t.irev)} units on IReV` + (t.mismatch ? ` · ${n(t.mismatch)} differ from ours` : ''),
    };
    return STAGES.map((s) => ({ ...s, pct: this.stageValue(s.id, t), label: this.pctLabel(this.stageRaw(s.id, t)), caption: caption[s.id] }));
  });

  layerNote = computed(() => {
    const mode = this.pickedLayer() ? 'Picked by you, click it again to follow the stage' : 'Follows the stage of the day';
    const what = { reporting: this.stage() === 'checkin' ? 'agents in place' : this.stage() === 'accreditation' ? 'units sending turnout' : 'units reporting',
      issues: 'open cases', votes: 'leading party, stronger where it leads by more' }[this.layer()];
    return `${mode} · ${what}`;
  });

  legend = computed(() => {
    const d = this.data();
    if (this.layer() === 'issues') return ISSUE_BANDS.map((b) => ({ label: b.label, colour: b.colour }));
    if (this.layer() === 'reporting') return [{ label: 'None', colour: REPORTING_BANDS[0] }, { label: 'Some', colour: REPORTING_BANDS[2] }, { label: 'All', colour: REPORTING_BANDS[4] }];
    return (d?.parties ?? []).slice(0, 8).map((p) => ({ label: p, colour: partyColour(p, d!.parties, d!.partyColours) }));
  });

  /** An estimate means something only once enough units are in: at least 20, and 5% of the area */
  canEstimate = computed(() => { const t = this.t(); return t.reported >= Math.max(20, Math.ceil(t.units * 0.05)); });
  neededForEstimate = computed(() => Math.max(20, Math.ceil(this.t().units * 0.05)));
  parties = computed(() => {
    const d = this.data(), t = this.t();
    if (!d) return [];
    const names = [...new Set([...Object.keys(t.estimate), ...Object.keys(t.confirmed), ...Object.keys(t.counted)])];
    // Early in the count the hatched part is only agents' counts not confirmed yet; later, the estimate
    const est = (p: string) => this.canEstimate() ? Math.max(t.estimate[p] ?? 0, t.confirmed[p] ?? 0) : (t.confirmed[p] ?? 0) + (t.counted[p] ?? 0);
    const max = Math.max(1, ...names.map(est));
    const total = names.reduce((a, p) => a + est(p), 0) || 1;
    return names.sort((a, b) => est(b) - est(a)).slice(0, 8).map((p) => ({
      party: p, colour: partyColour(p, d.parties, d.partyColours), conf: t.confirmed[p] ?? 0, est: est(p),
      confW: ((t.confirmed[p] ?? 0) / max) * 100, estW: (est(p) / max) * 100, share: Math.round((est(p) / total) * 100),
    }));
  });

  cols = computed(() => ({
    checkin: ['Agents in place', 'Agents'], accreditation: ['Turnout', 'Accredited'], count: ['Units counted', 'Leading (estimate)'],
    ec8a: ['Units confirmed', 'Leading'], irev: ['Units on IReV', 'Differ from our EC8A'],
  } as Record<StageId, [string, string]>)[this.layer() === 'issues' ? 'checkin' : this.stage()].map((x, i) =>
    this.layer() === 'issues' ? ['Open cases', 'Urgent'][i] : x));

  rows = computed(() => {
    const d = this.data();
    if (!d) return [];
    const st = this.stage(), issues = this.layer() === 'issues';
    const lead = (a: DayArea) => {
      const v = Object.keys(a.estimate).length ? a.estimate : a.votes;
      const top = Object.entries(v).sort((x, y) => y[1] - x[1])[0];
      return top ? { p: top[0], c: partyColour(top[0], d.parties, d.partyColours) } : null;
    };
    const rows = d.children.map((a) => {
      let pct = 0, aText = '', b = '', leadColour = '';
      if (issues) { pct = Math.min(100, a.open * 20); aText = String(a.open); b = a.critical ? `${a.critical} urgent` : '—'; }
      else if (st === 'checkin') { pct = this.pct(a.checked_in, a.units); aText = this.share(a.checked_in, a.units); b = a.agents.toLocaleString(); }
      else if (st === 'accreditation') { pct = this.pct(a.accredited, a.turnout_registered); aText = a.turnout_units ? this.share(a.accredited, a.turnout_registered) : '—'; b = a.accredited ? a.accredited.toLocaleString() : '—'; }
      else if (st === 'irev') { pct = this.pct(a.irev, a.units); aText = this.share(a.irev, a.units); b = a.mismatch ? `${a.mismatch} units` : '—'; }
      else {
        const done = st === 'count' ? a.quick + a.live + a.ec8a + a.irev : a.ec8a + a.irev;
        pct = this.pct(done, a.units); aText = this.share(done, a.units); const l = lead(a); b = l?.p ?? '—'; leadColour = l?.c ?? '';
      }
      return { code: a.code, name: a.name, pct, a: aText, b, leadColour, open: a.open, critical: a.critical };
    });
    // Worst first where it helps act: least reported, most issues
    return issues ? rows.sort((x, y) => y.open - x.open || x.name.localeCompare(y.name)) : rows.sort((x, y) => x.pct - y.pct || x.name.localeCompare(y.name));
  });
  sortNote = computed(() => this.layer() === 'issues' ? 'most open cases first' : 'least progress first');
  canDrill = computed(() => this.data()?.childLevel !== 'pu');
  kidsTitle = computed(() => {
    const lv = this.data()?.childLevel;
    return 'By ' + ({ zone: 'zone', state: 'state', senatorial: 'senatorial district', lga: 'LGA', ward: 'ward', pu: 'polling unit' }[lv ?? 'state'] ?? 'area');
  });

  /** Open cases in the area shown, most urgent first */
  areaCases = computed(() => {
    const parent = this.data()?.parent ?? 'NG';
    return this.cases().filter((c) => parent === 'NG' || (c.pu_code ?? c.area_code).startsWith(parent))
      .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.created_at.localeCompare(a.created_at));
  });

  constructor() {
    effect(() => { this.layer(); this.stage(); this.draw(); });
  }

  ngAfterViewInit() {
    this.areaMap = new AreaMap(this.el().nativeElement, window.RUMFA_CONFIG.mapTiles);
    void this.load();
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.stopLive = this.api.onChange(() => { pending ??= setTimeout(() => { pending = null; void this.load(); }, 2500); },
      ['cases', 'verifications', 'unit_figure_updates', 'checkins']);
    this.timers.push(setInterval(() => void this.load(), 60_000), setInterval(() => this.tick.update((n) => n + 1), 20_000));
  }
  ngOnDestroy() { this.stopLive(); this.timers.forEach(clearInterval); this.areaMap?.destroy(); }

  async load() {
    try {
      const [d, cases] = await Promise.all([
        this.api.get<DayData>('/map', { parent: this.parent }),
        this.api.get<CaseRow[]>('/cases', { status: 'queued,assigned,in_progress,escalated' }).catch(() => this.cases()),
      ]);
      const first = !this.data();
      this.data.set(d); this.cases.set(cases); this.parent = d.parent;
      if (first) this.areaMap?.resize();
      this.loadedAt.set(new Date().toISOString());
      this.draw();
    } catch (e) { this.ui.error(e); }
  }

  /** Goes into (or back up to) an area, and back to the top so the map and path are in view */
  open(code: string) {
    this.parent = code;
    void this.load();
    document.querySelector('mat-sidenav-content')?.scrollTo({ top: 0, behavior: 'smooth' });
  }
  pickStage(id: StageId) { this.pickedStage.set(this.pickedStage() === id ? null : id); }
  pickLayer(l: MapLayer) { this.pickedLayer.set(this.pickedLayer() === l ? null : l); }

  /** The map's "reporting" colours follow the stage: agents in place, units sending turnout, units counted… */
  private draw() {
    const d = this.data();
    if (!d || !this.areaMap) return;
    const st = this.stage();
    const reported = (a: DayArea) => st === 'checkin' ? a.checked_in : st === 'accreditation' ? a.turnout_units
      : st === 'irev' ? a.irev : st === 'ec8a' ? a.ec8a + a.irev : a.reported;
    const shown: MapData = this.layer() === 'reporting' ? { ...d, children: d.children.map((a) => ({ ...a, reported: reported(a) })) } : d;
    this.areaMap.render(shown, this.layer(), (a) => { if (d.childLevel !== 'pu') this.open(a.code); });
  }

  share(a: number, b: number) { return this.pctLabel(b ? a / b : 0); }
  pct(a: number, b: number) { return b ? Math.min(100, Math.round((a / b) * 100)) : 0; }
  sevName(s: string) { return ({ critical: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' } as Record<string, string>)[s] ?? s; }
  place(c: CaseRow) { return (c.where && placeLine(c.where, false)) || c.pu_code || c.area_code; }
}
