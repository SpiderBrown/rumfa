import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { Ui, label } from '../core/ui';

interface Contact {
  id: string; agency: string; title: string; person_name: string | null; phone: string | null; email: string | null; address: string | null;
  level: 'national' | 'state' | 'lga' | 'ward'; area_code: string; area_name: string | null; status: string; notes: string | null;
  source_type: string; source_url: string | null; last_call_ok_at: string | null; last_call_failed_at: string | null;
}
interface Area { code: string; name: string }
interface Form {
  id: string | null; agency: string; title: string; person: string; phone: string; email: string; address: string; notes: string;
  level: Contact['level']; state: string; lga: string; ward: string; status: 'pending' | 'verified';
}

/** Official authority contacts (INEC offices, police commands, ...): kept once here, shown on every client's dashboard. */
@Component({
  selector: 'page-contacts',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MatTooltipModule],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>Authority contacts</h1>
      <span class="spacer"></span>
      <mat-form-field class="narrow" subscriptSizing="dynamic"><mat-label>State</mat-label>
        <mat-select [(ngModel)]="stateFilter" (selectionChange)="load()">
          <mat-option value="">All of Nigeria</mat-option>
          <mat-option value="NG">National only</mat-option>
          @for (s of states(); track s.code) { <mat-option [value]="s.code">{{ s.name }}</mat-option> }
        </mat-select></mat-form-field>
      <mat-form-field class="narrow" subscriptSizing="dynamic"><mat-label>Search</mat-label>
        <input matInput [(ngModel)]="q" (ngModelChange)="search.set($event)" placeholder="Agency, title, name, place" /></mat-form-field>
      @if (api.canEdit && !form()) { <button mat-flat-button (click)="startNew()"><mat-icon>add</mat-icon> Add contact</button> }
    </div>
    <p class="hint">Official contacts added here are shared: every client's dashboard shows them, next to the contacts its own people add.</p>

    @if (form(); as f) {
      <div class="card">
        <h2>{{ f.id ? 'Edit contact' : 'New official contact' }}</h2>
        <div class="row">
          <mat-form-field><mat-label>Agency</mat-label>
            <mat-select [(ngModel)]="f.agency">@for (a of agencies(); track a) { <mat-option [value]="a">{{ a }}</mat-option> }</mat-select></mat-form-field>
          <mat-form-field class="wide"><mat-label>Title or office</mat-label><input matInput [(ngModel)]="f.title" placeholder="e.g. Resident Electoral Commissioner" /></mat-form-field>
          <mat-form-field><mat-label>Name (optional)</mat-label><input matInput [(ngModel)]="f.person" /></mat-form-field>
        </div>
        <div class="row">
          <mat-form-field><mat-label>Covers</mat-label>
            <mat-select [(ngModel)]="f.level">
              <mat-option value="national">All of Nigeria</mat-option><mat-option value="state">A state</mat-option>
              <mat-option value="lga">An LGA</mat-option><mat-option value="ward">A ward</mat-option>
            </mat-select></mat-form-field>
          @if (f.level !== 'national') {
            <mat-form-field><mat-label>State</mat-label>
              <mat-select [(ngModel)]="f.state" (selectionChange)="f.lga = ''; f.ward = ''; loadLgas(f.state)">
                @for (s of states(); track s.code) { <mat-option [value]="s.code">{{ s.name }}</mat-option> }</mat-select></mat-form-field>
          }
          @if (f.level === 'lga' || f.level === 'ward') {
            <mat-form-field><mat-label>LGA</mat-label>
              <mat-select [(ngModel)]="f.lga" (selectionChange)="f.ward = ''; loadWards(f.lga)" [disabled]="!f.state">
                @for (l of lgas(); track l.code) { <mat-option [value]="l.code">{{ l.name }}</mat-option> }</mat-select></mat-form-field>
          }
          @if (f.level === 'ward') {
            <mat-form-field><mat-label>Ward</mat-label>
              <mat-select [(ngModel)]="f.ward" [disabled]="!f.lga">
                @for (w of wards(); track w.code) { <mat-option [value]="w.code">{{ w.name }}</mat-option> }</mat-select></mat-form-field>
          }
        </div>
        <div class="row">
          <mat-form-field><mat-label>Phone</mat-label><input matInput [(ngModel)]="f.phone" placeholder="e.g. 0803 000 0000" /></mat-form-field>
          <mat-form-field><mat-label>Email (optional)</mat-label><input matInput [(ngModel)]="f.email" /></mat-form-field>
          <mat-form-field class="wide"><mat-label>Address (optional)</mat-label><input matInput [(ngModel)]="f.address" /></mat-form-field>
        </div>
        <div class="row">
          <mat-form-field><mat-label>Status</mat-label>
            <mat-select [(ngModel)]="f.status">
              <mat-option value="verified">Verified: the number works</mat-option>
              <mat-option value="pending">Not checked yet</mat-option>
            </mat-select></mat-form-field>
          <mat-form-field class="wide"><mat-label>Notes (optional)</mat-label><input matInput [(ngModel)]="f.notes" /></mat-form-field>
        </div>
        <div class="page-head">
          <span class="spacer"></span>
          <button mat-button (click)="form.set(null)">Cancel</button>
          <button mat-flat-button (click)="save()" [disabled]="busy()">{{ f.id ? 'Save changes' : 'Add contact' }}</button>
        </div>
      </div>
    }

    <table class="grid">
      <tr><th>Contact</th><th>Covers</th><th>Phone</th><th>Status</th><th></th></tr>
      @for (k of shown(); track k.id) {
        <tr>
          <td><b>{{ k.agency }}</b> · {{ k.title }}
            <div class="hint">{{ k.person_name }}{{ k.person_name && k.address ? ' · ' : '' }}{{ k.address }}</div>
            @if (k.source_type === 'official' && k.source_url) { <a class="hint" [href]="k.source_url" target="_blank" rel="noopener">source</a> }</td>
          <td>{{ k.level === 'national' ? 'Nigeria' : k.area_name ?? k.area_code }}<div class="hint">{{ levelName(k.level) }} · {{ k.area_code }}</div></td>
          <td>{{ k.phone ?? '—' }}@if (k.email) { <div class="hint">{{ k.email }}</div> }</td>
          <td><span class="chip" [class.ok]="k.status === 'verified'" [class.warn]="k.status !== 'verified'">{{ label(k.status) }}</span></td>
          <td class="acts">
            @if (api.canEdit) {
              <button mat-icon-button matTooltip="Edit" (click)="edit(k)"><mat-icon>edit</mat-icon></button>
              <button mat-icon-button matTooltip="Remove" (click)="remove(k)"><mat-icon>delete</mat-icon></button>
            }
          </td>
        </tr>
      } @empty { <tr><td colspan="5" class="hint">{{ loaded() ? 'No official contacts here yet.' : 'Loading…' }}</td></tr> }
    </table>
    @if (shown().length) { <p class="hint">{{ shown().length }} contact(s)</p> }
  </div>`,
  styles: `.narrow { width: 200px; } .row { display: flex; gap: 12px; flex-wrap: wrap; } .row mat-form-field { flex: 1; min-width: 180px; }
    .row .wide { flex: 2; } .acts { white-space: nowrap; text-align: right; }`,
})
export class ContactsPage {
  api = inject(Api);
  private ui = inject(Ui);
  label = label;
  items = signal<Contact[]>([]);
  agencies = signal<string[]>([]);
  states = signal<Area[]>([]);
  lgas = signal<Area[]>([]);
  wards = signal<Area[]>([]);
  loaded = signal(false);
  busy = signal(false);
  form = signal<Form | null>(null);
  stateFilter = '';
  q = '';
  search = signal('');
  shown = computed(() => {
    const f = this.search().trim().toLowerCase();
    return f ? this.items().filter((k) => [k.agency, k.title, k.person_name, k.area_name, k.area_code, k.phone].join(' ').toLowerCase().includes(f)) : this.items();
  });

  constructor() {
    void this.load();
    void this.api.get<{ items: Area[] }>('/platform/places/browse', { parent: 'NG' }).then((r) => this.states.set(r.items)).catch((e) => this.ui.error(e));
  }

  async load() {
    try {
      const r = await this.api.get<{ items: Contact[]; agencies: string[] }>('/platform/contacts', this.stateFilter ? { state: this.stateFilter } : {});
      this.items.set(r.items); this.agencies.set(r.agencies);
    } catch (e) { this.ui.error(e); }
    this.loaded.set(true);
  }
  async loadLgas(state: string) {
    this.lgas.set([]); this.wards.set([]);
    if (state) this.lgas.set((await this.api.get<{ items: Area[] }>('/platform/places/browse', { parent: state })).items);
  }
  async loadWards(lga: string) {
    this.wards.set([]);
    if (lga) this.wards.set((await this.api.get<{ items: Area[] }>('/platform/places/browse', { parent: lga })).items);
  }
  levelName(l: string) { return ({ national: 'National', state: 'State', lga: 'LGA', ward: 'Ward' } as Record<string, string>)[l] ?? l; }

  startNew() {
    const state = /^\d{2}$/.test(this.stateFilter) ? this.stateFilter : '';
    this.form.set({ id: null, agency: 'INEC', title: '', person: '', phone: '', email: '', address: '', notes: '',
      level: state ? 'state' : 'national', state, lga: '', ward: '', status: 'verified' });
    if (state) void this.loadLgas(state);
  }
  async edit(k: Contact) {
    const c = k.area_code;
    this.form.set({ id: k.id, agency: k.agency, title: k.title, person: k.person_name ?? '', phone: k.phone ?? '', email: k.email ?? '',
      address: k.address ?? '', notes: k.notes ?? '', level: k.level, state: c === 'NG' ? '' : c.slice(0, 2),
      lga: c.length >= 5 ? c.slice(0, 5) : '', ward: c.length >= 8 ? c.slice(0, 8) : '', status: k.status === 'verified' ? 'verified' : 'pending' });
    if (c !== 'NG') await this.loadLgas(c.slice(0, 2));
    if (c.length >= 5) await this.loadWards(c.slice(0, 5));
  }

  async save() {
    const f = this.form()!;
    const areaCode = { national: 'NG', state: f.state, lga: f.lga, ward: f.ward }[f.level];
    if (!f.title.trim()) { this.ui.toast('Give the title or office'); return; }
    if (!areaCode) { this.ui.toast(`Pick the ${f.level === 'lga' ? 'LGA' : f.level}`); return; }
    const body = { agency: f.agency, title: f.title, person: f.person, phone: f.phone, email: f.email, address: f.address,
      level: f.level, areaCode, status: f.status, notes: f.notes };
    this.busy.set(true);
    const ok = await this.ui.run(() => (f.id ? this.api.patch(`/platform/contacts/${f.id}`, body) : this.api.post('/platform/contacts', body)),
      f.id ? 'Contact saved' : 'Contact added');
    this.busy.set(false);
    if (ok) { this.form.set(null); await this.load(); }
  }

  async remove(k: Contact) {
    if (!(await this.ui.confirm(`Remove ${k.agency} · ${k.title}?`, 'It disappears from every client\'s dashboard.', 'Remove'))) return;
    if (await this.ui.run(() => this.api.del(`/platform/contacts/${k.id}`), 'Removed')) await this.load();
  }
}
