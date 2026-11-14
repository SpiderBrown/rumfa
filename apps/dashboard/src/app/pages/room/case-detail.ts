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
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Supa } from '../../core/supabase';
import { Calls } from '../../core/calls';
import { AgoPipe, SEVERITY_COLOR, Ui, label } from '../../core/ui';
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
    <h1>{{ c.title }}</h1>
  </div>
  <div class="meta">
    {{ label(c.status) }} · {{ c.report_count }} reports from {{ c.reporter_count }} people · opened {{ c.created_at | ago }}
    @if (c.status === 'assigned') { · acknowledge {{ c.ack_due_at | ago }} } @else if (!['resolved','closed','merged'].includes(c.status)) { · due {{ c.due_at | ago }} }
    @if (c.merged_into) { · merged into <a [routerLink]="['/room/case', c.merged_into]">another case</a> }
  </div>

  <div class="actions">
    @if (c.status === 'assigned' && c.assigned_to === me()) { <button mat-flat-button (click)="act('acknowledge_case', {}, 'Acknowledged')">Acknowledge</button> }
    @if (['queued','escalated'].includes(c.status) || (c.status === 'assigned' && c.assigned_to !== me())) {
      <button mat-flat-button (click)="takeOver()">Take this case</button> }
    @if (['assigned','in_progress','escalated'].includes(c.status)) {
      <button mat-stroked-button (click)="note()">Add note</button>
      <button mat-stroked-button (click)="resolve()">Resolve</button>
      <button mat-stroked-button (click)="escalate()">Escalate</button>
    }
    @if (c.status === 'resolved' && supa.isSupervisor()) { <button mat-flat-button (click)="act('close_case', {}, 'Case closed')">Confirm close</button> }
    @if (['resolved','closed'].includes(c.status)) { <button mat-stroked-button (click)="reopen()">Reopen</button> }
    @if (supa.isSupervisor() && !['closed','merged'].includes(c.status)) {
      <button mat-stroked-button [matMenuTriggerFor]="sup">Supervisor <mat-icon iconPositionEnd>expand_more</mat-icon></button>
      <mat-menu #sup>
        <button mat-menu-item [matMenuTriggerFor]="assign">Reassign to…</button>
        <button mat-menu-item [matMenuTriggerFor]="sev">Change severity…</button>
        <button mat-menu-item [matMenuTriggerFor]="merge">Merge into…</button>
      </mat-menu>
      <mat-menu #assign>@for (s of staff(); track s.id) {
        <button mat-menu-item (click)="act('reassign_case', { p_to: s.id }, 'Reassigned')">{{ s.full_name }} · {{ s.status }} · {{ s.open_cases }} open</button> }</mat-menu>
      <mat-menu #sev>@for (s of ['critical','high','medium','low']; track s) {
        <button mat-menu-item (click)="changeSeverity(s)">{{ label(s) }}</button> }</mat-menu>
      <mat-menu #merge>@for (o of mergeTargets(); track o.id) {
        <button mat-menu-item (click)="mergeInto(o)">{{ o.title }} ({{ o.report_count }} reports)</button> }
        @empty { <button mat-menu-item disabled>No open cases nearby</button> }</mat-menu>
    }
  </div>

  @if (openSuggestions().length && supa.isSupervisor()) {
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
              <div>{{ i.volunteers?.full_name }} ({{ label(i.volunteers?.role) }}) at {{ i.pu_code }}</div>
              @if (i.description) { <div class="desc">{{ i.description }}</div> }
              @for (m of i.media_paths; track $index) { <button mat-button (click)="openMedia({ kind: 'incident', incident_id: i.id, index: $index })"><mat-icon>image</mat-icon> Photo {{ $index + 1 }}</button> }
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
              <div class="msg" [class.mine]="m.sender_id === me()"><span class="who">{{ personName(m.sender_id) }}</span> {{ m.body }}
                @if (m.media_path) { <button mat-button (click)="openMedia({ kind: 'message', message_id: m.id })">{{ m.kind }}</button> }
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
            @if (lv.status === 'clip_uploaded') { <button mat-flat-button (click)="openMedia({ kind: 'live', request_id: lv.id })">Play clip</button> }
            @if (lv.status === 'declined') { <p>The agent declined. Call them instead.</p> }
          </mat-card-content>
        </mat-card>
      }
    </aside>
  </div>
  }`,
  styles: `
    .back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; color: var(--mat-sys-primary); }
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
  supa = inject(Supa);
  private ui = inject(Ui);
  private callsSvc = inject(Calls);
  label = label;
  sevColor = SEVERITY_COLOR;
  me = computed(() => this.supa.me()?.id);

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
  private rt?: RealtimeChannel;

  constructor() {
    void this.supa.client.from('incident_categories').select('code, label').then(({ data }) =>
      this.categories.set(Object.fromEntries((data ?? []).map((x) => [x.code, x.label]))));
    void this.supa.rpc('room_staff').then((s) => this.staff.set(s)).catch(() => {});
    effect(() => { const id = this.id(); void this.load(id); this.subscribe(id); });
  }

  ngOnDestroy() { if (this.rt) void this.supa.client.removeChannel(this.rt); }

  private subscribe(id: string) {
    if (this.rt) void this.supa.client.removeChannel(this.rt);
    this.rt = this.supa.client.channel(`case-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases', filter: `id=eq.${id}` }, () => void this.load(id))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'case_events', filter: `case_id=eq.${id}` }, () => void this.load(id))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
        if ((p.new as any).channel_id === this.channelId()) this.messages.set([...this.messages(), p.new]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_view_requests', filter: `case_id=eq.${id}` }, (p) => this.liveRequest.set(p.new))
      .subscribe();
  }

  async load(id: string) {
    const db = this.supa.client;
    const { data: c } = await db.from('cases').select('*').eq('id', id).maybeSingle();
    if (!c) { this.ui.error('Case not found or not in your area'); return; }
    this.c.set(c);
    const [inc, al, ev, sg, ch, lv] = await Promise.all([
      db.from('incidents').select('*, volunteers(id, full_name, phone, role, level, area_code)').eq('case_id', id).order('reported_at'),
      db.from('alerts').select('*').eq('case_id', id).order('created_at'),
      db.from('case_events').select('*').eq('case_id', id).order('at', { ascending: false }),
      db.from('case_suggestions').select('*').eq('case_id', id),
      db.from('channels').select('id').eq('case_id', id).maybeSingle(),
      db.from('live_view_requests').select('*').eq('case_id', id).order('created_at', { ascending: false }).limit(1),
    ]);
    this.incidents.set(inc.data ?? []); this.alerts.set(al.data ?? []); this.events.set(ev.data ?? []);
    this.suggestions.set(sg.data ?? []); this.liveRequest.set(lv.data?.[0] ?? null);
    this.channelId.set(ch.data?.id ?? null);
    if (ch.data) {
      const { data: msgs } = await db.from('messages').select('*').eq('channel_id', ch.data.id).order('created_at');
      this.messages.set(msgs ?? []);
    }
    const relIds = (sg.data ?? []).map((s) => s.related_case_id);
    if (relIds.length) {
      const { data } = await db.from('cases').select('id, title').in('id', relIds);
      this.related.set(Object.fromEntries((data ?? []).map((r) => [r.id, r.title])));
    }
    await this.loadPeople(c);
  }

  private async loadPeople(c: CaseRow) {
    const db = this.supa.client;
    const area = c.pu_code ?? c.area_code;
    const chain = [area.slice(0, 2), area.slice(0, 5), area.slice(0, 8)].filter((x, i, a) => x.length >= 2 && a.indexOf(x) === i);
    const reporters = this.incidents().map((i) => i.volunteers).filter(Boolean) as Person[];
    const [coords, unitPeople, k, targets] = await Promise.all([
      db.from('volunteers').select('id, full_name, phone, role, level, area_code, deputy_of').eq('role', 'coordinator').in('area_code', chain).eq('status', 'active'),
      c.pu_code ? db.from('volunteers').select('id, full_name, phone, role, level, area_code').eq('area_code', c.pu_code).eq('status', 'active') : Promise.resolve({ data: [] as Person[] }),
      db.from('authority_contacts').select('id, agency, title, person_name, level, area_code, status, source_type, last_call_ok_at')
        .in('area_code', [...chain, 'NG']).not('status', 'in', '(rejected,draft)'),
      db.from('cases').select('*').eq('category', c.category).neq('id', c.id).in('status', ['queued', 'assigned', 'in_progress', 'escalated'])
        .like('area_code', `${area.slice(0, 5)}%`).limit(20),
    ]);
    const seen = new Set<string>();
    const ordered = [...reporters, ...(unitPeople.data ?? []), ...((coords.data ?? []) as Person[]).sort((a, b) => b.area_code.length - a.area_code.length)];
    this.people.set(ordered.filter((p) => !seen.has(p.id) && seen.add(p.id)));
    const rank: Record<string, number> = { verified: 0, call_tested: 1, stale: 2, pending: 3 };
    this.contacts.set(((k.data ?? []) as Contact[]).sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.area_code.length - a.area_code.length));
    this.mergeTargets.set((targets.data ?? []) as CaseRow[]);
  }

  catLabel(code: string) { return this.categories()[code] ?? label(code); }
  relatedTitle(id: string) { return this.related()[id] ?? 'case'; }
  staffName(id: string) { return this.staff().find((s) => s.id === id)?.full_name ?? 'System'; }
  personName(id: string | null) { return id === this.me() ? 'You' : this.people().find((p) => p.id === id)?.full_name ?? this.staffName(id ?? ''); }
  figureKeys(d: any) { return ['registered', 'accredited', 'rejected', 'totalValid', ...Object.keys({ ...d.agent.votes, ...d.irev.votes }).map((p) => `votes.${p}`)]; }
  fig(f: any, k: string) { return k.startsWith('votes.') ? f.votes?.[k.slice(6)] ?? 0 : f[k]; }

  async act(fn: string, args: Record<string, unknown>, ok: string) {
    await this.ui.run(() => this.supa.rpc(fn, { p_case: this.id(), ...args }), ok);
    await this.load(this.id());
  }
  async takeOver() {
    if (this.supa.isSupervisor()) await this.act('reassign_case', { p_to: this.me() }, 'Assigned to you');
    else {
      const c = this.c()!;
      const id = await this.ui.run(() => this.supa.rpc<string | null>('take_next_case', { p_queue: c.queue_id }));
      if (id && id !== c.id) this.ui.toast('You were given the next case in the queue instead; it has higher priority.');
      await this.load(this.id());
    }
  }
  async note() { const b = await this.ui.prompt('Add note', 'Note', { multiline: true }); if (b) await this.act('add_case_note', { p_body: b }, 'Note added'); }
  async resolve() { const b = await this.ui.prompt('Resolve case', 'Outcome', { multiline: true, okLabel: 'Resolve' }); if (b) await this.act('resolve_case', { p_outcome: b }, 'Resolved'); }
  async escalate() { const b = await this.ui.prompt('Escalate to national room', 'Reason', { okLabel: 'Escalate' }); if (b) await this.act('escalate_case', { p_reason: b }, 'Escalated'); }
  async reopen() { const b = await this.ui.prompt('Reopen case', 'Reason'); if (b) await this.act('reopen_case', { p_reason: b }, 'Reopened'); }
  async changeSeverity(s: string) { const b = await this.ui.prompt(`Change severity to ${s}`, 'Reason'); if (b) await this.act('change_case_severity', { p_severity: s, p_reason: b }, 'Severity changed'); }
  async mergeInto(t: CaseRow) {
    if (!(await this.ui.confirm('Merge cases', `Move all reports of this case into "${t.title}"? You can undo this later.`, 'Merge'))) return;
    await this.ui.run(() => this.supa.rpc('merge_cases', { p_source: this.id(), p_target: t.id }), 'Merged');
    await this.load(this.id());
  }
  async decide(id: string, accept: boolean) {
    await this.ui.run(() => this.supa.rpc('decide_suggestion', { p_suggestion: id, p_accept: accept }), accept ? 'Linked' : 'Dismissed');
    await this.load(this.id());
  }
  async task(p: Person) {
    const b = await this.ui.prompt(`Task for ${p.full_name}`, 'What should they do?', { multiline: true, okLabel: 'Send' });
    if (b) await this.ui.run(() => this.supa.rpc('send_case_task', { p_case: this.id(), p_to: p.id, p_body: b }), 'Task sent by app and SMS');
  }
  async liveView(p: Person) {
    const id = await this.ui.run(() => this.supa.rpc<string>('request_live_view', { p_case: this.id(), p_agent: p.id }), `Live view requested from ${p.full_name}`);
    if (id) this.liveRequest.set({ id, status: 'requested' });
  }
  call(p: Person) { void this.callsSvc.call('volunteer', p.id, p.full_name, this.id()); }
  callContact(k: Contact) { void this.callsSvc.call('contact', k.id, `${k.agency} ${k.title}`, this.id()); }
  async send() {
    const ch = this.channelId(); const body = this.draft.trim();
    if (!ch || !body) return;
    this.draft = '';
    const { error } = await this.supa.client.from('messages').insert({ tenant_id: this.supa.me()!.tenant_id, channel_id: ch, sender_id: this.me(), body, client_id: crypto.randomUUID() });
    if (error) this.ui.error(error.message);
  }
  async openMedia(body: Record<string, unknown>) {
    const url = await this.ui.run(() => this.supa.signedUrl(body));
    if (url) window.open(url, '_blank', 'noopener');
  }
  async openSheets(a: any) {
    const c = this.c()!;
    const { data: sub } = await this.supa.client.from('result_submissions').select('id').eq('pu_code', c.pu_code!).order('version', { ascending: false }).limit(1);
    if (sub?.[0]) await this.openMedia({ kind: 'ec8a', submission_id: sub[0].id });
    await this.openMedia({ kind: 'irev', election_id: a.election_id, pu_code: c.pu_code });
  }
}
