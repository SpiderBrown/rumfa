import { Component, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Api } from '../core/api';
import { Ui, copy, label } from '../core/ui';

interface Person { id: string; full_name: string; role: string; level: string; area_code: string; area_name: string | null; email: string | null; phone: string; status: string }
interface Detail {
  id: string; name: string; brand: string; status: string; candidateName: string | null; party: string | null; seat: string | null;
  seatArea: string | null; seatAreaName: string | null; notes: string | null; createdAt: string; limits: Record<string, number | null>;
  addons?: { voice: boolean; airtime: boolean; liveVideo: boolean; sheetReading: boolean };
  coverage: { level: string; area_code: string; name: string }[]; elections: { purpose: string; id: string; name: string; election_date: string; status: string }[];
  domains: string[]; people: Person[]; recent: { at: string; action: string; by: string | null; details: any }[];
  stats?: { people: number; agents: number; coordinators: number; cases_today: number; cases_open: number; photos_today: number; sms_today: number; results: number };
}

const LIMITS: { key: string; label: string; hint: string }[] = [
  { key: 'topup_per_person_cap_ngn', label: 'Airtime per person (₦)', hint: 'Most one person can receive in total' },
  { key: 'topup_daily_cap_ngn', label: 'Airtime per day (₦)', hint: 'Most the client can send in a day' },
  { key: 'merge_window_min', label: 'Join reports into one case (min)', hint: 'Same place and problem within this time' },
  { key: 'reopen_window_min', label: 'Reopen a resolved case (min)', hint: 'A new report within this time reopens it' },
  { key: 'related_window_min', label: 'Suggest related cases (min)', hint: '' },
  { key: 'callback_retry_min', label: 'Retry an unanswered callback (min)', hint: '' },
  { key: 'irev_recheck_min', label: 'Recheck IReV every (min)', hint: '' },
];

