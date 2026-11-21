import { Component, Injectable, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { placeName } from '@rumfa/shared';
import { Api } from './api';
import { SheetViewer } from './sheet-viewer';
import { label } from './ui';

type Figs = { registered: number | null; accredited: number | null; rejected: number | null; total_valid: number | null; votes: Record<string, number> };
interface UnitData {
  pu: string; place: { name: string; ward: string; lga: string; registered_voters: number | null } | null;
  ours: (Figs & { id: string; version: number; has_photo: boolean; submitted_at: string; by: string | null; status: string;
    has_full: boolean; full_photo_requested_at: string | null }) | null;
  irev: (Figs & { version: number; ocr_status: string; min_confidence: number | null }) | null;
  availability: { status: string; stored: boolean; linked: boolean; irev_updated_at: string | null; replaced_count: number } | null;
  verification: { status: string; diff: string[] } | null;
  agentCheck: { status: string; note: string | null; case_id: string | null } | null;
}
const ROWS: { key: keyof Omit<Figs, 'votes'>; label: string }[] = [
  { key: 'registered', label: 'Registered' }, { key: 'accredited', label: 'Accredited' },
  { key: 'rejected', label: 'Rejected' }, { key: 'total_valid', label: 'Total valid' },
];

/** Opens one polling unit's two sheets side by side: our agent's signed EC8A and IReV's, with the figures compared. */
@Injectable({ providedIn: 'root' })
export class UnitCompare {
  private dialog = inject(MatDialog);
  open(electionId: string, pu: string) {
    this.dialog.open(UnitCompareDialog, { data: { electionId, pu }, width: '1200px', maxWidth: '96vw', maxHeight: '94vh', autoFocus: false, panelClass: 'unit-compare-panel' });
  }
}

@Component({
  selector: 'app-unit-compare',
  imports: [DatePipe, RouterLink, MatDialogModule, MatButtonModule, MatIconModule, SheetViewer],
  template: `
  <div class="head">
    <div><p class="eyebrow">{{ d()?.place ? name(d()!.place!.ward) + ' · ' + name(d()!.place!.lga) : '' }} · {{ data.pu }}</p>
      <h2>{{ d()?.place ? name(d()!.place!.name) : data.pu }}</h2></div>
    <span class="grow"></span>
    @if (status(); as st) { <span class="pill" [class]="'pill ' + st.cls">{{ st.text }}</span> }
    <button mat-icon-button (click)="ref.close()" aria-label="Close"><mat-icon>close</mat-icon></button>
  </div>
  @if (!d()) { <p class="muted pad">Loading…</p> } @else {
    <div class="grid">
      <section class="pane">
        <div class="ph"><b>Our agent's sheet</b>
          <span class="muted xs">@if (d()!.ours; as o) { {{ o.by ?? 'Our agent' }} · {{ o.submitted_at | date: 'd MMM, HH:mm' }}{{ o.version > 1 ? ' · version ' + o.version : '' }} } @else { not sent }</span></div>
        @if (d()!.ours?.has_photo) {
          <div class="full">@if (d()!.ours!.has_full) {
              <button mat-button (click)="showFull()" [disabled]="full()"><mat-icon>hd</mat-icon> {{ full() ? 'Full resolution' : 'Show full resolution' }}</button>
            } @else if (d()!.ours!.full_photo_requested_at || asked()) { <span class="muted xs"><mat-icon>schedule</mat-icon> Full photo asked for: it comes when the agent's phone is online</span>
            } @else { <button mat-button (click)="askFull()"><mat-icon>hd</mat-icon> Ask for the full photo</button> }</div>
        }
        @if (oursUrl()) { <app-sheet-viewer [url]="oursUrl()" /> }
        @else { <div class="none"><mat-icon>no_photography</mat-icon>{{ d()!.ours ? 'No photo with this result' : 'No result from our agent yet' }}</div> }
      </section>
      <section class="pane">
        <div class="ph"><b>IReV copy</b>
          <span class="muted xs">@if (d()!.availability; as a) { {{ label(a.status) }}{{ a.irev_updated_at ? ' · ' + (a.irev_updated_at | date: 'd MMM, HH:mm') : '' }}{{ a.replaced_count ? ' · replaced ' + a.replaced_count + '×' : '' }}{{ a.linked && !a.stored ? ' · from INEC\\'s link' : '' }} } @else { not checked yet }</span></div>
        @if (irevUrl()) { <app-sheet-viewer [url]="irevUrl()" /> }
        @else { <div class="none"><mat-icon>cloud_off</mat-icon>Not on IReV yet</div> }
      </section>
      <section class="figs">
        <div class="ph"><b>Figures</b></div>
        <table>
          <thead><tr><th></th><th>Ours</th><th>IReV</th></tr></thead>
          <tbody>
            @for (r of rows(); track r.label) {
              <tr [class.diff]="r.diff"><td>{{ r.label }}</td><td>{{ r.ours ?? '—' }}</td><td>{{ r.irev ?? '—' }}@if (r.diff && r.delta !== null) { <span class="delta">{{ r.delta > 0 ? '+' : '' }}{{ r.delta }}</span> }</td></tr>
            }
          </tbody>
        </table>
        @if (d()!.irev && d()!.irev!.ocr_status === 'needs_review') { <p class="note">IReV's figures were read by machine and aren't sure yet. <a routerLink="/irev/review" (click)="ref.close()">Check them in Sheet review</a>.</p> }
        @if (diffCount()) { <p class="note bad">{{ diffCount() }} {{ diffCount() === 1 ? 'figure differs' : 'figures differ' }} between our sheet and IReV.</p> }
        @if (d()!.agentCheck; as k) {
          <p class="note">Our agent {{ k.status === 'matches' ? 'confirmed IReV matches their sheet' : k.status === 'differs' ? 'says IReV is different' : 'was asked to check IReV' }}{{ k.note ? ': "' + k.note + '"' : '' }}.
            @if (k.case_id) { <a [routerLink]="['/room/case', k.case_id]" (click)="ref.close()">Open the case</a> }</p>
        }
      </section>
    </div>
  }`,
  styles: `
    :host { display: block; padding: 16px 18px 18px; }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .eyebrow { margin: 0; font-size: 12.5px; font-weight: 600; color: var(--r-muted); }
    h2 { margin: 2px 0 0; font-size: 20px; font-weight: 800; }
    .grow { flex: 1; } .muted { color: var(--r-muted); } .xs { font-size: 12px; } .pad { padding: 24px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 300px; gap: 14px; align-items: start; }
    .pane, .figs { border: 1px solid var(--r-line); border-radius: 12px; overflow: hidden; background: #fff; }
    .ph { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--r-line-soft); }
    .full { padding: 2px 8px; border-bottom: 1px solid var(--r-line-soft); display: flex; align-items: center; min-height: 36px; }
    .full .xs { display: inline-flex; align-items: center; gap: 4px; } .full mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .none { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; height: 360px; color: var(--r-muted); font-size: 13px; }
    .pane app-sheet-viewer { display: block; height: 520px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th { text-align: left; font-size: 12px; color: var(--r-muted); padding: 8px 12px; border-bottom: 1px solid var(--r-line); }
    td { padding: 8px 12px; border-bottom: 1px solid var(--r-line-soft); font-variant-numeric: tabular-nums; }
    td:first-child { font-weight: 700; }
    tr.diff td { background: #fdf3e7; }
    .delta { margin-left: 6px; font-size: 11.5px; font-weight: 800; color: #b4541a; }
    .note { margin: 10px 12px; font-size: 12.5px; color: var(--r-ink-2); } .note.bad { color: #7a2e0b; font-weight: 600; }
    .pill { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 3px 9px; }
    .pill.ok { background: #e3f4ea; color: #146c3a; } .pill.bad { background: var(--r-high-bg); color: #7a2e0b; } .pill.neutral { background: var(--r-low-bg); color: var(--r-ink-2); }
    @media (max-width: 1000px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class UnitCompareDialog {
  data = inject<{ electionId: string; pu: string }>(MAT_DIALOG_DATA);
  ref = inject(MatDialogRef<UnitCompareDialog>);
  private api = inject(Api);
  label = label;
  d = signal<UnitData | null>(null);
  oursUrl = signal<string | null>(null);
  irevUrl = signal<string | null>(null);
  full = signal(false);
  asked = signal(false);
  async showFull() {
    const o = this.d()?.ours; if (!o) return;
    const u = await this.api.viewUrl({ kind: 'ec8a', id: o.id, full: true }).catch(() => null);
    if (u) { this.oursUrl.set(u); this.full.set(true); }
  }
  async askFull() {
    const o = this.d()?.ours; if (!o) return;
    await this.api.post(`/results/${o.id}/request-full-photo`).then(() => this.asked.set(true)).catch(() => undefined);
  }

  rows = computed(() => {
    const o = this.d()?.ours, i = this.d()?.irev;
    const cmp = (a: number | null | undefined, b: number | null | undefined) => {
      const diff = a != null && b != null && Number(a) !== Number(b);
      return { diff, delta: diff ? Number(b) - Number(a) : null };
    };
    const parties = [...new Set([...Object.keys(o?.votes ?? {}), ...Object.keys(i?.votes ?? {})])]
      .sort((a, b) => (o?.votes[b] ?? i?.votes[b] ?? 0) - (o?.votes[a] ?? i?.votes[a] ?? 0));
    return [
      ...parties.map((p) => ({ label: p, ours: o ? o.votes[p] ?? 0 : null, irev: i ? i.votes[p] ?? 0 : null, ...cmp(o ? o.votes[p] ?? 0 : null, i ? i.votes[p] ?? 0 : null) })),
      ...ROWS.map((r) => ({ label: r.label, ours: o?.[r.key] ?? null, irev: i?.[r.key] ?? null, ...cmp(o?.[r.key], i?.[r.key]) })),
    ];
  });
  diffCount = computed(() => this.rows().filter((r) => r.diff).length);
  status = computed(() => {
    const v = this.d()?.verification?.status;
    if (v === 'verified') return { text: 'Matches', cls: 'ok' };
    if (v === 'mismatch') return { text: 'Differs', cls: 'bad' };
    if (v === 'agent_only') return { text: 'Only our sheet', cls: 'neutral' };
    if (v === 'irev_only') return { text: 'Only IReV', cls: 'neutral' };
    return null;
  });

  constructor() { void this.load(); }
  name(n: string) { return placeName(n); }

  private async load() {
    const d = await this.api.get<UnitData>('/results/unit', { election: this.data.electionId, pu: this.data.pu }).catch(() => null);
    if (!d) { this.ref.close(); return; }
    this.d.set(d);
    if (d.ours?.has_photo) this.oursUrl.set(await this.api.viewUrl({ kind: 'ec8a', id: d.ours.id }).catch(() => null));
    if (d.availability && (d.availability.stored || d.availability.linked)) this.irevUrl.set(await this.api.viewUrl({ kind: 'irev', electionId: this.data.electionId, pu: this.data.pu }).catch(() => null));
  }
}
