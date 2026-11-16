import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { checkResult } from '@rumfa/shared';
import { Api } from '../core/api';
import { Ui } from '../core/ui';
import { SheetViewer } from '../core/sheet-viewer';

/** Review queue: sheets whose figures OCR could not read confidently. Staff type them while viewing the sheet (photo or PDF). */
@Component({
  selector: 'app-irev-review',
  imports: [FormsModule, SheetViewer, MatButtonModule, MatCardModule, MatFormFieldModule, MatInputModule],
  template: `
  <h1>Sheet review <span class="n">{{ queue().length }} waiting</span></h1>
  @if (cur(); as s) {
    <div class="grid">
      <app-sheet-viewer class="img" [url]="imgUrl()" />
      <mat-card appearance="outlined" class="form">
        <mat-card-header><mat-card-title>{{ s.pu_code }}</mat-card-title><mat-card-subtitle>Sheet version {{ s.sheet_version }}
          @if (s.sheet_pu_code && s.sheet_pu_code !== s.pu_code) { · <b class="bad">sheet shows {{ s.sheet_pu_code }}</b> }</mat-card-subtitle></mat-card-header>
        <mat-card-content>
          @for (f of headerFields; track f.key) {
            <mat-form-field class="full"><mat-label>{{ f.label }}</mat-label>
              <input matInput type="number" min="0" [(ngModel)]="form[f.key]" [class.low]="low(f.key)" /></mat-form-field>
          }
          <div class="parties">
            @for (p of parties(); track p) {
              <mat-form-field><mat-label>{{ p }}</mat-label><input matInput type="number" min="0" [(ngModel)]="votes[p]" [class.low]="low('votes.' + p)" /></mat-form-field>
            }
          </div>
          @for (i of issues(); track i.code) { <div class="bad">{{ i.message }}</div> }
          <div class="acts">
            <button mat-flat-button (click)="confirm()">Confirm figures</button>
            <button mat-button (click)="skip()">Skip</button>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  } @else { <p>Nothing to review.</p> }`,
  styles: `h1 { font: var(--mat-sys-headline-small); } .n { font: var(--mat-sys-label-large); color: var(--mat-sys-on-surface-variant); }
    .grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(320px, 1fr); gap: 20px; }
    .img { position: sticky; top: 8px; align-self: start; } .parties { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 8px; }
    .acts { display: flex; gap: 8px; margin-top: 12px; } .bad { color: #b3261e; } input.low { background: #fff4e5; }`,
})
export class IrevReviewPage {
  private api = inject(Api);
  private ui = inject(Ui);
  headerFields = [
    { key: 'registered', label: 'Voters on the register' }, { key: 'accredited', label: 'Accredited voters' },
    { key: 'rejected', label: 'Rejected ballots' }, { key: 'total_valid', label: 'Total valid votes' },
  ] as const;
  queue = signal<any[]>([]);
  idx = signal(0);
  cur = computed(() => this.queue()[this.idx()] ?? null);
  parties = signal<string[]>([]);
  imgUrl = signal<string | null>(null);
  form: Record<string, number> = {};
  votes: Record<string, number> = {};
  issues = signal<{ code: string; message: string }[]>([]);

  constructor() { void this.load(); }

  async load() {
    const elections = [this.api.liveElectionId(), this.api.baselineElectionId()].filter(Boolean) as string[];
    const lists = await Promise.all(elections.map((e) => this.api.get<any[]>('/irev/review', { election: e }).catch(() => [])));
    this.queue.set(lists.flat().slice(0, 100));
    this.idx.set(0);
    await this.show();
  }

  low(k: string) { return (this.cur()?.confidence?.[k] ?? 0) < 0.85; }

  async show() {
    const s = this.cur();
    this.imgUrl.set(null);
    if (!s) return;
    this.parties.set(await this.api.get<string[]>(`/elections/${s.election_id}/parties`).catch(() => []));
    this.form = { registered: s.registered, accredited: s.accredited, rejected: s.rejected, total_valid: s.total_valid };
    this.votes = Object.fromEntries(this.parties().map((p) => [p, s.votes?.[p] ?? 0]));
    this.issues.set([]);
    this.imgUrl.set(await this.api.viewUrl({ kind: 'irev', electionId: s.election_id, pu: s.pu_code }).catch(() => null));
  }

  async confirm() {
    const s = this.cur()!;
    const f = { registered: +this.form['registered'], accredited: +this.form['accredited'], rejected: +this.form['rejected'], totalValid: +this.form['total_valid'],
      votes: Object.fromEntries(Object.entries(this.votes).map(([k, v]) => [k, +v])) };
    const issues = checkResult(f);
    this.issues.set(issues);
    if (issues.length && !(await this.ui.confirm('Figures do not add up', issues.map((i) => i.message).join(' '), 'Save as the sheet shows'))) return;
    const ok = await this.ui.run(async () => { await this.api.post('/irev/sheets/confirm', {
      electionId: s.election_id, pu: s.pu_code, version: s.sheet_version, registered: f.registered, accredited: f.accredited,
      rejected: f.rejected, totalValid: f.totalValid, votes: f.votes }); return true; }, 'Confirmed');
    if (ok) { this.queue.set(this.queue().filter((x) => x !== s)); await this.show(); }
  }

  async skip() { this.idx.set((this.idx() + 1) % Math.max(1, this.queue().length)); await this.show(); }
}
