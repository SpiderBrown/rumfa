import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { AgoPipe, Ui, label } from '../core/ui';

interface AreaRow { area_code: string; name: string; units: number; not_checked: number; not_on_irev: number; on_irev: number;
  downloaded: number; replaced: number; failed: number; ocr_read: number; ocr_review: number; ocr_confirmed: number }
interface Job { id: string; job_type: string; area_level: string; area_code: string; status: string; counts: Record<string, number>;
  auto_recheck: boolean; interval_min: number; created_at: string; next_run_at: string | null; error: string | null }

/** IReV data manager (design section 11.5): fetch and track result sheets by state, LGA and ward. */
@Component({
  selector: 'app-irev',
  imports: [FormsModule, RouterLink, MatButtonModule, MatButtonToggleModule, MatCardModule, MatIconModule, MatMenuModule,
    MatProgressBarModule, MatTableModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="head"><h1>IReV data</h1><span class="spacer"></span>
    <mat-button-toggle-group [ngModel]="mode()" (ngModelChange)="setMode($event)" hideSingleSelectionIndicator>
      <mat-button-toggle value="baseline">Baseline (past election)</mat-button-toggle>
      <mat-button-toggle value="live">Live (current election)</mat-button-toggle>
    </mat-button-toggle-group>
    <a mat-stroked-button routerLink="/irev/review"><mat-icon>fact_check</mat-icon> Review queue</a>
  </div>

  <div class="crumbs">
    @for (c of crumbs(); track c.code; let last = $last) {
      <a (click)="go(c.code)" [class.cur]="last">{{ c.name }}</a> @if (!last) { <span>›</span> }
    }
  </div>

  <table mat-table [dataSource]="rows()">
    <ng-container matColumnDef="area"><th mat-header-cell *matHeaderCellDef>{{ levelName() }}</th>
      <td mat-cell *matCellDef="let r">
        @if (isUnitLevel()) { <a (click)="openUnit(r)">{{ r.area_code }} {{ r.name }}</a> }
        @else { <a (click)="go(r.area_code)">{{ r.name ?? r.area_code }}</a> <span class="code">{{ r.area_code }}</span> }</td></ng-container>
    <ng-container matColumnDef="progress"><th mat-header-cell *matHeaderCellDef>Sheets downloaded</th>
      <td mat-cell *matCellDef="let r"><mat-progress-bar mode="determinate" [value]="100 * (r.downloaded + r.replaced) / r.units" />
        <span class="small">{{ r.downloaded + r.replaced }} / {{ r.units }}</span></td></ng-container>
    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>On IReV / missing / replaced / failed / unchecked</th>
      <td mat-cell *matCellDef="let r" class="small">
        {{ r.on_irev + r.downloaded + r.replaced }} / <span [class.warn]="r.not_on_irev">{{ r.not_on_irev }}</span> /
        <span [class.bad]="r.replaced">{{ r.replaced }}</span> / <span [class.bad]="r.failed">{{ r.failed }}</span> / {{ r.not_checked }}</td></ng-container>
    <ng-container matColumnDef="ocr"><th mat-header-cell *matHeaderCellDef>Figures read / review / confirmed</th>
      <td mat-cell *matCellDef="let r" class="small">{{ r.ocr_read }} / <span [class.warn]="r.ocr_review">{{ r.ocr_review }}</span> / {{ r.ocr_confirmed }}</td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th>
      <td mat-cell *matCellDef="let r" class="acts">
        @if (!isUnitLevel()) {
          <button mat-stroked-button (click)="fetch(r.area_code, mode())">Fetch</button>
          <button mat-icon-button [matMenuTriggerFor]="more" matTooltip="More"><mat-icon>more_vert</mat-icon></button>
          <mat-menu #more>
            <button mat-menu-item (click)="fetch(r.area_code, 'recheck')">Recheck missing and replaced</button>
            <button mat-menu-item (click)="fetch(r.area_code, 'ocr')">Read figures (OCR)</button>
            @if (mode() === 'live') { <button mat-menu-item (click)="fetch(r.area_code, 'live', true)">Watch for uploads (every 10 min)</button> }
            <button mat-menu-item (click)="exportCsv(r.area_code)">Export unit list (CSV)</button>
          </mat-menu>
        }
      </td></ng-container>
    <tr mat-header-row *matHeaderRowDef="cols"></tr>
    <tr mat-row *matRowDef="let r; columns: cols"></tr>
  </table>

  @if (unit(); as u) {
    <mat-card appearance="outlined" class="unit">
      <mat-card-header><mat-card-title>{{ u.pu_code }}</mat-card-title>
        <mat-card-subtitle>{{ label(u.status) }} · figures {{ label(u.ocr_status) }} @if (u.first_seen_at) { · first seen {{ u.first_seen_at | ago }} }
          @if (u.replaced_count) { · <span class="bad">replaced {{ u.replaced_count }}×</span> }</mat-card-subtitle></mat-card-header>
      <mat-card-content>
        @if (u.storage_path) { <button mat-flat-button (click)="openSheet(u.pu_code)">Open sheet</button> }
        @if (u.last_error) { <p class="bad">Last error: {{ u.last_error }}</p> }
        <h3>Check history</h3>
        @for (l of unitLog(); track l.id) { <div class="small">{{ l.at | ago }} · {{ label(l.status) }}</div> }
      </mat-card-content>
    </mat-card>
  }

  <h2>Jobs</h2>
  @for (j of jobs(); track j.id) {
    <div class="job">
      <div><b>{{ label(j.job_type) }}</b> · {{ j.area_level }} {{ j.area_code }} · {{ label(j.status) }}
        @if (j.auto_recheck) { · every {{ j.interval_min }} min, next {{ j.next_run_at | ago }} } · started {{ j.created_at | ago }}</div>
      <div class="small">{{ countsText(j.counts) }} @if (j.error) { <span class="bad">{{ j.error }}</span> }</div>
      <div class="acts">
        @if (j.status === 'running') { <button mat-button (click)="setJob(j, 'paused')">Pause</button> }
        @if (j.status === 'paused') { <button mat-button (click)="setJob(j, 'queued')">Resume</button> }
        @if (['running','paused','queued'].includes(j.status)) { <button mat-button (click)="setJob(j, 'cancelled')">Cancel</button> }
      </div>
    </div>
  } @empty { <p class="small">No jobs yet. Use Fetch on a state, LGA or ward.</p> }`,
  styles: `.head { display: flex; align-items: center; gap: 12px; } .spacer { flex: 1; } h1 { font: var(--mat-sys-headline-small); }
    .crumbs { display: flex; gap: 6px; margin: 8px 0 12px; } .crumbs a { cursor: pointer; color: var(--mat-sys-primary); } .crumbs a.cur { color: inherit; font-weight: 600; }
    table { width: 100%; } td a { cursor: pointer; color: var(--mat-sys-primary); } .code { font-size: 11px; color: var(--mat-sys-on-surface-variant); margin-left: 6px; }
    .small { font-size: 12px; } .warn { color: #c25700; } .bad { color: #b3261e; font-weight: 600; } .acts { display: flex; gap: 4px; align-items: center; }
    .job { border-bottom: 1px solid var(--mat-sys-outline-variant); padding: 8px 0; } .unit { margin: 16px 0; } h2 { font: var(--mat-sys-title-medium); margin-top: 24px; }
    mat-progress-bar { width: 140px; display: inline-block; margin-right: 8px; }`,
})
export class IrevPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  label = label;
  cols = ['area', 'progress', 'status', 'ocr', 'act'];
  mode = signal<'baseline' | 'live'>('baseline');
  parent = signal('NG');
  rows = signal<AreaRow[]>([]);
  jobs = signal<Job[]>([]);
  names = signal<Record<string, string>>({ NG: 'All covered states' });
  unit = signal<any | null>(null);
  unitLog = signal<any[]>([]);
  election = computed(() => this.mode() === 'live' ? this.api.liveElectionId() : this.api.baselineElectionId());
  isUnitLevel = computed(() => this.parent().length === 8);
  levelName = computed(() => ({ 2: 'State', 5: 'LGA', 8: 'Ward' } as Record<number, string>)[this.parent() === 'NG' ? 2 : this.parent().length + 3] ?? 'Polling unit');
  crumbs = computed(() => {
    const p = this.parent();
    const codes = p === 'NG' ? ['NG'] : ['NG', p.slice(0, 2), p.slice(0, 5), p.slice(0, 8)].filter((c, i, a) => c.length <= p.length && a.indexOf(c) === i);
    return codes.map((c) => ({ code: c, name: this.names()[c] ?? c }));
  });
  private stopLive: () => void;

  constructor() {
    void this.load();
    this.stopLive = this.api.onChange(() => { void this.loadJobs(); void this.loadRows(); }, ['irev_fetch_jobs']);
  }
  ngOnDestroy() { this.stopLive(); }

  setMode(m: 'baseline' | 'live') { this.mode.set(m); void this.load(); }
  go(code: string) { this.parent.set(code); this.unit.set(null); void this.loadRows(); }

  async load() { await Promise.all([this.loadRows(), this.loadJobs()]); }

  async loadRows() {
    const e = this.election();
    if (!e) { this.ui.toast(`No ${this.mode()} election is set up for your organisation.`); return; }
    const rows = await this.ui.run(() => this.api.get<AreaRow[]>('/irev/summary', { election: e, parent: this.parent() }));
    if (!rows) return;
    this.rows.set(rows);
    this.names.set({ ...this.names(), ...Object.fromEntries(rows.map((r) => [r.area_code, r.name ?? r.area_code])) });
  }

  async loadJobs() {
    const e = this.election();
    if (!e) return;
    this.jobs.set((await this.api.get<Job[]>('/irev/jobs', { election: e }).catch(() => [])).slice(0, 20));
  }

  async fetch(area: string, type: 'baseline' | 'live' | 'recheck' | 'ocr', auto = false) {
    const level = area === 'NG' ? 'national' : ({ 2: 'state', 5: 'lga', 8: 'ward' } as Record<number, string>)[area.length];
    const ok = await this.ui.run(() => this.api.post('/irev/jobs', { electionId: this.election(), jobType: type, areaLevel: level, areaCode: area, autoRecheck: auto, intervalMin: 10 }));
    if (ok) this.ui.toast(`${label(type)} job queued for ${this.names()[area] ?? area}`);
    await this.loadJobs();
  }

  async setJob(j: Job, status: string) {
    await this.ui.run(() => this.api.patch(`/irev/jobs/${j.id}`, { status }));
    await this.loadJobs();
  }

  countsText(c: Record<string, number>) { return Object.entries(c ?? {}).map(([k, v]) => `${label(k)} ${v}`).join(' · ') || 'Starting…'; }

  async openUnit(r: AreaRow) {
    const e = this.election();
    const d = await this.ui.run(() => this.api.get<{ availability: any; log: any[] }>(`/irev/units/${r.area_code}`, { election: e }));
    if (!d) return;
    this.unit.set(d.availability ?? { pu_code: r.area_code, status: 'not_checked', ocr_status: 'not_read' });
    this.unitLog.set(d.log);
  }

  async openSheet(pu: string) {
    const url = await this.ui.run(() => this.api.viewUrl({ kind: 'irev', electionId: this.election(), pu }));
    if (url) window.open(url, '_blank', 'noopener');
  }

  async exportCsv(area: string) {
    const e = this.election();
    const data = await this.ui.run(() => this.api.get<any[]>('/irev/units', { election: e, area: area === 'NG' ? undefined : area }));
    if (!data) return;
    const head = 'pu_code,status,ocr_status,first_seen_at,irev_updated_at,replaced_count,last_checked_at';
    const csv = [head, ...(data ?? []).map((r: any) => head.split(',').map((k) => r[k] ?? '').join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `irev-${area}-${this.mode()}.csv`; a.click();
  }
}
