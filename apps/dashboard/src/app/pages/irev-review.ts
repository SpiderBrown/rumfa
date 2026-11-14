import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { checkResult } from '@rumfa/shared';
import { Supa } from '../core/supabase';
import { Ui } from '../core/ui';

/** Review queue: sheets whose figures OCR could not read confidently. Staff type them while viewing the image. */
@Component({
  selector: 'app-irev-review',
  imports: [FormsModule, MatButtonModule, MatCardModule, MatFormFieldModule, MatInputModule],
  template: `
  <h1>Sheet review <span class="n">{{ queue().length }} waiting</span></h1>
  @if (cur(); as s) {
    <div class="grid">
      <div class="img">@if (imgUrl()) { <img [src]="imgUrl()" alt="Result sheet" /> } @else { Loading sheet… }</div>
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
    .img img { width: 100%; border: 1px solid var(--mat-sys-outline-variant); } .parties { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 8px; }
    .acts { display: flex; gap: 8px; margin-top: 12px; } .bad { color: #b3261e; } input.low { background: #fff4e5; }`,
})
export class IrevReviewPage {
  private supa = inject(Supa);
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
    const { data } = await this.supa.client.from('irev_sheet_results').select('*').eq('ocr_status', 'needs_review')
      .order('created_at').limit(100);
    this.queue.set(data ?? []);
    this.idx.set(0);
    await this.show();
  }

  low(k: string) { return (this.cur()?.confidence?.[k] ?? 0) < 0.85; }

  async show() {
    const s = this.cur();
    this.imgUrl.set(null);
    if (!s) return;
    const { data: ps } = await this.supa.client.from('election_parties').select('party').eq('election_id', s.election_id).order('ballot_order');
    this.parties.set((ps ?? []).map((p) => p.party));
    this.form = { registered: s.registered, accredited: s.accredited, rejected: s.rejected, total_valid: s.total_valid };
    this.votes = Object.fromEntries(this.parties().map((p) => [p, s.votes?.[p] ?? 0]));
    this.issues.set([]);
    this.imgUrl.set(await this.supa.signedUrl({ kind: 'irev', election_id: s.election_id, pu_code: s.pu_code }).catch(() => null));
  }

  async confirm() {
    const s = this.cur()!;
    const f = { registered: +this.form['registered'], accredited: +this.form['accredited'], rejected: +this.form['rejected'], totalValid: +this.form['total_valid'],
      votes: Object.fromEntries(Object.entries(this.votes).map(([k, v]) => [k, +v])) };
    const issues = checkResult(f);
    this.issues.set(issues);
    if (issues.length && !(await this.ui.confirm('Figures do not add up', issues.map((i) => i.message).join(' '), 'Save as the sheet shows'))) return;
    const ok = await this.ui.run(() => this.supa.rpc('confirm_irev_sheet', {
      p_election: s.election_id, p_pu: s.pu_code, p_version: s.sheet_version, p_registered: f.registered, p_accredited: f.accredited,
      p_rejected: f.rejected, p_total_valid: f.totalValid, p_votes: f.votes }), 'Confirmed');
    if (ok !== undefined) { this.queue.set(this.queue().filter((x) => x !== s)); await this.show(); }
  }

  async skip() { this.idx.set((this.idx() + 1) % Math.max(1, this.queue().length)); await this.show(); }
}
