import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Api } from '../core/api';
import { Ui, copy, label } from '../core/ui';

interface Seat { seat: string; label: string; area: string; ready: boolean; coordinatorLevels: string[] }
interface Place { code: string; name: string; zone?: string; senatorial_code?: string | null; lgas?: number }
interface Constituency { code: string; name: string; kind: 'federal' | 'state'; lgas: string[] }
interface Party { acronym: string; name: string; logoUrl: string | null }
interface Election { id: string; name: string; election_type: string; election_date: string; status: string; scope_state_code: string | null }
interface Coord { fullName: string; phone: string; level: string; areaCode: string }

const LEVEL = { national: 'National', state: 'State', lga: 'LGA', ward: 'Ward' } as Record<string, string>;

/**
 * Onboard a client in one go: who the candidate is and the seat they run for (which sets the client's area), the
 * elections, the dashboard admins (invite links) and the first coordinators at the seat's levels.
 */
@Component({
  selector: 'page-onboard',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule],
  template: `
  <div class="page">
    <div class="page-head"><a mat-icon-button routerLink="/clients"><mat-icon>arrow_back</mat-icon></a><h1>Onboard a client</h1></div>

    @if (done(); as d) {
      <div class="card">
        <h2>{{ brand }} is set up</h2>
        <p>Send each admin their own link (valid 7 days). They choose a password with it.</p>
        @for (i of d.invites; track i.email) {
          <p><b>{{ i.fullName }}</b> · {{ i.email }}</p>
          <code class="link">{{ link(i.inviteToken) }}</code>
          <button mat-button (click)="copyLink(i.inviteToken)"><mat-icon>content_copy</mat-icon> Copy link</button>
        }
        @if (d.coordinators.length) {
          <p class="hint">{{ d.coordinators.length }} coordinator(s) added. They sign in to the Rumfa app with their phone number (an SMS code activates it).</p>
        }
        <a mat-flat-button [routerLink]="['/clients', d.id]">Open the client</a>
      </div>
    } @else {
    <div class="card">
      <h2>1. The organisation</h2>
      <div class="row">
        <mat-form-field><mat-label>Organisation name</mat-label><input matInput [(ngModel)]="name" placeholder="e.g. Abba for Governor 2027" /></mat-form-field>
        <mat-form-field><mat-label>Short name</mat-label><input matInput [(ngModel)]="brand" maxlength="20" placeholder="e.g. ABBA27" />
          <mat-hint>Shown in the apps and at the start of every SMS</mat-hint></mat-form-field>
      </div>
    </div>

    <div class="card">
      <h2>2. Candidate and seat</h2>
      <div class="row">
        <mat-form-field><mat-label>Candidate's full name</mat-label><input matInput [(ngModel)]="candidate" /></mat-form-field>
        <mat-form-field><mat-label>Party</mat-label>
          <mat-select [(ngModel)]="party">
            @for (p of parties(); track p.acronym) {
              <mat-option [value]="p.acronym">@if (p.logoUrl) { <img class="logo small" [src]="api.asset(p.logoUrl)" alt="" /> } {{ p.acronym }} · {{ p.name }}</mat-option>
            }
          </mat-select></mat-form-field>
      </div>
      <div class="row">
        <mat-form-field><mat-label>Seat</mat-label>
          <mat-select [ngModel]="seat()" (ngModelChange)="setSeat($event)">
            @for (s of seats(); track s.seat) { <mat-option [value]="s.seat" [disabled]="!s.ready">{{ s.label }}{{ s.ready ? '' : ' (needs constituencies)' }}</mat-option> }
          </mat-select></mat-form-field>
        @if (seatInfo(); as si) {
          @if (si.area !== 'national') {
            <mat-form-field><mat-label>State</mat-label>
              <mat-select [ngModel]="state()" (ngModelChange)="setState($event)">
                @for (s of statesFor(); track s.code) { <mat-option [value]="s.code">{{ s.name }}</mat-option> }
              </mat-select></mat-form-field>
          }
          @if (si.area === 'constituency' && state()) {
            <mat-form-field><mat-label>{{ seat() === 'reps' ? 'Federal constituency' : 'State constituency' }}</mat-label>
              <mat-select [ngModel]="area()" (ngModelChange)="area.set($event)">
                @for (c of constituenciesFor(); track c.code) { <mat-option [value]="c.code" [disabled]="!c.lgas.length">{{ c.name }}{{ c.lgas.length ? '' : ' (no wards linked)' }}</mat-option> }
              </mat-select>
              @if (!constituenciesFor().length) { <mat-hint>None loaded for this state: Places → Load constituencies</mat-hint> }</mat-form-field>
          }
          @if (si.area === 'senatorial' && state()) {
            <mat-form-field><mat-label>Senatorial district</mat-label>
              <mat-select [ngModel]="area()" (ngModelChange)="area.set($event)">
                @for (d of districts(); track d.code) { <mat-option [value]="d.code" [disabled]="!d.lgas">{{ d.name }} ({{ d.lgas }} LGAs)</mat-option> }
              </mat-select>
              @if (!districts().length) { <mat-hint>No districts loaded for this state</mat-hint> }</mat-form-field>
          }
          @if ((si.area === 'lga' || si.area === 'ward') && state()) {
            <mat-form-field><mat-label>LGA</mat-label>
              <mat-select [ngModel]="lga()" (ngModelChange)="setLga($event)">
                @for (l of lgas(); track l.code) { <mat-option [value]="l.code">{{ l.name }}</mat-option> }
              </mat-select></mat-form-field>
          }
          @if (si.area === 'ward' && lga()) {
            <mat-form-field><mat-label>Ward</mat-label>
              <mat-select [ngModel]="area()" (ngModelChange)="area.set($event)">
                @for (w of wards(); track w.code) { <mat-option [value]="w.code">{{ w.name }}</mat-option> }
              </mat-select></mat-form-field>
          }
        }
      </div>
      @if (area()) { <p class="hint">The client will cover {{ coverageText() }}.</p> }
    </div>

    <div class="card">
      <h2>3. Elections</h2>
      <div class="row">
        <mat-form-field><mat-label>Live election</mat-label>
          <mat-select [(ngModel)]="live">
            @for (e of upcoming(); track e.id) { <mat-option [value]="e.id">{{ e.name }} · {{ e.election_date }}</mat-option> }
          </mat-select><mat-hint>The election this client is working on</mat-hint></mat-form-field>
        <mat-form-field><mat-label>Compare with (optional)</mat-label>
          <mat-select [(ngModel)]="baseline">
            <mat-option [value]="null">None</mat-option>
            @for (e of elections(); track e.id) { <mat-option [value]="e.id">{{ e.name }} · {{ e.election_date }}</mat-option> }
          </mat-select><mat-hint>A past election, for turnout and swings</mat-hint></mat-form-field>
      </div>
    </div>

    <div class="card">
      <h2>4. Dashboard admins</h2>
      <p class="hint">They run the client's situation room and add everyone else. Each gets an invite link.</p>
      @for (a of admins; track $index) {
        <div class="row person">
          <mat-form-field><mat-label>Full name</mat-label><input matInput [(ngModel)]="a.fullName" /></mat-form-field>
          <mat-form-field><mat-label>Work email</mat-label><input matInput type="email" [(ngModel)]="a.email" /></mat-form-field>
          <mat-form-field><mat-label>Phone</mat-label><input matInput [(ngModel)]="a.phone" placeholder="0803 000 0000" /></mat-form-field>
          <button mat-icon-button class="rm" (click)="admins.splice($index, 1)" [disabled]="admins.length === 1"><mat-icon>close</mat-icon></button>
        </div>
      }
      <button mat-button (click)="admins.push({ fullName: '', email: '', phone: '' })"><mat-icon>add</mat-icon> Another admin</button>
    </div>

    <div class="card">
      <h2>5. First coordinators</h2>
      @if (!seatInfo()) { <p class="hint">Pick the seat first.</p> } @else {
        <p class="hint">At {{ levelsText() }} level for a {{ seatInfo()!.label }} seat. They add the coordinators and agents below them in the app. Optional now.</p>
        @for (c of coords; track $index) {
          <div class="row person">
            <mat-form-field><mat-label>Full name</mat-label><input matInput [(ngModel)]="c.fullName" /></mat-form-field>
            <mat-form-field><mat-label>Phone</mat-label><input matInput [(ngModel)]="c.phone" /></mat-form-field>
            <mat-form-field><mat-label>Level</mat-label>
              <mat-select [(ngModel)]="c.level" (ngModelChange)="c.areaCode = c.level === 'national' ? 'NG' : ''">
                @for (l of seatInfo()!.coordinatorLevels; track l) { <mat-option [value]="l">{{ levelName(l) }}</mat-option> }
              </mat-select></mat-form-field>
            <mat-form-field><mat-label>Area</mat-label>
              <mat-select [(ngModel)]="c.areaCode" [disabled]="c.level === 'national'">
                @if (c.level === 'national') { <mat-option value="NG">Nigeria</mat-option> }
                @for (p of areasFor(c.level); track p.code) { <mat-option [value]="p.code">{{ p.name }}</mat-option> }
              </mat-select></mat-form-field>
            <button mat-icon-button class="rm" (click)="coords.splice($index, 1)"><mat-icon>close</mat-icon></button>
          </div>
        }
        <button mat-button (click)="addCoord()"><mat-icon>add</mat-icon> Add a coordinator</button>
      }
    </div>

    <div class="card">
      <h2>6. Website and notes</h2>
      <div class="row">
        <mat-form-field><mat-label>Dashboard address (optional)</mat-label><input matInput [(ngModel)]="domain" placeholder="e.g. room.example.ng" />
          <mat-hint>Where the client's situation room will be. Can be added later.</mat-hint></mat-form-field>
        <mat-form-field><mat-label>Notes (only Rumfa staff see these)</mat-label><textarea matInput rows="2" [(ngModel)]="notes"></textarea></mat-form-field>
      </div>
    </div>

    <div class="page-head">
      <span class="spacer"></span>
      <a mat-button routerLink="/clients">Cancel</a>
      <button mat-flat-button (click)="submit()" [disabled]="busy()">Onboard {{ brand || 'client' }}</button>
    </div>
    }
  </div>`,
  styles: `
    .person { align-items: center; } .person .rm { flex: 0 0 auto; }
    .logo.small { width: 20px; height: 20px; margin-right: 6px; }
  `,
})
export class OnboardPage {
  api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);

  seats = signal<Seat[]>([]);
  parties = signal<Party[]>([]);
  elections = signal<Election[]>([]);
  states = signal<Place[]>([]);
  lgas = signal<Place[]>([]);
  districts = signal<Place[]>([]);
  constituencies = signal<Constituency[]>([]);
  wards = signal<Place[]>([]);
  seat = signal<string | null>(null);
  state = signal<string | null>(null);
  lga = signal<string | null>(null);
  area = signal<string | null>(null);
  busy = signal(false);
  done = signal<{ id: string; invites: { fullName: string; email: string; inviteToken: string }[]; coordinators: unknown[] } | null>(null);

  name = ''; brand = ''; candidate = ''; party = ''; live: string | null = null; baseline: string | null = null; domain = ''; notes = '';
  admins = [{ fullName: '', email: '', phone: '' }];
  coords: Coord[] = [];

  seatInfo = computed(() => this.seats().find((s) => s.seat === this.seat()));
  upcoming = computed(() => this.elections().filter((e) => e.status !== 'closed'));
  /** FCT area council seats are only in the FCT */
  statesFor = computed(() => this.seat() === 'fct_area_council' ? this.states().filter((s) => s.code === '37') : this.states());

  constructor() { void this.load(); }
  async load() {
    try {
      const [seats, parties, elections, states] = await Promise.all([
        this.api.get<Seat[]>('/platform/clients/seats'), this.api.get<Party[]>('/platform/parties'),
        this.api.get<Election[]>('/platform/elections'), this.api.get<{ items: Place[] }>('/platform/places'),
      ]);
      this.seats.set(seats); this.parties.set(parties); this.elections.set(elections); this.states.set(states.items);
    } catch (e) { this.ui.error(e); }
  }

  setSeat(s: string) {
    this.seat.set(s); this.state.set(null); this.lga.set(null); this.coords = [];
    this.area.set(this.seatInfo()?.area === 'national' ? 'NG' : null);
  }
  async setState(code: string) {
    this.state.set(code); this.lga.set(null); this.wards.set([]);
    this.area.set(this.seatInfo()?.area === 'state' ? code : null);
    const r = await this.api.get<{ items: Place[]; districts: Place[]; constituencies: Constituency[] }>('/platform/places', { parent: code }).catch((e) => { this.ui.error(e); return null; });
    this.lgas.set(r?.items ?? []); this.districts.set(r?.districts ?? []); this.constituencies.set(r?.constituencies ?? []);
  }
  async setLga(code: string) {
    this.lga.set(code);
    this.area.set(this.seatInfo()?.area === 'lga' ? code : null);
    if (this.seatInfo()?.area === 'ward' || this.seatInfo()?.coordinatorLevels.includes('ward')) {
      const r = await this.api.get<{ items: Place[] }>('/platform/places', { parent: code }).catch(() => null);
      this.wards.set(r?.items ?? []);
    }
  }

  /** House of Reps seats pick a federal constituency, State Assembly seats a state one */
  constituenciesFor() { return this.constituencies().filter((c) => c.kind === (this.seat() === 'reps' ? 'federal' : 'state')); }

  coverageText() {
    const si = this.seatInfo(); const a = this.area();
    if (!si || !a) return '';
    if (si.area === 'national') return 'the whole country';
    const nameOf = (list: Place[], c: string | null) => list.find((x) => x.code === c)?.name ?? c;
    if (si.area === 'state') return `${nameOf(this.states(), a)} State`;
    if (si.area === 'constituency') {
      const c = this.constituencies().find((x) => x.code === a);
      return `${c?.name ?? a} (${this.lgas().filter((l) => c?.lgas.includes(l.code)).map((l) => l.name).join(', ')} LGA)`;
    }
    if (si.area === 'senatorial') {
      const lgas = this.lgas().filter((l) => l.senatorial_code === a).map((l) => l.name);
      return `${nameOf(this.districts(), a)}: ${lgas.join(', ')}`;
    }
    if (si.area === 'lga') return `${nameOf(this.lgas(), a)} LGA`;
    return `${nameOf(this.wards(), a)} ward, ${nameOf(this.lgas(), this.lga())} LGA`;
  }
  levelsText() { return (this.seatInfo()?.coordinatorLevels ?? []).map((l) => this.levelName(l)).join(' or '); }
  levelName(l: string) { return LEVEL[l] ?? label(l); }

  /** Areas a coordinator at this level may have, inside the seat */
  areasFor(level: string): Place[] {
    const si = this.seatInfo(); const a = this.area();
    if (!si || !a) return [];
    if (level === 'state') return si.area === 'national' ? this.states() : this.states().filter((s) => s.code === a);
    if (level === 'lga') {
      if (si.area === 'senatorial') return this.lgas().filter((l) => l.senatorial_code === a);
      if (si.area === 'constituency') { const c = this.constituencies().find((x) => x.code === a); return this.lgas().filter((l) => c?.lgas.includes(l.code)); }
      if (si.area === 'lga') return this.lgas().filter((l) => l.code === a);
      return this.lgas();
    }
    if (level === 'ward') return si.area === 'ward' ? this.wards().filter((w) => w.code === a) : this.wards();
    return [];
  }
  addCoord() {
    const lv = this.seatInfo()!.coordinatorLevels[0];
    const only = this.areasFor(lv);
    this.coords.push({ fullName: '', phone: '', level: lv, areaCode: lv === 'national' ? 'NG' : only.length === 1 ? only[0].code : '' });
  }

  link(token: string) { return this.api.dashboardInvite(token, this.domain.trim() ? [this.domain.trim().toLowerCase()] : []); }
  copyLink(token: string) { void copy(this.ui, this.link(token)); }

  async submit() {
    const problems = [
      !this.name.trim() && 'the organisation name', !this.brand.trim() && 'the short name', !this.candidate.trim() && 'the candidate',
      !this.party && 'the party', !this.area() && 'the seat and its area', !this.live && 'the live election',
      this.admins.some((a) => !a.fullName.trim() || !a.email.trim() || !a.phone.trim()) && 'each admin\'s name, email and phone',
      this.coords.some((c) => !c.fullName.trim() || !c.phone.trim() || !c.areaCode) && 'each coordinator\'s name, phone and area',
    ].filter(Boolean);
    if (problems.length) { this.ui.error(`Fill in ${problems.join(', ')}`); return; }
    this.busy.set(true);
    const r = await this.ui.run(() => this.api.post('/platform/clients', {
      name: this.name.trim(), brand: this.brand.trim(), candidateName: this.candidate.trim(), party: this.party, seat: this.seat(),
      seatArea: this.area(), liveElectionId: this.live, baselineElectionId: this.baseline || undefined,
      admins: this.admins.map((a) => ({ fullName: a.fullName.trim(), email: a.email.trim(), phone: a.phone.trim() })),
      coordinators: this.coords.map((c) => ({ ...c, fullName: c.fullName.trim(), phone: c.phone.trim() })),
      domains: this.domain.trim() ? [this.domain.trim().toLowerCase()] : [], notes: this.notes.trim() || undefined,
    }));
    this.busy.set(false);
    if (r) { this.done.set(r); window.scrollTo(0, 0); }
  }
}
