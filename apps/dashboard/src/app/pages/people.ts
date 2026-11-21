import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { normaliseNgPhone, normalisePuCode } from '@rumfa/shared';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { AgoPipe, Ui, label } from '../core/ui';

interface Person {
  id: string; full_name: string; phone: string; email: string | null; role: string; level: string; area_code: string; network: string | null;
  status: string; deputy_of: string | null; onboarded_at: string | null; activated: boolean; platform: string | null; last_seen: string | null;
  where: { name: string; parents: string[] } | null;
}
interface ImportResult { valid: number; problems: string[]; problemCount: number; already: number; added: number }

const STAFF = ['operator', 'supervisor', 'analyst', 'legal', 'security', 'voice_ops', 'admin'];
type Tab = 'all' | 'room' | 'coordinators' | 'field' | 'pending';
const TABS: { id: Tab; label: string; test: (p: Person) => boolean }[] = [
  { id: 'all', label: 'Everyone', test: () => true },
  { id: 'room', label: 'Room', test: (p) => STAFF.includes(p.role) },
  { id: 'coordinators', label: 'Coordinators', test: (p) => p.role === 'coordinator' },
  { id: 'field', label: 'Agents', test: (p) => p.role === 'agent' || p.role === 'volunteer' },
  { id: 'pending', label: 'Not onboarded', test: (p) => !STAFF.includes(p.role) && (!p.activated || !p.onboarded_at) },
];
const SAMPLE = 'full_name,phone,role,level,area_code,email,languages\nMusa Ibrahim,08031234567,agent,pu,19-28-02-003,,ha;en\nHadiza Yusuf,08061234567,coordinator,lga,19-28,,ha';