/** One client: what it is, its area and elections, its people at the top, its limits and website, and what Rumfa staff changed. */
@Component({
  selector: 'page-client',
  imports: [DatePipe, DecimalPipe, FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MatSlideToggleModule],
  template: `
  <div class="page">
    @if (d(); as d) {
      <a class="back" routerLink="/clients"><mat-icon>arrow_back</mat-icon> Clients</a>
      <div class="page-head">
        <p class="eyebrow">{{ seatLabel(d.seat) }}{{ d.seatAreaName ? ' · ' + d.seatAreaName : '' }} · since {{ d.createdAt | date: 'MMM y' }}</p>
        <h1>{{ d.brand }}</h1>
        <span class="chip" [class.ok]="d.status === 'active'" [class.bad]="d.status !== 'active'">{{ d.status === 'active' ? 'Live' : label(d.status) }}</span>
        <span class="spacer"></span>
        @if (api.canEdit) {
          @if (d.status === 'active') { <button mat-stroked-button (click)="openDashboard()"><mat-icon>login</mat-icon> Open their room</button> }
          @if (!editing()) { <button mat-stroked-button (click)="startEdit()"><mat-icon>edit</mat-icon> Edit</button> }
          @if (d.status === 'active') { <button mat-stroked-button (click)="setStatus('suspended')"><mat-icon>pause</mat-icon> Pause</button> }
          @else { <button mat-flat-button (click)="setStatus('active')"><mat-icon>play_arrow</mat-icon> Make active</button> }
        }
      </div>

      @if (editing() && f) {
        <div class="card">
          <h2>Edit client</h2>
          <div class="row">
            <mat-form-field><mat-label>Organisation name</mat-label><input matInput [(ngModel)]="f.name" /></mat-form-field>
            <mat-form-field><mat-label>Short name</mat-label><input matInput [(ngModel)]="f.brand" maxlength="20" />
              <mat-hint>Shown in the apps and at the start of every SMS</mat-hint></mat-form-field>
          </div>
          <div class="row">
            <mat-form-field><mat-label>Candidate's full name</mat-label><input matInput [(ngModel)]="f.candidateName" /></mat-form-field>
            <mat-form-field><mat-label>Party</mat-label>
              <mat-select [(ngModel)]="f.party">
                @for (p of parties(); track p.acronym) { <mat-option [value]="p.acronym">{{ p.acronym }} · {{ p.name }}</mat-option> }
              </mat-select></mat-form-field>
          </div>
          <div class="row">
            <mat-form-field><mat-label>Live election</mat-label>
              <mat-select [(ngModel)]="f.live">
                @for (e of elections(); track e.id) { <mat-option [value]="e.id">{{ e.name }} · {{ e.election_date }}</mat-option> }
              </mat-select></mat-form-field>
            <mat-form-field><mat-label>Compare with (optional)</mat-label>
              <mat-select [(ngModel)]="f.baseline">
                <mat-option [value]="null">None</mat-option>
                @for (e of elections(); track e.id) { <mat-option [value]="e.id">{{ e.name }} · {{ e.election_date }}</mat-option> }
              </mat-select></mat-form-field>
          </div>
          <mat-form-field class="full"><mat-label>Notes (only Rumfa staff see these)</mat-label><textarea matInput rows="2" [(ngModel)]="f.notes"></textarea></mat-form-field>
          <h3>Seat</h3>
          <p class="hint">Changing the seat changes the client's area; you will see what changes before it is saved.</p>
          @if (true) {
            <div class="row">
              <mat-form-field><mat-label>Seat</mat-label>
                <mat-select [ngModel]="ns.seat" (ngModelChange)="setSeat($event)">
                  @for (x of seats(); track x.seat) { <mat-option [value]="x.seat" [disabled]="!x.ready">{{ x.label }}{{ x.ready ? '' : ' (needs constituencies)' }}</mat-option> }
                </mat-select></mat-form-field>
              @if (seatKind() && seatKind() !== 'national') {
                <mat-form-field><mat-label>State</mat-label>
                  <mat-select [ngModel]="ns.state" (ngModelChange)="setState($event)">
                    @for (x of statesFor(); track x.code) { <mat-option [value]="x.code">{{ x.name }}</mat-option> }
                  </mat-select></mat-form-field>
              }
              @if (seatKind() === 'constituency' && ns.state) {
                <mat-form-field><mat-label>{{ ns.seat === 'reps' ? 'Federal constituency' : 'State constituency' }}</mat-label>
                  <mat-select [(ngModel)]="ns.area">
                    @for (x of constituenciesFor(); track x.code) { <mat-option [value]="x.code" [disabled]="!x.lgas.length">{{ x.name }}</mat-option> }
                  </mat-select>
                  @if (!constituenciesFor().length) { <mat-hint>None loaded for this state: Places → Load constituencies</mat-hint> }</mat-form-field>
              }
              @if (seatKind() === 'senatorial' && ns.state) {
                <mat-form-field><mat-label>Senatorial district</mat-label>
                  <mat-select [(ngModel)]="ns.area">
                    @for (x of districts(); track x.code) { <mat-option [value]="x.code" [disabled]="!x.lgas">{{ x.name }} ({{ x.lgas }} LGAs)</mat-option> }
                  </mat-select></mat-form-field>
              }
              @if ((seatKind() === 'lga' || seatKind() === 'ward') && ns.state) {
                <mat-form-field><mat-label>LGA</mat-label>
                  <mat-select [ngModel]="ns.lga" (ngModelChange)="setLga($event)">
                    @for (x of lgas(); track x.code) { <mat-option [value]="x.code">{{ x.name }}</mat-option> }
                  </mat-select></mat-form-field>
              }
              @if (seatKind() === 'ward' && ns.lga) {
                <mat-form-field><mat-label>Ward</mat-label>
                  <mat-select [(ngModel)]="ns.area">
                    @for (x of wards(); track x.code) { <mat-option [value]="x.code">{{ x.name }}</mat-option> }
                  </mat-select></mat-form-field>
              }
            </div>
          }
          <div class="page-head">
            <span class="spacer"></span>
            <button mat-button (click)="editing.set(false)">Cancel</button>
            <button mat-flat-button (click)="saveEdit()">Save changes</button>
          </div>
        </div>
      }

      <div class="tabs" role="tablist">
        @for (t of tabList; track t.id) { <button role="tab" [class.on]="tab() === t.id" (click)="tab.set(t.id)">{{ t.label }}</button> }
      </div>

      @switch (tab()) {
        @case ('overview') {
          <div class="cols">
            <div>
          <div class="card">
            <h2>Client</h2>
            <p><b>{{ d.name }}</b></p>
            <p>{{ d.candidateName ?? '—' }} @if (d.party) { <span class="chip">{{ d.party }}</span> }</p>
            <p>{{ seatLabel(d.seat) }}{{ (d.seatAreaName ?? d.seatArea) ? " · " + (d.seatAreaName ?? d.seatArea) : "" }}</p>
            <p class="hint">Covers {{ coverage(d) }}</p>
            @for (e of d.elections; track e.id) { <p class="hint">{{ e.purpose === 'live' ? 'Live' : 'Compares with' }}: {{ e.name }} ({{ e.election_date }})</p> }
            @if (d.notes) { <p class="hint">Notes: {{ d.notes }}</p> }
            <p class="hint">Onboarded {{ d.createdAt | date: 'd MMM y' }}</p>
          </div>

          <div class="card">
            <h2>Dashboard address</h2>
            <p class="hint">The client's situation room opens on these addresses (one per line).</p>
            <mat-form-field class="full"><textarea matInput rows="2" [(ngModel)]="domains" [disabled]="!api.canEdit" placeholder="e.g. room.example.ng"></textarea></mat-form-field>
            @if (api.canEdit) { <button mat-stroked-button (click)="saveDomains()">Save addresses</button> }
          </div>

            </div>
            <div>
          <div class="card">
            <h2>Add-ons</h2>
            <p class="hint">Premium services. When off, the client's dashboard does not show them and nothing is sent.</p>
            @for (a of addonList; track a.key) {
              <div class="addon">
                <mat-slide-toggle [checked]="!!d.addons?.[a.key]" [disabled]="!api.canEdit" (change)="setAddon(a.key, $event.checked)">{{ a.label }}</mat-slide-toggle>
                <div class="hint">{{ a.hint }}</div>
              </div>
            }
          </div>

            </div>
          </div>
          @if (d.stats; as st) {
            <div class="kpis">
              <div class="kpi"><span class="k-l">People</span><b>{{ st.people | number }}</b><span class="k-h">{{ st.agents | number }} agents · {{ st.coordinators | number }} coordinators</span></div>
              <div class="kpi"><span class="k-l">Cases today</span><b>{{ st.cases_today | number }}</b><span class="k-h">{{ st.cases_open | number }} open now</span></div>
              <div class="kpi"><span class="k-l">Photos today</span><b>{{ st.photos_today | number }}</b><span class="k-h">with reports</span></div>
              <div class="kpi"><span class="k-l">SMS today</span><b>{{ st.sms_today | number }}</b><span class="k-h">sent by Rumfa</span></div>
              <div class="kpi"><span class="k-l">Results</span><b>{{ st.results | number }}</b><span class="k-h">EC8A sheets received</span></div>
            </div>
          }
        }
        @case ('addons') { <div class="narrow">          <div class="card">
            <h2>Add-ons</h2>
            <p class="hint">Premium services. When off, the client's dashboard does not show them and nothing is sent.</p>
            @for (a of addonList; track a.key) {
              <div class="addon">
                <mat-slide-toggle [checked]="!!d.addons?.[a.key]" [disabled]="!api.canEdit" (change)="setAddon(a.key, $event.checked)">{{ a.label }}</mat-slide-toggle>
                <div class="hint">{{ a.hint }}</div>
              </div>
            }
          </div>

</div> }
        @case ('limits') { <div class="narrow">          <div class="card">
            <h2>Limits</h2>
            @for (l of limits; track l.key) {
              <mat-form-field class="full"><mat-label>{{ l.label }}</mat-label>
                <input matInput type="number" min="0" [(ngModel)]="limitValues[l.key]" [disabled]="!api.canEdit" />
                @if (l.hint) { <mat-hint>{{ l.hint }}</mat-hint> }</mat-form-field>
            }
            @if (api.canEdit) { <button mat-stroked-button (click)="saveLimits()">Save limits</button> }
          </div>
</div> }
        @case ('admins') {           <div class="card">
            <div class="page-head"><h2>People at the top</h2><span class="spacer"></span>
              @if (api.canEdit) {
                <button mat-button (click)="addPerson('admin')"><mat-icon>person_add</mat-icon> Admin</button>
                <button mat-button (click)="addPerson('coordinator')"><mat-icon>person_add</mat-icon> Coordinator</button>
              }
            </div>
            <div class="scroll"><table class="grid">
              <tr><th>Name</th><th>Role</th><th>Area</th><th>Status</th><th></th></tr>
              @for (p of d.people; track p.id) {
                <tr>
                  <td>{{ p.full_name }}<div class="hint">{{ p.email ?? p.phone }}</div></td>
                  <td>{{ label(p.role) }}</td>
                  <td>{{ p.area_name ?? p.area_code }}<div class="hint">{{ label(p.level) }}</div></td>
                  <td><span class="chip" [class.ok]="p.status === 'active'" [class.warn]="p.status === 'invited'">{{ label(p.status) }}</span></td>
                  <td>@if (p.email && p.role !== 'coordinator') { <button mat-button (click)="reinvite(p)">Invite link</button> }</td>
                </tr>
              }
            </table></div>
            @if (link()) {
              <p>Invite link for {{ linkFor() }} (valid 7 days):</p>
              <code class="link">{{ link() }}</code>
              <button mat-button (click)="copyLink()"><mat-icon>content_copy</mat-icon> Copy</button>
            }
          </div>

 }
        @case ('activity') { <div class="narrow">          <div class="card">
            <h2>What Rumfa staff changed</h2>
            @for (r of d.recent; track $index) {
              <p class="hint"><b>{{ r.at | date: 'd MMM, HH:mm' }}</b> · {{ r.by ?? 'System' }} · {{ actionText(r.action) }}</p>
            } @empty { <p class="hint">Nothing yet.</p> }
          </div>
</div> }
      }
    } @else { <p class="hint">Loading…</p> }
  </div>`,
  styles: `.addon { margin: 8px 0 12px; } .addon .hint { margin: 2px 0 0 52px; }
    .back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
    .back mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; } @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
    .narrow { max-width: 760px; }
    .scroll { overflow-x: auto; }
    h3 { font: var(--mat-sys-title-small); margin: 12px 0 4px; }
    .impact { background: var(--mat-sys-surface-container); border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; } .impact p { margin: 4px 0; }
    .warn { color: #8a4b00; } .card .page-head { flex-wrap: wrap; }
    .card p { margin: 4px 0; } .card .page-head { margin-bottom: 8px; } .card .page-head h2 { margin: 0; }`,
})
export class ClientPage {
  id = input.required<string>();
  api = inject(Api);
  private ui = inject(Ui);
  d = signal<Detail | null>(null);
  readonly tabList = [{ id: 'overview', label: 'Overview' }, { id: 'addons', label: 'Add-ons' }, { id: 'limits', label: 'Limits' },
    { id: 'admins', label: 'Admins' }, { id: 'activity', label: 'Activity' }] as const;
  tab = signal<'overview' | 'addons' | 'limits' | 'admins' | 'activity'>('overview');
  editing = signal(false);
  seats = signal<{ seat: string; label: string; area: string; ready: boolean }[]>([]);
  states = signal<{ code: string; name: string }[]>([]);
  lgas = signal<{ code: string; name: string }[]>([]);
  districts = signal<{ code: string; name: string; lgas: number }[]>([]);
  constituencies = signal<{ code: string; name: string; kind: string; lgas: string[] }[]>([]);
  wards = signal<{ code: string; name: string }[]>([]);
  ns: { seat: string | null; state: string | null; lga: string | null; area: string | null } = { seat: null, state: null, lga: null, area: null };
  parties = signal<{ acronym: string; name: string }[]>([]);
  elections = signal<{ id: string; name: string; election_date: string }[]>([]);
  f: { name: string; brand: string; candidateName: string; party: string | null; live: string | null; baseline: string | null; notes: string } | null = null;
  link = signal('');
  linkFor = signal('');
  domains = '';
  limitValues: Record<string, number | null> = {};
  limits = LIMITS;
  readonly addonList = [
    { key: 'voice' as const, label: 'Voice outreach', hint: 'Recorded messages called out to supporters, with consent and opt-out.' },
    { key: 'airtime' as const, label: 'Airtime and data', hint: 'Airtime and data top-ups for agents and coordinators, approved by two admins.' },
    { key: 'liveVideo' as const, label: 'Live video from the field', hint: 'The room can ask an agent to stream video from the unit. On for every client unless switched off.' },
    { key: 'sheetReading' as const, label: 'Sheet reading', hint: 'Reads the figures from agents\' EC8A photos automatically, to check what they typed. On unless switched off.' },
  ];
  label = label;
  private seatNames: Record<string, string> = {};

