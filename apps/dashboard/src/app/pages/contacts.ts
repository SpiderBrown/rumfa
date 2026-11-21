import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { normaliseNgPhone } from '@rumfa/shared';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { AgoPipe, Ui, label } from '../core/ui';

interface Contact {
  id: string; tenant_id: string | null; agency: string; title: string; person_name: string | null; phone: string | null; level: string; area_code: string;
  status: string; source_type: string; source_url: string | null; address: string | null; added_by: string | null;
  last_call_ok_at: string | null; last_call_failed_at: string | null; where: { name: string; parents: string[] } | null;
}
type State = 'all' | 'todo' | 'verified';

const STATUS: Record<string, { text: string; cls: string; hint: string }> = {
  verified: { text: 'Verified', cls: 'ok', hint: 'Answered a test call and approved' },
  call_tested: { text: 'Answered, needs approval', cls: 'wait', hint: 'A second person approves it' },
  pending: { text: 'Not called yet', cls: 'wait', hint: 'Make a test call' },
  stale: { text: 'Check again', cls: 'wait', hint: 'Not reached for a while' },
  draft: { text: 'Draft', cls: 'off', hint: '' }, rejected: { text: 'Rejected', cls: 'off', hint: '' },
};

/**
 * Authority contacts: police, INEC, security and emergency numbers for your areas, each test-called and approved.
 * Official ones are kept by Rumfa for every organisation; coordinators and the room add local ones.
 * Call from here; from a case, the call is logged on the case.
 */
