import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../core/api';
import { Ui, copy, label } from '../core/ui';

interface StaffRow { id: string; email: string; full_name: string; role: string; status: string; last_login_at: string | null }

const ROLES = [
  { value: 'owner', label: 'Owner', hint: 'Everything, including Rumfa staff' },
  { value: 'staff', label: 'Staff', hint: 'Clients and shared data' },
  { value: 'support', label: 'Support', hint: 'Can look, and make new invite links for clients' },
];

/** Rumfa's own team on the console. Owners invite people and change their access. */
@Component({
  selector: 'page-staff',
  imports: [DatePipe, MatButtonModule, MatIconModule],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>Rumfa staff</h1>
      <span class="spacer"></span>
      @if (api.isOwner) { <button mat-flat-button (click)="invite()"><mat-icon>person_add</mat-icon> Invite</button> }
    </div>
    @if (link()) {
      <div class="card">
        <p>Send this link to {{ linkFor() }} (valid 3 days). They choose a password with it.</p>
        <code class="link">{{ link() }}</code>
        <button mat-button (click)="copyLink()"><mat-icon>content_copy</mat-icon> Copy</button>
      </div>
    }
    <table class="grid">
      <tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr>
      @for (s of rows(); track s.id) {
        <tr>
          <td>{{ s.full_name }}<div class="hint">{{ s.email }}</div></td>
          <td>{{ label(s.role) }}</td>
          <td><span class="chip" [class.ok]="s.status === 'active'" [class.warn]="s.status === 'invited'" [class.bad]="s.status === 'suspended'">{{ label(s.status) }}</span>
</td>
          <td class="hint">{{ s.last_login_at ? (s.last_login_at | date: 'd MMM, HH:mm') : 'Never' }}</td>
          <td class="actions">
            @if (api.isOwner && s.id !== api.me()?.id) {
              <button mat-button (click)="role(s)">Role</button>
              <button mat-button (click)="reset(s)">New link</button>
              @if (s.status === 'suspended') { <button mat-button (click)="setStatus(s, 'active')">Restore</button> }
              @else { <button mat-button (click)="setStatus(s, 'suspended')">Suspend</button> }
            }
          </td>
        </tr>
      }
    </table>
  </div>`,
  styles: `.actions { text-align: right; white-space: nowrap; }`,
})
export class StaffPage {
  api = inject(Api);
  private ui = inject(Ui);
  rows = signal<StaffRow[]>([]);
  link = signal('');
  linkFor = signal('');
  label = label;

  constructor() { void this.load(); }
  async load() { try { this.rows.set(await this.api.get<StaffRow[]>('/platform/staff')); } catch (e) { this.ui.error(e); } }

  async invite() {
    const fullName = await this.ui.prompt('Invite to Rumfa Console', 'Full name');
    if (!fullName) return;
    const email = await this.ui.prompt(`${fullName}'s email`, 'Email');
    if (!email) return;
    const role = await this.ui.choose('Role', '', ROLES.map((r) => ({ label: r.label, hint: r.hint, value: r.value })));
    if (!role) return;
    const r = await this.ui.run(() => this.api.post<{ inviteToken: string }>('/platform/staff', { fullName, email, role }));
    if (r) { this.link.set(this.api.consoleInvite(r.inviteToken)); this.linkFor.set(fullName); await this.load(); }
  }
  async role(s: StaffRow) {
    const role = await this.ui.choose(`Role for ${s.full_name}`, '', ROLES.map((r) => ({ label: r.label, hint: r.hint, value: r.value })));
    if (role && await this.ui.run(() => this.api.patch(`/platform/staff/${s.id}`, { role }), 'Role changed')) await this.load();
  }
  async setStatus(s: StaffRow, status: string) {
    if (status === 'suspended' && !(await this.ui.confirm(`Suspend ${s.full_name}?`, 'They are signed out now and cannot sign in until restored.', 'Suspend'))) return;
    if (await this.ui.run(() => this.api.patch(`/platform/staff/${s.id}`, { status }), status === 'active' ? 'Restored' : 'Suspended')) await this.load();
  }
  async reset(s: StaffRow) {
    if (!(await this.ui.confirm(`New sign-in link for ${s.full_name}?`, 'They set a new password with it, and are signed out now.', 'Make link'))) return;
    const r = await this.ui.run(() => this.api.post<{ inviteToken: string }>(`/platform/staff/${s.id}/reset`));
    if (r) { this.link.set(this.api.consoleInvite(r.inviteToken)); this.linkFor.set(s.full_name); }
  }
  copyLink() { void copy(this.ui, this.link()); }
}
