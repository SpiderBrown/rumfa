import { Component, Injectable, inject } from '@angular/core';
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

  /** Pick one of a few options; null when cancelled. */
  async choose<T>(title: string, text: string, options: { label: string; hint?: string; value: T }[]): Promise<T | null> {
    const ref = this.dialog.open(ChoiceDialog, { data: { title, text, options }, width: '440px' });
    const i = await firstValueFrom(ref.afterClosed());
    return typeof i === 'number' ? options[i].value : null;
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
    <mat-dialog-content style="white-space: pre-line">{{ data.text }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [mat-dialog-close]="true">{{ data.okLabel }}</button>
    </mat-dialog-actions>`,
})
export class ConfirmDialog { data = inject<{ title: string; text: string; okLabel: string }>(MAT_DIALOG_DATA); }

@Component({
  selector: 'app-choice',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      @if (data.text) { <p>{{ data.text }}</p> }
      @for (o of data.options; track $index) {
        <button mat-stroked-button class="opt" [mat-dialog-close]="$index">
          <b>{{ o.label }}</b>@if (o.hint) { <span class="hint">{{ o.hint }}</span> }
        </button>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"><button mat-button mat-dialog-close>Cancel</button></mat-dialog-actions>`,
  styles: `.opt { display: block; width: 100%; height: auto; text-align: left; padding: 10px 14px; margin: 6px 0; }
    .hint { display: block; font-size: 12px; font-weight: 400; color: var(--mat-sys-on-surface-variant); }`,
})
export class ChoiceDialog { data = inject<{ title: string; text?: string; options: { label: string; hint?: string }[] }>(MAT_DIALOG_DATA); }

/** "governorship" → "Governorship", "fct_area_council" → "Fct area council" */
export function label(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Copies text and says so. */
export async function copy(ui: Ui, text: string, what = 'Link') {
  try { await navigator.clipboard.writeText(text); ui.toast(`${what} copied`); } catch { ui.toast('Select the text and copy it'); }
}
