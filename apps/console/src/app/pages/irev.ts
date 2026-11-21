import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { Ui, label } from '../core/ui';

interface Watcher { id: string; status: string; interval_min: number; area_code: string; next_run_at: string | null; error: string | null; counts: Record<string, number> }
interface Election { id: string; name: string; election_type: string; election_date: string; irev_election_id: string | null; status: string; scope_state_code: string | null;
  on_irev: number; stored: number; linked: number; review: number; last_checked_at: string | null; watcher: Watcher | null }
interface AreaRow { area_code: string; name: string; units: number; not_checked: number; not_on_irev: number; on_irev: number; downloaded: number; replaced: number;
  failed: number; ocr_read: number; ocr_review: number; ocr_confirmed: number; linked: number }
interface Job { id: string; job_type: string; area_level: string; area_code: string; status: string; counts: Record<string, number>; auto_recheck: boolean;
  interval_min: number; keep: 'file' | 'link'; watcher: boolean; error: string | null; created_at: string; next_run_at: string | null;
  requested_by_name: string | null; client_name: string | null }

const ago = (t: string | null) => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/**
 * IReV for every election: progress by area, fetch jobs (keep each sheet as a file, or only INEC's link), and one
 * watcher per election that keeps checking IReV at a gentle pace (the worker goes at IREV_RPS requests a second).
 */
