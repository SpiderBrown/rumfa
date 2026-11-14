import { Component, Injectable, Pipe, type PipeTransform, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class Ui {
  private snack = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  toast(msg: string) { this.snack.open(msg, 'OK', { duration: 4000 }); }
  error(e: unknown) { this.snack.open(e instanceof Error ? e.message : String(e), 'Dismiss', { duration: 8000, panelClass: 'snack-error' }); }

  /** Run an action, show success or the error message. */
  async run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    try { const r = await fn(); if (ok) this.toast(ok); return r; } catch (e) { this.error(e); return undefined; }
  }

  async prompt(title: string, label: string, opts: { value?: string; multiline?: boolean; okLabel?: string } = {}): Promise<string | null> {
    const ref = this.dialog.open(PromptDialog, { data: { title, label, ...opts }, width: '480px' });
    return (await firstValueFrom(ref.afterClosed())) ?? null;
  }

  async confirm(title: string, text: string, okLabel = 'Confirm'): Promise<boolean> {
    const ref = this.dialog.open(ConfirmDialog, { data: { title, text, okLabel }, width: '420px' });
    return !!(await firstValueFrom(ref.afterClosed()));
  }
}

@Component({
  selector: 'app-prompt',
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, FormsModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <mat-form-field class="full">
        <mat-label>{{ data.label }}</mat-label>
        @if (data.multiline) { <textarea matInput rows="4" [(ngModel)]="value" cdkFocusInitial></textarea> }
        @else { <input matInput [(ngModel)]="value" (keyup.enter)="ok()" /> }
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!value.trim()" (click)="ok()">{{ data.okLabel ?? 'Save' }}</button>
    </mat-dialog-actions>`,
})
export class PromptDialog {
  data = inject<{ title: string; label: string; value?: string; multiline?: boolean; okLabel?: string }>(MAT_DIALOG_DATA);
  ref = inject(MatDialogRef<PromptDialog>);
  value = this.data.value ?? '';
  ok() { if (this.value.trim()) this.ref.close(this.value.trim()); }
}

@Component({
  selector: 'app-confirm',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>{{ data.text }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [mat-dialog-close]="true">{{ data.okLabel }}</button>
    </mat-dialog-actions>`,
})
export class ConfirmDialog { data = inject<{ title: string; text: string; okLabel: string }>(MAT_DIALOG_DATA); }

/** "3 min ago", "in 2 min" */
@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(v: string | null | undefined): string {
    if (!v) return '';
    const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
    const a = Math.abs(s);
    const t = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
    return s >= 0 ? `${t} ago` : `in ${t}`;
  }
}

export const SEVERITY_COLOR: Record<string, string> = { critical: '#b3261e', high: '#c25700', medium: '#8a6d00', low: '#4a6572' };

export function label(s: string | null | undefined): string {
  return (s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
