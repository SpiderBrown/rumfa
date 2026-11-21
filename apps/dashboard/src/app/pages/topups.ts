import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Api } from '../core/api';
import { AgoPipe, Ui, label } from '../core/ui';

interface Plan { id: string; name: string; kind: 'airtime' | 'data'; amount_ngn: number; data_plan_code: string | null; target_roles: string[];
  target_area_codes: string[]; onboarded_only: boolean; scheduled_for: string | null; created_at: string }
interface Batch { id: string; plan_id: string; plan_name: string; status: string; person_count: number; total_ngn: number; created_by: string;
  created_at: string; counts: Record<string, number> | null }

const ROLES = ['agent', 'volunteer', 'coordinator', 'operator', 'supervisor'];

/**
 * Airtime and data (add-on): top up registered people so they can report on election day. Plans say who and how
 * much; each send is a batch that a second admin approves. Every top-up is logged against the person.
 */
@Component({
  selector: 'app-topups',
  imports: [DatePipe, DecimalPipe, FormsModule, MatButtonModule, MatIconModule, MatSlideToggleModule, AgoPipe],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="eyebrow">Add-on · switched on by Rumfa</p>
        <h1>Airtime and data</h1>
        <p class="lede">Top up agents so they can report on election day. Only registered people with a role, never typed-in numbers. Every send needs a second admin.</p>
      </div>
      <button mat-flat-button (click)="adding.set(!adding())"><mat-icon>add</mat-icon> New top-up plan</button>
    </header>

    <section class="stats" aria-label="Summary">
      <div class="stat r-card"><span class="s-l">Sent today</span><b>₦{{ today().ngn | number }}</b><span class="s-h">{{ today().people | number }} people</span></div>
      <div class="stat r-card"><span class="s-l">Sent in all</span><b>₦{{ total().ngn | number }}</b><span class="s-h">{{ total().people | number }} top-ups</span></div>
      <div class="stat r-card" [class.warn]="failed()"><span class="s-l">Failed</span><b>{{ failed() | number }}</b><span class="s-h">wrong network or number</span></div>
      <div class="stat r-card" [class.warn]="waiting().length"><span class="s-l">Waiting for approval</span><b>{{ waiting().length }}</b>
        <span class="s-h">{{ waiting().length ? '₦' + (waitingNgn() | number) + ' to approve' : 'nothing waiting' }}</span></div>
      @if (nextScheduled(); as p) {
        <div class="stat r-card"><span class="s-l">Scheduled</span><b>{{ p.scheduled_for | date: 'EEE HH:mm' : '+0100' }}</b>
          <span class="s-h">₦{{ p.amount_ngn | number }} {{ p.kind }} to {{ who(p) }}</span></div>
      }
    </section>

    @if (adding()) {
      <section class="r-card panel" aria-label="New top-up plan">
        <div class="p-head"><h2>New top-up plan</h2><button mat-icon-button (click)="adding.set(false)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="form">
          <label><span>Name</span><input [(ngModel)]="n.name" placeholder="Agents data, 15 Jan" /></label>
          <label><span>Kind</span><select [(ngModel)]="n.kind"><option value="airtime">Airtime</option><option value="data">Data</option></select></label>
          <label><span>Amount per person (₦)</span><input type="number" min="50" [(ngModel)]="n.amount" /></label>
          @if (n.kind === 'data') { <label><span>Provider's data plan code</span><input [(ngModel)]="n.plan" /></label> }
          <label><span>Areas (codes, comma-separated; empty for all)</span><input [(ngModel)]="n.areas" placeholder="19-28, 19-30" /></label>
          <label><span>Send on (optional)</span><input type="datetime-local" [(ngModel)]="n.when" /></label>
        </div>
        <div class="roles"><span class="xs b">Who</span>
          @for (r of roles; track r) {
            <label class="chk"><input type="checkbox" [checked]="n.roles.includes(r)" (change)="toggleRole(r)" /> {{ label(r) }}s</label>
          }
          <mat-slide-toggle [(ngModel)]="n.onboarded">Only people who finished onboarding</mat-slide-toggle>
        </div>
        <div class="p-foot"><span class="muted sm">Saving a plan sends nothing. Press Send on it; a second admin approves.</span>
          <button mat-flat-button (click)="createPlan()">Save plan</button></div>
      </section>
    }

    @if (plans().length) {
      <section aria-label="Plans">
        <h2 class="sec">Plans</h2>
        <div class="plans">
          @for (p of plans(); track p.id) {
            <div class="plan r-card">
              <div class="pl-top"><b>{{ p.name }}</b><span class="pill" [class.data]="p.kind === 'data'">{{ p.kind === 'data' ? 'Data' : 'Airtime' }}</span></div>
              <div class="amt">₦{{ p.amount_ngn | number }}<span class="muted xs"> each</span></div>
              <div class="muted xs">{{ who(p) }}{{ p.onboarded_only ? ' · onboarded only' : '' }}</div>
              @if (p.scheduled_for) { <div class="xs b sched"><mat-icon>schedule</mat-icon> {{ p.scheduled_for | date: 'EEE d MMM, HH:mm' : '+0100' }}</div> }
              <button mat-stroked-button (click)="batch(p)"><mat-icon>send</mat-icon> Send now</button>
            </div>
          }
        </div>
      </section>
    }

    <section class="r-card tbl" aria-label="Top-ups sent">
      <div class="l-head"><h2>Sends</h2><span class="muted sm">Newest first</span></div>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Total</th><th>Status</th><th class="r"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          @for (b of batches(); track b.id) {
            <tr>
              <td>{{ b.created_at | date: 'd MMM, HH:mm' : '+0100' }}<div class="muted xs">{{ b.created_at | ago }}</div></td>
              <td><b>{{ planWho(b) }}</b> ({{ b.person_count | number }})</td>
              <td>{{ planWhat(b) }}</td>
              <td>₦{{ b.total_ngn | number }}</td>
              <td><span class="st" [class]="'st ' + statusCls(b)">{{ statusText(b) }}</span></td>
              <td class="r acts">
                @if (b.status === 'pending_approval' && b.created_by !== api.me()?.id) {
                  <button mat-flat-button (click)="approve(b, true)">Approve</button> <button mat-button (click)="approve(b, false)">Cancel</button> }
                @else if (b.status === 'pending_approval') { <span class="muted xs">Another admin approves or cancels it</span> }
              </td>
            </tr>
          } @empty { <tr><td colspan="6"><p class="empty muted">Nothing sent yet. Make a plan, then press Send.</p></td></tr> }
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
    h2 { margin: 0; font-size: 16px; font-weight: 700; } h2.sec { margin-bottom: 10px; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; } .b { font-weight: 700; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .stat { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; }
    .stat b { font-size: 24px; font-weight: 800; }
    .s-l { font-size: 13px; font-weight: 600; color: var(--r-ink-2); } .s-h { font-size: 12px; color: var(--r-muted); }
    .stat.warn { border-color: #f0c9a8; background: #fffaf5; } .stat.warn b { color: var(--r-high); }
    .panel { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .p-head, .p-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
    .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--r-ink-2); }
    input:not([type=checkbox]), select { border: 1px solid var(--r-line); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13.5px; background: #fff; color: var(--r-ink); }
    .roles { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; }
    .plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .plan { padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
    .plan button { margin-top: 8px; align-self: flex-start; }
    .pl-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .amt { font-size: 20px; font-weight: 800; }
    .sched { display: flex; align-items: center; gap: 4px; color: var(--r-medium); }
    .sched mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .pill { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px; background: #fdf3d8; color: #6b4a00; }
    .pill.data { background: var(--r-medium-bg); color: var(--r-medium); }
    .tbl { overflow-x: auto; }
    .l-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 18px 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: var(--r-muted); padding: 10px 14px; background: #fafbfc; border-top: 1px solid var(--r-line-soft); border-bottom: 1px solid var(--r-line); }
    td { padding: 10px 14px; border-bottom: 1px solid var(--r-line-soft); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: 0; }
    .r { text-align: right; } .acts { white-space: nowrap; }
    .st { font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 9px; }
    .st.ok { background: #e3f4ea; color: #146c3a; } .st.wait { background: var(--r-high-bg); color: #7a2e0b; } .st.off { background: var(--r-low-bg); color: var(--r-ink-2); }
    .st.run { background: var(--r-medium-bg); color: var(--r-medium); }
    .empty { margin: 0; padding: 24px; text-align: center; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
})
export class TopupsPage {
  api = inject(Api);
  private ui = inject(Ui);
  label = label;
  readonly roles = ROLES;
  plans = signal<Plan[]>([]);
  batches = signal<Batch[]>([]);
  adding = signal(false);
  n = { name: '', kind: 'data', amount: 1000, plan: '', roles: ['agent'] as string[], areas: '', onboarded: true, when: '' };

  private planOf = computed(() => new Map(this.plans().map((p) => [p.id, p])));
  private per(b: Batch) { return b.person_count ? b.total_ngn / b.person_count : 0; }
  private sentOf(b: Batch) { return (b.counts?.['sent'] ?? 0) + (b.counts?.['delivered'] ?? 0) + (b.counts?.['success'] ?? 0); }
  today = computed(() => {
    const d = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
    return this.batches().filter((b) => new Date(+new Date(b.created_at) + 3_600_000).toISOString().slice(0, 10) === d)
      .reduce((t, b) => ({ ngn: t.ngn + this.sentOf(b) * this.per(b), people: t.people + this.sentOf(b) }), { ngn: 0, people: 0 });
  });
  total = computed(() => this.batches().reduce((t, b) => ({ ngn: t.ngn + this.sentOf(b) * this.per(b), people: t.people + this.sentOf(b) }), { ngn: 0, people: 0 }));
  failed = computed(() => this.batches().reduce((n, b) => n + (b.counts?.['failed'] ?? 0), 0));
  waiting = computed(() => this.batches().filter((b) => b.status === 'pending_approval'));
  waitingNgn = computed(() => this.waiting().reduce((n, b) => n + Number(b.total_ngn), 0));
  nextScheduled = computed(() => this.plans().filter((p) => p.scheduled_for && +new Date(p.scheduled_for) > Date.now())
    .sort((a, b) => a.scheduled_for!.localeCompare(b.scheduled_for!))[0] ?? null);

  constructor() { void this.load(); }

  async load() {
    const [p, b] = await Promise.all([this.api.get<Plan[]>('/topups/plans'), this.api.get<Batch[]>('/topups/batches')])
      .catch((e) => { this.ui.error(e); return [[], []] as [Plan[], Batch[]]; });
    this.plans.set(p); this.batches.set(b);
  }

  who(p: Plan) {
    const roles = p.target_roles.map((r) => label(r) + 's').join(', ');
    return `${roles}${p.target_area_codes?.length ? ' in ' + p.target_area_codes.join(', ') : ', everywhere'}`;
  }
  planWho(b: Batch) { const p = this.planOf().get(b.plan_id); return p ? this.who(p) : b.plan_name; }
  planWhat(b: Batch) { const p = this.planOf().get(b.plan_id); return p ? `₦${p.amount_ngn.toLocaleString()} ${p.kind}` : b.plan_name; }
  statusText(b: Batch) {
    if (b.status === 'pending_approval') return 'Waiting for approval';
    const sent = this.sentOf(b), failed = b.counts?.['failed'] ?? 0;
    if (b.counts && (sent || failed)) return `Sent ${sent.toLocaleString()}${failed ? ' · ' + failed + ' failed' : ''}`;
    return label(b.status);
  }
  statusCls(b: Batch) {
    if (b.status === 'pending_approval') return 'wait';
    if (['cancelled', 'rejected'].includes(b.status)) return 'off';
    if (['approved', 'sending', 'running'].includes(b.status)) return 'run';
    return 'ok';
  }
  toggleRole(r: string) { this.n.roles = this.n.roles.includes(r) ? this.n.roles.filter((x) => x !== r) : [...this.n.roles, r]; }

  async createPlan() {
    if (!this.n.name || !this.n.amount || !this.n.roles.length) { this.ui.error('Name, amount and who are required'); return; }
    const ok = await this.ui.run(() => this.api.post('/topups/plans', { name: this.n.name, kind: this.n.kind, amountNgn: Number(this.n.amount),
      dataPlanCode: this.n.kind === 'data' ? this.n.plan || undefined : undefined, targetRoles: this.n.roles,
      targetAreaCodes: this.n.areas.split(',').map((s) => s.trim()).filter(Boolean), onboardedOnly: this.n.onboarded,
      scheduledFor: this.n.when ? new Date(this.n.when).toISOString() : undefined }), 'Plan saved');
    if (ok) { this.adding.set(false); await this.load(); }
  }
  async batch(p: Plan) {
    if (!(await this.ui.confirm(`Send ${p.name}?`, `₦${p.amount_ngn.toLocaleString()} ${p.kind} to ${this.who(p)}. A second admin must approve before anything is spent.`, 'Prepare send'))) return;
    await this.ui.run(() => this.api.post('/topups/batches', { planId: p.id }), 'Ready; a second admin must approve it');
    await this.load();
  }
  async approve(b: Batch, ok: boolean) {
    if (ok && !(await this.ui.confirm('Approve top-ups', `Send ₦${Number(b.total_ngn).toLocaleString()} to ${b.person_count} people? This spends real money.`, 'Approve and send'))) return;
    await this.ui.run(() => this.api.post(`/topups/batches/${b.id}/approve`, { approve: ok }), ok ? 'Approved; sending starts shortly' : 'Cancelled');
    await this.load();
  }
}