  ngOnInit() { void this.load(); }
  async load() {
    try {
      const [d, seats] = await Promise.all([this.api.get<Detail>(`/platform/clients/${this.id()}`), this.api.get<any[]>('/platform/clients/seats')]);
      this.seatNames = Object.fromEntries(seats.map((s) => [s.seat, s.label]));
      this.d.set(d);
      this.domains = d.domains.join('\n');
      this.limitValues = { ...d.limits };
    } catch (e) { this.ui.error(e); }
  }

  seatLabel(s: string | null) { return s ? this.seatNames[s] ?? label(s) : 'No seat recorded'; }
  coverage(d: Detail) { return d.coverage.map((c) => c.area_code === 'NG' ? 'the whole country' : c.name).join(', ') || 'nothing yet'; }
  actionText(a: string) {
    return ({ 'client.onboard': 'Onboarded the client', 'client.update': 'Changed details', 'client.suspended': 'Suspended', 'client.active': 'Made active',
      'client.add_admin': 'Added an admin', 'client.add_coordinator': 'Added a coordinator', 'client.reinvite': 'Made a new invite link' } as Record<string, string>)[a] ?? a;
  }

  /**
   * Opens the client's dashboard in a new tab, signed in as Rumfa support (an admin). The one-time ticket travels after
   * the # so it never reaches a web server's logs; it works once, within 2 minutes.
   */
  async openDashboard() {
    const tab = window.open('', '_blank'); // opened now, before waiting, so the browser does not block it
    const r = await this.ui.run(() => this.api.post<{ ticket: string; domains: string[] }>(`/platform/clients/${this.d()!.id}/open`));
    if (!r) { tab?.close(); return; }
    const url = `${this.api.dashboardBase(r.domains)}/login#support=${encodeURIComponent(r.ticket)}`;
    if (tab) tab.location.href = url; else location.href = url;
  }

