import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Supa } from '../../core/supabase';
import { AgoPipe, SEVERITY_COLOR, Ui, label } from '../../core/ui';

export interface CaseRow {
  id: string; title: string; category: string; severity: string; status: string; pu_code: string | null; area_code: string;
  report_count: number; reporter_count: number; assigned_to: string | null; queue_id: string; created_at: string;
  ack_due_at: string | null; due_at: string | null; escalation_level: number; incident_group_id: string | null;
}
interface QueueCount { queue_id: string; name: string; kind: string; waiting: number; assigned: number; overdue: number; critical: number }

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

@Component({
  selector: 'app-queue',
  imports: [RouterLink, FormsModule, MatButtonModule, MatButtonToggleModule, MatCardModule, MatChipsModule, MatIconModule,
    MatTableModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="head">
    <h1>Situation room</h1>
    <span class="spacer"></span>
    <mat-button-toggle-group [(ngModel)]="view" hideSingleSelectionIndicator>
      <mat-button-toggle value="mine">My cases</mat-button-toggle>
      <mat-button-toggle value="open">All open</mat-button-toggle>
      <mat-button-toggle value="closed">Recently closed</mat-button-toggle>
    </mat-button-toggle-group>
  </div>

  <div class="queues">
    @for (q of queues(); track q.queue_id) {
      <mat-card appearance="outlined" class="q" [class.sel]="queueFilter() === q.queue_id" (click)="toggleQueue(q.queue_id)">
        <div class="qname">{{ q.name }}</div>
        <div class="qnums">
          <span matTooltip="Waiting"><b>{{ q.waiting }}</b> waiting</span>
          <span matTooltip="Being worked">{{ q.assigned }} active</span>
          @if (q.overdue) { <span class="warn">{{ q.overdue }} overdue</span> }
          @if (q.critical) { <span class="crit">{{ q.critical }} critical</span> }
        </div>
        <button mat-stroked-button (click)="$event.stopPropagation(); takeNext(q.queue_id)" [disabled]="!q.waiting">Take next</button>
      </mat-card>
    }
  </div>

  <table mat-table [dataSource]="rows()" class="cases">
    <ng-container matColumnDef="severity"><th mat-header-cell *matHeaderCellDef>Severity</th>
      <td mat-cell *matCellDef="let c"><span class="sev" [style.background]="sevColor[c.severity]">{{ c.severity }}</span></td></ng-container>
    <ng-container matColumnDef="title"><th mat-header-cell *matHeaderCellDef>Case</th>
      <td mat-cell *matCellDef="let c"><a [routerLink]="['/room/case', c.id]">{{ c.title }}</a>
        @if (c.incident_group_id) { <mat-icon class="small" matTooltip="Part of a linked incident group">link</mat-icon> }</td></ng-container>
    <ng-container matColumnDef="reports"><th mat-header-cell *matHeaderCellDef>Reports</th>
      <td mat-cell *matCellDef="let c">{{ c.report_count }} from {{ c.reporter_count || 0 }}</td></ng-container>
    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>Status</th>
      <td mat-cell *matCellDef="let c">{{ label(c.status) }} @if (c.escalation_level) { <span class="warn">↑{{ c.escalation_level }}</span> }</td></ng-container>
    <ng-container matColumnDef="owner"><th mat-header-cell *matHeaderCellDef>Operator</th>
      <td mat-cell *matCellDef="let c">{{ staffName(c.assigned_to) }}</td></ng-container>
    <ng-container matColumnDef="due"><th mat-header-cell *matHeaderCellDef>Due</th>
      <td mat-cell *matCellDef="let c" [class.warn]="overdue(c)">{{ (c.status === 'assigned' ? c.ack_due_at : c.due_at) | ago }}</td></ng-container>
    <ng-container matColumnDef="age"><th mat-header-cell *matHeaderCellDef>Opened</th>
      <td mat-cell *matCellDef="let c">{{ c.created_at | ago }}</td></ng-container>
    <tr mat-header-row *matHeaderRowDef="cols"></tr>
    <tr mat-row *matRowDef="let c; columns: cols" (dblclick)="open(c.id)" [class.crit-row]="c.severity === 'critical'"></tr>
  </table>
  @if (!rows().length) { <p class="empty">No cases in this view.</p> }`,
  styles: `
    .head { display: flex; align-items: center; gap: 12px; } .spacer { flex: 1; } h1 { font: var(--mat-sys-headline-small); margin: 0; }
    .queues { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin: 16px 0; }
    .q { padding: 12px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; } .q.sel { outline: 2px solid var(--mat-sys-primary); }
    .qname { font: var(--mat-sys-title-small); } .qnums { display: flex; gap: 10px; flex-wrap: wrap; font: var(--mat-sys-body-small); }
    .warn { color: #c25700; } .crit { color: #b3261e; font-weight: 600; }
    .sev { color: white; border-radius: 10px; padding: 2px 8px; font-size: 12px; text-transform: capitalize; }
    .cases { width: 100%; } .crit-row { background: color-mix(in srgb, #b3261e 6%, transparent); }
    .small { font-size: 16px; height: 16px; width: 16px; vertical-align: middle; }
    .empty { color: var(--mat-sys-on-surface-variant); padding: 24px; }
  `,
})
export class QueuePage implements OnDestroy {
  private supa = inject(Supa);
  private ui = inject(Ui);
  private router = inject(Router);
  label = label;
  sevColor = SEVERITY_COLOR;
  cols = ['severity', 'title', 'reports', 'status', 'owner', 'due', 'age'];
  viewSig = signal<'mine' | 'open' | 'closed'>('open');
  get view() { return this.viewSig(); } set view(v) { this.viewSig.set(v); void this.load(); }
  queueFilter = signal<string | null>(null);
  cases = signal<CaseRow[]>([]);
  queues = signal<QueueCount[]>([]);
  staff = signal<Record<string, string>>({});
  private channel?: RealtimeChannel;
  private timer = setInterval(() => { this.cases.set([...this.cases()]); void this.loadCounts(); }, 30_000);

  rows = computed(() => {
    const q = this.queueFilter();
    return this.cases().filter((c) => !q || c.queue_id === q)
      .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.created_at.localeCompare(b.created_at));
  });

  constructor() {
    void this.load();
    void this.loadCounts();
    void this.supa.rpc<{ id: string; full_name: string }[]>('room_staff').then((s) =>
      this.staff.set(Object.fromEntries(s.map((x) => [x.id, x.full_name])))).catch(() => {});
    this.channel = this.supa.client.channel('room-cases')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases' }, () => { void this.load(); void this.loadCounts(); })
      .subscribe();
  }

  ngOnDestroy() { clearInterval(this.timer); if (this.channel) void this.supa.client.removeChannel(this.channel); }

  async load() {
    let q = this.supa.client.from('cases').select('*').order('created_at', { ascending: false }).limit(500);
    if (this.view === 'mine') q = q.eq('assigned_to', this.supa.me()!.id).in('status', ['assigned', 'in_progress', 'escalated', 'resolved']);
    else if (this.view === 'open') q = q.in('status', ['queued', 'assigned', 'in_progress', 'escalated', 'resolved']);
    else q = q.in('status', ['closed', 'merged']).gte('updated_at', new Date(Date.now() - 6 * 3600_000).toISOString());
    const { data, error } = await q;
    if (error) this.ui.error(error); else this.cases.set(data as CaseRow[]);
  }

  async loadCounts() { this.queues.set(await this.supa.rpc<QueueCount[]>('queue_counts').catch(() => [])); }

  toggleQueue(id: string) { this.queueFilter.set(this.queueFilter() === id ? null : id); }
  staffName(id: string | null) { return id ? this.staff()[id] ?? '…' : '—'; }
  overdue(c: CaseRow) { const d = c.status === 'assigned' ? c.ack_due_at : c.due_at; return !!d && new Date(d) < new Date() && !['resolved', 'closed', 'merged'].includes(c.status); }
  open(id: string) { void this.router.navigate(['/room/case', id]); }

  async takeNext(queueId: string) {
    const id = await this.ui.run(() => this.supa.rpc<string | null>('take_next_case', { p_queue: queueId }));
    if (id) this.open(id); else if (id === null) this.ui.toast('Nothing waiting in this queue');
  }
}
