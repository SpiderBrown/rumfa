import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { normaliseNgPhone, normalisePuCode } from '@alawa/shared';
import { Supa } from '../core/supabase';
import { Calls } from '../core/calls';
import { Ui, label } from '../core/ui';

/** People in your area: agents, volunteers, coordinators. Coordinators add people below them. */
@Component({
  selector: 'app-people',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MatTableModule, MatTooltipModule],
  template: `
  <div class="head"><h1>People</h1><span class="spacer"></span>
    <mat-form-field class="search"><mat-label>Search name, phone or area</mat-label><input matInput [(ngModel)]="q" (ngModelChange)="filter.set($event)" /></mat-form-field>
    <mat-form-field class="search"><mat-label>Role</mat-label><mat-select [(ngModel)]="role" (selectionChange)="load()">
      <mat-option value="">All</mat-option>@for (r of roles; track r) { <mat-option [value]="r">{{ label(r) }}</mat-option> }</mat-select></mat-form-field>
    <button mat-flat-button (click)="adding.set(!adding())"><mat-icon>person_add</mat-icon> Add person</button>
  </div>
  <p class="hint">For hundreds of people at once (e.g. the party's list of agents), use the bulk import: <code>npm run import:people</code> in the worker.</p>

  @if (adding()) {
    <div class="addform">
      <mat-form-field><mat-label>Full name</mat-label><input matInput [(ngModel)]="n.name" /></mat-form-field>
      <mat-form-field><mat-label>Phone</mat-label><input matInput [(ngModel)]="n.phone" /></mat-form-field>
      <mat-form-field><mat-label>Role</mat-label><mat-select [(ngModel)]="n.role">
        @for (r of addRoles(); track r) { <mat-option [value]="r">{{ label(r) }}</mat-option> }</mat-select></mat-form-field>
      <mat-form-field><mat-label>Level</mat-label><mat-select [(ngModel)]="n.level">
        @for (l of ['pu','ward','lga','state','national']; track l) { <mat-option [value]="l">{{ l === 'pu' ? 'Polling unit' : label(l) }}</mat-option> }</mat-select></mat-form-field>
      <mat-form-field><mat-label>Area code</mat-label><input matInput [(ngModel)]="n.area" placeholder="e.g. 19-28-02-003" /></mat-form-field>
      <mat-form-field><mat-label>Languages</mat-label><mat-select multiple [(ngModel)]="n.languages">
        @for (l of langs; track l.code) { <mat-option [value]="l.code">{{ l.name }}</mat-option> }</mat-select></mat-form-field>
      <button mat-flat-button (click)="add()">Save</button>
    </div>
  }

  <table mat-table [dataSource]="rows()">
    <ng-container matColumnDef="name"><th mat-header-cell *matHeaderCellDef>Name</th>
      <td mat-cell *matCellDef="let p">{{ p.full_name }} @if (p.deputy_of) { <span class="sub">(deputy)</span> }</td></ng-container>
    <ng-container matColumnDef="role"><th mat-header-cell *matHeaderCellDef>Role</th><td mat-cell *matCellDef="let p">{{ label(p.role) }}</td></ng-container>
    <ng-container matColumnDef="area"><th mat-header-cell *matHeaderCellDef>Area</th><td mat-cell *matCellDef="let p">{{ p.level }} {{ p.area_code }}</td></ng-container>
    <ng-container matColumnDef="phone"><th mat-header-cell *matHeaderCellDef>Phone</th><td mat-cell *matCellDef="let p">{{ p.phone }} <span class="sub">{{ p.network }}</span></td></ng-container>
    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>Status</th>
      <td mat-cell *matCellDef="let p">{{ label(p.status) }} @if (!p.onboarded_at) { <span class="sub">· not onboarded</span> }</td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th>
      <td mat-cell *matCellDef="let p" class="acts">
        <button mat-icon-button matTooltip="Call" (click)="call(p)"><mat-icon>call</mat-icon></button>
        @if (p.status !== 'removed' && p.id !== supa.me()?.id) { <button mat-icon-button matTooltip="Remove access" (click)="remove(p)"><mat-icon>person_remove</mat-icon></button> }
      </td></ng-container>
    <tr mat-header-row *matHeaderRowDef="cols"></tr>
    <tr mat-row *matRowDef="let r; columns: cols"></tr>
  </table>
  <p class="sub">{{ rows().length }} shown</p>`,
  styles: `.head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .spacer { flex: 1; } h1 { font: var(--mat-sys-headline-small); }
    .search { width: 200px; } .hint { font-size: 12px; color: var(--mat-sys-on-surface-variant); } table { width: 100%; }
    .addform { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .sub { font-size: 12px; color: var(--mat-sys-on-surface-variant); } .acts { display: flex; }`,
})
export class PeoplePage {
  supa = inject(Supa);
  private ui = inject(Ui);
  private calls = inject(Calls);
  label = label;
  roles = ['agent', 'volunteer', 'coordinator', 'operator', 'supervisor', 'analyst', 'legal', 'security', 'voice_ops', 'admin'];
  langs = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }, { code: 'ff', name: 'Fulfulde' }, { code: 'kr', name: 'Kanuri' },
    { code: 'yo', name: 'Yoruba' }, { code: 'ig', name: 'Igbo' }, { code: 'tiv', name: 'Tiv' }, { code: 'nup', name: 'Nupe' }];
  cols = ['name', 'role', 'area', 'phone', 'status', 'act'];
  all = signal<any[]>([]);
  filter = signal('');
  q = '';
  role = '';
  adding = signal(false);
  n = { name: '', phone: '', role: 'agent', level: 'pu', area: '', languages: ['en'] as string[] };
  addRoles = computed(() => this.supa.isAdmin() ? this.roles : ['agent', 'volunteer', 'coordinator']);
  rows = computed(() => {
    const f = this.filter().toLowerCase();
    return this.all().filter((p) => !f || p.full_name.toLowerCase().includes(f) || p.phone.includes(f) || p.area_code.startsWith(f));
  });

  constructor() { void this.load(); }

  async load() {
    let q = this.supa.client.from('volunteers').select('*').neq('status', 'removed').order('area_code').limit(5000);
    if (this.role) q = q.eq('role', this.role);
    const { data, error } = await q;
    if (error) this.ui.error(error.message); else this.all.set(data ?? []);
  }

  async add() {
    const phone = normaliseNgPhone(this.n.phone);
    let area = this.n.area.trim();
    if (this.n.level === 'pu') area = normalisePuCode(area) ?? '';
    if (this.n.level === 'national') area = 'NG';
    if (!this.n.name || !phone || !area) { this.ui.error('Name, a valid phone and area code are required'); return; }
    const agentCode = this.n.role === 'agent' ? Math.random().toString(36).slice(2, 6).toUpperCase() : null;
    const { error } = await this.supa.client.from('volunteers').insert({
      tenant_id: this.supa.me()!.tenant_id, full_name: this.n.name, phone, role: this.n.role, level: this.n.level, area_code: area,
      agent_code: agentCode, languages: this.n.languages, created_by: this.supa.me()!.id,
    });
    if (error) { this.ui.error(error.message.includes('row-level') ? 'You can only add people inside your own area, below your level.' : error.message); return; }
    this.ui.toast(`${this.n.name} added. They sign in to the app with an SMS code to ${phone}.`);
    this.adding.set(false); await this.load();
  }

  call(p: any) { void this.calls.call('volunteer', p.id, p.full_name); }
  async remove(p: any) {
    if (!(await this.ui.confirm('Remove access', `${p.full_name} will lose access to the app and all channels at once.`, 'Remove'))) return;
    const { error } = await this.supa.client.from('volunteers').update({ status: 'removed' }).eq('id', p.id);
    if (error) this.ui.error(error.message); else { this.ui.toast('Access removed'); await this.load(); }
  }
}
