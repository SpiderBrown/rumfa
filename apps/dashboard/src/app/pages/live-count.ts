import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { partyColour } from '@rumfa/shared';
import { Api } from '../core/api';
import { Ui, AgoPipe } from '../core/ui';

interface Agg { units: number; counting: number; done: number; ballots: number; invalid: number; votes: Record<string, number>; updatedAt: string | null }
interface Child extends Agg { code: string; name: string }
interface Summary extends Agg {
  area: string; scope: string; parties: string[]; unitsInArea: number; unitsWithAgent: number;
  breadcrumb: { code: string; name: string }[]; childLevel: 'state' | 'lga' | 'ward' | 'pu' | null; children: Child[];
}
const LEVEL_NAME: Record<string, string> = { state: 'State', lga: 'LGA', ward: 'Ward', pu: 'Polling unit' };

/**
 * Live count: ballots as they are called during sorting at each unit, summed for any state, LGA or ward,
 * before results are announced or uploaded. Partial by nature: it shows how far counting has got.
 */
@Component({
  selector: 'app-live-count',
  imports: [DecimalPipe, PercentPipe, MatIconModule, AgoPipe],
  template: `
  <div class="head">
    <h1>Live count <span class="internal">internal · partial while sorting</span></h1>
    <nav class="crumbs">
      @for (b of s()?.breadcrumb ?? []; track b.code; let last = $last) {
        @if (last) { <b>{{ b.name }}</b> } @else { <a (click)="open(b.code)">{{ b.name }}</a><mat-icon>chevron_right</mat-icon> }
      }
    </nav>
    <span class="spacer"></span>
    @if (s()?.updatedAt) { <span class="upd"><span class="dot"></span>Last ballot {{ s()!.updatedAt | ago }}</span> }
  </div>

  @if (s(); as d) {
    <section class="kpis">
      <div><b>{{ d.ballots | number }}</b><span>ballots called</span></div>
      <div><b>{{ d.counting }}</b><span>units sorting now</span></div>
      <div><b>{{ d.done }}</b><span>units finished</span></div>
      <div><b>{{ d.units }} / {{ d.unitsWithAgent }}</b><span>units with agents reporting</span></div>
      <div><b>{{ d.invalid | number }}</b><span>invalid</span></div>
    </section>

    <section class="bars">
      @for (v of shares(d); track v.party) {
        <div class="bar"><span class="p">{{ v.party }}</span>
          <span class="track"><span class="fill" [style.width.%]="v.share * 100" [style.background]="colour(v.party)"></span></span>
          <span class="n">{{ v.share | percent: '1.1-1' }}</span><span class="v">{{ v.votes | number }}</span></div>
      } @empty { <p class="none">No ballots called yet in this area.</p> }
    </section>

    @if (d.childLevel) {
      <table>
        <thead><tr><th>{{ level(d.childLevel) }}</th><th>Sorting</th><th>Finished</th><th>Ballots</th><th>Leading</th><th class="mini">Split</th><th>Last ballot</th></tr></thead>
        <tbody>
          @for (c of rows(); track c.code) {
            <tr [class.click]="d.childLevel !== 'pu'" [class.quiet]="!c.units" (click)="d.childLevel !== 'pu' && open(c.code)">
              <td>{{ c.name }} <span class="code">{{ c.code }}</span></td>
              <td>{{ c.counting || '' }}</td><td>{{ c.done || '' }}</td><td>{{ c.ballots ? (c.ballots | number) : '' }}</td>
              <td>@if (lead(c); as l) { <span class="chip" [style.border-color]="colour(l.party)">{{ l.party }} {{ l.share | percent }}</span> }</td>
              <td class="mini"><span class="stack">@for (v of shares(c); track v.party) { <i [style.width.%]="v.share * 100" [style.background]="colour(v.party)"></i> }</span></td>
              <td class="sub">{{ c.updatedAt ? (c.updatedAt | ago) : '' }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  } @else { <p>Loading…</p> }`,
  styles: `
    .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    h1 { font: var(--mat-sys-headline-small); margin: 0; }
    .internal { font-size: 12px; font-weight: 400; color: var(--mat-sys-on-surface-variant); margin-left: 8px; }
    .crumbs { display: flex; align-items: center; flex-wrap: wrap; } .crumbs a { cursor: pointer; color: var(--mat-sys-primary); }
    .crumbs mat-icon { font-size: 18px; height: 18px; width: 18px; color: var(--mat-sys-outline); }
    .spacer { flex: 1; } .upd { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; animation: pulse 1.6s infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
    .kpis div { background: var(--mat-sys-surface-container); border-radius: 12px; padding: 10px 12px; }
    .kpis b { display: block; font: var(--mat-sys-headline-small); } .kpis span { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
    .bars { margin: 16px 0; max-width: 760px; }
    .bar { display: grid; grid-template-columns: 70px 1fr 64px 90px; align-items: center; gap: 8px; margin: 6px 0; }
    .p { font-weight: 600; } .track { height: 16px; background: var(--mat-sys-surface-container-high); border-radius: 8px; overflow: hidden; }
    .fill { display: block; height: 100%; transition: width .6s; } .n { text-align: right; font-weight: 600; } .v { text-align: right; color: var(--mat-sys-on-surface-variant); }
    .none { color: var(--mat-sys-on-surface-variant); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-weight: 500; color: var(--mat-sys-on-surface-variant); border-bottom: 1px solid var(--mat-sys-outline-variant); padding: 6px; }
    td { padding: 6px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    tr.click { cursor: pointer; } tr.click:hover { background: var(--mat-sys-surface-container); } tr.quiet { color: var(--mat-sys-outline); }
    .code { font-size: 11px; color: var(--mat-sys-outline); margin-left: 4px; }
    .chip { font-size: 12px; padding: 1px 6px; border-radius: 8px; border: 1px solid; }
    .mini { width: 160px; } .stack { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--mat-sys-surface-container-high); }
    .stack i { display: block; height: 100%; } .sub { font-size: 12px; color: var(--mat-sys-on-surface-variant); }
  `,
})
export class LiveCountPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  s = signal<Summary | null>(null);
  private area: string | null = null;
  private timer = setInterval(() => void this.load(), 5000);
  private stopLive = this.api.onChange(() => void this.load(), ['live_counts']);

  rows = computed(() => [...(this.s()?.children ?? [])].sort((a, b) => b.ballots - a.ballots || a.name.localeCompare(b.name)));

  constructor() { void this.load(); }
  ngOnDestroy() { clearInterval(this.timer); this.stopLive(); }

  async load() {
    try {
      const d = await this.api.get<Summary>('/live-counts/summary', { area: this.area ?? undefined });
      this.s.set(d);
      this.area = d.area;
    } catch (e) { this.ui.error(e); clearInterval(this.timer); }
  }

  open(code: string) { this.area = code; void this.load(); }
  level(l: string) { return LEVEL_NAME[l] ?? l; }
  colour(p: string) { return partyColour(p, this.s()?.parties ?? [], this.api.partyColours()); }

  shares(a: Agg) {
    const total = Object.values(a.votes).reduce((x, y) => x + y, 0);
    const order = this.s()?.parties ?? [];
    return Object.entries(a.votes).map(([party, votes]) => ({ party, votes, share: total ? votes / total : 0 }))
      .sort((x, y) => y.votes - x.votes || order.indexOf(x.party) - order.indexOf(y.party));
  }
  lead(a: Agg) { return this.shares(a)[0] ?? null; }
}
