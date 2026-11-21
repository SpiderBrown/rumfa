import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { AgoPipe, Ui, label } from '../core/ui';

type Need = 'callback' | 'notin' | 'silent' | 'trouble' | 'turnout';
interface Person {
  id: string; full_name: string; phone: string; network: string | null; role: string; level: string; area_code: string; place: string;
  checked_in_at: string | null; last_heard: string | null; needs: Need[]; followed: { need: Need; at: string }[];
}
interface Child { code: string; name: string; coordinator: { id: string; full_name: string } | null; agents: number; inPlace: number; todo: number }
interface Team {
  area: string; name: string; scope: string; childLevel: string; counts: Record<Need | 'any' | 'people', number>;
  children: Child[]; people: Person[]; rules: { silentMinutes: number; turnoutMinutes: number; snoozeMinutes: number };
}

/** What each need means, in the order they matter; colours shared by the cards and the chips */
const NEED: Record<Need, { name: string; hint: string; cls: string }> = {
  callback: { name: 'Asked for a call', hint: 'waiting for someone to ring', cls: 'n-call' },
  notin: { name: 'Not checked in', hint: 'no check-in at their unit yet', cls: 'n-urgent' },
  silent: { name: 'Silent', hint: 'nothing from them for an hour', cls: 'n-high' },
  trouble: { name: 'Phone or app trouble', hint: 'reported a phone or app problem', cls: 'n-low' },
  turnout: { name: 'No turnout update', hint: 'no accredited figure for 2 hours', cls: 'n-medium' },
};
const ORDER: Need[] = ['callback', 'notin', 'silent', 'trouble', 'turnout'];
const CHILD_NAME: Record<string, string> = { state: 'States', lga: 'LGAs', ward: 'Wards', pu: 'Polling units' };

/**
 * My field team: who in my area needs a call right now, by what they need; the sub-areas with their
 * coordinators; and one announcement to everyone (in the app, by SMS for those offline).
 */