  async startEdit() {
    const d = this.d()!;
    try {
      const [parties, elections, seats, states] = await Promise.all([this.api.get<any[]>('/platform/parties'), this.api.get<any[]>('/platform/elections'),
        this.api.get<any[]>('/platform/clients/seats'), this.api.get<{ items: any[] }>('/platform/places')]);
      this.parties.set(parties); this.elections.set(elections); this.seats.set(seats); this.states.set(states.items);
    } catch (e) { this.ui.error(e); return; }
    // The current seat, filled in (with the lists its pickers need)
    this.ns = { seat: d.seat, state: null, lga: null, area: null };
    const area = d.seatArea ?? '';
    if (this.seatKind() === 'national') this.ns.area = 'NG';
    else if (area) {
      await this.setState(area.slice(0, 2));
      if (['senatorial', 'state', 'constituency'].includes(this.seatKind() ?? '')) this.ns.area = area;
      else { await this.setLga(area.slice(0, 5)); this.ns.area = area; }
    }
    this.f = {
      name: d.name, brand: d.brand, candidateName: d.candidateName ?? '', party: d.party,
      live: d.elections.find((e) => e.purpose === 'live')?.id ?? null, baseline: d.elections.find((e) => e.purpose === 'baseline')?.id ?? null,
      notes: d.notes ?? '',
    };
    this.editing.set(true);
  }
  async saveEdit() {
    const f = this.f!;
    if (f.name.trim().length < 3 || f.brand.trim().length < 2 || f.candidateName.trim().length < 3) { this.ui.error('Fill in the name, short name and candidate'); return; }
    const body: Record<string, unknown> = { name: f.name.trim(), brand: f.brand.trim(), candidateName: f.candidateName.trim(), notes: f.notes.trim(),
      baselineElectionId: f.baseline && f.baseline !== f.live ? f.baseline : null };
    if (f.party) body['party'] = f.party;
    if (f.live) body['liveElectionId'] = f.live;
    const d = this.d()!;
    const seatChanged = !!this.ns.seat && (this.ns.seat !== d.seat || this.ns.area !== d.seatArea);
    if (seatChanged && !this.ns.area) { this.ui.error('Finish picking the seat\'s area'); return; }
    if (seatChanged) {
      const r = await this.ui.run(() => this.api.post<any>(`/platform/clients/${d.id}/seat`, { seat: this.ns.seat, seatArea: this.ns.area }));
      if (!r) return;
      const pv = r.preview;
      const text = [
        `The client will cover: ${pv.coverage.join(', ')}.`,
        `${pv.adminsMoved} admin(s) move there. A situation room desk for it is added if missing; old desks and cases stay.`,
        pv.outside.n ? `${pv.outside.n} people (${pv.outside.coordinators} coordinators, ${pv.outside.agents} agents) are outside the new area and stay where they are.` : 'Everyone else is inside the new area.',
      ].join('\n\n');
      if (!(await this.ui.confirm(`Change the seat to ${this.seatLabel(this.ns.seat)}?`, text, 'Change seat and save'))) return;
      if (!(await this.ui.run(() => this.api.post(`/platform/clients/${d.id}/seat`, { seat: this.ns.seat, seatArea: this.ns.area, confirm: true })))) return;
    }
    if (await this.ui.run(() => this.api.patch(`/platform/clients/${d.id}`, body), 'Client saved')) { this.editing.set(false); await this.load(); }
  }