@Component({
  selector: 'app-contacts',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="eyebrow">Official ones kept by Rumfa · local ones added by your team</p>
        <h1>Authority contacts</h1>
        <p class="lede">Police, INEC, security and emergency numbers for your areas. Each is test-called before it's trusted. Call from a case to log the call on it.</p>
      </div>
      @if (canAdd()) { <button mat-flat-button (click)="adding.set(!adding())"><mat-icon>add</mat-icon> Add contact</button> }
    </header>

    @if (adding()) {
      <section class="r-card panel" aria-label="Add a contact">
        <div class="p-head"><h2>Add a contact</h2><button mat-icon-button (click)="adding.set(false)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="form">
          <label><span>Agency</span><select [(ngModel)]="n.agency">@for (a of agencies; track a) { <option [value]="a">{{ a }}</option> }</select></label>
          <label><span>Office or title</span><input [(ngModel)]="n.title" placeholder="Divisional Police Officer, Kofar Mata" /></label>
          <label><span>Name (optional)</span><input [(ngModel)]="n.person" /></label>
          <label><span>Phone</span><input [(ngModel)]="n.phone" /></label>
          <label><span>Level</span><select [(ngModel)]="n.level"><option value="ward">Ward</option><option value="lga">LGA</option><option value="state">State</option></select></label>
          <label><span>Area code</span><input [(ngModel)]="n.area" [placeholder]="api.me()?.area_code ?? ''" /></label>
        </div>
        <div class="p-foot"><span class="muted sm">After saving, make a test call. Someone else approves it before it shows as verified.</span>
          <button mat-flat-button (click)="add()">Save</button></div>
      </section>
    }

    <div class="tools">
      <div class="chips" role="tablist" aria-label="Agency">
        @for (a of agencyTabs(); track a.name) {
          <button role="tab" class="chip r-focus" [class.on]="agency() === a.name" (click)="agency.set(a.name)">{{ a.name === '' ? 'All' : a.name }} <b>{{ a.count }}</b></button>
        }
      </div>
      <div class="right">
        <div class="r-seg" role="tablist" aria-label="State">
          @for (s of states; track s.id) {
            <button role="tab" [class.on]="state() === s.id" (click)="setState(s.id)">{{ s.label }}</button>
          }
        </div>
        <label class="search"><mat-icon aria-hidden="true">search</mat-icon><input placeholder="Place, office or name" aria-label="Search contacts" [ngModel]="q()" (ngModelChange)="q.set($event)" /></label>
      </div>
    </div>

    <section class="r-card tbl" aria-label="Contacts">
      <table>
        <thead><tr><th>Name</th><th>Office</th><th>Area</th><th>Phone</th><th>State</th><th>Source</th><th>Last checked</th><th class="r"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          @for (k of rows(); track k.id) {
            <tr>
              <td><b>{{ k.person_name || k.title }}</b></td>
              <td [matTooltip]="k.address ?? ''">{{ k.person_name ? k.title + ' · ' : '' }}{{ k.agency }}@if (k.address) { <mat-icon class="addr" aria-hidden="true">location_on</mat-icon> }</td>
              <td>{{ k.where?.name ?? k.area_code }}<div class="muted xs">{{ label(k.level) }}{{ k.where?.parents?.length ? ' · ' + k.where!.parents[0] : '' }}</div></td>
              <td class="mono">{{ masked(k.phone) }}</td>
              <td><span class="st" [class]="'st ' + st(k).cls" [matTooltip]="st(k).hint">{{ st(k).text }}</span></td>
              <td><span class="src" [class]="'src ' + k.source_type" [matTooltip]="k.tenant_id ? '' : 'Added by Rumfa for every organisation'">{{ k.tenant_id ? label(k.source_type) : 'Official (Rumfa)' }}</span>
                @if (k.source_url) { <a [href]="k.source_url" target="_blank" rel="noopener" class="xs">source</a> }</td>
              <td class="muted">@if (k.last_call_ok_at) { {{ k.last_call_ok_at | ago }} } @else if (k.last_call_failed_at) { <span class="bad">failed {{ k.last_call_failed_at | ago }}</span> } @else { never }</td>
              <td class="r acts">
                @if (k.phone) { <button mat-stroked-button (click)="call(k)"><mat-icon>call</mat-icon> Call</button> }
                @if (needsAction(k)) {
                  <button mat-icon-button [matMenuTriggerFor]="m" [attr.aria-label]="'Check ' + k.title"><mat-icon>more_horiz</mat-icon></button>
                  <mat-menu #m>
                    @if (k.phone && ['pending','stale','call_tested'].includes(k.status)) {
                      <button mat-menu-item (click)="markCall(k, true)"><mat-icon>check_circle</mat-icon> They answered</button>
                      <button mat-menu-item (click)="markCall(k, false)"><mat-icon>phone_missed</mat-icon> No answer</button>
                    }
                    @if (k.status === 'call_tested' && k.added_by !== api.me()?.id) {
                      <button mat-menu-item (click)="approve(k, true)"><mat-icon>verified</mat-icon> Approve</button>
                      <button mat-menu-item (click)="approve(k, false)"><mat-icon>block</mat-icon> Reject</button>
                    }
                  </mat-menu>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="8"><p class="empty muted">{{ loaded() ? 'No contacts here.' : 'Loading…' }}</p></td></tr> }
        </tbody>
      </table>
    </section>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); max-width: 760px; }
    h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; } .bad { color: var(--r-urgent); }
    .panel { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .p-head, .p-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
    .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--r-ink-2); }
    input, select { border: 1px solid var(--r-line); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13.5px; background: #fff; color: var(--r-ink); }
    .tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip { border: 1px solid var(--r-line); background: #fff; border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 600; color: var(--r-ink-2); cursor: pointer; }
    .chip b { margin-left: 3px; } .chip.on { background: var(--r-ink); border-color: var(--r-ink); color: #fff; }
    .search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--r-line); border-radius: 10px; background: #fff; padding: 0 10px; width: 240px; }
    .search mat-icon { color: var(--r-muted); font-size: 20px; width: 20px; height: 20px; }
    .search input { border: 0; padding: 9px 0; flex: 1; outline: none; }
    .tbl { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: var(--r-muted); padding: 10px 14px; background: #fafbfc; border-bottom: 1px solid var(--r-line); white-space: nowrap; }
    td { padding: 10px 14px; border-bottom: 1px solid var(--r-line-soft); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: 0; }
    .addr { font-size: 15px; width: 15px; height: 15px; vertical-align: -3px; color: var(--r-muted); margin-left: 3px; }
    .r { text-align: right; } .acts { white-space: nowrap; } .mono { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .st { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
    .st.ok { background: #e3f4ea; color: #146c3a; } .st.wait { background: var(--r-high-bg); color: #7a2e0b; } .st.off { background: var(--r-low-bg); color: var(--r-ink-2); }
    .src { padding: 2px 8px; border-radius: 8px; font-size: 12px; white-space: nowrap; }
    .src.official { background: #e3f2e1; } .src.liaison { background: #e7f1fb; } .src.coordinator { background: #f9eeda; }
    .empty { margin: 0; padding: 24px; text-align: center; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
})
export class ContactsPage {
  api = inject(Api);
  private ui = inject(Ui);
  private calls = inject(Calls);
  label = label;
  readonly agencies = ['INEC', 'Police', 'Army', 'NSCDC', 'DSS', 'Fire service', 'Ambulance', 'Party legal team', 'Traditional ruler', 'Local government', 'Other'];
  readonly states: { id: State; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'todo', label: 'Needs checking' }, { id: 'verified', label: 'Verified' }];
  all = signal<Contact[]>([]);
  loaded = signal(false);
  q = signal('');
  agency = signal('');
  state = signal<State>('all');
  adding = signal(false);
  n = { agency: 'Police', title: '', person: '', phone: '', level: 'ward', area: '' };
  canAdd = computed(() => ['coordinator', 'supervisor', 'admin'].includes(this.api.me()?.role ?? ''));

  /** The agencies present, most contacts first */
  agencyTabs = computed(() => {
    const by = new Map<string, number>();
    for (const k of this.all()) by.set(k.agency, (by.get(k.agency) ?? 0) + 1);
    return [{ name: '', count: this.all().length }, ...[...by.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))];
  });
  rows = computed(() => {
    const f = this.q().trim().toLowerCase(), a = this.agency();
    return this.all().filter((k) => (!a || k.agency === a) && (!f || k.area_code.startsWith(f)
      || `${k.agency} ${k.title} ${k.person_name ?? ''} ${k.where?.name ?? ''} ${(k.where?.parents ?? []).join(' ')}`.toLowerCase().includes(f)));
  });

  constructor() { void this.load(); }

  async load() {
    const s = this.state();
    const status = s === 'todo' ? 'pending,call_tested,stale' : s === 'verified' ? 'verified' : undefined;
    try { this.all.set(await this.api.get<Contact[]>('/contacts', { status })); } catch (e) { this.ui.error(e); }
    this.loaded.set(true);
  }
  setState(s: State) { this.state.set(s); void this.load(); }

  st(k: Contact) { return STATUS[k.status] ?? { text: label(k.status), cls: 'off', hint: '' }; }
  needsAction(k: Contact) { return (!!k.phone && ['pending', 'stale', 'call_tested'].includes(k.status)) || (k.status === 'call_tested' && k.added_by !== this.api.me()?.id); }
  /** 0803 *** 1120: enough to recognise, not to copy (calls go through Rumfa) */
  masked(p: string | null) {
    if (!p) return '—';
    const local = p.replace(/^\+234/, '0');
    return local.length >= 10 ? `${local.slice(0, 4)} *** ${local.slice(-4)}` : local;
  }

  async add() {
    const phone = normaliseNgPhone(this.n.phone);
    if (!phone || !this.n.title || !this.n.area) { this.ui.error('Title, a valid phone and area code are required'); return; }
    const ok = await this.ui.run(() => this.api.post('/contacts', { agency: this.n.agency, title: this.n.title, person: this.n.person || undefined,
      phone, level: this.n.level, areaCode: this.n.area }), 'Saved. Now make a test call.');
    if (ok) { this.adding.set(false); this.state.set('todo'); await this.load(); }
  }

  call(k: Contact) {
    const test = k.status !== 'verified';
    void this.calls.call('contact', k.id, `${k.agency} ${k.title}`, undefined, test ? 'Test call' : undefined);
  }
  async markCall(k: Contact, ok: boolean) { await this.ui.run(() => this.api.post(`/contacts/${k.id}/call-result`, { ok }), ok ? 'Marked as reached' : 'Marked unreachable'); await this.load(); }
  async approve(k: Contact, ok: boolean) { await this.ui.run(() => this.api.post(`/contacts/${k.id}/approve`, { approve: ok }), ok ? 'Approved' : 'Rejected'); await this.load(); }
}