@Component({
  selector: 'app-team',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="muted sm b">{{ t()?.counts?.people ?? 0 }} people in the field · {{ areaPath() }}</p>
        <h1>My field team</h1>
        @if (stack().length > 1) {
          <button class="back" (click)="up()"><mat-icon>arrow_back</mat-icon> Back to {{ stack()[stack().length - 2].name }}</button>
        } @else { <p class="muted">Who needs a call right now. Everyone in your area, by what they need.</p> }
      </div>
      <div class="head-r">
        <button mat-flat-button (click)="openAnnounce()"><mat-icon>campaign</mat-icon> Send announcement</button>
      </div>
    </header>

    <!-- One message to the team: app first, SMS for anyone not in the app lately -->
    @if (announcing()) {
      <section class="r-card announce" aria-label="Announcement">
        <div class="a-head"><h2>Announcement to {{ audienceName() }}</h2>
          <button mat-icon-button (click)="announcing.set(false)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="r-seg" role="radiogroup" aria-label="Who it goes to">
          @for (a of audiences(); track a.id) {
            <button role="radio" [class.on]="audience() === a.id" [attr.aria-checked]="audience() === a.id" (click)="audience.set(a.id)" [disabled]="!a.count">{{ a.label }}</button>
          }
        </div>
        <label class="field"><span>Message</span>
          <textarea rows="3" maxlength="480" [(ngModel)]="text" placeholder="e.g. Polls close at 2:30. Send your turnout figure now, then stay at your unit for the count."></textarea>
          <span class="muted sm">{{ text.length }}/480 · signed with your name</span></label>
        <div class="a-foot">
          <span class="muted sm">Arrives in the app with a sound, and in the area's chat. People not seen in the app for 30 minutes get it by SMS.</span>
          <button mat-flat-button (click)="send()" [disabled]="text.trim().length < 2 || sending()">Send to {{ audienceCount() }}</button>
        </div>
        @if (sentNote(); as n) { <p class="sent"><mat-icon>check_circle</mat-icon>{{ n }}</p> }
      </section>
    }

    <!-- What needs following up: each is a filter for the list -->
    <section class="needs" role="tablist" aria-label="Follow up">
      <button class="need r-focus" role="tab" [class.on]="filter() === 'any'" [attr.aria-selected]="filter() === 'any'" (click)="filter.set('any')">
        <b>{{ t()?.counts?.any ?? 0 }}</b><span class="n-name">Need follow-up</span><span class="muted xs">everything below</span></button>
      @for (n of order; track n) {
        <button class="need r-focus" role="tab" [class]="'need r-focus ' + needInfo[n].cls" [class.on]="filter() === n" [attr.aria-selected]="filter() === n" (click)="filter.set(n)">
          <b>{{ t()?.counts?.[n] ?? 0 }}</b><span class="n-name">{{ needInfo[n].name }}</span><span class="muted xs">{{ needInfo[n].hint }}</span></button>
      }
    </section>

    <!-- Sub-areas: their coordinator and how they are doing; click to see only theirs, Open to go in -->
    @if (t()?.children?.length) {
      <section aria-label="Sub-areas">
        <div class="row-head"><h2>{{ childName() }}</h2><span class="muted sm">{{ child() ? 'Showing ' + childLabel() + ' only · click it again for all' : 'Click one to see only its people' }}</span></div>
        <div class="kids">
          @for (k of t()!.children; track k.code) {
            <div class="kid" [class.on]="child() === k.code">
              <button class="k-main r-focus" (click)="child.set(child() === k.code ? null : k.code)" [attr.aria-pressed]="child() === k.code">
                <b>{{ k.name }}</b>
                <span class="muted xs">{{ k.coordinator ? 'Coordinator: ' + k.coordinator.full_name : 'No coordinator yet' }}</span>
                @if (k.agents) {
                  <span class="k-bar"><span class="bar" aria-hidden="true"><span [style.width.%]="pct(k.inPlace, k.agents)"></span></span><span class="xs">{{ pct(k.inPlace, k.agents) }}% in place</span></span>
                }
                <span class="xs" [class.bad]="k.todo" [class.good]="!k.todo">{{ k.todo ? k.todo + ' to follow up' : 'All good' }}</span>
              </button>
              @if (t()!.childLevel !== 'pu') { <button class="k-open" (click)="go(k.code, k.name)" [attr.aria-label]="'Open ' + k.name">Open <mat-icon>chevron_right</mat-icon></button> }
            </div>
          }
        </div>
      </section>
    }

    <!-- The list -->
    <section class="r-card list" aria-label="People to follow up">
      <div class="l-head">
        <h2>{{ listTitle() }}</h2>
        <button mat-button (click)="showFollowed.set(!showFollowed())">{{ showFollowed() ? 'Hide followed up' : 'Show followed up (' + followedCount() + ')' }}</button>
      </div>
      <div class="scroll">
        <table>
          <thead><tr><th>Person</th><th>Where</th><th>Needs</th><th>Last heard</th><th class="r"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            @for (p of rows(); track p.id) {
              <tr [class.dim]="!p.needs.length">
                <td><b>{{ p.full_name }}</b><div class="muted xs">{{ label(p.role) }} · {{ p.phone }}{{ p.network ? ' · ' + p.network.toUpperCase() : '' }}</div></td>
                <td>{{ p.place }}</td>
                <td><div class="chips">
                  @for (n of p.needs; track n) { <span class="chip" [class]="'chip ' + needInfo[n].cls">{{ needInfo[n].name }}</span> }
                  @for (f of p.followed; track f.need) { <span class="chip done" [matTooltip]="'Back on the list ' + backAt(f.at) + ' if it is still a problem'">{{ needInfo[f.need].name }} · followed up {{ f.at | ago }}</span> }
                </div></td>
                <td class="muted">{{ p.last_heard ? (p.last_heard | ago) : 'never' }}</td>
                <td class="r acts">
                  <button mat-stroked-button (click)="call(p)"><mat-icon>call</mat-icon> Call</button>
                  <button mat-stroked-button (click)="message(p)"><mat-icon>chat</mat-icon> Message</button>
                  @if (p.needs.length) { <button mat-flat-button (click)="done(p)" [matTooltip]="'Off the list for an hour'"><mat-icon>check</mat-icon> Done</button> }
                  @else { <button mat-button (click)="undo(p)">Undo</button> }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="5"><div class="calm"><mat-icon>verified</mat-icon>{{ emptyText() }}</div></td></tr>
            }
          </tbody>
        </table>
      </div>
      @if (t(); as d) { <p class="muted xs rules">Silent: nothing for {{ d.rules.silentMinutes }} min. No turnout update: none for {{ d.rules.turnoutMinutes / 60 }} hours after check-in. Done takes someone off for {{ d.rules.snoozeMinutes }} min.</p> }
    </section>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1500px; }
    .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
    h1 { margin: 2px 0 4px; font-size: 26px; font-weight: 800; letter-spacing: -.01em; } h2 { margin: 0; font-size: 17px; font-weight: 700; }
    p { margin: 0; } .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; } .b { font-weight: 600; }
    .back { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; color: #0f5e8c; font: inherit; font-weight: 600; padding: 0; cursor: pointer; }
    .back mat-icon { font-size: 18px; width: 18px; height: 18px; }

    .announce { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; border: 2px solid var(--r-ink); }
    .a-head, .a-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--r-ink-2); }
    textarea { font: inherit; font-size: 15px; font-weight: 400; padding: 10px 12px; border: 1px solid #c9d1dc; border-radius: 10px; resize: vertical; }
    textarea:focus { outline: 2px solid var(--r-accent); outline-offset: 0; border-color: transparent; }
    .sent { display: flex; align-items: center; gap: 8px; background: #eaf5f3; color: var(--r-accent-strong); font-weight: 600; border-radius: 10px; padding: 10px 12px; }

    .needs { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .need { display: flex; flex-direction: column; gap: 3px; text-align: left; font: inherit; color: var(--r-ink); cursor: pointer;
      background: #fff; border: 1px solid var(--r-line); border-radius: 12px; padding: 12px 14px; }
    .need:hover { border-color: #9aa6b6; } .need.on { border: 2px solid var(--r-ink); padding: 11px 13px; }
    .need b { font-size: 26px; font-weight: 800; } .n-name { font-size: 13px; font-weight: 700; }
    .need.n-urgent b { color: var(--r-urgent); } .need.n-high b { color: var(--r-high); } .need.n-medium b { color: var(--r-medium); } .need.n-call b { color: #5b3fa8; }

    .row-head, .l-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
    .kids { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
    .kid { flex: 0 0 auto; min-width: 170px; background: #fff; border: 1px solid var(--r-line); border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
    .kid.on { border: 2px solid var(--r-ink); }
    .k-main { border: 0; background: none; text-align: left; padding: 10px 12px 6px; display: flex; flex-direction: column; gap: 4px; font: inherit; color: var(--r-ink); cursor: pointer; }
    .k-main:hover { background: #fafbfc; }
    .k-bar { display: flex; align-items: center; gap: 8px; } .bar { flex: 1; min-width: 50px; height: 6px; border-radius: 3px; background: #e7ebf0; overflow: hidden; display: block; }
    .bar span { display: block; height: 100%; background: var(--r-accent); }
    .bad { color: var(--r-urgent); font-weight: 700; } .good { color: var(--r-accent-strong); font-weight: 700; }
    .k-open { display: flex; align-items: center; justify-content: flex-end; gap: 2px; border: 0; border-top: 1px solid var(--r-line-soft); background: none; color: #0f5e8c;
      font: inherit; font-size: 13px; font-weight: 600; padding: 4px 10px; cursor: pointer; }
    .k-open mat-icon { font-size: 18px; width: 18px; height: 18px; } .k-open:hover { background: #eaf2f8; }

    .list { padding: 16px 0 8px; } .l-head { padding: 0 18px; }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 820px; }
    th { text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--r-muted); padding: 8px 12px; }
    th:first-child, td:first-child { padding-left: 18px; } th.r, td.r { padding-right: 18px; text-align: right; }
    td { padding: 10px 12px; border-top: 1px solid var(--r-line-soft); vertical-align: top; }
    tr.dim { opacity: .65; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; background: var(--r-low-bg); }
    .chip.n-urgent { background: var(--r-urgent); color: #fff; } .chip.n-high { background: var(--r-high-bg); color: #7a2e0b; }
    .chip.n-medium { background: var(--r-medium-bg); color: #1f3a5f; } .chip.n-call { background: #ece6f8; color: #3b2a6b; }
    .chip.done { background: #eaf5f3; color: var(--r-accent-strong); font-weight: 600; }
    .acts { white-space: nowrap; } .acts button { margin-left: 6px; }
    .calm { display: flex; align-items: center; gap: 8px; color: var(--r-accent-strong); padding: 12px 0; }
    .rules { padding: 8px 18px 0; }
  `,
})
export class TeamPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  private calls = inject(Calls);
  label = label;
  readonly order = ORDER;
  readonly needInfo = NEED;

  t = signal<Team | null>(null);
  /** The areas walked through, from my own down to the one shown */
  stack = signal<{ code: string; name: string }[]>([]);
  filter = signal<Need | 'any'>('any');
  child = signal<string | null>(null);
  showFollowed = signal(false);
  announcing = signal(false);
  audience = signal<'all' | 'list' | 'coordinators'>('all');
  sending = signal(false);
  sentNote = signal<string | null>(null);
  text = '';
  private stopLive: () => void;
  private timer = setInterval(() => void this.load(), 60_000);

  areaPath = computed(() => this.stack().map((s) => s.name).join(' › ') || '…');
  childName = computed(() => CHILD_NAME[this.t()?.childLevel ?? 'ward'] ?? 'Areas');
  childLabel = computed(() => this.t()?.children.find((k) => k.code === this.child())?.name ?? '');

  rows = computed(() => {
    const d = this.t(); if (!d) return [];
    const f = this.filter(), c = this.child();
    const rank = (p: Person) => Math.min(...p.needs.map((n) => ORDER.indexOf(n)), 9);
    return d.people
      .filter((p) => (!c || p.area_code === c || p.area_code.startsWith(c + '-')))
      .filter((p) => (p.needs.length ? f === 'any' || p.needs.includes(f) : this.showFollowed() && (f === 'any' || p.followed.some((x) => x.need === f))))
      .sort((a, b) => rank(a) - rank(b) || a.full_name.localeCompare(b.full_name));
  });
  followedCount = computed(() => (this.t()?.people ?? []).filter((p) => !p.needs.length).length);
  listTitle = computed(() => (this.filter() === 'any' ? 'Need follow-up' : NEED[this.filter() as Need].name) + (this.child() ? ' · ' + this.childLabel() : ''));
  emptyText = computed(() => this.t() ? 'Nobody to follow up here. Well done.' : 'Loading…');

  audiences = computed(() => {
    const d = this.t();
    const all = d?.counts.people ?? 0, list = this.rows().filter((p) => p.needs.length).length;
    const coords = (d?.people ?? []).filter((p) => p.role === 'coordinator').length + (d?.children ?? []).filter((k) => k.coordinator).length;
    return [
      { id: 'all' as const, label: `Everyone (${all})`, count: all },
      { id: 'list' as const, label: `Only the list below (${list})`, count: list },
      { id: 'coordinators' as const, label: 'Coordinators only', count: coords || 1 },
    ];
  });
  audienceName = computed(() => ({ all: `everyone in ${this.stack().at(-1)?.name ?? 'your area'}`, list: 'the people in the list', coordinators: 'the coordinators' })[this.audience()]);
  audienceCount = computed(() => {
    const a = this.audience(); const x = this.audiences().find((y) => y.id === a)!;
    return a === 'coordinators' ? 'coordinators' : x.count;
  });

  constructor() {
    void this.load();
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.stopLive = this.api.onChange(() => { pending ??= setTimeout(() => { pending = null; void this.load(); }, 2000); },
      ['checkins', 'unit_figure_updates', 'callback_requests', 'cases']);
  }
  ngOnDestroy() { clearInterval(this.timer); this.stopLive(); }

  async load() {
    const area = this.stack().at(-1)?.code;
    try {
      const d = await this.api.get<Team>('/team', { area });
      this.t.set(d);
      if (!this.stack().length) this.stack.set([{ code: d.area, name: d.name }]);
    } catch (e) { this.ui.error(e); }
  }
  go(code: string, name: string) { this.stack.update((s) => [...s, { code, name }]); this.child.set(null); this.t.set(null); void this.load(); }
  up() { this.stack.update((s) => s.slice(0, -1)); this.child.set(null); void this.load(); }

  pct(a: number, b: number) { return b ? Math.round((a / b) * 100) : 0; }
  backAt(at: string) {
    const d = new Date(new Date(at).getTime() + (this.t()?.rules.snoozeMinutes ?? 60) * 60_000);
    return 'at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  call(p: Person) { void this.calls.call('volunteer', p.id, p.full_name); }
  async message(p: Person) {
    const body = await this.ui.prompt(`Message ${p.full_name}`, 'Message', { multiline: true, okLabel: 'Send' });
    if (!body) return;
    await this.ui.run(async () => {
      const { channelId } = await this.api.post<{ channelId: string }>('/channels/direct', { otherId: p.id });
      await this.api.post(`/channels/${channelId}/messages`, { body, clientId: crypto.randomUUID() });
    }, `Sent to ${p.full_name}. Their reply will show in Messages.`);
  }
  async done(p: Person) {
    const ok = await this.ui.run(() => Promise.all(p.needs.map((need) => this.api.post('/team/follow-ups', { volunteerId: p.id, need }))),
      `${p.full_name} is off the list for an hour`);
    if (ok) await this.load();
  }
  async undo(p: Person) {
    if (await this.ui.run(() => this.api.post('/team/follow-ups/undo', { volunteerId: p.id }), 'Back on the list')) await this.load();
  }

  openAnnounce() { this.announcing.set(true); this.sentNote.set(null); }
  async send() {
    const a = this.audience(), area = this.stack().at(-1)?.code ?? this.t()?.area;
    if (!area) return;
    this.sending.set(true);
    const ids = a === 'list' ? this.rows().filter((p) => p.needs.length).map((p) => p.id) : undefined;
    const r = await this.ui.run(() => this.api.post<{ sent: number; sms: number; chat: boolean }>('/team/announce', { area, audience: a, ids, text: this.text.trim() }));
    this.sending.set(false);
    if (r) {
      this.sentNote.set(`Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'} in the app` + (r.sms ? `, ${r.sms} also by SMS` : '') + (r.chat ? ', and posted in the area chat.' : '.'));
      this.text = '';
    }
  }
}