  constituenciesFor() { return this.constituencies().filter((c) => c.kind === (this.ns.seat === 'reps' ? 'federal' : 'state')); }
  seatKind() { return this.seats().find((x) => x.seat === this.ns.seat)?.area ?? null; }
  statesFor() { return this.ns.seat === 'fct_area_council' ? this.states().filter((x) => x.code === '37') : this.states(); }
  setSeat(seat: string) {
    this.ns = { seat, state: null, lga: null, area: null };
    if (this.seatKind() === 'national') this.ns.area = 'NG';
  }
  async setState(code: string) {
    this.ns.state = code; this.ns.lga = null; this.ns.area = this.seatKind() === 'state' ? code : null;
    const r = await this.api.get<{ items: any[]; districts: any[]; constituencies: any[] }>('/platform/places', { parent: code }).catch((e) => { this.ui.error(e); return null; });
    this.lgas.set(r?.items ?? []); this.districts.set(r?.districts ?? []); this.constituencies.set(r?.constituencies ?? []);
  }
  async setLga(code: string) {
    this.ns.lga = code; this.ns.area = this.seatKind() === 'lga' ? code : null;
    if (this.seatKind() === 'ward') {
      const r = await this.api.get<{ items: any[] }>('/platform/places', { parent: code }).catch(() => null);
      this.wards.set(r?.items ?? []);
    }
  }
  async setStatus(status: string) {
    const d = this.d()!;
    if (status === 'suspended' && !(await this.ui.confirm(`Suspend ${d.brand}?`, 'Nobody in this client can sign in until it is made active again. Their data is kept.', 'Suspend'))) return;
    if (await this.ui.run(() => this.api.patch(`/platform/clients/${d.id}`, { status }), status === 'active' ? 'Client is active' : 'Client suspended')) await this.load();
  }
  async saveDomains() {
    const list = this.domains.split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
    if (await this.ui.run(() => this.api.patch(`/platform/clients/${this.d()!.id}`, { domains: list }), 'Addresses saved')) await this.load();
  }
  async setAddon(key: 'voice' | 'airtime' | 'liveVideo' | 'sheetReading', on: boolean) {
    const name = this.addonList.find((a) => a.key === key)!.label;
    if (!on && !(await this.ui.confirm(`Switch off ${name}?`, `${this.d()!.name} will no longer see ${name} on its dashboard, and nothing more is sent. Their records stay; switching it on again brings them back.`, 'Switch off'))) {
      await this.load(); return;
    }
    if (await this.ui.run(() => this.api.patch(`/platform/clients/${this.d()!.id}`, { addons: { [key]: on } }), `${name} ${on ? 'on' : 'off'}`)) await this.load();
    else await this.load();
  }
  async saveLimits() {
    const limits = Object.fromEntries(Object.entries(this.limitValues).filter(([, v]) => v !== null && v !== undefined && String(v) !== '').map(([k, v]) => [k, Number(v)]));
    if (await this.ui.run(() => this.api.patch(`/platform/clients/${this.d()!.id}`, { limits }), 'Limits saved')) await this.load();
  }
  async reinvite(p: Person) {
    const r = await this.ui.run(() => this.api.post<{ inviteToken: string }>(`/platform/clients/${this.d()!.id}/people/${p.id}/invite`));
    if (r) { this.link.set(this.api.dashboardInvite(r.inviteToken, this.d()!.domains)); this.linkFor.set(p.full_name); }
  }
  copyLink() { void copy(this.ui, this.link()); }

