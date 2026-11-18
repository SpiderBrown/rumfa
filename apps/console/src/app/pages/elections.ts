import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Api } from '../core/api';
import { Ui, label } from '../core/ui';

interface Election {
  id: string; name: string; election_type: string; election_date: string; irev_election_id: string | null; scope_state_code: string | null;
  status: string; parties: string[]; clients: number;
}
interface Party { acronym: string; name: string; logoUrl: string | null; colour: string | null }
interface Form { id: string | null; name: string; electionType: string; electionDate: string; scopeStateCode: string | null; irevElectionId: string; status: string }

const TYPES = ['presidential', 'governorship', 'senate', 'reps', 'state_assembly', 'chairman', 'councillor', 'fct_area_council'];
const STATUSES = ['upcoming', 'live', 'collation', 'closed'];
const blank = (): Form => ({ id: null, name: '', electionType: 'governorship', electionDate: '', scopeStateCode: null, irevElectionId: '', status: 'upcoming' });

/** Elections the platform knows about: date, IReV id, status and the ballot (parties in ballot order). */
@Component({
  selector: 'page-elections',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>Elections</h1>
      <span class="spacer"></span>
      @if (api.canEdit && !form()) { <button mat-flat-button (click)="startNew()"><mat-icon>add</mat-icon> Add an election</button> }
    </div>

    @if (form(); as f) {
      <div class="card">
        <h2>{{ f.id ? 'Edit ' + f.name : 'New election' }}</h2>
        <div class="row">
          <mat-form-field><mat-label>Name</mat-label><input matInput [(ngModel)]="f.name" placeholder="e.g. 2027 Kano Governorship" /></mat-form-field>
          <mat-form-field><mat-label>Type</mat-label><mat-select [(ngModel)]="f.electionType" [disabled]="!!f.id">
            @for (t of types; track t) { <mat-option [value]="t">{{ label(t) }}</mat-option> }</mat-select></mat-form-field>
          <mat-form-field><mat-label>Date</mat-label><input matInput type="date" [(ngModel)]="f.electionDate" /></mat-form-field>
        </div>
        <div class="row">
          <mat-form-field><mat-label>State (for state elections)</mat-label><mat-select [(ngModel)]="f.scopeStateCode" [disabled]="!!f.id">
            <mat-option [value]="null">Nationwide</mat-option>
            @for (s of states(); track s.code) { <mat-option [value]="s.code">{{ s.name }}</mat-option> }</mat-select></mat-form-field>
          <mat-form-field><mat-label>IReV election id (optional)</mat-label><input matInput [(ngModel)]="f.irevElectionId" placeholder="24 characters, from IReV" />
            <mat-hint>Added by INEC shortly before polling day</mat-hint></mat-form-field>
          <mat-form-field><mat-label>Status</mat-label><mat-select [(ngModel)]="f.status">
            @for (s of statuses; track s) { <mat-option [value]="s">{{ label(s) }}</mat-option> }</mat-select></mat-form-field>
        </div>

        <h3>Ballot <span class="hint">({{ ballot().length }} parties, in INEC's alphabetical order)</span></h3>
        <p class="hint">Tick the parties with a candidate. Until INEC publishes the final candidate list, you can tick all registered parties and trim it later.</p>
        <div class="tools">
          <button mat-button (click)="selectAll()">Tick all</button>
          <button mat-button (click)="ballot.set([])">Clear</button>
        </div>
        <div class="parties">
          @for (p of parties(); track p.acronym) {
            <button type="button" class="party" [class.on]="ballot().includes(p.acronym)" (click)="toggle(p.acronym)" [title]="p.name">
              @if (p.logoUrl) { <img [src]="api.asset(p.logoUrl)" alt="" /> } @else { <span class="dot" [style.background]="p.colour ?? '#bdbdbd'"></span> }
              {{ p.acronym }}
              @if (ballot().includes(p.acronym)) { <mat-icon>check</mat-icon> }
            </button>
          }
        </div>
        @if (ballot().length) { <p class="order">{{ ballot().join(' · ') }}</p> }

        <div class="page-head">
          <span class="spacer"></span>
          <button mat-button (click)="form.set(null)">Cancel</button>
          <button mat-flat-button (click)="save()" [disabled]="busy()">{{ f.id ? 'Save changes' : 'Save election' }}</button>
        </div>
      </div>
    }

    <table class="grid">
      <tr><th>Election</th><th>Date</th><th>Status</th><th>Ballot</th><th>Clients</th><th></th></tr>
      @for (e of rows(); track e.id) {
        <tr>
          <td><b>{{ e.name }}</b><div class="hint">{{ label(e.election_type) }}{{ e.scope_state_code ? ' · ' + stateName(e.scope_state_code) : '' }}{{ e.irev_election_id ? ' · on IReV' : '' }}</div></td>
          <td>{{ e.election_date }}</td>
          <td>{{ label(e.status) }}</td>
          <td class="ballot">@for (p of e.parties; track p) { <span class="chip">{{ p }}</span> } @empty { <span class="hint">Not set</span> }</td>
          <td>{{ e.clients }}</td>
          <td>@if (api.canEdit) { <button mat-button (click)="edit(e)"><mat-icon>edit</mat-icon> Edit</button> }</td>
        </tr>
      }
    </table>
  </div>`,
  styles: `
    h3 { font: var(--mat-sys-title-small); margin: 8px 0 4px; }
    .tools { margin-bottom: 6px; }
    .parties { display: flex; flex-wrap: wrap; gap: 6px; }
    .party { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 16px; border: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface); cursor: pointer; font: var(--mat-sys-label-large); }
    .party.on { background: var(--mat-sys-primary-container); border-color: var(--mat-sys-primary); }
    .party img { width: 20px; height: 20px; object-fit: contain; } .party .dot { width: 12px; height: 12px; border-radius: 50%; }
    .party mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .order { font-size: 13px; color: var(--mat-sys-on-surface-variant); margin: 8px 0 0; }
    .ballot { max-width: 420px; } .ballot .chip { margin-bottom: 3px; }
  `,
})
export class ElectionsPage {
  api = inject(Api);
  private ui = inject(Ui);
  rows = signal<Election[]>([]);
  states = signal<{ code: string; name: string }[]>([]);
  parties = signal<Party[]>([]);
  form = signal<Form | null>(null);
  ballot = signal<string[]>([]);
  busy = signal(false);
  types = TYPES; statuses = STATUSES; label = label;
  private sorted = computed(() => this.parties().map((p) => p.acronym));

  constructor() { void this.load(); }
  async load() {
    try {
      const [rows, st, parties] = await Promise.all([
        this.api.get<Election[]>('/platform/elections'), this.api.get<{ items: any[] }>('/platform/places'), this.api.get<Party[]>('/platform/parties'),
      ]);
      this.rows.set(rows); this.states.set(st.items); this.parties.set(parties);
    } catch (e) { this.ui.error(e); }
  }
  stateName(c: string) { return this.states().find((s) => s.code === c)?.name ?? c; }

  startNew() { this.form.set(blank()); this.ballot.set([]); }
  edit(e: Election) {
    this.form.set({ id: e.id, name: e.name, electionType: e.election_type, electionDate: e.election_date, scopeStateCode: e.scope_state_code,
      irevElectionId: e.irev_election_id ?? '', status: e.status });
    this.ballot.set([...e.parties]);
    window.scrollTo(0, 0);
  }

  /** Ballot papers list parties alphabetically by acronym: keep that order whatever order they are ticked in */
  private order(list: string[]) { return this.sorted().filter((a) => list.includes(a)); }
  toggle(a: string) { const b = this.ballot(); this.ballot.set(this.order(b.includes(a) ? b.filter((x) => x !== a) : [...b, a])); }
  selectAll() { this.ballot.set([...this.sorted()]); }

  async save() {
    const f = this.form()!;
    if (!f.name.trim() || !f.electionDate) { this.ui.error('Fill in the name and date'); return; }
    const irev = f.irevElectionId.trim();
    if (irev && !/^[0-9a-f]{24}$/.test(irev)) { this.ui.error('The IReV id is 24 letters and numbers (0-9, a-f)'); return; }
    this.busy.set(true);
    const ok = await this.ui.run(async () => {
      if (f.id) {
        await this.api.patch(`/platform/elections/${f.id}`, { name: f.name.trim(), electionDate: f.electionDate, irevElectionId: irev || null, status: f.status });
        await this.api.put(`/platform/elections/${f.id}/parties`, { parties: this.ballot() });
      } else {
        await this.api.post('/platform/elections', {
          name: f.name.trim(), electionType: f.electionType, electionDate: f.electionDate, scopeStateCode: f.scopeStateCode ?? undefined,
          irevElectionId: irev || undefined, status: f.status, parties: this.ballot(),
        });
      }
      return true;
    }, f.id ? 'Election saved' : 'Election added');
    this.busy.set(false);
    if (ok) { this.form.set(null); await this.load(); }
  }
}
