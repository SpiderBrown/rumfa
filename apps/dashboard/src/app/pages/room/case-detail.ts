import { Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../../core/api';
import { Calls } from '../../core/calls';
import { AgoPipe, SEVERITY_COLOR, Ui, label, placeLine } from '../../core/ui';
import { LiveViewer } from './live-viewer';
import type { CaseRow } from './queue';

interface Person { id: string; full_name: string; phone: string; role: string; level: string; area_code: string; deputy_of?: string | null }
interface Contact { id: string; agency: string; title: string; person_name: string | null; level: string; area_code: string; status: string; source_type: string; last_call_ok_at: string | null }

@Component({
  selector: 'app-case-detail',
  imports: [RouterLink, FormsModule, JsonPipe, MatButtonModule, MatCardModule, MatDividerModule, MatFormFieldModule, MatIconModule,
    MatInputModule, MatListModule, MatMenuModule, MatSelectModule, MatTabsModule, MatTooltipModule, AgoPipe, LiveViewer],
  template: `
  @if (c(); as c) {
  <a routerLink="/room" class="back"><mat-icon>arrow_back</mat-icon> Queue</a>
  <div class="title">
    <span class="sev" [style.background]="sevColor[c.severity]">{{ c.severity }}</span>
    <h1>{{ c.what ?? c.title }}</h1>
  </div>
  @if (c.where) { <div class="where"><mat-icon>place</mat-icon>{{ place(c.where) }} <span class="code">{{ c.where.code }}</span></div> }
  <div class="meta">
    {{ label(c.status) }} · {{ c.report_count }} reports from {{ c.reporter_count }} people · opened {{ c.created_at | ago }}
    @if (c.status === 'assigned') { · acknowledge {{ c.ack_due_at | ago }} } @else if (!['resolved','closed','merged'].includes(c.status)) { · due {{ c.due_at | ago }} }
    @if (c.merged_into) { · merged into <a [routerLink]="['/room/case', c.merged_into]">another case</a> }
  </div>

  <div class="actions">
    @if (c.status === 'assigned' && c.assigned_to === me()) { <button mat-flat-button (click)="act('acknowledge', {}, 'Acknowledged')">Acknowledge</button> }
    @if (['queued','escalated'].includes(c.status) || (c.status === 'assigned' && c.assigned_to !== me())) {
      <button mat-flat-button (click)="takeOver()">Take this case</button> }
    @if (['assigned','in_progress','escalated'].includes(c.status)) {
      <button mat-stroked-button (click)="note()">Add note</button>
      <button mat-stroked-button (click)="resolve()">Resolve</button>
      <button mat-stroked-button (click)="escalate()">Escalate</button>
    }
    @if (c.status === 'resolved' && api.isSupervisor()) { <button mat-flat-button (click)="act('close', {}, 'Case closed')">Confirm close</button> }
    @if (['resolved','closed'].includes(c.status)) { <button mat-stroked-button (click)="reopen()">Reopen</button> }
    @if (api.isSupervisor() && !['closed','merged'].includes(c.status)) {
      <button mat-stroked-button [matMenuTriggerFor]="sup">Supervisor <mat-icon iconPositionEnd>expand_more</mat-icon></button>
      <mat-menu #sup>
        <button mat-menu-item [matMenuTriggerFor]="assign">Reassign to…</button>
        <button mat-menu-item [matMenuTriggerFor]="sev">Change severity…</button>
        <button mat-menu-item [matMenuTriggerFor]="merge">Merge into…</button>
      </mat-menu>
      <mat-menu #assign>@for (s of staff(); track s.id) {
        <button mat-menu-item (click)="act('reassign', { to: s.id }, 'Reassigned')">{{ s.full_name }} · {{ s.status }} · {{ s.open_cases }} open</button> }</mat-menu>
      <mat-menu #sev>@for (s of ['critical','high','medium','low']; track s) {
        <button mat-menu-item (click)="changeSeverity(s)">{{ label(s) }}</button> }</mat-menu>
      <mat-menu #merge>@for (o of mergeTargets(); track o.id) {
        <button mat-menu-item (click)="mergeInto(o)">{{ o.what ?? o.title }} · {{ place(o.where, false) || o.pu_code || o.area_code }} ({{ o.report_count }} reports)</button> }
        @empty { <button mat-menu-item disabled>No open cases nearby</button> }</mat-menu>
    }
  </div>

  @if (openSuggestions().length && api.isSupervisor()) {
    <mat-card appearance="outlined" class="banner">
      <mat-icon>link</mat-icon>
      <div class="grow">
        @for (s of openSuggestions(); track s.id) {
          <div>Possibly related: <a [routerLink]="['/room/case', s.related_case_id]">{{ relatedTitle(s.related_case_id) }}</a>
            ({{ s.reason === 'same_ward_category' ? 'same problem in the same ward' : 'related problem at the same unit' }})
            <button mat-button (click)="decide(s.id, true)">Link as one incident</button>
            <button mat-button (click)="decide(s.id, false)">Not related</button></div>
        }
      </div>
    </mat-card>
  }

  <div class="grid">
    <section>
      <mat-tab-group>
        <mat-tab label="Reports ({{ incidents().length + alerts().length }})">
          @for (i of incidents(); track i.id) {
            <div class="report">
              <div><b>{{ catLabel(i.category) }}</b> · {{ i.severity }} @if (i.is_sos) { <span class="crit">SOS</span> } · {{ i.source }} · {{ i.reported_at | ago }}</div>
              <div>{{ i.volunteer?.full_name }} ({{ label(i.volunteer?.role) }}) at {{ i.pu_code }}</div>
              @if (i.description) { <div class="desc">{{ i.description }}</div> }
              @for (m of i.media_paths; track $index) { <button mat-button (click)="openMedia({ kind: 'incident', id: i.id, index: $index })"><mat-icon>image</mat-icon> Photo {{ $index + 1 }}</button> }
            </div>
          }
          @for (a of alerts(); track a.id) {
            <div class="report alert">
              <div><b>{{ catLabel(a.rule) }}</b> · rule alert · {{ a.created_at | ago }}</div>
              @if (a.details?.diff) { <div>Differs in: {{ a.details.diff.join(', ') }}</div> }
              @if (a.details?.agent && a.details?.irev) {
                <table class="cmp"><tr><th></th><th>Our EC8A</th><th>IReV</th></tr>
                  @for (k of figureKeys(a.details); track k) {
                    <tr [class.diff]="a.details.diff.includes(k)"><td>{{ k }}</td><td>{{ fig(a.details.agent, k) }}</td><td>{{ fig(a.details.irev, k) }}</td></tr> }
                </table>
                <button mat-button (click)="openSheets(a)"><mat-icon>compare</mat-icon> Open both sheets</button>
              } @else { <pre>{{ a.details | json }}</pre> }
            </div>
          }
        </mat-tab>
        <mat-tab label="Timeline">
          @for (e of events(); track e.id) {
            <div class="event"><span class="when">{{ e.at | ago }}</span> <b>{{ label(e.kind) }}</b>
              @if (e.body) { — {{ e.body }} } @if (e.actor_id) { <span class="who">· {{ staffName(e.actor_id) }}</span> }</div>
          }
        </mat-tab>
        <mat-tab label="Chat ({{ messages().length }})">
          <div class="chat">
            @for (m of messages(); track m.id) {
              <div class="msg" [class.mine]="m.sender_id === me()"><span class="who">{{ m.sender_id === me() ? 'You' : (m.sender_name ?? personName(m.sender_id)) }}</span> {{ m.body }}
                @if (m.media_path) { <button mat-button (click)="openMedia({ kind: 'message', id: m.id })">{{ m.kind }}</button> }
                <span class="when">{{ m.created_at | ago }}</span></div>
            }
          </div>
          <div class="send"><mat-form-field class="grow"><mat-label>Message</mat-label>
            <input matInput [(ngModel)]="draft" (keyup.enter)="send()" /></mat-form-field>
            <button mat-flat-button (click)="send()" [disabled]="!draft.trim()">Send</button></div>
        </mat-tab>
      </mat-tab-group>
    </section>

    <aside>
      <mat-card appearance="outlined"><mat-card-header><mat-card-title>People to call</mat-card-title></mat-card-header>
        <mat-list>
          @for (p of people(); track p.id) {
            <mat-list-item>
              <span matListItemTitle>{{ p.full_name }}</span>
              <span matListItemLine>{{ label(p.role) }} · {{ p.level }} {{ p.area_code }} @if (p.deputy_of) { · deputy }</span>
              <span matListItemMeta class="row">
                <button mat-icon-button matTooltip="Call" (click)="call(p)"><mat-icon>call</mat-icon></button>
                @if (p.role === 'agent' || p.role === 'volunteer') {
                  <button mat-icon-button matTooltip="Request live view" (click)="liveView(p)"><mat-icon>videocam</mat-icon></button> }
                @if (p.role === 'coordinator') {
                  <button mat-icon-button matTooltip="Send task" (click)="task(p)"><mat-icon>assignment</mat-icon></button> }
              </span>
            </mat-list-item>
          }
        </mat-list>
      </mat-card>
      <mat-card appearance="outlined"><mat-card-header><mat-card-title>Authority contacts</mat-card-title></mat-card-header>
        <mat-list>
          @for (k of contacts(); track k.id) {
            <mat-list-item>
              <span matListItemTitle>{{ k.agency }} · {{ k.title }}</span>
              <span matListItemLine>{{ k.person_name ?? '' }} {{ k.level }} {{ k.area_code }} · {{ label(k.status) }} · {{ k.source_type }}
                @if (k.last_call_ok_at) { · reached {{ k.last_call_ok_at | ago }} }</span>
              <button matListItemMeta mat-icon-button matTooltip="Call" (click)="callContact(k)"><mat-icon>call</mat-icon></button>
            </mat-list-item>
          } @empty { <p class="empty">No contacts for this area yet.</p> }
        </mat-list>
      </mat-card>
      @if (liveRequest(); as lv) {
        <mat-card appearance="outlined"><mat-card-header><mat-card-title>Live view</mat-card-title>
          <mat-card-subtitle>{{ label(lv.status) }}</mat-card-subtitle></mat-card-header>
          <mat-card-content>
            @if (lv.status === 'live') { <app-live-viewer [requestId]="lv.id" /> }
            @if (lv.status === 'clip_uploaded') { <button mat-flat-button (click)="openMedia({ kind: 'live', id: lv.id })">Play clip</button> }
            @if (lv.status === 'declined') { <p>The agent declined. Call them instead.</p> }
          </mat-card-content>
        </mat-card>
      }
    </aside>
  </div>
  }`,
  styles: `
    .back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; color: var(--mat-sys-primary); }
    .where { display: flex; align-items: center; gap: 4px; color: var(--mat-sys-on-surface-variant); margin-bottom: 4px; }
    .where mat-icon { font-size: 18px; width: 18px; height: 18px; } .where .code { color: var(--mat-sys-outline); font-size: 12px; margin-left: 4px; }
    .title { display: flex; gap: 12px; align-items: center; } h1 { font: var(--mat-sys-headline-small); margin: 8px 0; }
    .meta { color: var(--mat-sys-on-surface-variant); margin-bottom: 12px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .sev { color: white; border-radius: 10px; padding: 2px 10px; text-transform: capitalize; }
    .banner { display: flex; flex-direction: row; gap: 12px; padding: 12px; margin-bottom: 16px; background: var(--mat-sys-tertiary-container); }
    .grow { flex: 1; } .grid { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 20px; }
    aside { display: flex; flex-direction: column; gap: 16px; }
    .report { padding: 12px 4px; border-bottom: 1px solid var(--mat-sys-outline-variant); } .report.alert { background: color-mix(in srgb, var(--mat-sys-error) 5%, transparent); }
    .desc { margin-top: 4px; } .crit { color: #b3261e; font-weight: 700; }
    .cmp { border-collapse: collapse; margin: 8px 0; } .cmp td, .cmp th { padding: 2px 10px; text-align: right; } .cmp td:first-child { text-align: left; }
    .cmp tr.diff { background: #fde7e4; font-weight: 600; }
    .event { padding: 6px 0; } .when, .who { color: var(--mat-sys-on-surface-variant); font-size: 12px; }
    .chat { max-height: 420px; overflow: auto; display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
    .msg { padding: 6px 10px; border-radius: 10px; background: var(--mat-sys-surface-container); max-width: 80%; } .msg.mine { align-self: flex-end; background: var(--mat-sys-primary-container); }
    .send { display: flex; gap: 8px; align-items: center; } .row { display: flex; } .empty { padding: 0 16px; color: var(--mat-sys-on-surface-variant); }
    pre { white-space: pre-wrap; font-size: 12px; }
  `,
})
export class CaseDetailPage implements OnDestroy {
  id = input.required<string>();
  api = inject(Api);
  private ui = inject(Ui);
  private callsSvc = inject(Calls);
  label = label;
  sevColor = SEVERITY_COLOR;
  me = computed(() => this.api.me()?.id);

  c = signal<(CaseRow & { merged_into: string | null }) | null>(null);
  incidents = signal<any[]>([]);
  alerts = signal<any[]>([]);
  events = signal<any[]>([]);
  suggestions = signal<any[]>([]);
  related = signal<Record<string, string>>({});
  messages = signal<any[]>([]);
  people = signal<Person[]>([]);
  contacts = signal<Contact[]>([]);
  staff = signal<any[]>([]);
  mergeTargets = signal<CaseRow[]>([]);
  liveRequest = signal<any | null>(null);
  categories = signal<Record<string, string>>({});
  channelId = signal<string | null>(null);
  draft = '';
  openSuggestions = computed(() => this.suggestions().filter((s) => s.status === 'open'));
  private stopLive: () => void = () => undefined;
  private unfollow: () => void = () => undefined;

  constructor() {
    this.categories.set(Object.fromEntries(this.api.categories().map((x) => [x.code, x.label])));
    void this.api.get('/people/room-staff').then((s) => this.staff.set(s)).catch(() => {});
    effect(() => { const id = this.id(); void this.load(id); this.subscribe(id); });
  }

  ngOnDestroy() { this.stopLive(); this.unfollow(); }

  /** Live: this case, its timeline, its conversation and its live-view request. */
  private subscribe(id: string) {
    this.stopLive(); this.unfollow();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const reload = () => { pending ??= setTimeout(() => { pending = null; void this.load(id); }, 300); };
    const unCase = this.api.follow({ case: id });
    let unChannel = () => {};
    this.unfollow = () => { unCase(); unChannel(); };
    this.stopLive = this.api.onChange((c) => {
      if (c.t === 'messages' && c.channel_id === this.channelId()) void this.loadMessages();
      else if ((c.t === 'cases' && c.id === id) || (c.t !== 'cases' && c.case_id === id)) reload();
    }, ['cases', 'case_events', 'messages', 'live_view_requests']);
    this.followChannel = (ch: string) => { unChannel(); unChannel = this.api.follow({ channel: ch }); };
  }
  private followChannel: (ch: string) => void = () => {};

  async load(id: string) {
    let d: any;
    try { d = await this.api.get<any>(`/cases/${id}`); } catch (e) { this.ui.error(e); return; }
    this.c.set(d.case);
    this.incidents.set(d.incidents); this.alerts.set(d.alerts); this.events.set(d.events);
    this.suggestions.set(d.suggestions); this.liveRequest.set(d.liveView);
    this.related.set(Object.fromEntries(d.suggestions.map((s: any) => [s.related_case_id, s.related_title ?? 'case'])));
    if (d.channelId && d.channelId !== this.channelId()) this.followChannel(d.channelId);
    this.channelId.set(d.channelId);
    this.messages.set(d.messages);
    this.latestResult = d.latestResult;
    // People to call: reporters first, then people at the unit, then coordinators from the nearest level up
    const reporters = d.incidents.map((i: any) => i.volunteer).filter((v: any) => v?.id) as Person[];
    const coords = (d.people as Person[]).filter((p) => p.role === 'coordinator').sort((a, b) => b.area_code.length - a.area_code.length);
    const unit = (d.people as Person[]).filter((p) => p.role !== 'coordinator');
    const seen = new Set<string>();
    this.people.set([...reporters, ...unit, ...coords].filter((p) => !seen.has(p.id) && seen.add(p.id)));
    const rank: Record<string, number> = { verified: 0, call_tested: 1, stale: 2, pending: 3 };
    this.contacts.set((d.contacts as Contact[]).filter((k) => k.status !== 'draft')
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.area_code.length - a.area_code.length));
    this.mergeTargets.set(d.mergeTargets);
  }
  private latestResult: { id: string; version: number } | null = null;

  private async loadMessages() {
    const ch = this.channelId();
    if (ch) this.messages.set((await this.api.get<any>(`/channels/${ch}`).catch(() => ({ messages: this.messages() }))).messages);
  }

  catLabel(code: string) { return this.categories()[code] ?? label(code); }
  relatedTitle(id: string) { return this.related()[id] ?? 'case'; }
  staffName(id: string) { return this.staff().find((s) => s.id === id)?.full_name ?? 'System'; }
  personName(id: string | null) { return id === this.me() ? 'You' : this.people().find((p) => p.id === id)?.full_name ?? this.staffName(id ?? ''); }
  figureKeys(d: any) { return ['registered', 'accredited', 'rejected', 'totalValid', ...Object.keys({ ...d.agent.votes, ...d.irev.votes }).map((p) => `votes.${p}`)]; }
  fig(f: any, k: string) { return k.startsWith('votes.') ? f.votes?.[k.slice(6)] ?? 0 : f[k]; }

  /** A case action: POST /cases/:id/<action>. */
  async act(action: string, body: Record<string, unknown>, ok: string) {
    await this.ui.run(() => this.api.post(`/cases/${this.id()}/${action}`, body), ok);
    await this.load(this.id());
  }
  async takeOver() {
    if (this.api.isSupervisor()) await this.act('reassign', { to: this.me() }, 'Assigned to you');
    else {
      const c = this.c()!;
      const r = await this.ui.run(() => this.api.post<{ caseId: string | null }>('/cases/next', { queueId: c.queue_id ?? undefined }));
      if (r?.caseId && r.caseId !== c.id) this.ui.toast('You were given the next case in the queue instead; it has higher priority.');
      await this.load(this.id());
    }
  }
  async note() { const b = await this.ui.prompt('Add note', 'Note', { multiline: true }); if (b) await this.act('notes', { text: b }, 'Note added'); }
  async resolve() { const b = await this.ui.prompt('Resolve case', 'Outcome', { multiline: true, okLabel: 'Resolve' }); if (b) await this.act('resolve', { text: b }, 'Resolved'); }
  async escalate() { const b = await this.ui.prompt('Escalate to national room', 'Reason', { okLabel: 'Escalate' }); if (b) await this.act('escalate', { text: b }, 'Escalated'); }
  async reopen() { const b = await this.ui.prompt('Reopen case', 'Reason'); if (b) await this.act('reopen', { text: b }, 'Reopened'); }
  async changeSeverity(s: string) { const b = await this.ui.prompt(`Change severity to ${s}`, 'Reason'); if (b) await this.act('severity', { severity: s, reason: b }, 'Severity changed'); }
  async mergeInto(t: CaseRow) {
    if (!(await this.ui.confirm('Merge cases', `Move all reports of this case into "${t.what ?? t.title}${t.where ? ' at ' + (placeLine(t.where, false) || t.where.code) : ''}"? You can undo this later.`, 'Merge'))) return;
    await this.ui.run(() => this.api.post(`/cases/${this.id()}/merge`, { target: t.id }), 'Merged');
    await this.load(this.id());
  }
  async decide(id: string, accept: boolean) {
    await this.ui.run(() => this.api.post(`/case-suggestions/${id}/decide`, { accept }), accept ? 'Linked' : 'Dismissed');
    await this.load(this.id());
  }
  async task(p: Person) {
    const b = await this.ui.prompt(`Task for ${p.full_name}`, 'What should they do?', { multiline: true, okLabel: 'Send' });
    if (b) await this.ui.run(() => this.api.post(`/cases/${this.id()}/tasks`, { to: p.id, text: b }), 'Task sent by app and SMS');
  }
  async liveView(p: Person) {
    const r = await this.ui.run(() => this.api.post<{ requestId: string }>(`/cases/${this.id()}/live-view`, { agentId: p.id }), `Live view requested from ${p.full_name}`);
    if (r) this.liveRequest.set({ id: r.requestId, status: 'requested' });
  }
  call(p: Person) { void this.callsSvc.call('volunteer', p.id, p.full_name, this.id()); }
  place(w: any, withParents = true) { return placeLine(w, withParents); }
  callContact(k: Contact) { void this.callsSvc.call('contact', k.id, `${k.agency} ${k.title}`, this.id()); }
  async send() {
    const ch = this.channelId(); const body = this.draft.trim();
    if (!ch || !body) return;
    this.draft = '';
    try { await this.api.post(`/channels/${ch}/messages`, { body, clientId: crypto.randomUUID() }); await this.loadMessages(); }
    catch (e) { this.draft = body; this.ui.error(e); }
  }
  async openMedia(body: Record<string, unknown>) {
    const url = await this.ui.run(() => this.api.viewUrl(body));
    if (url) window.open(url, '_blank', 'noopener');
  }
  async openSheets(a: any) {
    const c = this.c()!;
    if (this.latestResult) await this.openMedia({ kind: 'ec8a', id: this.latestResult.id });
    await this.openMedia({ kind: 'irev', electionId: a.election_id, pu: c.pu_code });
  }
}
