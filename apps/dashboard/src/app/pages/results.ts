import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

interface Tally { stage: 'quick' | 'ec8a' | 'irev'; party: string; votes: number; units: number }
interface Overview { area_code: string; name: string; units_covered: number; quick_tallies: number; ec8a_reported: number; irev_uploaded: number; verified: number; mismatched: number }
interface Estimate { state_code: string; party: string; share: number; margin: number; units_reported: number; units_in_sample: number }

/** Live results (internal only): early estimate, our EC8A tally, IReV tally, and matching. */
@Component({
  selector: 'app-results',
  imports: [DecimalPipe, PercentPipe, MatButtonModule, MatCardModule, MatIconModule, MatTableModule, MatProgressBarModule],
  template: `
  <div class="head"><h1>Live results <span class="internal">internal only</span></h1><span class="spacer"></span>
    @if (area() !== 'NG') { <button mat-stroked-button (click)="setArea('NG')"><mat-icon>arrow_back</mat-icon> All states</button> }
    <span class="upd">Updated {{ updated() }}</span></div>

  <div class="stages">
    @for (s of stages; track s.key) {
      <mat-card appearance="outlined" class="stage">
        <div class="sname">{{ s.title }}</div><div class="sdesc">{{ s.desc }}</div>
        @for (p of top(s.key); track p.party) {
          <div class="bar"><span class="pn">{{ p.party }}</span>
            <mat-progress-bar mode="determinate" [value]="p.share * 100" />
            <span class="pv">{{ p.share | percent: '1.1-1' }} · {{ p.votes | number }}</span></div>
        } @empty { <div class="none">No data yet</div> }
        <div class="units">{{ unitsOf(s.key) | number }} units</div>
      </mat-card>
    }
  </div>

  @if (area() === 'NG' && estimate().length) {
    <h2>Sample estimate by state</h2>
    <table mat-table [dataSource]="estimate()">
      <ng-container matColumnDef="state"><th mat-header-cell *matHeaderCellDef>State</th><td mat-cell *matCellDef="let e">{{ e.state_code }}</td></ng-container>
      <ng-container matColumnDef="party"><th mat-header-cell *matHeaderCellDef>Party</th><td mat-cell *matCellDef="let e">{{ e.party }}</td></ng-container>
      <ng-container matColumnDef="share"><th mat-header-cell *matHeaderCellDef>Share</th><td mat-cell *matCellDef="let e">{{ e.share | percent: '1.1-1' }} ± {{ e.margin | percent: '1.1-1' }}</td></ng-container>
      <ng-container matColumnDef="units"><th mat-header-cell *matHeaderCellDef>Sample units in</th><td mat-cell *matCellDef="let e">{{ e.units_reported }} / {{ e.units_in_sample }}</td></ng-container>
      <tr mat-header-row *matHeaderRowDef="['state','party','share','units']"></tr>
      <tr mat-row *matRowDef="let r; columns: ['state','party','share','units']"></tr>
    </table>
  }

  <h2>Reporting and matching {{ area() === 'NG' ? 'by state' : 'by LGA in ' + area() }}</h2>
  <table mat-table [dataSource]="overview()">
    <ng-container matColumnDef="area"><th mat-header-cell *matHeaderCellDef>Area</th>
      <td mat-cell *matCellDef="let o"><a class="link" (click)="area() === 'NG' && setArea(o.area_code)">{{ o.name ?? o.area_code }}</a></td></ng-container>
    <ng-container matColumnDef="covered"><th mat-header-cell *matHeaderCellDef>Units with agents</th><td mat-cell *matCellDef="let o">{{ o.units_covered | number }}</td></ng-container>
    <ng-container matColumnDef="quick"><th mat-header-cell *matHeaderCellDef>Quick counts</th><td mat-cell *matCellDef="let o">{{ pct(o.quick_tallies, o.units_covered) }}</td></ng-container>
    <ng-container matColumnDef="ec8a"><th mat-header-cell *matHeaderCellDef>Our EC8A</th><td mat-cell *matCellDef="let o">{{ pct(o.ec8a_reported, o.units_covered) }}</td></ng-container>
    <ng-container matColumnDef="irev"><th mat-header-cell *matHeaderCellDef>On IReV</th><td mat-cell *matCellDef="let o">{{ pct(o.irev_uploaded, o.units_covered) }}</td></ng-container>
    <ng-container matColumnDef="verified"><th mat-header-cell *matHeaderCellDef>Matched</th><td mat-cell *matCellDef="let o">{{ o.verified | number }}</td></ng-container>
    <ng-container matColumnDef="mismatch"><th mat-header-cell *matHeaderCellDef>Mismatch</th><td mat-cell *matCellDef="let o" [class.bad]="o.mismatched">{{ o.mismatched | number }}</td></ng-container>
    <tr mat-header-row *matHeaderRowDef="ocols"></tr>
    <tr mat-row *matRowDef="let r; columns: ocols"></tr>
  </table>`,
  styles: `.head { display: flex; align-items: center; gap: 12px; } .spacer { flex: 1; } h1 { font: var(--mat-sys-headline-small); }
    .internal { font: var(--mat-sys-label-small); background: var(--mat-sys-error-container); color: var(--mat-sys-on-error-container); padding: 2px 8px; border-radius: 8px; vertical-align: middle; }
    .upd { color: var(--mat-sys-on-surface-variant); font-size: 12px; }
    .stages { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 12px 0 24px; }
    .stage { padding: 16px; } .sname { font: var(--mat-sys-title-medium); } .sdesc { font-size: 12px; color: var(--mat-sys-on-surface-variant); margin-bottom: 12px; }
    .bar { display: grid; grid-template-columns: 56px 1fr 130px; gap: 8px; align-items: center; margin: 6px 0; } .pv { font-size: 12px; text-align: right; }
    .units { margin-top: 8px; font-size: 12px; } .none { color: var(--mat-sys-on-surface-variant); }
    table { width: 100%; margin-bottom: 24px; } .bad { color: #b3261e; font-weight: 600; } .link { cursor: pointer; color: var(--mat-sys-primary); }
    h2 { font: var(--mat-sys-title-medium); }`,
})
export class ResultsPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  stages = [
    { key: 'quick' as const, title: '1. Early estimate', desc: 'Quick counts from agents and volunteers' },
    { key: 'ec8a' as const, title: '2. Our EC8A tally', desc: 'Signed sheets submitted by our agents' },
    { key: 'irev' as const, title: '3. IReV tally', desc: 'INEC uploads, read by OCR (official)' },
  ];
  ocols = ['area', 'covered', 'quick', 'ec8a', 'irev', 'verified', 'mismatch'];
  area = signal('NG');
  tallies = signal<Tally[]>([]);
  overview = signal<Overview[]>([]);
  estimate = signal<Estimate[]>([]);
  updated = signal('');
  private timer = setInterval(() => void this.load(), 60_000);

  constructor() { void this.load(); }
  ngOnDestroy() { clearInterval(this.timer); }

  setArea(a: string) { this.area.set(a); void this.load(); }

  top(stage: Tally['stage']) {
    const rows = this.tallies().filter((t) => t.stage === stage);
    const total = rows.reduce((a, r) => a + Number(r.votes), 0) || 1;
    return rows.map((r) => ({ party: r.party, votes: Number(r.votes), share: Number(r.votes) / total }))
      .sort((a, b) => b.votes - a.votes).slice(0, 6);
  }
  unitsOf(stage: Tally['stage']) { return Math.max(0, ...this.tallies().filter((t) => t.stage === stage).map((t) => t.units)); }
  pct(n: number, d: number) { return d ? `${n} (${Math.round((100 * n) / d)}%)` : '—'; }

  async load() {
    const e = this.api.liveElectionId();
    if (!e) return;
    try {
      const [t, o, est] = await Promise.all([
        this.api.get<Tally[]>('/results/tallies', { election: e, area: this.area() }),
        this.api.get<Overview[]>('/results/overview', { election: e, state: this.area() === 'NG' ? undefined : this.area() }),
        this.area() === 'NG' ? this.api.get<Estimate[]>('/results/sample-estimate', { election: e }) : Promise.resolve([] as Estimate[]),
      ]);
      this.tallies.set(t); this.overview.set(o); this.estimate.set(est);
      this.updated.set(new Date().toLocaleTimeString());
    } catch (err) { this.ui.error(err); }
  }
}