@Component({
  selector: 'page-irev',
  imports: [DecimalPipe, FormsModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>IReV</h1>
      <span class="hint">INEC's result viewing portal, for every election and every client</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="loadAll()"><mat-icon>refresh</mat-icon> Refresh</button>
    </div>

    <table class="grid elections">
      <thead><tr><th>Election</th><th>On IReV</th><th>Kept as</th><th>To review</th><th>Last checked</th><th>Watcher</th><th></th></tr></thead>
      <tbody>
        @for (e of elections(); track e.id) {
          <tr class="link" [class.sel]="sel()?.id === e.id" (click)="pick(e)">
            <td><b>{{ e.name }}</b><div class="hint">{{ e.election_date }} · {{ label(e.status) }}{{ e.irev_election_id ? '' : ' · no IReV id yet' }}</div></td>
            <td>{{ e.on_irev | number }}</td>
            <td class="hint">{{ e.stored | number }} files · {{ e.linked | number }} links</td>
            <td>{{ e.review | number }}</td>
            <td class="hint">{{ ago(e.last_checked_at) }}</td>
            <td>@if (e.watcher; as w) { <span class="chip on">{{ w.status === 'paused' ? 'Paused' : 'Every ' + w.interval_min + ' min' }} · {{ w.area_code }}</span> } @else { <span class="hint">Off</span> }</td>
            <td><mat-icon>chevron_right</mat-icon></td>
          </tr>
        }
      </tbody>
    </table>

    @if (sel(); as e) {
      <div class="card">
        <div class="page-head"><h2>{{ e.name }}</h2><span class="spacer"></span>
          @if (!e.irev_election_id) { <span class="hint">Set its IReV id under Elections to fetch anything.</span> }</div>

        <!-- The watcher: a links-only live job that rechecks by itself -->
        <div class="watch">
          <div class="w-text"><b>Keep checking IReV</b>
            <div class="hint">Runs only from election day to two days after (it waits on other days). Goes through every ward in the area at INEC's pace (one request a second), saves the link to each new or replaced sheet (no download) and reads the figures, then waits before the next pass.
              @if (e.watcher; as w) { <br>Now: every {{ w.interval_min }} min after a pass · {{ w.area_code }} · {{ label(w.status) }}{{ w.next_run_at ? ' · next pass ' + ago(w.next_run_at).replace(' ago', '') : '' }}{{ w.error ? ' · ' + w.error : '' }} }</div></div>
          <label class="f">Area <input [(ngModel)]="watchArea" [placeholder]="e.scope_state_code ?? 'NG'" size="9" /></label>
          <label class="f">Wait <select [(ngModel)]="watchEvery">@for (m of [10, 15, 20, 30, 60]; track m) { <option [ngValue]="m">{{ m }} min</option> }</select></label>
          @if (api.canEdit) {
            <button mat-flat-button (click)="watch(e, true)" [disabled]="!e.irev_election_id">{{ e.watcher ? 'Update' : 'Start' }}</button>
            @if (e.watcher) { <button mat-button (click)="watch(e, false)">Stop</button> }
          }
        </div>

        <div class="crumbs">
          @for (c of crumbs(); track c.code; let last = $last) {
            @if (!last) { <a (click)="go(c.code)">{{ c.name }}</a> <span>›</span> } @else { <b>{{ c.name }}</b> }
          }
        </div>
        <table class="grid">
          <thead><tr><th>Area</th><th>On IReV</th><th>Files · links</th><th>Missing · replaced · failed · unchecked</th><th>Read · review · confirmed</th><th></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.area_code) {
              <tr>
                <td>@if (parent().length < 8) { <a (click)="go(r.area_code)">{{ r.name }}</a> } @else { {{ r.name }} } <span class="hint">{{ r.area_code }}</span></td>
                <td><span class="bar"><span [style.width.%]="pct(r.on_irev + r.downloaded + r.replaced, r.units)"></span></span> {{ r.on_irev + r.downloaded + r.replaced | number }} / {{ r.units | number }}</td>
                <td class="hint">{{ r.downloaded + r.replaced | number }} · {{ r.linked | number }}</td>
                <td class="hint">{{ r.not_on_irev | number }} · <span [class.bad]="r.replaced">{{ r.replaced }}</span> · <span [class.bad]="r.failed">{{ r.failed }}</span> · {{ r.not_checked | number }}</td>
                <td class="hint">{{ r.ocr_read }} · {{ r.ocr_review }} · {{ r.ocr_confirmed }}</td>
                <td class="acts">
                  @if (api.canEdit && e.irev_election_id && parent().length < 8) {
                    <button mat-stroked-button [matMenuTriggerFor]="m">Fetch</button>
                    <mat-menu #m>
                      <button mat-menu-item (click)="fetch(e, r.area_code, 'live', 'link')"><mat-icon>link</mat-icon> Save links (no download)</button>
                      <button mat-menu-item (click)="fetch(e, r.area_code, 'live', 'file')"><mat-icon>download</mat-icon> Download sheets</button>
                      <button mat-menu-item (click)="fetch(e, r.area_code, 'baseline', 'file')"><mat-icon>history</mat-icon> Baseline (past election), download</button>
                      <button mat-menu-item (click)="fetch(e, r.area_code, 'recheck', 'link')"><mat-icon>refresh</mat-icon> Recheck missing and replaced</button>
                      <button mat-menu-item (click)="fetch(e, r.area_code, 'ocr', 'file')"><mat-icon>document_scanner</mat-icon> Read figures (OCR)</button>
                    </mat-menu>
                  }
                </td>
              </tr>
            } @empty { <tr><td colspan="6" class="hint">{{ loading() ? 'Loading…' : 'Nothing here.' }}</td></tr> }
          </tbody>
        </table>

        <h3>Jobs</h3>
        <table class="grid">
          <thead><tr><th>What</th><th>Area</th><th>Status</th><th>Progress</th><th>Started</th><th></th></tr></thead>
          <tbody>
            @for (j of jobs(); track j.id) {
              <tr>
                <td>{{ j.watcher ? 'Watcher' : label(j.job_type) }} <span class="chip">{{ j.keep === 'link' ? 'links' : 'files' }}</span>
                  @if (j.auto_recheck) { <span class="hint">every {{ j.interval_min }} min</span> }</td>
                <td>{{ j.area_code }}</td>
                <td>{{ label(j.status) }}@if (j.error) { <div class="hint" [class.bad]="j.status !== 'running'">{{ j.error }}</div> }</td>
                <td class="hint">{{ countsText(j.counts) || '—' }}</td>
                <td class="hint">{{ ago(j.created_at) }} · {{ j.client_name ?? j.requested_by_name ?? 'Rumfa' }}</td>
                <td class="acts">
                  @if (api.canEdit) {
                    @if (j.status === 'running') { <button mat-button (click)="setJob(j, 'paused')">Pause</button> }
                    @if (j.status === 'paused' || (j.status === 'failed' && j.counts['failed'])) { <button mat-button (click)="setJob(j, 'queued')">{{ j.status === 'paused' ? 'Resume' : 'Retry' }}</button> }
                    @if (['running','paused','queued'].includes(j.status)) { <button mat-button (click)="setJob(j, 'cancelled')">Cancel</button> }
                  }
                </td>
              </tr>
            } @empty { <tr><td colspan="6" class="hint">No jobs for this election yet.</td></tr> }
          </tbody>
        </table>
        <p class="hint">Jobs run in the worker (npm run start:worker). From a terminal the watcher is <code>npm run irev:watch -- --election {{ e.id }} --interval 20</code>.</p>
      </div>
    }
  </div>`,
  styles: `
    .spacer { flex: 1; }
    .elections { margin-bottom: 16px; }
    tr.sel td { background: var(--mat-sys-surface-container); }
    .chip.on { background: #e3f4ea; border-color: #b9dfc6; color: #146c3a; }
    .watch { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px; border-radius: 10px; background: var(--mat-sys-surface); margin-bottom: 14px; }
    .w-text { flex: 1 1 360px; }
    .f { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
    .f input, .f select { padding: 6px 8px; border: 1px solid var(--mat-sys-outline-variant); border-radius: 6px; font: inherit; }
    .crumbs { margin: 6px 0 8px; } .crumbs a { cursor: pointer; }
    .bar { display: inline-block; width: 90px; height: 6px; border-radius: 4px; background: var(--mat-sys-outline-variant); overflow: hidden; vertical-align: middle; margin-right: 6px; }
    .bar span { display: block; height: 100%; background: var(--mat-sys-primary); }
    .bad { color: #b3261e; font-weight: 600; } td a { cursor: pointer; }
    .acts { white-space: nowrap; text-align: right; }
    h3 { margin: 18px 0 6px; }
  `,
})
export class IrevPage implements OnDestroy {
  api = inject(Api);
  private ui = inject(Ui);
  label = label;
  ago = ago;
  elections = signal<Election[]>([]);
  sel = signal<Election | null>(null);
  parent = signal('NG');
  rows = signal<AreaRow[]>([]);
  jobs = signal<Job[]>([]);
  loading = signal(false);
  names = signal<Record<string, string>>({ NG: 'Nigeria' });
  watchArea = '';
  watchEvery = 20;
  private timer = setInterval(() => { void this.loadElections(); if (this.sel()) void this.loadJobs(); }, 20_000);

  crumbs = computed(() => {
    const p = this.parent();
    const codes = p === 'NG' ? ['NG'] : ['NG', p.slice(0, 2), p.slice(0, 5), p.slice(0, 8)].filter((c, i, a) => c.length <= p.length && a.indexOf(c) === i);
    return codes.map((c) => ({ code: c, name: this.names()[c] ?? c }));
  });

  constructor() { void this.loadElections(); }
  ngOnDestroy() { clearInterval(this.timer); }

  pct(a: number, b: number) { return b ? Math.round(a / b * 100) : 0; }
  countsText(c: Record<string, number>) { return Object.entries(c ?? {}).filter(([, v]) => v).map(([k, v]) => `${label(k)} ${v}`).join(' · '); }

  async loadAll() { await this.loadElections(); if (this.sel()) await Promise.all([this.loadRows(), this.loadJobs()]); }
  async loadElections() {
    const list = await this.api.get<Election[]>('/platform/irev/elections').catch((e) => { this.ui.error(e); return null; });
    if (!list) return;
    this.elections.set(list);
    const s = this.sel();
    if (s) this.sel.set(list.find((x) => x.id === s.id) ?? null);
  }
  pick(e: Election) {
    this.sel.set(e); this.parent.set(e.scope_state_code ?? 'NG');
    this.watchArea = e.watcher?.area_code ?? e.scope_state_code ?? 'NG'; this.watchEvery = e.watcher?.interval_min ?? 20;
    void this.loadRows(); void this.loadJobs();
  }
  go(code: string) { this.parent.set(code); void this.loadRows(); }
  async loadRows() {
    const e = this.sel(); if (!e) return;
    this.loading.set(true);
    const r = await this.api.get<AreaRow[]>('/platform/irev/summary', { election: e.id, parent: this.parent() }).catch((x) => { this.ui.error(x); return null; });
    this.loading.set(false);
    if (!r) return;
    this.rows.set(r);
    this.names.set({ ...this.names(), ...Object.fromEntries(r.map((x) => [x.area_code, x.name])) });
  }
  async loadJobs() {
    const e = this.sel(); if (!e) return;
    this.jobs.set(await this.api.get<Job[]>('/platform/irev/jobs', { election: e.id }).catch(() => []));
  }

  async fetch(e: Election, area: string, jobType: string, keep: 'file' | 'link') {
    const ok = await this.ui.run(() => this.api.post('/platform/irev/jobs', { electionId: e.id, jobType, areaCode: area, keep }),
      `${label(jobType)} queued for ${this.names()[area] ?? area}${keep === 'link' ? ' (links only)' : ''}`);
    if (ok) await this.loadJobs();
  }
  async setJob(j: Job, status: string) { await this.ui.run(() => this.api.patch(`/platform/irev/jobs/${j.id}`, { status })); await this.loadJobs(); await this.loadElections(); }
  async watch(e: Election, on: boolean) {
    const area = (this.watchArea || e.scope_state_code || 'NG').trim();
    const ok = await this.ui.run(() => this.api.post('/platform/irev/watch', { electionId: e.id, on, intervalMin: this.watchEvery, areaCode: area }),
      on ? `Watching ${e.name}: every ${this.watchEvery} min after each pass` : 'Watcher stopped');
    if (ok) { await this.loadElections(); await this.loadJobs(); }
  }
}