/** People: room staff, coordinators and agents in your area. Add one, or import a list. */
@Component({
  selector: 'app-people',
  imports: [FormsModule, DecimalPipe, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="eyebrow">{{ api.brand() }} · {{ api.me()?.area_code === 'NG' ? 'Nigeria' : api.me()?.area_code }}</p>
        <h1>People</h1>
        <p class="lede">Room staff, coordinators and agents. Add one, or import a list.</p>
      </div>
      <div class="head-r">
        @if (api.isAdmin()) { <button mat-stroked-button (click)="openImport()"><mat-icon>upload</mat-icon> Import list</button> }
        @if (canAdd()) { <button mat-flat-button (click)="adding.set(!adding()); importing.set(false)"><mat-icon>person_add</mat-icon> Add person</button> }
      </div>
    </header>

    @if (adding()) {
      <section class="r-card panel" aria-label="Add a person">
        <div class="p-head"><h2>Add a person</h2><button mat-icon-button (click)="adding.set(false)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="form">
          <label><span>Full name</span><input [(ngModel)]="n.name" /></label>
          <label><span>Phone</span><input [(ngModel)]="n.phone" placeholder="0803 123 4567" /></label>
          <label><span>Role</span><select [(ngModel)]="n.role">@for (r of addRoles(); track r) { <option [value]="r">{{ label(r) }}</option> }</select></label>
          @if (isStaff(n.role)) { <label><span>Work email (dashboard sign-in)</span><input type="email" [(ngModel)]="n.email" /></label> }
          <label><span>Level</span><select [(ngModel)]="n.level">
            @for (l of levels; track l) { <option [value]="l">{{ l === 'pu' ? 'Polling unit' : l === 'lga' ? 'LGA' : label(l) }}</option> }</select></label>
          @if (n.level !== 'national') { <label><span>Area code</span><input [(ngModel)]="n.area" placeholder="e.g. 19-28-02-003" /></label> }
          <label><span>Languages</span><select multiple size="3" [(ngModel)]="n.languages">
            @for (l of langs; track l.code) { <option [value]="l.code">{{ l.name }}</option> }</select></label>
        </div>
        <div class="p-foot"><span class="muted sm">{{ isStaff(n.role) ? 'They get an invite link to set a password.' : 'They activate the app with their phone number.' }}</span>
          <button mat-flat-button (click)="add()">Save</button></div>
      </section>
    }

    @if (importing()) {
      <section class="r-card panel" aria-label="Import a list">
        <div class="p-head"><h2>Import a list</h2><button mat-icon-button (click)="importing.set(false)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <p class="muted sm">A CSV file (from Excel: Save as CSV) with the columns <code>full_name, phone, role, level, area_code</code>, and optionally
          <code>email, languages</code>. Agents' area is their polling unit code. Every line is checked first; nothing is added until the whole list is right.
          People already here (same phone) are left as they are.</p>
        <div class="imp">
          <label class="file"><mat-icon>description</mat-icon><span>{{ fileName() || 'Choose a CSV file' }}</span>
            <input type="file" accept=".csv,text/csv" (change)="pick($event)" /></label>
          <button mat-button (click)="csv.set(sample); fileName.set('example.csv'); result.set(null)">Use an example</button>
        </div>
        @if (result(); as r) {
          <div class="res" [class.bad]="r.problemCount">
            @if (r.added) { <p><mat-icon>check_circle</mat-icon> <b>{{ r.added }} added.</b> {{ r.already ? r.already + ' were already here.' : '' }} They show as Not onboarded until they activate the app.</p> }
            @else if (r.problemCount) {
              <p><mat-icon>error</mat-icon> <b>{{ r.problemCount }} {{ r.problemCount === 1 ? 'problem' : 'problems' }}</b> to fix in the file, then choose it again.</p>
              <ul>@for (x of r.problems; track $index) { <li>{{ x }}</li> }</ul>
            } @else { <p><mat-icon>task_alt</mat-icon> <b>{{ r.valid }} people, all fine.</b> {{ r.valid - r.already }} new{{ r.already ? ', ' + r.already + ' already here' : '' }}.</p> }
          </div>
        }
        <div class="p-foot"><span></span>
          @if (result() && !result()!.problemCount && !result()!.added) {
            <button mat-flat-button (click)="runImport(false)" [disabled]="busy() || result()!.valid === result()!.already">Add {{ result()!.valid - result()!.already }} people</button>
          } @else { <button mat-flat-button (click)="runImport(true)" [disabled]="!csv() || busy()">Check the list</button> }
        </div>
      </section>
    }

    <div class="tools">
      <div class="chips" role="tablist" aria-label="Who">
        @for (t of tabs; track t.id) {
          <button role="tab" class="chip r-focus" [class.on]="tab() === t.id" [attr.aria-selected]="tab() === t.id" (click)="tab.set(t.id)">
            {{ t.label }} <b>{{ count(t.id) | number }}</b></button>
        }
      </div>
      <label class="search"><mat-icon aria-hidden="true">search</mat-icon><input placeholder="Name, phone or area" aria-label="Search people" [ngModel]="q()" (ngModelChange)="q.set($event)" /></label>
    </div>

    <section class="r-card tbl" aria-label="People">
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>Area</th><th>App</th><th>Status</th><th>Last seen</th><th class="r"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          @for (p of shown(); track p.id) {
            <tr>
              <td><div class="who"><span class="av" [class.staff]="isStaff(p.role)">{{ p.full_name[0] }}</span>
                <div><b>{{ p.full_name }}</b>@if (p.deputy_of) { <span class="tag">deputy</span> }
                  <div class="muted xs">{{ p.phone }}{{ p.network ? ' · ' + p.network.toUpperCase() : '' }}</div></div></div></td>
              <td>{{ roleName(p) }}</td>
              <td><div>{{ p.where?.name ?? p.area_code }}</div>@if (p.where?.parents?.length) { <div class="muted xs">{{ p.where!.parents.slice(0, 2).join(' · ') }}</div> }</td>
              <td>@switch (app(p)) {
                @case ('none') { <span class="pill warn">Not installed</span> }
                @default { {{ app(p) }} } }</td>
              <td><span class="st" [class]="'st ' + statusClass(p)">{{ statusText(p) }}</span></td>
              <td class="muted">{{ p.last_seen ? (p.last_seen | ago) : '—' }}</td>
              <td class="r acts">
                <button mat-icon-button matTooltip="Call" (click)="call(p)" [attr.aria-label]="'Call ' + p.full_name"><mat-icon>call</mat-icon></button>
                @if (p.id !== api.me()?.id && canAdd()) {
                  <button mat-icon-button [matMenuTriggerFor]="m" [attr.aria-label]="'More for ' + p.full_name"><mat-icon>more_horiz</mat-icon></button>
                  <mat-menu #m>
                    @if (isStaff(p.role)) { @if (api.isAdmin()) { <button mat-menu-item (click)="invite(p)"><mat-icon>mail</mat-icon> Invite link</button> } }
                    @else {
                      <button mat-menu-item (click)="activationCode(p)"><mat-icon>pin</mat-icon> Activation code</button>
                      @if (p.activated) { <button mat-menu-item (click)="signOutPhone(p)"><mat-icon>phonelink_erase</mat-icon> Sign out lost phone</button> }
                    }
                    @if (p.status === 'suspended') { <button mat-menu-item (click)="setStatus(p, 'active')"><mat-icon>play_circle</mat-icon> Restore access</button> }
                    @else if (p.status === 'active') { <button mat-menu-item (click)="setStatus(p, 'suspended')"><mat-icon>pause_circle</mat-icon> Suspend</button> }
                    <button mat-menu-item (click)="remove(p)"><mat-icon>person_remove</mat-icon> Remove access</button>
                  </mat-menu>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7"><p class="empty muted">{{ loaded() ? 'Nobody matches.' : 'Loading…' }}</p></td></tr>
          }
        </tbody>
      </table>
      @if (filtered().length > shown().length) {
        <div class="more"><span class="muted sm">Showing {{ shown().length }} of {{ filtered().length | number }}</span>
          <button mat-button (click)="limit.set(limit() + 200)">Show more</button></div>
      }
    </section>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .head-r { display: flex; gap: 8px; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); }
    h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; }
    .panel { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .p-head, .p-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
    .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--r-ink-2); }
    input, select { border: 1px solid var(--r-line); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13.5px; background: #fff; color: var(--r-ink); }
    .imp { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .file { display: inline-flex; align-items: center; gap: 8px; border: 1.5px dashed var(--r-line); border-radius: 10px; padding: 10px 14px; cursor: pointer; font-weight: 600; }
    .file:hover { border-color: var(--r-accent); } .file input { display: none; }
    .res { border-radius: 10px; padding: 10px 14px; background: #eef7f5; font-size: 13.5px; }
    .res.bad { background: var(--r-urgent-bg); }
    .res p { display: flex; align-items: center; gap: 6px; margin: 0; } .res mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .res ul { margin: 6px 0 0; padding-left: 22px; max-height: 180px; overflow: auto; }
    .tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip { border: 1px solid var(--r-line); background: #fff; border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; color: var(--r-ink-2); cursor: pointer; }
    .chip b { margin-left: 3px; } .chip.on { background: var(--r-ink); border-color: var(--r-ink); color: #fff; }
    .search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--r-line); border-radius: 10px; background: #fff; padding: 0 10px; width: 280px; }
    .search mat-icon { color: var(--r-muted); font-size: 20px; width: 20px; height: 20px; }
    .search input { border: 0; padding: 9px 0; flex: 1; outline: none; }
    .tbl { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: var(--r-muted); padding: 10px 14px; background: #fafbfc; border-bottom: 1px solid var(--r-line); }
    td { padding: 9px 14px; border-bottom: 1px solid var(--r-line-soft); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: 0; }
    .r { text-align: right; } .acts { white-space: nowrap; }
    .who { display: flex; align-items: center; gap: 10px; }
    .av { width: 30px; height: 30px; border-radius: 50%; background: #1f4e8c; color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 700; flex: none; }
    .av.staff { background: var(--r-accent); }
    .tag { margin-left: 6px; font-size: 11px; font-weight: 700; color: var(--r-muted); background: var(--r-line-soft); border-radius: 999px; padding: 1px 7px; }
    .pill { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px; }
    .pill.warn { color: #7a2e0b; background: var(--r-high-bg); }
    .st { font-weight: 600; } .st.ok { color: var(--r-accent-strong); } .st.wait { color: var(--r-high); } .st.off { color: var(--r-urgent); }
    .empty { margin: 0; padding: 24px; text-align: center; }
    .more { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; border-top: 1px solid var(--r-line-soft); }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
})
export class PeoplePage {
  api = inject(Api);
  private ui = inject(Ui);
  private calls = inject(Calls);
  label = label;
  readonly tabs = TABS;
  readonly sample = SAMPLE;
  readonly levels = ['pu', 'ward', 'lga', 'state', 'national'];
  roles = ['agent', 'volunteer', 'coordinator', 'operator', 'supervisor', 'analyst', 'legal', 'security', 'voice_ops', 'admin'];
  langs = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }, { code: 'ff', name: 'Fulfulde' }, { code: 'kr', name: 'Kanuri' },
    { code: 'yo', name: 'Yoruba' }, { code: 'ig', name: 'Igbo' }, { code: 'tiv', name: 'Tiv' }, { code: 'nup', name: 'Nupe' }];

  all = signal<Person[]>([]);
  loaded = signal(false);
  tab = signal<Tab>('all');
  q = signal('');
  limit = signal(200);
  adding = signal(false);
  importing = signal(false);
  csv = signal('');
  fileName = signal('');
  result = signal<ImportResult | null>(null);
  busy = signal(false);
  n = { name: '', phone: '', email: '', role: 'agent', level: 'pu', area: '', languages: ['en'] as string[] };

  canAdd = computed(() => this.api.isAdmin() || this.api.me()?.role === 'coordinator');
  addRoles = computed(() => this.api.isAdmin() ? this.roles : ['agent', 'volunteer', 'coordinator']);
  filtered = computed(() => {
    const t = TABS.find((x) => x.id === this.tab())!, f = this.q().trim().toLowerCase();
    return this.all().filter((p) => t.test(p) && (!f || p.full_name.toLowerCase().includes(f) || p.phone.includes(f) || p.area_code.startsWith(f)
      || (p.where?.name ?? '').toLowerCase().includes(f)));
  });
  shown = computed(() => this.filtered().slice(0, this.limit()));
  private counts = computed(() => Object.fromEntries(TABS.map((t) => [t.id, this.all().filter(t.test).length])) as Record<Tab, number>);
  count(t: Tab) { return this.counts()[t]; }

  constructor() {
    void this.load();
    // ?q=… (from the search box)
    inject(ActivatedRoute).queryParamMap.subscribe((m) => { const q = m.get('q'); if (q) { this.q.set(q); this.tab.set('all'); } });
  }

  async load() {
    try { this.all.set(await this.api.get<Person[]>('/people')); } catch (e) { this.ui.error(e); }
    this.loaded.set(true);
  }

  isStaff(role: string) { return STAFF.includes(role); }
  roleName(p: Person) {
    if (p.role === 'coordinator') return ({ ward: 'Ward', lga: 'LGA', state: 'State', national: 'National' } as Record<string, string>)[p.level] + ' coordinator';
    return label(p.role);
  }
  app(p: Person) {
    if (this.isStaff(p.role)) return 'Dashboard';
    if (!p.activated) return 'none';
    return p.platform === 'ios' ? 'iPhone app' : p.platform === 'android' ? 'Android app' : 'App';
  }
  statusText(p: Person) {
    if (p.status === 'suspended') return 'Suspended';
    if (this.isStaff(p.role)) return p.status === 'invited' ? 'Invited' : 'Active';
    if (!p.activated) return 'Not signed in yet';
    if (!p.onboarded_at) return 'Not onboarded';
    return 'Active';
  }
  statusClass(p: Person) {
    const t = this.statusText(p);
    return t === 'Active' ? 'ok' : t === 'Suspended' ? 'off' : 'wait';
  }

  async add() {
    const phone = normaliseNgPhone(this.n.phone);
    let area = this.n.area.trim();
    if (this.n.level === 'pu') area = normalisePuCode(area) ?? '';
    if (this.n.level === 'national') area = 'NG';
    if (!this.n.name || !phone || !area) { this.ui.error('Name, a valid phone and area code are required'); return; }
    try {
      await this.api.post('/people', { fullName: this.n.name, phone, email: this.n.email || undefined, role: this.n.role, level: this.n.level,
        areaCode: area, languages: this.n.languages });
    } catch (e: any) {
      this.ui.error(e?.status === 403 ? 'You can only add people inside your own area, below your level.' : e);
      return;
    }
    this.ui.toast(this.isStaff(this.n.role) ? `${this.n.name} added. Send them an invite to set a password.` : `${this.n.name} added. They activate the app on ${phone}.`);
    this.n = { ...this.n, name: '', phone: '', email: '' };
    this.adding.set(false); await this.load();
  }

  openImport() { this.importing.set(!this.importing()); this.adding.set(false); this.result.set(null); }
  async pick(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    this.fileName.set(f.name); this.csv.set(await f.text()); this.result.set(null);
    await this.runImport(true);
    (ev.target as HTMLInputElement).value = '';
  }
  async runImport(dryRun: boolean) {
    this.busy.set(true);
    const r = await this.ui.run(() => this.api.post<ImportResult>('/people/import', { csv: this.csv(), dryRun }));
    this.busy.set(false);
    if (r) { this.result.set(r); if (r.added) await this.load(); }
  }

  call(p: Person) { void this.calls.call('volunteer', p.id, p.full_name); }
  async setStatus(p: Person, status: 'active' | 'suspended') {
    if (status === 'suspended' && !(await this.ui.confirm('Suspend', `${p.full_name} can't sign in until you restore access. Nothing is deleted.`, 'Suspend'))) return;
    const ok = await this.ui.run(() => this.api.patch(`/people/${p.id}`, { status }), status === 'active' ? 'Access restored' : 'Suspended');
    if (ok) await this.load();
  }
  async remove(p: Person) {
    if (!(await this.ui.confirm('Remove access', `${p.full_name} will lose access to the app and all channels at once.`, 'Remove'))) return;
    const ok = await this.ui.run(async () => { await this.api.del(`/people/${p.id}`); return true; }, 'Access removed');
    if (ok) await this.load();
  }

  /** One-time code a field user types instead of an SMS code (valid 48 hours). */
  async activationCode(p: Person) {
    const r = await this.ui.run(() => this.api.post<{ code: string; expiresAt: string }>(`/people/${p.id}/activation-code`));
    if (r) await this.ui.confirm(`Activation code for ${p.full_name}`, `${r.code} — valid until ${new Date(r.expiresAt).toLocaleString()}. Give it to them in person or by phone.`, 'Done');
  }

  /** Invite link for dashboard staff to set their password (valid 7 days). */
  async invite(p: Person) {
    const r = await this.ui.run(() => this.api.post<{ inviteToken: string; email: string }>(`/people/${p.id}/invite`));
    if (!r) return;
    const link = `${location.origin}/login?invite=${encodeURIComponent(r.inviteToken)}`;
    await navigator.clipboard?.writeText(link).catch(() => undefined);
    await this.ui.confirm(`Invite for ${p.full_name}`, `Send this link to ${r.email} (copied): ${link}`, 'Done');
  }

  async signOutPhone(p: Person) {
    if (!(await this.ui.confirm('Sign out phone', `${p.full_name}'s phone will be signed out. They activate it again to continue.`, 'Sign out'))) return;
    await this.ui.run(() => this.api.post(`/people/${p.id}/devices/revoke`), 'Phone signed out');
  }
}
