import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { normaliseNgPhone, normalisePuCode } from '@rumfa/shared';
import { Api } from '../core/api';
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
  <p class="hint">For hundreds of people at once (e.g. the party's list of agents), use the bulk import: <code>npm run import:people</code> in the API.</p>

  @if (adding()) {
    <div class="addform">
      <mat-form-field><mat-label>Full name</mat-label><input matInput [(ngModel)]="n.name" /></mat-form-field>
      <mat-form-field><mat-label>Phone</mat-label><input matInput [(ngModel)]="n.phone" /></mat-form-field>
      @if (isStaff(n.role)) { <mat-form-field><mat-label>Work email (dashboard sign-in)</mat-label><input matInput type="email" [(ngModel)]="n.email" /></mat-form-field> }
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
      <td mat-cell *matCellDef="let p">{{ label(p.status) }} @if (!p.activated) { <span class="sub">· not signed in yet</span> } @else if (!p.onboarded_at) { <span class="sub">· not onboarded</span> }</td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th>
      <td mat-cell *matCellDef="let p" class="acts">
        <button mat-icon-button matTooltip="Call" (click)="call(p)"><mat-icon>call</mat-icon></button>
        @if (p.status !== 'removed' && p.id !== api.me()?.id) {
          @if (isStaff(p.role)) { @if (api.isAdmin()) { <button mat-icon-button matTooltip="Invite link" (click)="invite(p)"><mat-icon>mail</mat-icon></button> } }
          @else {
            <button mat-icon-button matTooltip="Activation code" (click)="activationCode(p)"><mat-icon>pin</mat-icon></button>
            @if (p.activated) { <button mat-icon-button matTooltip="Sign out lost phone" (click)="signOutPhone(p)"><mat-icon>phonelink_erase</mat-icon></button> }
          }
        }
        @if (p.status !== 'removed' && p.id !== api.me()?.id) { <button mat-icon-button matTooltip="Remove access" (click)="remove(p)"><mat-icon>person_remove</mat-icon></button> }
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
  api = inject(Api);
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
  n = { name: '', phone: '', email: '', role: 'agent', level: 'pu', area: '', languages: ['en'] as string[] };
  addRoles = computed(() => this.api.isAdmin() ? this.roles : ['agent', 'volunteer', 'coordinator']);
  rows = computed(() => {
    const f = this.filter().toLowerCase();
    return this.all().filter((p) => !f || p.full_name.toLowerCase().includes(f) || p.phone.includes(f) || p.area_code.startsWith(f));
  });

  constructor() { void this.load(); }

  async load() {
    try { this.all.set(await this.api.get<any[]>('/people', { role: this.role || undefined })); } catch (e) { this.ui.error(e); }
  }

  async add() {
    const phone = normaliseNgPhone(this.n.phone);
    let area = this.n.area.trim();
    if (this.n.level === 'pu') area = normalisePuCode(area) ?? '';
    if (this.n.level === 'national') area = 'NG';
    if (!this.n.name || !phone || !area) { this.ui.error('Name, a valid phone and area code are required'); return; }
    try {
      await this.api.post('/people', { fullName: this.n.name, phone, email: this.n.email || undefined, role: this.n.role, level: this.n.level,
        areaCode: area, languages: this.n.languages });
    } catch (e: any) {
      this.ui.error(e?.status === 403 ? 'You can only add people inside your own area, below your level.' : e);
      return;
    }
    this.ui.toast(this.isStaff(this.n.role) ? `${this.n.name} added. Send them an invite to set a password.` : `${this.n.name} added. They activate the app on ${phone}.`);
    this.adding.set(false); await this.load();
  }

  call(p: any) { void this.calls.call('volunteer', p.id, p.full_name); }
  async remove(p: any) {
    if (!(await this.ui.confirm('Remove access', `${p.full_name} will lose access to the app and all channels at once.`, 'Remove'))) return;
    const ok = await this.ui.run(async () => { await this.api.del(`/people/${p.id}`); return true; }, 'Access removed');
    if (ok) await this.load();
  }

  isStaff(role: string) { return !['agent', 'volunteer', 'coordinator'].includes(role); }

  /** One-time code a field user types instead of an SMS code (valid 48 hours). */
  async activationCode(p: any) {
    const r = await this.ui.run(() => this.api.post<{ code: string; expiresAt: string }>(`/people/${p.id}/activation-code`));
    if (r) await this.ui.confirm(`Activation code for ${p.full_name}`, `${r.code} — valid until ${new Date(r.expiresAt).toLocaleString()}. Give it to them in person or by phone.`, 'Done');
  }

  /** Invite link for dashboard staff to set their password (valid 7 days). */
  async invite(p: any) {
    const r = await this.ui.run(() => this.api.post<{ inviteToken: string; email: string }>(`/people/${p.id}/invite`));
    if (!r) return;
    const link = `${location.origin}/login?invite=${encodeURIComponent(r.inviteToken)}`;
    await navigator.clipboard?.writeText(link).catch(() => undefined);
    await this.ui.confirm(`Invite for ${p.full_name}`, `Send this link to ${r.email} (copied): ${link}`, 'Done');
  }

  async signOutPhone(p: any) {
    if (!(await this.ui.confirm('Sign out phone', `${p.full_name}'s phone will be signed out. They activate it again to continue.`, 'Sign out'))) return;
    await this.ui.run(() => this.api.post(`/people/${p.id}/devices/revoke`), 'Phone signed out');
  }
}
