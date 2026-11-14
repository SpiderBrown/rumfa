import { Component, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { Supa } from '../core/supabase';
import { AgoPipe, Ui, label } from '../core/ui';

/** Optional airtime and data top-ups for registered people, with two-admin approval and caps. */
@Component({
  selector: 'app-topups',
  imports: [DecimalPipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule, MatTableModule, AgoPipe],
  template: `
  <h1>Airtime and data</h1>
  <p class="hint">Top-ups go only to registered people with a role, never to typed-in numbers. Each batch needs a second admin to approve it.</p>

  <h2>New plan</h2>
  <div class="form">
    <mat-form-field><mat-label>Name</mat-label><input matInput [(ngModel)]="n.name" placeholder="Agents data, 15 Jan" /></mat-form-field>
    <mat-form-field><mat-label>Kind</mat-label><mat-select [(ngModel)]="n.kind"><mat-option value="airtime">Airtime</mat-option><mat-option value="data">Data</mat-option></mat-select></mat-form-field>
    <mat-form-field><mat-label>Amount per person (₦)</mat-label><input matInput type="number" min="50" [(ngModel)]="n.amount" /></mat-form-field>
    @if (n.kind === 'data') { <mat-form-field><mat-label>Provider data plan code</mat-label><input matInput [(ngModel)]="n.plan" /></mat-form-field> }
    <mat-form-field><mat-label>Roles</mat-label><mat-select multiple [(ngModel)]="n.roles">
      @for (r of ['agent','volunteer','coordinator','operator','supervisor']; track r) { <mat-option [value]="r">{{ label(r) }}</mat-option> }</mat-select></mat-form-field>
    <mat-form-field><mat-label>Areas (codes, comma-separated, empty = all)</mat-label><input matInput [(ngModel)]="n.areas" /></mat-form-field>
    <mat-slide-toggle [(ngModel)]="n.onboarded">Only people who finished onboarding</mat-slide-toggle>
    <button mat-flat-button (click)="createPlan()">Save plan</button>
  </div>

  <h2>Plans</h2>
  <table mat-table [dataSource]="plans()">
    <ng-container matColumnDef="name"><th mat-header-cell *matHeaderCellDef>Plan</th><td mat-cell *matCellDef="let p">{{ p.name }}</td></ng-container>
    <ng-container matColumnDef="what"><th mat-header-cell *matHeaderCellDef>What</th><td mat-cell *matCellDef="let p">{{ label(p.kind) }} ₦{{ p.amount_ngn | number }} · {{ p.target_roles.join(', ') }}</td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let p"><button mat-stroked-button (click)="batch(p)">Create batch</button></td></ng-container>
    <tr mat-header-row *matHeaderRowDef="['name','what','act']"></tr><tr mat-row *matRowDef="let r; columns: ['name','what','act']"></tr>
  </table>

  <h2>Batches</h2>
  <table mat-table [dataSource]="batches()">
    <ng-container matColumnDef="plan"><th mat-header-cell *matHeaderCellDef>Plan</th><td mat-cell *matCellDef="let b">{{ b.topup_plans?.name }}</td></ng-container>
    <ng-container matColumnDef="size"><th mat-header-cell *matHeaderCellDef>People · total</th><td mat-cell *matCellDef="let b">{{ b.person_count | number }} · ₦{{ b.total_ngn | number }}</td></ng-container>
    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>Status</th>
      <td mat-cell *matCellDef="let b">{{ label(b.status) }} · created {{ b.created_at | ago }}
        @if (progress()[b.id]; as p) { <div class="hint">{{ p }}</div> }</td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th>
      <td mat-cell *matCellDef="let b">
        @if (b.status === 'pending_approval' && b.created_by !== supa.me()?.id) {
          <button mat-flat-button (click)="approve(b, true)">Approve</button> <button mat-button (click)="approve(b, false)">Cancel</button> }
        @if (b.status === 'pending_approval' && b.created_by === supa.me()?.id) { <span class="hint">Waiting for a second admin</span> }
      </td></ng-container>
    <tr mat-header-row *matHeaderRowDef="['plan','size','status','act']"></tr><tr mat-row *matRowDef="let r; columns: ['plan','size','status','act']"></tr>
  </table>`,
  styles: `h1 { font: var(--mat-sys-headline-small); } h2 { font: var(--mat-sys-title-medium); margin-top: 24px; } table { width: 100%; }
    .form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .hint { font-size: 12px; color: var(--mat-sys-on-surface-variant); }`,
})
export class TopupsPage {
  supa = inject(Supa);
  private ui = inject(Ui);
  label = label;
  plans = signal<any[]>([]);
  batches = signal<any[]>([]);
  progress = signal<Record<string, string>>({});
  n = { name: '', kind: 'data', amount: 1000, plan: '', roles: ['agent'] as string[], areas: '', onboarded: true };

  constructor() { void this.load(); }

  async load() {
    const [p, b] = await Promise.all([
      this.supa.client.from('topup_plans').select('*').order('created_at', { ascending: false }),
      this.supa.client.from('topup_batches').select('*, topup_plans(name)').order('created_at', { ascending: false }),
    ]);
    this.plans.set(p.data ?? []); this.batches.set(b.data ?? []);
    const prog: Record<string, string> = {};
    for (const x of (b.data ?? []).filter((x) => ['sending', 'done'].includes(x.status))) {
      const { data } = await this.supa.client.from('topups').select('status').eq('batch_id', x.id);
      const c: Record<string, number> = {};
      for (const t of data ?? []) c[t.status] = (c[t.status] ?? 0) + 1;
      prog[x.id] = Object.entries(c).map(([k, v]) => `${label(k)} ${v}`).join(' · ');
    }
    this.progress.set(prog);
  }

  async createPlan() {
    if (!this.n.name || !this.n.amount || !this.n.roles.length) { this.ui.error('Name, amount and roles are required'); return; }
    const { error } = await this.supa.client.from('topup_plans').insert({
      tenant_id: this.supa.me()!.tenant_id, name: this.n.name, kind: this.n.kind, amount_ngn: this.n.amount,
      data_plan_code: this.n.kind === 'data' ? this.n.plan || null : null, target_roles: this.n.roles,
      target_area_codes: this.n.areas.split(',').map((s) => s.trim()).filter(Boolean), onboarded_only: this.n.onboarded,
      created_by: this.supa.me()!.id,
    });
    if (error) this.ui.error(error.message); else { this.ui.toast('Plan saved'); await this.load(); }
  }
  async batch(p: any) { await this.ui.run(() => this.supa.rpc('create_topup_batch', { p_plan: p.id }), 'Batch created; a second admin must approve it'); await this.load(); }
  async approve(b: any, ok: boolean) {
    if (ok && !(await this.ui.confirm('Approve top-ups', `Send ₦${b.total_ngn.toLocaleString()} to ${b.person_count} people? This spends real money.`, 'Approve and send'))) return;
    await this.ui.run(() => this.supa.rpc('approve_topup_batch', { p_batch: b.id, p_approve: ok }), ok ? 'Approved; sending starts shortly' : 'Cancelled');
    await this.load();
  }
}
