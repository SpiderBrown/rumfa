import { Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../../core/api';
import { Calls } from '../../core/calls';
import { AgoPipe, Ui, label, minutesText, placeLine, reportsLine } from '../../core/ui';
import { kindOf } from '../../core/queues';
import { LiveViewer } from './live-viewer';
import { MediaItem, MediaThumb, MediaViewer, mediaType } from '../../core/media';
import type { CaseRow } from './queue';

interface Person { id: string; full_name: string; phone: string; role: string; level: string; area_code: string; deputy_of?: string | null }
interface Contact { id: string; agency: string; title: string; person_name: string | null; level: string; area_code: string; status: string; source_type: string; last_call_ok_at: string | null }
type Detail = CaseRow & { merged_into: string | null; queue_name?: string; queue_kind?: string; top_room?: string | null; at_top?: boolean; registered?: number | null };
/** One line of the case's story: a report, an automatic check, something someone did, or a message */
interface Entry { at: string; kind: 'report' | 'alert' | 'event' | 'message'; who: string; initials: string; tone: string; what: string; body?: string | null; data: any }
type Tab = 'timeline' | 'messages' | 'people' | 'live';

const ROLE_TONE: Record<string, string> = { agent: '#1f4e8c', volunteer: '#1f4e8c', coordinator: '#5b3fa8' };
const HIDDEN_EVENTS = ['report_merged', 'created'];

/**
 * A case: what happened and where, how long is left and where it goes next, who is on it and who could be sent,
 * the photos and videos, and its whole story in one timeline, with the message box always at the bottom.
 * Shown beside the list in the situation room (embedded) or on its own.
 */
@Component({
  selector: 'app-case-detail',
  imports: [RouterLink, FormsModule, DatePipe, DecimalPipe, JsonPipe, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, AgoPipe, LiveViewer, MediaThumb],
  template: `
  @if (c(); as c) {
  <div class="wrap" [class.embedded]="embedded()">
  @if (!embedded()) { <a routerLink="/room" class="back"><mat-icon>arrow_back</mat-icon> Situation room</a> }

  <!-- What, where, how long is left, and the actions -->
  <section class="card head" aria-label="The case">
    <div class="row1">
      <span class="r-pill" [class]="c.severity">{{ sevName(c.severity) }}</span>
      @if (c.queue_name) { <span class="qpill"><span class="dot" [style.background]="queueColour()"></span>{{ c.queue_name }}</span> }
      <span class="spill" [class]="'spill ' + c.status">{{ statusName(c) }}</span>
      <span class="grow"></span>
      @if (countdown(); as cd) {
        <span class="due" [class.late]="cd.late"><mat-icon aria-hidden="true">timer</mat-icon>{{ cd.text }}</span>
        @if (cd.next) { <span class="muted sm">· {{ cd.next }}</span> }
      }
    </div>
    <h2 class="title">{{ c.what ?? c.title }}@if (c.where && c.where.level === 'pu') { at {{ c.where.name }} }</h2>
    <div class="where">
      @if (c.where) { {{ c.where.level === 'pu' ? c.where.parents.join(' · ') : place(c.where) }} · <span class="code">{{ c.where.code }}</span> }
      @if (c.registered) { <span class="muted">({{ c.registered | number }} registered)</span> }
      <span class="muted">· {{ reportsLine(c.report_count, c.reporter_count, alerts().length) }} · opened {{ c.created_at | ago }}</span>
      @if (c.merged_into) { · merged into <a [routerLink]="['/room/case', c.merged_into]">another case</a> }
    </div>

    <div class="actions">
      @if (c.status === 'assigned' && c.assigned_to === me()) { <button mat-flat-button (click)="act('acknowledge', {}, 'Acknowledged')"><mat-icon>check</mat-icon> Acknowledge</button> }
      @if (['queued','escalated'].includes(c.status) || (c.status === 'assigned' && c.assigned_to !== me())) {
        <button mat-flat-button (click)="takeOver()"><mat-icon>pan_tool</mat-icon> Take this case</button> }
      @if (reporter(); as r) {
        <button mat-stroked-button (click)="call(r)"><mat-icon>call</mat-icon> Call {{ first(r.full_name) }}</button>
        @if ((r.role === 'agent' || r.role === 'volunteer') && api.addons().liveVideo) { <button mat-stroked-button (click)="liveView(r)"><mat-icon>videocam</mat-icon> Ask for live video</button> }
      }
      @if (open(c)) {
        @if (!c.at_top) { <button mat-stroked-button (click)="escalate()"><mat-icon>trending_up</mat-icon> Escalate</button> }
        <button mat-stroked-button (click)="note()"><mat-icon>edit_note</mat-icon> Add note</button>
        @if (['assigned','in_progress','escalated'].includes(c.status)) { <button mat-flat-button class="ok" (click)="resolve()"><mat-icon>task_alt</mat-icon> Resolve</button> }
      }
      @if (c.status === 'resolved' && api.isSupervisor()) { <button mat-flat-button (click)="act('close', {}, 'Case closed')">Confirm close</button> }
      @if (['resolved','closed'].includes(c.status)) { <button mat-stroked-button (click)="reopen()">Reopen</button> }
      @if (api.isSupervisor() && !['closed','merged'].includes(c.status)) {
        <button mat-button [matMenuTriggerFor]="sup">Supervisor <mat-icon iconPositionEnd>expand_more</mat-icon></button>
        <mat-menu #sup>
          <button mat-menu-item [matMenuTriggerFor]="sev">Change severity…</button>
          <button mat-menu-item [matMenuTriggerFor]="merge">Merge into…</button>
        </mat-menu>
        <mat-menu #sev>@for (s of ['critical','high','medium','low']; track s) {
          <button mat-menu-item (click)="changeSeverity(s)">{{ sevName(s) }}</button> }</mat-menu>
        <mat-menu #merge>@for (o of mergeTargets(); track o.id) {
          <button mat-menu-item (click)="mergeInto(o)">{{ o.what ?? o.title }} · {{ place(o.where, false) || o.pu_code || o.area_code }} ({{ o.report_count }} reports)</button> }
          @empty { <button mat-menu-item disabled>No open cases nearby</button> }</mat-menu>
      }
    </div>

    <!-- Who is on it, and who could be sent -->
    <div class="owner">
      <div class="o-who">
        @if (c.assigned_to) {
          <span class="av" [style.background]="'var(--r-accent)'">{{ initials(staffName(c.assigned_to)) }}</span>
          <div><b>{{ c.assigned_to === me() ? 'You' : staffName(c.assigned_to) }}</b><div class="muted xs">{{ tookLine(c) }}</div></div>
        } @else {
          <span class="av none"><mat-icon>person_off</mat-icon></span><div><b>Nobody on it yet</b><div class="muted xs">Take it, or a supervisor assigns it</div></div>
        }
      </div>
      <div class="send">
        <span class="muted xs b">Send someone:</span>
        @for (p of nearest(); track p.id) {
          <button class="chip r-focus" [matMenuTriggerFor]="pm"><mat-icon>person_pin_circle</mat-icon>{{ short(p.full_name) }} · {{ coordWord(p) }}</button>
          <mat-menu #pm>
            <button mat-menu-item (click)="call(p)"><mat-icon>call</mat-icon> Call</button>
            <button mat-menu-item (click)="task(p)"><mat-icon>assignment</mat-icon> Send a task (app and SMS)</button>
          </mat-menu>
        }
        @if (contacts()[0]; as k) {
          <button class="chip r-focus" (click)="callContact(k)" [matTooltip]="'Call ' + k.agency + ' ' + k.title"><mat-icon>shield</mat-icon>{{ k.title }}</button>
        }
        @if (!nearest().length && !contacts().length) { <span class="muted xs">No coordinator or contact for this area yet</span> }
        @if (api.isSupervisor() && open(c)) {
          <button mat-flat-button [matMenuTriggerFor]="assign"><mat-icon>assignment_ind</mat-icon> Assign</button>
          <mat-menu #assign>@for (s of staff(); track s.id) {
            <button mat-menu-item (click)="act('reassign', { to: s.id }, 'Assigned to ' + s.full_name)">{{ s.full_name }} · {{ label(s.status) }} · {{ s.open_cases }} open</button> }</mat-menu>
        }
      </div>
    </div>
  </section>

  @if (openSuggestions().length && api.isSupervisor()) {
    <section class="card banner" aria-label="Possibly related">
      <mat-icon>link</mat-icon>
      <div class="grow">
        @for (s of openSuggestions(); track s.id) {
          <div>Possibly related: <a [routerLink]="['/room/case', s.related_case_id]">{{ relatedTitle(s.related_case_id) }}</a>
            ({{ s.reason === 'same_ward_category' ? 'same problem in the same ward' : 'related problem at the same unit' }})
            <button mat-button (click)="decide(s.id, true)">Link as one incident</button>
            <button mat-button (click)="decide(s.id, false)">Not related</button></div>
        }
      </div>
    </section>
  }

  <!-- Photos and videos -->
  @if (evidence().length) {
    <section class="card ev" aria-label="Photos and videos">
      <div class="ev-h"><h3>Evidence <span class="muted">· {{ evidenceLine() }}</span></h3><span class="grow"></span>
        <button mat-button (click)="viewer.open(evidence())"><mat-icon>fullscreen</mat-icon> View all</button></div>
      <div class="ev-grid" [class.one]="evidence().length === 1">
        @for (e of evidence().slice(0, 5); track e.key; let i = $index) {
          <app-media-thumb [class.big]="i === 0" [items]="evidence()" [index]="i" [size]="i === 0 ? 400 : 190" [height]="i === 0 ? 250 : 120" />
        }
        @if (evidence().length > 5) { <button class="more r-focus" (click)="viewer.open(evidence(), 5)">+{{ evidence().length - 5 }} more</button> }
        @else if (reporter(); as r) {
          <button class="ask r-focus" (click)="askMore(r)"><mat-icon>add_a_photo</mat-icon><span>Ask {{ first(r.full_name) }} for more photos</span></button>
        }
      </div>
    </section>
  }

  <!-- The story, messages, people to call, live video -->
  <section class="card story" aria-label="Timeline and messages">
    <div class="tabs" role="tablist">
      <button role="tab" [class.on]="tab() === 'timeline'" (click)="tab.set('timeline')">Timeline</button>
      <button role="tab" [class.on]="tab() === 'messages'" (click)="tab.set('messages')">Messages {{ messages().length || '' }}</button>
      <button role="tab" [class.on]="tab() === 'people'" (click)="tab.set('people')">People to call {{ people().length + contacts().length || '' }}</button>
      @if (api.addons().liveVideo || liveRequest()) { <button role="tab" [class.on]="tab() === 'live'" (click)="tab.set('live')">Live video @if (liveRequest()?.status === 'live') { <span class="livedot"></span> }</button> }
    </div>

    @switch (tab()) {
      @case ('timeline') {
        <div class="tl">
          @for (e of timeline(); track $index) {
            <div class="ent" [class.alert]="e.kind === 'alert'">
              <span class="t">{{ e.at | date: 'HH:mm' : '+0100' }}</span>
              <span class="av sm" [style.background]="e.tone">{{ e.initials }}</span>
              <div class="e-body">
                <div><b>{{ e.who }}</b> <span class="muted">· {{ e.what }}</span></div>
                @if (e.body) { <div class="txt">{{ e.body }}</div> }
                @if (e.kind === 'report' && e.data.media_paths?.length) {
                  <div class="thumbs">@for (m of e.data.media_paths; track $index) { <app-media-thumb [items]="evidence()" [index]="evIndex('incident', e.data.id, $index)" [size]="150" [height]="104" /> }</div>
                }
                @if (e.kind === 'message' && e.data.media_path) {
                  <div class="thumbs"><app-media-thumb [items]="evidence()" [index]="evIndex('message', e.data.id)" [size]="150" [height]="104" /></div>
                }
                @if (e.kind === 'alert' && e.data.details?.source === 'agent') {
                  <div class="txt"><b>{{ personName(e.data.details.reported_by) }}</b> checked IReV against the sheet they signed and says it's different@if (e.data.details.note) {: "{{ e.data.details.note }}"}.</div>
                  <button mat-stroked-button (click)="openSheets(e.data)"><mat-icon>compare</mat-icon> Open both sheets</button>
                } @else if (e.kind === 'alert') {
                  @if (e.data.details?.diff) { <div class="muted sm">Differs in: {{ e.data.details.diff.join(', ') }}</div> }
                  @if (e.data.details?.agent && e.data.details?.irev) {
                    <table class="cmp"><tr><th></th><th>Our EC8A</th><th>IReV</th></tr>
                      @for (k of figureKeys(e.data.details); track k) {
                        <tr [class.diff]="e.data.details.diff.includes(k)"><td>{{ k }}</td><td>{{ fig(e.data.details.agent, k) }}</td><td>{{ fig(e.data.details.irev, k) }}</td></tr> }
                    </table>
                    <button mat-stroked-button (click)="openSheets(e.data)"><mat-icon>compare</mat-icon> Open both sheets</button>
                  } @else if (!e.data.details?.diff) { <pre>{{ e.data.details | json }}</pre> }
                }
              </div>
            </div>
          } @empty { <p class="muted pad">Nothing yet.</p> }
        </div>
      }
      @case ('messages') {
        <div class="chat">
          @for (m of messages(); track m.id) {
            <div class="msg" [class.mine]="m.sender_id === me()"><span class="who">{{ m.sender_id === me() ? 'You' : (m.sender_name ?? personName(m.sender_id)) }}</span>
              @if (m.body) { <div>{{ m.body }}</div> }
              @if (m.media_path) { <div class="thumbs"><app-media-thumb [items]="evidence()" [index]="evIndex('message', m.id)" [size]="160" [height]="110" /></div> }
              <span class="when">{{ m.created_at | ago }}</span></div>
          } @empty { <p class="muted pad">No messages on this case yet. Everyone on the case and the reporter see what you write below.</p> }
        </div>
      }
      @case ('people') {
        <div class="plist">
          @for (p of people(); track p.id) {
            <div class="prow">
              <span class="av sm" [style.background]="tone(p.role)">{{ initials(p.full_name) }}</span>
              <div class="grow"><b>{{ p.full_name }}</b> @if (isReporter(p)) { <span class="tag">reported it</span> }
                <div class="muted xs">{{ label(p.role) }} · {{ p.level === 'pu' ? 'PU ' + p.area_code.slice(-3) : label(p.level) + ' ' + p.area_code }}{{ p.deputy_of ? ' · deputy' : '' }} · {{ p.phone }}</div></div>
              <button mat-icon-button matTooltip="Call" (click)="call(p)"><mat-icon>call</mat-icon></button>
              @if ((p.role === 'agent' || p.role === 'volunteer') && api.addons().liveVideo) { <button mat-icon-button matTooltip="Ask for live video" (click)="liveView(p)"><mat-icon>videocam</mat-icon></button> }
              @if (p.role === 'coordinator') { <button mat-icon-button matTooltip="Send a task" (click)="task(p)"><mat-icon>assignment</mat-icon></button> }
            </div>
          }
          <h4>Authority contacts</h4>
          @for (k of contacts(); track k.id) {
            <div class="prow">
              <span class="av sm" style="background:#3d4652"><mat-icon>shield</mat-icon></span>
              <div class="grow"><b>{{ k.agency }} · {{ k.title }}</b>
                <div class="muted xs">{{ k.person_name ?? '' }} {{ label(k.level) }} {{ k.area_code }} · {{ label(k.status) }} · {{ k.source_type }}
                  @if (k.last_call_ok_at) { · reached {{ k.last_call_ok_at | ago }} }</div></div>
              <button mat-icon-button matTooltip="Call" (click)="callContact(k)"><mat-icon>call</mat-icon></button>
            </div>
          } @empty { <p class="muted pad">No contacts for this area yet.</p> }
        </div>
      }
      @case ('live') {
        <div class="live">
          @if (liveRequest(); as lv) {
            <p><b>{{ label(lv.status) }}</b></p>
            @if (lv.status === 'live') { <app-live-viewer [requestId]="lv.id" /> }
            @if (lv.status === 'clip_uploaded') { <button mat-flat-button (click)="viewer.open([{ ref: { kind: 'live', id: lv.id }, type: 'video', caption: 'Clip from the live view' }])"><mat-icon>play_arrow</mat-icon> Play clip</button> }
            @if (lv.status === 'declined') { <p>They declined. Call them instead.</p> }
          } @else {
            <p class="muted">Ask someone at the unit to show you what is happening. Their phone streams video here; nothing is posted anywhere.</p>
          }
          <div class="lv-people" [hidden]="!api.addons().liveVideo">
            @for (p of fieldPeople(); track p.id) { <button mat-stroked-button (click)="liveView(p)"><mat-icon>videocam</mat-icon> Ask {{ first(p.full_name) }}</button> }
          </div>
        </div>
      }
    }

    <!-- Always here: a message to everyone on the case, or a note for the room only -->
    @if (channelId() || open(c)) {
      <div class="composer">
        <div class="r-seg small" role="radiogroup" aria-label="Write a">
          <button role="radio" [class.on]="mode() === 'message'" [attr.aria-checked]="mode() === 'message'" (click)="mode.set('message')" [disabled]="!channelId()">Message</button>
          <button role="radio" [class.on]="mode() === 'note'" [attr.aria-checked]="mode() === 'note'" (click)="mode.set('note')">Note</button>
        </div>
        <input [(ngModel)]="draft" (keydown.enter)="submit()" [placeholder]="mode() === 'note' ? 'A note for the room (the field doesn\\'t see it)…' : 'Message ' + (reporter() ? first(reporter()!.full_name) + ' and everyone on the case' : 'everyone on the case') + '…'" aria-label="Write" />
        @if (mode() === 'message') {
          <button mat-icon-button matTooltip="Attach a photo" (click)="file.click()" [disabled]="sending()"><mat-icon>attach_file</mat-icon></button>
          <input #file type="file" accept="image/*" hidden (change)="attach($event)" />
        }
        <button mat-flat-button (click)="submit()" [disabled]="!draft.trim() || sending()">{{ mode() === 'note' ? 'Add note' : 'Send' }}</button>
      </div>
    }
  </section>
  </div>
  }`,
  styles: `
    :host { display: block; container-type: inline-size; }
    .wrap { display: flex; flex-direction: column; gap: 14px; }
    .back { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; color: var(--r-accent); font-weight: 600; }
    .card { background: #fff; border: 1px solid var(--r-line); border-radius: var(--r-radius); }
    .head { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; }
    .row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
    .grow { flex: 1; min-width: 0; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; } .b { font-weight: 700; }
    .qpill, .spill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--r-line); border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 700; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .spill { border: 0; background: var(--r-medium-bg); color: var(--r-medium); }
    .spill.queued, .spill.escalated { background: var(--r-high-bg); color: #7a2e0b; }
    .spill.resolved, .spill.closed { background: #e3f4ea; color: #146c3a; } .spill.merged { background: var(--r-low-bg); color: var(--r-ink-2); }
    .due { display: inline-flex; align-items: center; gap: 4px; font-weight: 800; color: var(--r-ink-2); }
    .due mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .due.late { color: var(--r-urgent); }
    .title { margin: 4px 0 0; font-size: 22px; font-weight: 800; line-height: 1.25; letter-spacing: -.01em; }
    .where { font-size: 14px; color: var(--r-ink-2); }
    .code { font-size: 12.5px; color: var(--r-muted); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .actions .ok { --mdc-filled-button-container-color: var(--r-accent); }
    .owner { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 10px; padding: 10px 12px; border: 1px solid var(--r-line-soft); border-radius: 12px; background: #fafbfc; }
    .o-who { display: flex; align-items: center; gap: 10px; min-width: 200px; }
    .send { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1; justify-content: flex-end; }
    .chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--r-line); background: #fff; border-radius: 9px; padding: 6px 10px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--r-ink); }
    .chip mat-icon { font-size: 17px; width: 17px; height: 17px; color: var(--r-ink-2); }
    .chip:hover { border-color: #9aa6b6; }
    .av { width: 34px; height: 34px; border-radius: 50%; color: #fff; display: grid; place-items: center; font-size: 12.5px; font-weight: 800; flex: none; background: #1f4e8c; }
    .av.sm { width: 28px; height: 28px; font-size: 11px; } .av mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .av.none { background: var(--r-line); color: var(--r-ink-2); }
    .banner { display: flex; gap: 12px; padding: 12px 14px; background: #f3f7fb; }
    .ev { padding: 14px 16px; }
    .ev-h { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    h3 { margin: 0; font-size: 16px; font-weight: 800; } h3 .muted { font-weight: 600; }
    .ev-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; grid-auto-rows: 120px; gap: 10px; }
    .ev-grid.one { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
    .ev-grid .big { grid-row: span 2; }
    .ev-grid app-media-thumb { display: block; min-width: 0; }
    .ev-grid ::ng-deep .thumb { width: 100% !important; height: 100% !important; }
    .ask, .more { border: 1.5px dashed var(--r-line); background: #f7f8fa; border-radius: 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      font: inherit; font-size: 12.5px; font-weight: 700; color: var(--r-ink-2); cursor: pointer; text-align: center; padding: 8px; }
    .ask:hover, .more:hover { border-color: var(--r-accent); color: var(--r-accent-strong); }
    .story { overflow: hidden; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--r-line); padding: 0 12px; overflow-x: auto; }
    .tabs button { border: 0; background: none; padding: 13px 12px 11px; font: inherit; font-size: 14px; font-weight: 700; color: var(--r-muted); cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
    .tabs button.on { color: var(--r-ink); border-bottom-color: var(--r-accent); }
    .livedot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--r-urgent); margin-left: 4px; }
    .tl { padding: 6px 16px; max-height: 620px; overflow: auto; }
    .ent { display: grid; grid-template-columns: 46px 28px minmax(0, 1fr); gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--r-line-soft); }
    .ent:last-child { border-bottom: 0; }
    .ent.alert .e-body { background: #fff6f5; border-radius: 8px; padding: 6px 8px; }
    .t { font-size: 12.5px; color: var(--r-muted); padding-top: 5px; }
    .e-body { font-size: 14px; min-width: 0; }
    .txt { margin-top: 3px; }
    .thumbs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .cmp { border-collapse: collapse; margin: 8px 0; font-size: 13px; } .cmp td, .cmp th { padding: 2px 10px; text-align: right; } .cmp td:first-child { text-align: left; }
    .cmp tr.diff { background: #fde7e4; font-weight: 700; }
    pre { white-space: pre-wrap; font-size: 12px; }
    .chat { max-height: 520px; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; }
    .msg { padding: 8px 12px; border-radius: 12px; background: var(--r-ground); max-width: 80%; font-size: 14px; }
    .msg.mine { align-self: flex-end; background: #dff0ee; }
    .msg .who { font-size: 12px; font-weight: 700; color: var(--r-ink-2); display: block; }
    .msg .when { font-size: 11px; color: var(--r-muted); }
    .plist { padding: 6px 16px 12px; }
    .plist h4 { margin: 14px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--r-muted); }
    .prow { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--r-line-soft); }
    .tag { font-size: 11px; font-weight: 700; background: var(--r-medium-bg); color: var(--r-medium); border-radius: 999px; padding: 1px 7px; }
    .live { padding: 14px 16px; }
    .lv-people { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .pad { padding: 14px 0; margin: 0; }
    .composer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--r-line); background: #fafbfc; }
    .composer input:not([type=file]) { flex: 1; min-width: 0; border: 1px solid var(--r-line); border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 14px; background: #fff; }
    .composer input:focus { outline: 2px solid var(--r-accent); outline-offset: 0; }
    .r-seg.small button { padding: 5px 10px; font-size: 12.5px; }
    @container (max-width: 640px) { .ev-grid { grid-template-columns: 1fr 1fr; } .ev-grid .big { grid-column: span 2; grid-row: auto; } .send { justify-content: flex-start; } }
  `,
})
export class CaseDetailPage implements OnDestroy {
  id = input.required<string>();
  /** Shown beside the queue in the situation room (no back link) */
  embedded = input(false);
  api = inject(Api);
  private ui = inject(Ui);
  private callsSvc = inject(Calls);
  label = label;
  readonly reportsLine = reportsLine;
  me = computed(() => this.api.me()?.id);
  tab = signal<Tab>('timeline');
  mode = signal<'message' | 'note'>('message');
  sending = signal(false);
  private tick = signal(0);
  private timer = setInterval(() => this.tick.update((n) => n + 1), 1000);

  c = signal<Detail | null>(null);
  incidents = signal<any[]>([]);
  viewer = inject(MediaViewer);
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
  private latestResult: { id: string; version: number } | null = null;

  /** Every photo, video and voice note on the case: reports first (oldest first), then the chat */
  evidence = computed<(MediaItem & { key: string })[]>(() => {
    const out: (MediaItem & { key: string })[] = [];
    const when = (t: string) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    for (const i of [...this.incidents()].sort((a, b) => a.reported_at.localeCompare(b.reported_at))) {
      (i.media_paths ?? []).forEach((p: string, n: number) => out.push({
        key: `incident:${i.id}:${n}`, ref: { kind: 'incident', id: i.id, index: n }, type: mediaType(p),
        caption: `${when(i.reported_at)} · ${i.volunteer?.full_name ?? 'Agent'}`,
        meta: [{ label: 'Sent by', value: `${i.volunteer?.full_name ?? 'Agent'} (${label(i.volunteer?.role)})` },
          { label: 'Reported', value: when(i.reported_at) }, { label: 'Polling unit', value: i.pu_code },
          { label: 'Sent from', value: i.source === 'app' ? 'Agent app camera' : label(i.source) }],
      }));
    }
    for (const m of this.messages()) {
      if (!m.media_path) continue;
      const who = m.sender_id === this.me() ? 'You' : (m.sender_name ?? this.personName(m.sender_id));
      out.push({ key: `message:${m.id}`, ref: { kind: 'message', id: m.id }, type: mediaType(m.kind === 'photo' ? m.media_path : m.kind),
        caption: `Chat · ${who}${m.body ? ' · ' + m.body : ''}`,
        meta: [{ label: 'Sent by', value: who }, { label: 'Sent', value: when(m.created_at) }] });
    }
    return out;
  });
  evidenceLine = computed(() => {
    const n = (t: string) => this.evidence().filter((e) => e.type === t).length;
    return [[n('image'), 'photo'], [n('video'), 'video'], [n('audio'), 'voice note']].filter(([c]) => c)
      .map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`).join(' · ');
  });
  evIndex(kind: string, id: string, n?: number) { return Math.max(0, this.evidence().findIndex((e) => e.key === (kind === 'incident' ? `incident:${id}:${n}` : `message:${id}`))); }

  /** Whoever reported it first (a person, not an automatic check) */
  reporter = computed(() => [...this.incidents()].sort((a, b) => a.reported_at.localeCompare(b.reported_at)).map((i) => i.volunteer).find((v) => v?.id) as Person | undefined);
  /** The nearest coordinators up from the unit (ward first) */
  nearest = computed(() => this.people().filter((p) => p.role === 'coordinator' && !p.deputy_of).slice(0, 2));
  fieldPeople = computed(() => this.people().filter((p) => p.role === 'agent' || p.role === 'volunteer'));
  queueColour = computed(() => kindOf(this.c()?.queue_kind ?? '').colour);

  /** The case's story, oldest first: reports, automatic checks, what the room did, and messages */
  timeline = computed<Entry[]>(() => {
    const out: Entry[] = [];
    for (const i of this.incidents()) {
      const who = i.volunteer?.full_name ?? 'Agent';
      out.push({ at: i.reported_at, kind: 'report', who, initials: this.initials(who), tone: this.tone(i.volunteer?.role),
        what: `Reported ${this.catLabel(i.category).toLowerCase()}${i.is_sos ? ' (SOS)' : ''}${i.source !== 'app' ? ' by ' + label(i.source) : ''}`, body: i.description, data: i });
    }
    for (const a of this.alerts()) out.push({ at: a.created_at, kind: 'alert', who: 'Rumfa', initials: 'R', tone: '#9aa3ae', what: `Automatic check: ${this.catLabel(a.rule).toLowerCase()}`, data: a });
    for (const e of this.events()) {
      if (HIDDEN_EVENTS.includes(e.kind)) continue;
      const who = e.actor_id ? this.staffName(e.actor_id) : 'Rumfa';
      out.push({ at: e.at, kind: 'event', who, initials: this.initials(who), tone: e.actor_id ? 'var(--r-accent)' : '#9aa3ae', what: this.eventWords(e), body: e.body, data: e });
    }
    for (const m of this.messages()) {
      const who = m.sender_id === this.me() ? 'You' : (m.sender_name ?? this.personName(m.sender_id));
      out.push({ at: m.created_at, kind: 'message', who, initials: this.initials(who), tone: m.sender_id === this.me() ? 'var(--r-accent)' : '#1f4e8c',
        what: m.media_path ? 'Sent a photo' : 'Message', body: m.body, data: m });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  });

  /** "4:12 to resolve", then where it goes when time runs out */
  countdown = computed(() => {
    this.tick();
    const c = this.c();
    if (!c || !this.open(c)) return null;
    const d = c.status === 'assigned' ? c.ack_due_at : c.due_at;
    if (!d) return null;
    const ms = new Date(d).getTime() - Date.now();
    const verb = c.status === 'assigned' ? 'to acknowledge' : c.assigned_to ? 'to resolve' : 'to take';
    const at = new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
    const next = c.status === 'assigned' ? `goes to someone else at ${at}`
      : c.at_top || !c.top_room ? `supervisors alerted at ${at}` : `moves up to ${c.top_room} at ${at}`;
    if (ms < 0) return { text: `Over by ${minutesText(Math.round(-ms / 60_000))}`, late: true, next: '' };
    const m = Math.floor(ms / 60_000), s = Math.floor(ms / 1000) % 60;
    return { text: m >= 60 ? `${minutesText(m)} ${verb}` : `${m}:${String(s).padStart(2, '0')} ${verb}`, late: m < 2, next };
  });

  constructor() {
    this.categories.set(Object.fromEntries(this.api.categories().map((x) => [x.code, x.label])));
    void this.api.get('/people/room-staff').then((s) => this.staff.set(s as any[])).catch(() => {});
    effect(() => { const id = this.id(); this.tab.set('timeline'); void this.load(id); this.subscribe(id); });
  }

  ngOnDestroy() { this.stopLive(); this.unfollow(); clearInterval(this.timer); }

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
    if (!d.channelId) this.mode.set('note');
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

  private async loadMessages() {
    const ch = this.channelId();
    if (ch) this.messages.set((await this.api.get<any>(`/channels/${ch}`).catch(() => ({ messages: this.messages() }))).messages);
  }

  open(c: CaseRow) { return !['resolved', 'closed', 'merged'].includes(c.status); }
  sevName(s: string) { return ({ critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' } as Record<string, string>)[s] ?? label(s); }
  statusName(c: CaseRow) {
    return ({ queued: 'Waiting', assigned: 'Given, not taken yet', in_progress: 'In progress', escalated: 'Escalated', resolved: 'Resolved', closed: 'Closed', merged: 'Merged' } as Record<string, string>)[c.status] ?? label(c.status);
  }
  tookLine(c: CaseRow) {
    const e = this.events().filter((x) => ['assigned', 'acknowledged'].includes(x.kind)).sort((a, b) => b.at.localeCompare(a.at))[0];
    const at = e ? new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '';
    const s = this.staff().find((x) => x.id === c.assigned_to);
    return [s ? label(s.role) : '', c.status === 'assigned' ? `given at ${at}, not taken yet` : at ? `took it at ${at}` : ''].filter(Boolean).join(' · ');
  }
  eventWords(e: any) {
    const to = e.data?.to ? this.staffName(e.data.to) : null;
    return ({ assigned: to ? `Assigned it to ${to}` : 'Assigned it', acknowledged: 'Took the case', note: 'Added a note', resolved: 'Resolved it', closed: 'Closed it',
      reopened: 'Reopened it', escalated: 'Escalated it', moved: 'Moved it up', overdue: 'Out of time', severity_changed: 'Changed the severity', task_sent: 'Sent a task',
      call: 'Called', live_view: 'Asked for live video', suggestion: 'Found a possibly related case', merged: 'Merged a case into this one' } as Record<string, string>)[e.kind] ?? label(e.kind);
  }
  catLabel(code: string) { return this.categories()[code] ?? label(code); }
  relatedTitle(id: string) { return this.related()[id] ?? 'case'; }
  staffName(id: string) { return this.staff().find((s) => s.id === id)?.full_name ?? this.people().find((p) => p.id === id)?.full_name ?? 'Someone'; }
  personName(id: string | null) { return id === this.me() ? 'You' : this.people().find((p) => p.id === id)?.full_name ?? this.staffName(id ?? ''); }
  isReporter(p: Person) { return this.incidents().some((i) => i.volunteer?.id === p.id); }
  initials(n: string) { return n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  first(n: string) { return n.split(' ')[0]; }
  short(n: string) { const [a, b] = n.split(' '); return b ? `${a} ${b[0]}.` : a; }
  tone(role?: string) { return ROLE_TONE[role ?? ''] ?? '#3d4652'; }
  coordWord(p: Person) { return `${({ ward: 'ward', lga: 'LGA', state: 'state' } as Record<string, string>)[p.level] ?? ''} coord.`; }
  figureKeys(d: any) { return ['registered', 'accredited', 'rejected', 'totalValid', ...Object.keys({ ...d.agent.votes, ...d.irev.votes }).map((p) => `votes.${p}`)]; }
  fig(f: any, k: string) { return k.startsWith('votes.') ? f.votes?.[k.slice(6)] ?? 0 : f[k]; }
  place(w: any, withParents = true) { return placeLine(w, withParents); }

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
  async resolve() { const b = await this.ui.prompt('Resolve case', 'What was done', { multiline: true, okLabel: 'Resolve' }); if (b) await this.act('resolve', { text: b }, 'Resolved'); }
  async escalate() {
    const to = this.c()?.top_room ?? 'the next level up';
    const b = await this.ui.prompt(`Escalate to ${to}`, 'Reason', { okLabel: 'Escalate' });
    if (b) await this.act('escalate', { text: b }, `Escalated to ${to}`);
  }
  async reopen() { const b = await this.ui.prompt('Reopen case', 'Reason'); if (b) await this.act('reopen', { text: b }, 'Reopened'); }
  async changeSeverity(s: string) { const b = await this.ui.prompt(`Change severity to ${this.sevName(s)}`, 'Reason'); if (b) await this.act('severity', { severity: s, reason: b }, 'Severity changed'); }
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
  async askMore(p: Person) {
    const b = await this.ui.prompt(`Ask ${p.full_name} for more`, 'Message (app and SMS)', { multiline: true, okLabel: 'Send',
      value: 'Please send more photos or a short video of this from the app, if it is safe to do so.' });
    if (b) await this.ui.run(() => this.api.post(`/cases/${this.id()}/tasks`, { to: p.id, text: b }), `Asked ${this.first(p.full_name)}`);
  }
  async liveView(p: Person) {
    const r = await this.ui.run(() => this.api.post<{ requestId: string }>(`/cases/${this.id()}/live-view`, { agentId: p.id }), `Live video requested from ${p.full_name}`);
    if (r) { this.liveRequest.set({ id: r.requestId, status: 'requested' }); this.tab.set('live'); }
  }
  call(p: Person) { void this.callsSvc.call('volunteer', p.id, p.full_name, this.id()); }
  callContact(k: Contact) { void this.callsSvc.call('contact', k.id, `${k.agency} ${k.title}`, this.id()); }

  async submit() {
    const body = this.draft.trim();
    if (!body) return;
    if (this.mode() === 'note') { this.draft = ''; await this.act('notes', { text: body }, 'Note added'); return; }
    const ch = this.channelId();
    if (!ch) return;
    this.draft = '';
    try { await this.api.post(`/channels/${ch}/messages`, { body, clientId: crypto.randomUUID() }); await this.loadMessages(); }
    catch (e) { this.draft = body; this.ui.error(e); }
  }
  async attach(ev: Event) {
    const input = ev.target as HTMLInputElement, f = input.files?.[0], ch = this.channelId();
    input.value = '';
    if (!f || !ch) return;
    this.sending.set(true);
    try {
      const path = await this.api.upload('chat', f, (f.name.split('.').pop() ?? 'jpg').toLowerCase());
      await this.api.post(`/channels/${ch}/messages`, { mediaPath: path, kind: 'photo', clientId: crypto.randomUUID() });
      await this.loadMessages();
    } catch (e) { this.ui.error(e); }
    this.sending.set(false);
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