  async addPerson(kind: 'admin' | 'coordinator') {
    const fullName = await this.ui.prompt(kind === 'admin' ? 'Add an admin' : 'Add a coordinator', 'Full name');
    if (!fullName) return;
    const phone = await this.ui.prompt('Phone number', 'Nigerian mobile number');
    if (!phone) return;
    const body: Record<string, string> = { kind, fullName, phone };
    if (kind === 'admin') {
      const email = await this.ui.prompt('Work email', 'Email address');
      if (!email) return;
      body['email'] = email;
    } else {
      const level = await this.ui.choose('Level', 'Where this coordinator works', ['national', 'state', 'lga', 'ward'].map((l) => ({ label: label(l), value: l })));
      if (!level) return;
      const areaCode = level === 'national' ? 'NG' : await this.ui.prompt('Area code', 'State 19, LGA 19-28 or ward 19-28-02');
      if (!areaCode) return;
      Object.assign(body, { level, areaCode });
    }
    const r = await this.ui.run(() => this.api.post<any>(`/platform/clients/${this.d()!.id}/people`, body), `${fullName} added`);
    if (r?.inviteToken) { this.link.set(this.api.dashboardInvite(r.inviteToken, this.d()!.domains)); this.linkFor.set(fullName); }
    if (r) await this.load();
  }
}
