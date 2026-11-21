import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../core/api';
import { Ui, label } from '../core/ui';

type Counts = Record<string, number> | null;
interface Beat { task: string; every_s: number | null; last_run_at: string | null; last_ok_at: string | null; last_error: string | null; last_error_at: string | null; runs: number; worker: string | null }
interface IrevJob { id: string; job_type: string; area_level: string; area_code: string; status: string; keep: string; auto_recheck: boolean; interval_min: number; watcher: boolean;
  counts: Counts; error: string | null; created_at: string; started_at: string | null; finished_at: string | null; next_run_at: string | null; election: string; client: string | null }
interface Overview {
  now: string; worker: Beat[]; irev: IrevJob[];
  outbox: { counts: { channel: string; status: string; n: number }[]; queued: { oldest: string | null; n: number }; failures: { id: number; channel: string; template: string; attempts: number; last_error: string | null; created_at: string; client: string | null }[] };
  voiceMessages: { id: string; title: string; status: string; created_at: string; ends_at: string; client: string; counts: Counts }[];
  campaigns: { id: string; name: string; status: string; calls_per_minute: number; client: string; counts: Counts }[];
  topups: { id: string; status: string; person_count: number; total_ngn: number; created_at: string; client: string; counts: Counts }[];
  ocr: { waiting: number; oldest: string | null };
  places: { id: string; kind: string; params: any; status: string; progress: any; error: string | null; created_at: string; finished_at: string | null; by: string | null }[];
}

const TASKS: Record<string, string> = {
  tick: 'Case and callback deadlines', outbox: 'Notifications (push, SMS)', topups: 'Airtime and data', 'ocr-agent': 'Reading agents’ sheet photos',
  voice: 'Voice outreach calls', 'voice messages': 'Voice message calls', trend: 'Trend checks', figures: 'Missing figures', 'stale-contacts': 'Stale contacts', irev: 'IReV jobs',
};
const ago = (t: string | null) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 0) return 'in ' + (s > -3600 ? Math.round(-s / 60) + ' min' : Math.round(-s / 3600) + ' h');
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const countsText = (c: Counts) => Object.entries(c ?? {}).filter(([, v]) => v).map(([k, v]) => `${label(k)} ${v}`).join(' · ');

