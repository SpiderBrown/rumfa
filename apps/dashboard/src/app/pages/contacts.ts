import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { normaliseNgPhone } from '@rumfa/shared';
import { Supa } from '../core/supabase';
import { Calls } from '../core/calls';
import { AgoPipe, Ui, label } from '../core/ui';

/** Authority contacts (design 11.7): official, campaign liaison and coordinator-added, each call-tested and approved. */
@Component({
  selector: 'app-contacts',
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule,
    MatTableModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="head"><h1>Authority contacts</h1><span class="spacer"></span>
    <mat-form-field class="search"><mat-label>Area code or name</mat-label><input matInput [(ngModel)]="q" (ngModelChange)="filter.set($event)" /></mat-form-field>
    <mat-button-toggle-group [(ngModel)]="statusFilter" (change)="load()" hideSingleSelectionIndicator>
      <mat-button-toggle value="all">All</mat-button-toggle>
      <mat-button-toggle value="todo">Needs action</mat-button-toggle>
      <mat-button-toggle value="verified">Verified</mat-button-toggle>
    </mat-button-toggle-group>
    @if (canAdd()) { <button mat-flat-button (click)="adding.set(!adding())"><mat-icon>add</mat-icon> Add contact</button> }
  </div>

  @if (adding()) {
    <div class="addform">
      <mat-form-field><mat-label>Agency</mat-label><mat-select [(ngModel)]="n.agency">
        @for (a of agencies; track a) { <mat-option [value]="a">{{ a }}</mat-option> }</mat-select></mat-form-field>
      <mat-form-field><mat-label>Title</mat-label><input matInput [(ngModel)]="n.title" placeholder="e.g. Divisional Police Officer" /></mat-form-field>
      <mat-form-field><mat-label>Name (optional)</mat-label><input matInput [(ngModel)]="n.person" /></mat-form-field>
      <mat-form-field><mat-label>Phone</mat-label><input matInput [(ngModel)]="n.phone" /></mat-form-field>
      <mat-form-field><mat-label>Level</mat-label><mat-select [(ngModel)]="n.level">
        @for (l of ['ward','lga','state']; track l) { <mat-option [value]="l">{{ l }}</mat-option> }</mat-select></mat-form-field>
      <mat-form-field><mat-label>Area code</mat-label><input matInput [(ngModel)]="n.area" [placeholder]="supa.me()?.area_code ?? ''" /></mat-form-field>
      <button mat-flat-button (click)="add()">Save</button>
    </div>
  }

  <table mat-table [dataSource]="rows()">
    <ng-container matColumnDef="who"><th mat-header-cell *matHeaderCellDef>Contact</th>
      <td mat-cell *matCellDef="let k"><b>{{ k.agency }}</b> · {{ k.title }}<div class="sub">{{ k.person_name }} {{ k.address }}</div></td></ng-container>
    <ng-container matColumnDef="area"><th mat-header-cell *matHeaderCellDef>Area</th>
      <td mat-cell *matCellDef="let k">{{ k.level }} {{ k.area_code }}</td></ng-container>
    <ng-container matColumnDef="source"><th mat-header-cell *matHeaderCellDef>Source</th>
      <td mat-cell *matCellDef="let k"><span class="src" [class]="k.source_type">{{ label(k.source_type) }}</span>
        @if (k.source_url) { <a [href]="k.source_url" target="_blank" rel="noopener" class="sub">source</a> }</td></ng-container>
    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>Status</th>
      <td mat-cell *matCellDef="let k">{{ label(k.status) }}
        <div class="sub">@if (k.last_call_ok_at) { reached {{ k.last_call_ok_at | ago }} } @if (k.last_call_failed_at) { · failed {{ k.last_call_failed_at | ago }} }</div></td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th>
      <td mat-cell *matCellDef="let k" class="acts">
        @if (k.phone) { <button mat-icon-button matTooltip="Test call" (click)="testCall(k)"><mat-icon>call</mat-icon></button> }
        @if (k.phone && ['pending','stale','call_tested'].includes(k.status)) {
          <button mat-button (click)="markCall(k, true)">Answered</button><button mat-button (click)="markCall(k, false)">No answer</button> }
        @if (k.status === 'call_tested' && k.added_by !== supa.me()?.id) {
          <button mat-stroked-button (click)="approve(k, true)">Approve</button><button mat-button (click)="approve(k, false)">Reject</button> }
      </td></ng-container>
    <tr mat-header-row *matHeaderRowDef="cols"></tr>
    <tr mat-row *matRowDef="let r; columns: cols"></tr>
  </table>`,
  styles: `.head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .spacer { flex: 1; } h1 { font: var(--mat-sys-headline-small); }
    .search { width: 200px; } .addform { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    table { width: 100%; } .sub { font-size: 12px; color: var(--mat-sys-on-surface-variant); } .acts { display: flex; gap: 4px; align-items: center; }
    .src { padding: 2px 8px; border-radius: 8px; font-size: 12px; } .src.official { background: #e3f2e1; } .src.liaison { background: #e7f1fb; } .src.coordinator { background: #f9eeda; }`,
})
export class ContactsPage {
  supa = inject(Supa);
  private ui = inject(Ui);
  private calls = inject(Calls);
  label = label;
  agencies = ['INEC', 'Police', 'Army', 'NSCDC', 'DSS', 'Party legal team', 'Traditional ruler', 'Local government', 'Other'];
  cols = ['who', 'area', 'source', 'status', 'act'];
  all = signal<any[]>([]);
  filter = signal('');
  q = '';
  statusFilter: 'all' | 'todo' | 'verified' = 'todo';
  adding = signal(false);
  n = { agency: 'Police', title: '', person: '', phone: '', level: 'ward', area: '' };
  canAdd = computed(() => ['coordinator', 'supervisor', 'admin'].includes(this.supa.me()?.role ?? ''));
  rows = computed(() => {
    const f = this.filter().toLowerCase();
    return this.all().filter((k) => !f || k.area_code.startsWith(f) || `${k.agency} ${k.title} ${k.person_name ?? ''}`.toLowerCase().includes(f));
  });

  constructor() { void this.load(); }

  async load() {
    let q = this.supa.client.from('authority_contacts').select('*').order('area_code').limit(2000);
    if (this.statusFilter === 'todo') q = q.in('status', ['pending', 'call_tested', 'stale']);
    if (this.statusFilter === 'verified') q = q.eq('status', 'verified');
    const { data, error } = await q;
    if (error) this.ui.error(error.message); else this.all.set(data ?? []);
  }

  async add() {
    const phone = normaliseNgPhone(this.n.phone);
    if (!phone || !this.n.title || !this.n.area) { this.ui.error('Title, a valid phone and area code are required'); return; }
    await this.ui.run(() => this.supa.rpc('add_authority_contact', { p_agency: this.n.agency, p_title: this.n.title, p_person: this.n.person || null,
      p_phone: phone, p_level: this.n.level, p_area: this.n.area }), 'Saved. Now make a test call.');
    this.adding.set(false); this.statusFilter = 'todo'; await this.load();
  }

  testCall(k: any) { void this.calls.call('contact', k.id, `${k.agency} ${k.title}`, undefined, 'Test call'); }
  async markCall(k: any, ok: boolean) { await this.ui.run(() => this.supa.rpc('mark_contact_call', { p_contact: k.id, p_ok: ok }), ok ? 'Marked as reached' : 'Marked unreachable'); await this.load(); }
  async approve(k: any, ok: boolean) { await this.ui.run(() => this.supa.rpc('approve_contact', { p_contact: k.id, p_approve: ok }), ok ? 'Approved' : 'Rejected'); await this.load(); }
}
