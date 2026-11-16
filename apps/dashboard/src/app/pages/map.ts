import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ISSUE_BANDS, REPORTING_BANDS, issueScore, partyColour, type MapLayer } from '@rumfa/shared';
import { Api } from '../core/api';
import { AreaMap, type MapArea, type MapData } from '../core/area-map';
import { Calls } from '../core/calls';
import { Ui } from '../core/ui';

const LEVEL_NAME: Record<string, string> = { zone: 'Zones', state: 'States', senatorial: 'Senatorial districts', lga: 'LGAs', ward: 'Wards', pu: 'Polling units' };

/**
 * Situation map: the sub-areas of your area coloured by open issues, the leading party or reporting.
 * Click an area to go down a level (state → LGA → ward → polling units). Updates live as cases and
 * results come in.
 */
@Component({
  selector: 'app-map',
  imports: [DecimalPipe, PercentPipe, MatButtonModule, MatButtonToggleModule, MatIconModule, MatTooltipModule],
  template: `
  <div class="head">
    <h1>Situation map</h1>
    <nav class="crumbs">
      @for (b of data()?.breadcrumb ?? []; track b.code; let last = $last) {
        @if (last) { <b>{{ b.name }}</b> } @else { <a (click)="open(b.code)">{{ b.name }}</a><mat-icon>chevron_right</mat-icon> }
      }
    </nav>
 <span class="spacer"></span>
    @if (data()?.scope === 'NG' && (data()?.level === 'national' || data()?.level === 'zone')) {
      <!-- The country can be seen by state or by geopolitical zone -->
      <mat-button-toggle-group class="group" [value]="zones() ? 'zone' : 'state'" (change)="setZones($event.value === 'zone')" hideSingleSelectionIndicator aria-label="Show Nigeria as">
        <mat-button-toggle value="state">States</mat-button-toggle>
        <mat-button-toggle value="zone">Zones</mat-button-toggle>
      </mat-button-toggle-group>
    }
    @if (data()?.level === 'state' || data()?.level === 'senatorial') {
      <!-- A state can be seen by LGA or by senatorial district (how Senate seats are won) -->
      <mat-button-toggle-group class="group" [value]="group()" (change)="setGroup($event.value)" hideSingleSelectionIndicator aria-label="Show areas as">
        <mat-button-toggle value="lga">LGAs</mat-button-toggle>
        <mat-button-toggle value="senatorial">Senatorial districts</mat-button-toggle>
      </mat-button-toggle-group>
    }
    <mat-button-toggle-group [value]="layer()" (change)="setLayer($event.value)" hideSingleSelectionIndicator>
      <mat-button-toggle value="issues"><mat-icon>warning</mat-icon> Issues</mat-button-toggle>
      <mat-button-toggle value="votes"><mat-icon>how_to_vote</mat-icon> Votes</mat-button-toggle>
      <mat-button-toggle value="reporting"><mat-icon>fact_check</mat-icon> Reporting</mat-button-toggle>
    </mat-button-toggle-group>
  </div>

  <div class="body">
    <div class="mapwrap">
      <div #map class="map"></div>
      <div class="legend">
        @switch (layer()) {
          @case ('issues') { @for (b of issueBands; track b.label) { <span><i [style.background]="b.colour"></i>{{ b.label }}</span> } }
          @case ('votes') {
            @for (p of partiesShown(); track p) { <span><i [style.background]="colour(p)"></i>{{ p }}</span> }
            <span class="note">Stronger colour = wider lead</span>
          }
          @case ('reporting') { @for (b of reportingBands; track b.label) { <span><i [style.background]="b.colour"></i>{{ b.label }}</span> } }
        }
      </div>
      @if (approx() > 0) {
        <div class="noshape">{{ approxNote() }}</div>
      } @else if (noShape() > 0) { <div class="noshape">{{ noShape() }} {{ childName().toLowerCase() }} have no outline yet: load boundaries with <code>npm run import:boundaries</code>.</div> }
    </div>

    <aside class="panel">
      @if (data(); as d) {
        <section class="sum">
          <div><b>{{ totals().units | number }}</b><span>units</span></div>
          <div><b>{{ totals().reported / (totals().units || 1) | percent }}</b><span>reported</span></div>
          <div [class.bad]="totals().open > 0"><b>{{ totals().open }}</b><span>open issues</span></div>
          <div [class.bad]="totals().critical > 0"><b>{{ totals().critical }}</b><span>critical</span></div>
        </section>
        @if (d.areaWide.open) { <p class="wide">{{ d.areaWide.open }} open issue(s) cover the whole of {{ d.breadcrumb.at(-1)?.name }}.</p> }
        @if (voteTotals().length) {
          <section class="votes">
            @for (v of voteTotals(); track v.party) {
              <div class="bar"><span class="p">{{ v.party }}</span>
                <span class="track"><span class="fill" [style.width.%]="v.share * 100" [style.background]="colour(v.party)"></span></span>
                <span class="n">{{ v.votes | number }}</span></div>
            }
          </section>
        }
        <h3>{{ childName() }} <span class="sub">({{ d.children.length }})</span></h3>
        <div class="list">
          @for (a of sorted(); track a.code) {
            <div class="row" [class.sel]="a.code === selected()" (click)="clickArea(a)">
              <div class="name">{{ a.name }} @if (!a.code.startsWith('Z-')) { <span class="code">{{ a.code }}</span> }</div>
              <div class="chips">
                @if (a.critical) { <span class="chip crit">{{ a.critical }} critical</span> }
                @if (a.open) { <span class="chip warn">{{ a.open }} open</span> }
                @if (a.leader) { <span class="chip" [style.border-color]="colour(a.leader.party)">{{ a.leader.party }} {{ a.leader.share | percent }}</span> }
                <span class="chip">{{ a.reported }}/{{ d.childLevel === 'pu' ? 1 : a.units }} reported</span>
                @if (a.mismatch) { <span class="chip warn">{{ a.mismatch }} mismatch</span> }
                <span class="chip">{{ a.agents }} agent{{ a.agents === 1 ? '' : 's' }}</span>
              </div>
              @if (a.coordinator) {
                <div class="coord"><mat-icon>person</mat-icon> {{ a.coordinator.full_name }}
                  <button mat-icon-button matTooltip="Call coordinator" (click)="call(a, $event)"><mat-icon>call</mat-icon></button></div>
              }
            </div>
          }
        </div>
      } @else { <p class="sub">Loading…</p> }
    </aside>
  </div>`,
  styles: `
    :host { display: block; }
    .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    h1 { font: var(--mat-sys-headline-small); margin: 0; }
    .crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
    .crumbs a { cursor: pointer; color: var(--mat-sys-primary); } .crumbs mat-icon { font-size: 18px; height: 18px; width: 18px; color: var(--mat-sys-outline); }
    .spacer { flex: 1; }
    .body { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 16px; }
    @media (max-width: 1000px) { .body { grid-template-columns: 1fr; } }
    .mapwrap { position: relative; }
    .map { height: calc(100vh - 170px); min-height: 420px; border-radius: 12px; border: 1px solid var(--mat-sys-outline-variant); background: #eef1f4; }
    .legend { position: absolute; left: 12px; bottom: 12px; z-index: 500; background: var(--mat-sys-surface); padding: 8px 10px; border-radius: 8px;
      box-shadow: 0 1px 6px rgba(0,0,0,.2); display: flex; flex-direction: column; gap: 4px; font-size: 12px; max-height: 50%; overflow: auto; }
    .legend span { display: flex; align-items: center; gap: 6px; } .legend i { width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,.2); }
    .legend .note { color: var(--mat-sys-on-surface-variant); }
    .noshape { position: absolute; right: 12px; top: 12px; z-index: 500; background: var(--mat-sys-tertiary-container); padding: 6px 10px; border-radius: 8px; font-size: 12px; max-width: min(360px, calc(100% - 70px)); }
    .panel { height: calc(100vh - 170px); min-height: 420px; overflow: auto; }
    .sum { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .sum div { background: var(--mat-sys-surface-container); border-radius: 10px; padding: 8px; text-align: center; }
    .sum b { display: block; font: var(--mat-sys-title-large); } .sum span { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .sum .bad b { color: var(--mat-sys-error); }
    .wide { font-size: 13px; color: var(--mat-sys-error); }
    .votes { margin: 12px 0; } .bar { display: grid; grid-template-columns: 56px 1fr 72px; align-items: center; gap: 6px; font-size: 13px; margin: 3px 0; }
    .track { height: 10px; background: var(--mat-sys-surface-container-high); border-radius: 5px; overflow: hidden; } .fill { display: block; height: 100%; }
    .n { text-align: right; }
    h3 { font: var(--mat-sys-title-small); margin: 16px 0 6px; } .sub { color: var(--mat-sys-on-surface-variant); font-weight: 400; }
    .group { margin-right: 8px; }
    .row { padding: 8px 10px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
    .row:hover { background: var(--mat-sys-surface-container); } .row.sel { border-color: var(--mat-sys-primary); }
    .name { font-weight: 500; } .code { font-size: 11px; color: var(--mat-sys-outline); margin-left: 4px; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .chip { font-size: 11px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--mat-sys-outline-variant); }
    .chip.warn { background: #fff1e0; border-color: #fb923c; } .chip.crit { background: #fde2e2; border-color: #b3261e; color: #8f1d1d; }
    .coord { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .coord mat-icon { font-size: 16px; height: 16px; width: 16px; }
  `,
})
export class MapPage implements AfterViewInit, OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  private calls = inject(Calls);
  private el = viewChild.required<ElementRef<HTMLElement>>('map');
  private areaMap: AreaMap | null = null;
  private stopLive: () => void = () => undefined;
  private timer: any;
  private reloadTimer: any;

  readonly issueBands = ISSUE_BANDS;
  readonly reportingBands = REPORTING_BANDS.map((colour, i) => ({ colour, label: ['None', 'Under 25%', '25–50%', '50–90%', '90% or more'][i] }));
  data = signal<MapData | null>(null);
  layer = signal<MapLayer>((localStorage.getItem('rumfa.map.layer') as MapLayer) ?? 'issues');
  selected = signal<string | null>(null);
  private parent: string | null = null;
  /** Show a state's areas as LGAs or senatorial districts (kept while drilling down, so the path shows the district) */
  group = signal<'lga' | 'senatorial'>((localStorage.getItem('rumfa.map.group') as 'lga' | 'senatorial') ?? 'lga');
  /** Show the country by geopolitical zone instead of by state (national staff; kept while drilling down) */
  zones = signal(localStorage.getItem('rumfa.map.zones') === '1');

  childName = computed(() => LEVEL_NAME[this.data()?.childLevel ?? 'state']);
  approx = computed(() => (this.data()?.children ?? []).filter((c) => c.approx).length);
  /** Says plainly that dashed circles are rough places, not real ones */
  approxNote = computed(() => {
    const n = this.approx(), d = this.data();
    const pu = d?.childLevel === 'pu';
    const what = pu ? (n === 1 ? 'polling unit has no location' : 'polling units have no location') : (n === 1 ? 'ward has no outline' : 'wards have no outline');
    return `${n} ${what} yet, so ${n === 1 ? 'it is' : 'they are'} shown as ${n === 1 ? 'a dashed circle at a rough place' : 'dashed circles at rough places'}, not real ${n === 1 ? 'one' : 'ones'}.`
      + (d?.approxArea ? ' This ward is placed roughly too.' : '');
  });
  noShape = computed(() => (this.data()?.children ?? []).filter((c) => !c.shape && (c.lat == null || c.lng == null)).length);
  totals = computed(() => {
    const d = this.data();
    const t = { units: 0, reported: 0, open: d?.areaWide.open ?? 0, critical: d?.areaWide.critical ?? 0 };
    for (const c of d?.children ?? []) {
      t.units += d!.childLevel === 'pu' ? 1 : c.units; t.reported += c.reported; t.open += c.open; t.critical += c.critical;
    }
    return t;
  });
  voteTotals = computed(() => {
    const sum: Record<string, number> = {};
    for (const c of this.data()?.children ?? []) for (const [p, n] of Object.entries(c.votes)) sum[p] = (sum[p] ?? 0) + n;
    const total = Object.values(sum).reduce((a, b) => a + b, 0);
    return Object.entries(sum).sort((a, b) => b[1] - a[1]).map(([party, votes]) => ({ party, votes, share: total ? votes / total : 0 }));
  });
  partiesShown = computed(() => {
    const leading = new Set((this.data()?.children ?? []).map((c) => c.leader?.party).filter(Boolean) as string[]);
    return leading.size ? [...leading] : (this.data()?.parties ?? []).slice(0, 6);
  });
  sorted = computed(() => {
    const kids = [...(this.data()?.children ?? [])];
    const l = this.layer();
    if (l === 'issues') return kids.sort((a, b) => issueScore(b) - issueScore(a) || a.name.localeCompare(b.name));
    if (l === 'reporting') return kids.sort((a, b) => a.reported / (a.units || 1) - b.reported / (b.units || 1) || a.name.localeCompare(b.name));
    return kids.sort((a, b) => (b.leader?.votes ?? 0) - (a.leader?.votes ?? 0) || a.name.localeCompare(b.name));
  });

  ngAfterViewInit() {
    this.areaMap = new AreaMap(this.el().nativeElement, window.RUMFA_CONFIG.mapTiles);
    void this.load();
    // Live: new cases and verified results; plus a slow refresh for agents' results
    this.stopLive = this.api.onChange(() => { clearTimeout(this.reloadTimer); this.reloadTimer = setTimeout(() => void this.load(), 2500); },
      ['cases', 'verifications']);
    this.timer = setInterval(() => void this.load(), 60_000);
  }
  ngOnDestroy() { this.stopLive(); clearInterval(this.timer); clearTimeout(this.reloadTimer); this.areaMap?.destroy(); }

  async load() {
    try {
      const group = [this.zones() && 'zone', this.group() === 'senatorial' && 'senatorial'].filter(Boolean).join(',');
      const d = await this.api.get<MapData>('/map', { parent: this.parent ?? undefined, group: group || undefined });
      this.data.set(d);
      this.parent = d.parent;
      this.draw();
    } catch (e) { this.ui.error(e); }
  }

  open(code: string) { this.parent = code; this.selected.set(null); void this.load(); }

  clickArea(a: MapArea) {
    if (this.data()?.childLevel === 'pu') { this.selected.set(a.code); this.draw(); return; }
    this.open(a.code);
  }

  setGroup(g: 'lga' | 'senatorial') {
    this.group.set(g);
    try { localStorage.setItem('rumfa.map.group', g); } catch { /* private mode */ }
    // From a district, "LGAs" goes back to the whole state by LGA
    if (g === 'lga' && this.parent?.includes('SD')) this.parent = this.parent.slice(0, 2);
    this.selected.set(null);
    void this.load();
  }

  setZones(on: boolean) {
    this.zones.set(on);
    try { localStorage.setItem('rumfa.map.zones', on ? '1' : '0'); } catch { /* private mode */ }
    // From a zone, "States" goes back to the whole country by state
    if (!on && this.parent?.startsWith('Z-')) this.parent = 'NG';
    this.selected.set(null);
    void this.load();
  }

  setLayer(l: MapLayer) {
    this.layer.set(l);
    try { localStorage.setItem('rumfa.map.layer', l); } catch { /* private mode */ }
    this.draw();
  }

  colour(p: string) { const d = this.data(); return partyColour(p, d?.parties ?? [], d?.partyColours ?? {}); }

  call(a: MapArea, ev: Event) {
    ev.stopPropagation();
    if (a.coordinator) void this.calls.call('volunteer', a.coordinator.id, a.coordinator.full_name);
  }

  private draw() {
    const d = this.data();
    if (d && this.areaMap) this.areaMap.render(d, this.layer(), (a) => this.clickArea(a), this.selected());
  }
}