/** Rumfa Console → Background jobs: is the worker alive, and what is each queue doing, across every client. */
@Component({
  selector: 'page-jobs',
  imports: [DecimalPipe, MatButtonModule, MatIconModule],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>Background jobs</h1>
      <span class="hint">The worker's tasks and queues, for every client · updated {{ ago(d()?.now ?? null) }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="load()"><mat-icon>refresh</mat-icon> Refresh</button>
    </div>

    @if (d(); as d) {
      @if (workerDown(); as w) {
        <div class="banner bad"><mat-icon>error</mat-icon><span><b>The worker doesn't seem to be running.</b> {{ w }} Start it with <code>npm run start:worker</code> in apps/api.</span></div>
      }

      <div class="card">
        <h2>Worker</h2>
        <table class="grid">
          <thead><tr><th>Task</th><th>Runs every</th><th>Last ran</th><th>Last worked</th><th>State</th><th>Last error</th></tr></thead>
          <tbody>
            @for (b of d.worker; track b.task) {
              <tr>
                <td><b>{{ taskName(b.task) }}</b><div class="hint">{{ b.task }}{{ b.worker ? ' · ' + b.worker : '' }}</div></td>
                <td>{{ b.every_s ? every(b.every_s) : '—' }}</td>
                <td>{{ ago(b.last_run_at) }}</td>
                <td>{{ ago(b.last_ok_at) }}</td>
                <td><span class="chip" [class]="'chip ' + state(b).cls">{{ state(b).text }}</span></td>
                <td class="err">@if (b.last_error) { {{ b.last_error }} <span class="hint">· {{ ago(b.last_error_at) }}</span> }</td>
              </tr>
            } @empty { <tr><td colspan="6" class="hint">No heartbeat yet. The worker records one when it runs (after this update, restart it once).</td></tr> }
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>IReV jobs <span class="hint">{{ activeIrev() }} active</span></h2>
        <table class="grid">
          <thead><tr><th>Election</th><th>For</th><th>What</th><th>Area</th><th>State</th><th>Progress</th><th>When</th><th></th></tr></thead>
          <tbody>
            @for (j of d.irev; track j.id) {
              <tr [class.dim]="!['queued','running','paused'].includes(j.status)">
                <td>{{ j.election }}</td>
                <td>{{ j.client ?? 'Rumfa' }}</td>
                <td>{{ j.watcher ? 'Watcher' : label(j.job_type) }} <span class="chip">{{ j.keep === 'link' ? 'links' : 'files' }}</span>
                  @if (j.auto_recheck) { <div class="hint">every {{ j.interval_min }} min, election days only</div> }</td>
                <td>{{ j.area_code }}</td>
                <td>{{ label(j.status) }}@if (j.error) { <div class="hint err">{{ j.error }}</div> }</td>
                <td class="hint">{{ countsText(j.counts) || '—' }}</td>
                <td class="hint">started {{ ago(j.started_at ?? j.created_at) }}@if (j.next_run_at) { <br>next {{ ago(j.next_run_at) }} }</td>
                <td class="acts">@if (api.canEdit) {
                  @if (j.status === 'running') { <button mat-button (click)="setIrev(j, 'paused')">Pause</button> }
                  @if (j.status === 'paused') { <button mat-button (click)="setIrev(j, 'queued')">Resume</button> }
                  @if (['running','paused','queued'].includes(j.status)) { <button mat-button (click)="setIrev(j, 'cancelled')">Cancel</button> } }</td>
              </tr>
            } @empty { <tr><td colspan="8" class="hint">No IReV jobs yet.</td></tr> }
          </tbody>
        </table>
      </div>

      <div class="row2">
        <div class="card">
          <h2>Notifications</h2>
          <p>Waiting to send: <b>{{ d.outbox.queued.n | number }}</b>@if (d.outbox.queued.oldest) { <span class="hint"> · oldest {{ ago(d.outbox.queued.oldest) }}</span> }</p>
          <table class="grid mini">
            <thead><tr><th>Last 7 days</th><th>Sent</th><th>Waiting</th><th>Failed</th></tr></thead>
            <tbody>@for (c of channels(); track c.channel) {
              <tr><td>{{ c.channel === 'sms' ? 'SMS' : label(c.channel) }}</td><td>{{ c.sent | number }}</td><td>{{ c.queued | number }}</td><td [class.err]="c.failed">{{ c.failed | number }}</td></tr> }</tbody>
          </table>
          @if (d.outbox.failures.length) {
            <h3>Recent failures @if (api.canEdit) { <button mat-stroked-button (click)="retry()">Try failed ones again</button> }</h3>
            @for (f of d.outbox.failures; track f.id) {
              <div class="fail"><b>{{ f.channel === 'sms' ? 'SMS' : label(f.channel) }} · {{ f.template }}</b> <span class="hint">{{ f.client ?? '' }} · {{ ago(f.created_at) }} · {{ f.attempts }} tries</span>
                <div class="err">{{ f.last_error }}</div></div>
            }
          }
        </div>
        <div class="card">
          <h2>Other queues</h2>
          <p><b>Agents' sheet photos waiting to be read:</b> {{ d.ocr.waiting | number }}@if (d.ocr.oldest) { <span class="hint"> · oldest {{ ago(d.ocr.oldest) }}</span> }</p>
          <h3>Voice messages</h3>
          @for (m of d.voiceMessages; track m.id) { <div class="line"><b>{{ m.title }}</b> <span class="hint">{{ m.client }} · {{ label(m.status) }} · {{ countsText(m.counts) }}</span></div> }
          @empty { <p class="hint">None in the last 2 days.</p> }
          <h3>Voice outreach</h3>
          @for (c of d.campaigns; track c.id) { <div class="line"><b>{{ c.name }}</b> <span class="hint">{{ c.client }} · {{ label(c.status) }} · {{ c.calls_per_minute }}/min · {{ countsText(c.counts) }}</span></div> }
          @empty { <p class="hint">No campaign running.</p> }
          <h3>Airtime and data</h3>
          @for (t of d.topups; track t.id) { <div class="line"><b>₦{{ t.total_ngn | number }} to {{ t.person_count }}</b> <span class="hint">{{ t.client }} · {{ label(t.status) }} · {{ countsText(t.counts) }}</span></div> }
          @empty { <p class="hint">Nothing waiting or sending.</p> }
          <h3>Place imports</h3>
          @for (p of d.places; track p.id) { <div class="line"><b>{{ label(p.kind) }} {{ p.params?.state ?? '' }}</b> <span class="hint">{{ label(p.status) }} · {{ ago(p.created_at) }}{{ p.by ? ' · ' + p.by : '' }}{{ p.error ? ' · ' + p.error : '' }}</span></div> }
          @empty { <p class="hint">None yet.</p> }
        </div>
      </div>
    } @else { <p class="hint">Loading…</p> }
  </div>`,
  styles: `
    .spacer { flex: 1; } h2 .hint { font-size: 13px; font-weight: 400; margin-left: 6px; }
    h3 { display: flex; align-items: center; gap: 10px; margin: 16px 0 6px; font-size: 14px; }
    .banner { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; margin-bottom: 16px; }
    .banner.bad { background: #fdecea; color: #7a1d16; }
    .chip.ok { background: #e3f4ea; border-color: #b9dfc6; color: #146c3a; } .chip.late { background: #fff4e5; border-color: #f0c9a8; color: #7a2e0b; }
    .chip.bad { background: #fdecea; border-color: #f1b8b2; color: #7a1d16; }
    .err { color: #b3261e; font-size: 12.5px; } tr.dim td { opacity: .6; } .acts { white-space: nowrap; text-align: right; }
    .row2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; align-items: start; }
    .row2 .card { margin-bottom: 0; }
    .mini { margin-top: 6px; } .fail { padding: 6px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .line { padding: 4px 0; }
  `,
})
export class JobsPage implements OnDestroy {
  api = inject(Api);
  private ui = inject(Ui);
  label = label;
  ago = ago;
  countsText = countsText;
  d = signal<Overview | null>(null);
  private timer = setInterval(() => void this.load(), 15_000);

  activeIrev = computed(() => (this.d()?.irev ?? []).filter((j) => ['queued', 'running', 'paused'].includes(j.status)).length);
  channels = computed(() => {
    const by = new Map<string, { channel: string; sent: number; queued: number; failed: number }>();
    for (const c of this.d()?.outbox.counts ?? []) {
      const r = by.get(c.channel) ?? { channel: c.channel, sent: 0, queued: 0, failed: 0 };
      (r as any)[c.status] = c.n; by.set(c.channel, r);
    }
    return [...by.values()];
  });
  /** No task has run for a while: the worker is stopped (or can't reach the database) */
  workerDown = computed(() => {
    const w = this.d()?.worker ?? [];
    if (!w.length) return null;
    const last = Math.max(...w.map((b) => (b.last_run_at ? new Date(b.last_run_at).getTime() : 0)));
    return Date.now() - last > 3 * 60_000 ? `Nothing has run for ${ago(new Date(last).toISOString()).replace(' ago', '')}.` : null;
  });

  constructor() { void this.load(); }
  ngOnDestroy() { clearInterval(this.timer); }

  taskName(t: string) { return TASKS[t] ?? label(t); }
  every(s: number) { return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`; }
  /** Fine, late (missed a few runs) or failing (last run was an error) */
  state(b: Beat): { text: string; cls: string } {
    const due = Math.max(3 * (b.every_s ?? 60), 120) * 1000;
    if (!b.last_run_at || Date.now() - new Date(b.last_run_at).getTime() > due) return { text: 'Not running', cls: 'bad' };
    if (b.last_error_at && (!b.last_ok_at || new Date(b.last_error_at) > new Date(b.last_ok_at))) return { text: 'Failing', cls: 'bad' };
    if (b.last_ok_at && Date.now() - new Date(b.last_ok_at).getTime() > due) return { text: 'Late', cls: 'late' };
    return { text: 'OK', cls: 'ok' };
  }

  async load() {
    const r = await this.api.get<Overview>('/platform/background/overview').catch((e) => { this.ui.error(e); return null; });
    if (r) this.d.set(r);
  }
  async setIrev(j: IrevJob, status: string) { await this.ui.run(() => this.api.patch(`/platform/irev/jobs/${j.id}`, { status })); await this.load(); }
  async retry() {
    const r = await this.ui.run(() => this.api.post<{ requeued: number }>('/platform/background/outbox/retry', {}));
    if (r) this.ui.toast(`${r.requeued} notifications will be tried again`);
    await this.load();
  }
}
