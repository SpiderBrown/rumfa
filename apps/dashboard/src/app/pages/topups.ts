import { Component, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { Api } from '../core/api';
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
        @if (b.status === 'pending_approval' && b.created_by !== api.me()?.id) {
          <button mat-flat-button (click)="approve(b, true)">Approve</button> <button mat-button (click)="approve(b, false)">Cancel</button> }
        @if (b.status === 'pending_approval' && b.created_by === api.me()?.id) { <span class="hint">Waiting for a second admin</span> }
      </td></ng-container>
    <tr mat-header-row *matHeaderRowDef="['plan','size','status','act']"></tr><tr mat-row *matRowDef="let r; columns: ['plan','size','status','act']"></tr>
  </table>`,
  styles: `h1 { font: var(--mat-sys-headline-small); } h2 { font: var(--mat-sys-title-medium); margin-top: 24px; } table { width: 100%; }
    .form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .hint { font-size: 12px; color: var(--mat-sys-on-surface-variant); }`,
})
export class TopupsPage {
  api = inject(Api);
  private ui = inject(Ui);
  label = label;
  plans = signal<any[]>([]);
  batches = signal<any[]>([]);
  progress = signal<Record<string, string>>({});
  n = { name: '', kind: 'data', amount: 1000, plan: '', roles: ['agent'] as string[], areas: '', onboarded: true };

  constructor() { void this.load(); }

  async load() {
    const [p, b] = await Promise.all([this.api.get<any[]>('/topups/plans'), this.api.get<any[]>('/topups/batches')]).catch((e) => { this.ui.error(e); return [[], []]; });
    this.plans.set(p); this.batches.set(b.map((x: any) => ({ ...x, topup_plans: { name: x.plan_name } })));
    this.progress.set(Object.fromEntries(b.filter((x: any) => x.counts).map((x: any) =>
      [x.id, Object.entries(x.counts as Record<string, number>).map(([k, v]) => `${label(k)} ${v}`).join(' · ')])));
  }

  async createPlan() {
    if (!this.n.name || !this.n.amount || !this.n.roles.length) { this.ui.error('Name, amount and roles are required'); return; }
    const ok = await this.ui.run(() => this.api.post('/topups/plans', { name: this.n.name, kind: this.n.kind, amountNgn: Number(this.n.amount),
      dataPlanCode: this.n.kind === 'data' ? this.n.plan || undefined : undefined, targetRoles: this.n.roles,
      targetAreaCodes: this.n.areas.split(',').map((s) => s.trim()).filter(Boolean), onboardedOnly: this.n.onboarded }), 'Plan saved');
    if (ok) await this.load();
  }
  async batch(p: any) { await this.ui.run(() => this.api.post('/topups/batches', { planId: p.id }), 'Batch created; a second admin must approve it'); await this.load(); }
  async approve(b: any, ok: boolean) {
    if (ok && !(await this.ui.confirm('Approve top-ups', `Send ₦${Number(b.total_ngn).toLocaleString()} to ${b.person_count} people? This spends real money.`, 'Approve and send'))) return;
    await this.ui.run(() => this.api.post(`/topups/batches/${b.id}/approve`, { approve: ok }), ok ? 'Approved; sending starts shortly' : 'Cancelled');
    await this.load();
  }
}
