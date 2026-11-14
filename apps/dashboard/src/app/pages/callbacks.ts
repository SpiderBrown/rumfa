import { Component, OnDestroy, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { FormsModule } from '@angular/forms';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { CALLBACK_REASONS, INCIDENT_CATEGORIES } from '@rumfa/shared';
import { Supa } from '../core/supabase';
import { AgoPipe, Ui, label } from '../core/ui';

/**
 * Callback requests ("Ask my coordinator to call me"). Coordinators see their
 * own queue; room staff see all, including those escalated to the state room.
 */
@Component({
  selector: 'app-callbacks',
  imports: [RouterLink, FormsModule, MatButtonModule, MatButtonToggleModule, MatIconModule, MatTableModule, AgoPipe],
  template: `
  <div class="head"><h1>Callback requests</h1><span class="spacer"></span>
    <mat-button-toggle-group [(ngModel)]="scope" (change)="load()" hideSingleSelectionIndicator>
      <mat-button-toggle value="mine">Assigned to me</mat-button-toggle>
      <mat-button-toggle value="open">All open</mat-button-toggle>
      <mat-button-toggle value="done">Finished today</mat-button-toggle>
    </mat-button-toggle-group></div>
  <table mat-table [dataSource]="rows()">
    <ng-container matColumnDef="who"><th mat-header-cell *matHeaderCellDef>Agent</th>
      <td mat-cell *matCellDef="let r">{{ r.requester?.full_name }}<div class="sub">{{ r.requester?.area_code }} · via {{ r.channel }}</div></td></ng-container>
    <ng-container matColumnDef="reason"><th mat-header-cell *matHeaderCellDef>Reason</th>
      <td mat-cell *matCellDef="let r">{{ reason(r.reason) }}
        @if (r.voice_note_path) { <button mat-button (click)="play(r)"><mat-icon>play_arrow</mat-icon> Voice note</button> }</td></ng-container>
    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>Status</th>
      <td mat-cell *matCellDef="let r">{{ label(r.status) }} · level {{ r.escalation_level }} · {{ r.attempts }} tries
        @if (r.case_id) { · <a [routerLink]="['/room/case', r.case_id]">case</a> }</td></ng-container>
    <ng-container matColumnDef="due"><th mat-header-cell *matHeaderCellDef>Due</th>
      <td mat-cell *matCellDef="let r">{{ r.due_at | ago }}</td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th>
      <td mat-cell *matCellDef="let r" class="acts">
        @if (['waiting','no_answer','escalated'].includes(r.status)) { <button mat-flat-button (click)="call(r)"><mat-icon>call</mat-icon> Call</button> }
        @if (r.status === 'calling') {
          <button mat-stroked-button (click)="done(r, true)">Talked</button>
          <button mat-stroked-button (click)="done(r, false)">No answer</button>
          <button mat-stroked-button (click)="toCase(r)">Open case</button>
        }
      </td></ng-container>
    <tr mat-header-row *matHeaderRowDef="cols"></tr>
    <tr mat-row *matRowDef="let r; columns: cols"></tr>
  </table>
  @if (!rows().length) { <p class="empty">No requests.</p> }`,
  styles: `.head { display: flex; align-items: center; } .spacer { flex: 1; } h1 { font: var(--mat-sys-headline-small); }
           .sub { font-size: 12px; color: var(--mat-sys-on-surface-variant); } .acts { display: flex; gap: 6px; } .empty { padding: 24px; }
           table { width: 100%; }`,
})
export class CallbacksPage implements OnDestroy {
  private supa = inject(Supa);
  private ui = inject(Ui);
  label = label;
  scope: 'mine' | 'open' | 'done' = 'mine';
  rows = signal<any[]>([]);
  cols = ['who', 'reason', 'status', 'due', 'act'];
  private rt: RealtimeChannel;

  constructor() {
    if (this.supa.isRoom()) this.scope = 'open';
    void this.load();
    this.rt = this.supa.client.channel('callbacks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'callback_requests' }, () => void this.load()).subscribe();
  }
  ngOnDestroy() { void this.supa.client.removeChannel(this.rt); }

  reason(code: string) { return CALLBACK_REASONS.find((r) => r.code === code)?.label ?? code; }

  async load() {
    let q = this.supa.client.from('callback_requests').select('*, requester:volunteers!callback_requests_requester_id_fkey(full_name, phone, area_code)')
      .order('due_at').limit(300);
    if (this.scope === 'mine') q = q.eq('assigned_to', this.supa.me()!.id).in('status', ['waiting', 'calling', 'no_answer']);
    else if (this.scope === 'open') q = q.in('status', ['waiting', 'calling', 'no_answer', 'escalated']);
    else q = q.in('status', ['done', 'closed', 'cancelled', 'case_opened']).gte('updated_at', new Date(Date.now() - 86400_000).toISOString());
    const { data, error } = await q;
    if (error) this.ui.error(error.message); else this.rows.set(data ?? []);
  }

  async call(r: any) {
    const res = await this.ui.run(() => this.supa.fn<{ bridged: boolean; dial_direct?: string }>('calls', { action: 'callback', callback_id: r.id }));
    if (res?.bridged) this.ui.toast('Your phone will ring first, then the agent is connected.');
    else if (res?.dial_direct) { this.ui.toast('Automatic call failed; dialling directly.'); window.location.href = `tel:${res.dial_direct}`; }
    await this.load();
  }
  async done(r: any, answered: boolean) {
    const outcome = answered ? await this.ui.prompt('Call outcome', 'What was agreed?', { multiline: true }) : null;
    if (answered && !outcome) return;
    await this.ui.run(() => this.supa.rpc('complete_callback', { p_id: r.id, p_answered: answered, p_outcome: outcome }), 'Saved');
    await this.load();
  }
  async toCase(r: any) {
    const cats = INCIDENT_CATEGORIES.map((c) => c.code).join(', ');
    const cat = await this.ui.prompt('Open a case', `Category (${cats})`, { value: 'other' });
    if (!cat) return;
    const note = await this.ui.prompt('Open a case', 'What is happening?', { multiline: true });
    if (!note) return;
    await this.ui.run(() => this.supa.rpc('convert_callback_to_case', { p_id: r.id, p_category: cat, p_note: note }), 'Case opened');
    await this.load();
  }
  async play(r: any) {
    const url = await this.ui.run(() => this.supa.signedUrl({ kind: 'callback', callback_id: r.id }));
    if (url) window.open(url, '_blank', 'noopener');
  }
}
