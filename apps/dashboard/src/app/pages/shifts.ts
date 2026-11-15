import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../core/api';
import { Ui, label } from '../core/ui';

/** Queues and shifts: assignment only picks operators who are on shift for the queue. */
@Component({
  selector: 'app-shifts',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTableModule, MatIconModule],
  template: `
  <h1>Shifts and queues</h1>
  <h2>Room staff now</h2>
  <table mat-table [dataSource]="staff()">
    <ng-container matColumnDef="name"><th mat-header-cell *matHeaderCellDef>Name</th><td mat-cell *matCellDef="let s">{{ s.full_name }}</td></ng-container>
    <ng-container matColumnDef="role"><th mat-header-cell *matHeaderCellDef>Role</th><td mat-cell *matCellDef="let s">{{ label(s.role) }}</td></ng-container>
    <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>Status</th><td mat-cell *matCellDef="let s">{{ label(s.status) }} @if (s.on_shift) { · on shift }</td></ng-container>
    <ng-container matColumnDef="open"><th mat-header-cell *matHeaderCellDef>Open cases</th><td mat-cell *matCellDef="let s">{{ s.open_cases }}</td></ng-container>
    <ng-container matColumnDef="lang"><th mat-header-cell *matHeaderCellDef>Languages</th><td mat-cell *matCellDef="let s">{{ s.languages.join(', ') }}</td></ng-container>
    <tr mat-header-row *matHeaderRowDef="['name','role','status','open','lang']"></tr>
    <tr mat-row *matRowDef="let r; columns: ['name','role','status','open','lang']"></tr>
  </table>

  <h2>Add shift</h2>
  <div class="form">
    <mat-form-field><mat-label>Person</mat-label><mat-select [(ngModel)]="n.volunteer">
      @for (s of staff(); track s.id) { <mat-option [value]="s.id">{{ s.full_name }}</mat-option> }</mat-select></mat-form-field>
    <mat-form-field><mat-label>Queue</mat-label><mat-select [(ngModel)]="n.queue">
      @for (q of queues(); track q.id) { <mat-option [value]="q.id">{{ q.name }}</mat-option> }</mat-select></mat-form-field>
    <mat-form-field><mat-label>Role</mat-label><mat-select [(ngModel)]="n.role">
      <mat-option value="operator">Operator</mat-option><mat-option value="supervisor">Supervisor</mat-option>
      <mat-option value="overflow">Overflow (national)</mat-option></mat-select></mat-form-field>
    <mat-form-field><mat-label>Starts</mat-label><input matInput type="datetime-local" [(ngModel)]="n.starts" /></mat-form-field>
    <mat-form-field><mat-label>Ends</mat-label><input matInput type="datetime-local" [(ngModel)]="n.ends" /></mat-form-field>
    <button mat-flat-button (click)="addShift()">Add</button>
  </div>

  <h2>Upcoming shifts</h2>
  <table mat-table [dataSource]="shifts()">
    <ng-container matColumnDef="who"><th mat-header-cell *matHeaderCellDef>Person</th><td mat-cell *matCellDef="let s">{{ s.full_name }}</td></ng-container>
    <ng-container matColumnDef="queue"><th mat-header-cell *matHeaderCellDef>Queue</th><td mat-cell *matCellDef="let s">{{ s.queue_name }}</td></ng-container>
    <ng-container matColumnDef="role"><th mat-header-cell *matHeaderCellDef>Role</th><td mat-cell *matCellDef="let s">{{ label(s.role) }}</td></ng-container>
    <ng-container matColumnDef="time"><th mat-header-cell *matHeaderCellDef>Time</th>
      <td mat-cell *matCellDef="let s">{{ s.starts_at | date: 'EEE d MMM HH:mm' }} – {{ s.ends_at | date: 'HH:mm' }}</td></ng-container>
    <ng-container matColumnDef="act"><th mat-header-cell *matHeaderCellDef></th>
      <td mat-cell *matCellDef="let s"><button mat-icon-button (click)="remove(s.id)"><mat-icon>delete</mat-icon></button></td></ng-container>
    <tr mat-header-row *matHeaderRowDef="['who','queue','role','time','act']"></tr>
    <tr mat-row *matRowDef="let r; columns: ['who','queue','role','time','act']"></tr>
  </table>

  <h2>Queues</h2>
  @for (q of queues(); track q.id) {
    <div class="queue">{{ q.name }} · {{ q.kind }} @if (q.state_code) { {{ q.state_code }} }
      · overflow after <input type="number" min="1" [value]="q.overflow_limit" (change)="setOverflow(q.id, $any($event.target).value)" /> waiting</div>
  }`,
  styles: `h1 { font: var(--mat-sys-headline-small); } h2 { font: var(--mat-sys-title-medium); margin-top: 24px; } table { width: 100%; }
    .form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .queue { padding: 6px 0; } .queue input { width: 56px; }`,
})
export class ShiftsPage {
  private api = inject(Api);
  private ui = inject(Ui);
  label = label;
  staff = signal<any[]>([]);
  queues = signal<any[]>([]);
  shifts = signal<any[]>([]);
  n = { volunteer: '', queue: '', role: 'operator', starts: '', ends: '' };

  constructor() { void this.load(); }

  async load() {
    const [s, q, sh] = await Promise.all([
      this.api.get<any[]>('/people/room-staff').catch(() => []),
      this.api.get<any[]>('/queues').catch(() => []),
      this.api.get<any[]>('/shifts').catch(() => []),
    ]);
    this.staff.set(s); this.queues.set(q); this.shifts.set(sh);
  }

  async addShift() {
    if (!this.n.volunteer || !this.n.queue || !this.n.starts || !this.n.ends) { this.ui.error('Fill all fields'); return; }
    const ok = await this.ui.run(() => this.api.post('/shifts', { volunteerId: this.n.volunteer, queueId: this.n.queue, role: this.n.role,
      startsAt: new Date(this.n.starts).toISOString(), endsAt: new Date(this.n.ends).toISOString() }), 'Shift added');
    if (ok) await this.load();
  }
  async remove(id: string) { await this.ui.run(() => this.api.del(`/shifts/${id}`)); await this.load(); }
  async setOverflow(id: string, v: string) {
    await this.ui.run(() => this.api.patch(`/queues/${id}`, { overflowLimit: Number(v) }), 'Saved');
  }
}
