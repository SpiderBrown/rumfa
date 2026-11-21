import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { INCIDENT_CATEGORIES } from '@rumfa/shared';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { AgoPipe, Ui } from '../core/ui';
import { CallLog, CallRequest, Conversation, Inbox, REQUEST_REASON, convIcon, convSub, convTitle } from '../core/inbox';
import { MediaItem, MediaThumb, MediaViewer, mediaType } from '../core/media';

type Filter = 'chats' | 'case' | 'calls';
/** One person in Chats: their direct chat, their open call request, or both */
interface PersonRow { key: string; personId: string | null; name: string; conv: Conversation | null; req: CallRequest | null }
interface Msg { id: string; sender_id: string | null; sender_name?: string | null; kind: string; body: string | null; media_path: string | null; created_at: string }
interface Person { id: string; full_name: string; role: string; level?: string; area_code: string; phone?: string; last_seen?: string | null }
interface PCall { id: string; caller_id: string | null; callee_id: string | null; route: string; status: string; duration_s: number | null; reason: string | null;
  case_id: string | null; callback_id: string | null; started_at: string; caller_name: string | null; callee_name: string | null }
interface PRequest { id: string; reason: string; status: string; channel: string; attempts: number; escalation_level: number; due_at: string; outcome: string | null;
  case_id: string | null; created_at: string; updated_at: string; has_voice_note: boolean; assigned_name: string | null }
/** One line in a conversation: a message, a call, or a call request */
type Line = { at: string; key: string } & ({ t: 'msg'; m: Msg } | { t: 'call'; c: PCall } | { t: 'req'; r: PRequest });

function readTab(): Filter | null {
  try { const t = localStorage.getItem('rumfa.messages.tab'); return t && ['chats', 'case', 'calls'].includes(t) ? (t as Filter) : null; } catch { return null; }
}

const ROLE: Record<string, string> = { agent: 'Agent', volunteer: 'Volunteer', coordinator: 'Coordinator', operator: 'Operator', supervisor: 'Supervisor',
  analyst: 'Analyst', legal: 'Legal', security: 'Security', voice_ops: 'Voice outreach', admin: 'Admin' };

/**
 * Messages and calls: everything between the Room and people in the field, the way people know from WhatsApp.
 * People waiting for a call are pinned on top; a person's chat shows their messages, call requests and every call
 * with them in one timeline; the call log is one filter away.
 */
@Component({
  selector: 'app-messages',
  imports: [FormsModule, RouterLink, MatButtonModule, MatIconModule, MatTooltipModule, AgoPipe, MediaThumb],
  template: `
  <header class="head">
    <div><p class="eyebrow">Chats, cases and calls</p><h1>Messages and calls</h1>
      <p class="lede">Your teams sit on top; anyone waiting for a call comes first. Open anyone to see their messages and every call with them.</p></div>
    <button mat-flat-button (click)="startNew()"><mat-icon>edit_square</mat-icon> New message</button>
  </header>

  <div class="r-card panes">
    <aside class="list" aria-label="Conversations and calls">
      <div class="tabs" role="tablist" aria-label="Show">
        @for (f of filters; track f.k) {
          <button type="button" role="tab" class="tab r-focus" [class.on]="filter() === f.k" [attr.aria-selected]="filter() === f.k" (click)="setFilter(f.k)">
            <mat-icon aria-hidden="true">{{ f.icon }}</mat-icon><span>{{ f.label }}</span>
            @if (countOf(f.k); as n) { <span class="n" [class.hot]="f.k === 'chats' && inbox.requests().length">{{ n > 99 ? '99+' : n }}</span> }
          </button>
        }
      </div>
      <div class="tools">
        <label class="search"><mat-icon aria-hidden="true">search</mat-icon><input [ngModel]="q()" (ngModelChange)="q.set($event)" [placeholder]="searchHint()" aria-label="Search" /></label>
      </div>

      <div class="rows">
        @if (filter() === 'chats') {
          @if (teams().length) {
            <div class="sect">Your teams</div>
            <div class="teams">
              @for (c of teams(); track c.id) {
                <button type="button" class="team r-focus" [class.on]="c.id === openId()" [class.unread]="c.unread > 0" (click)="open(c.id)" [attr.aria-label]="title(c) + (c.unread ? ', ' + c.unread + ' unread' : '')">
                  <span class="tname"><mat-icon aria-hidden="true">groups</mat-icon>{{ teamName(c) }}</span>
                  <span class="tlevel">{{ teamLevel(c) }}</span>
                  @if (c.unread) { <span class="badge">{{ c.unread > 99 ? '99+' : c.unread }}</span> }
                </button>
              }
            </div>
          }
          <div class="sect">People @if (waitingCount()) { <span class="hotnote">· {{ waitingCount() }} waiting for a call</span> }</div>
          @for (p of people(); track p.key) {
            <div class="conv" [class.req]="!!p.req" [class.late]="p.req && late(p.req)" [class.on]="isOpen(p)" [class.unread]="(p.conv?.unread ?? 0) > 0">
              <button type="button" class="hit r-focus" (click)="openRow(p)" [attr.aria-label]="'Open ' + p.name"></button>
              <span class="av" [class.direct]="!p.req" [class.req]="!!p.req"><mat-icon aria-hidden="true">{{ p.req ? (p.req.status === 'calling' ? 'phone_in_talk' : 'phone_callback') : 'person' }}</mat-icon></span>
              <span class="txt">
                <span class="t1"><b>{{ p.name }}</b>
                  @if (p.req) { <span class="due">{{ waitText(p.req) }}</span> } @else if (p.conv?.last) { <span class="when">{{ p.conv!.last!.at | ago }}</span> }</span>
                @if (p.req) { <span class="t2 reqline">{{ p.req.status === 'calling' ? 'Being called' : 'Wants a call' }} · {{ reason(p.req.reason) }}{{ p.req.attempts ? ' · ' + p.req.attempts + (p.req.attempts === 1 ? ' try' : ' tries') : '' }}</span> }
                @else { <span class="t2">{{ p.conv?.last ? (p.conv!.last!.mine ? 'You: ' : '') + preview(p.conv!) : sub(p.conv!) }}</span> }
              </span>
              @if (p.req) { <button type="button" class="callbtn r-focus" (click)="callFor(p.req.requester_id, p.name, p.req)" [attr.aria-label]="'Call ' + p.name" matTooltip="Call now"><mat-icon aria-hidden="true">call</mat-icon></button> }
              @else if (p.conv?.unread) { <span class="badge" [attr.aria-label]="p.conv!.unread + ' unread'">{{ p.conv!.unread > 99 ? '99+' : p.conv!.unread }}</span> }
            </div>
          } @empty {
            <p class="empty">@if (!inbox.loaded()) { Loading… } @else if (q()) { Nobody matches "{{ q() }}". } @else { No chats with people yet. Use New message to write to someone. }</p>
          }
        } @else if (filter() === 'calls') {
          @for (c of callsShown(); track c.id) {
            <button type="button" class="conv r-focus" [class.on]="otherOf(c) === personId()" (click)="openCall(c)" [disabled]="!otherOf(c) || !!c.contact_id">
              <span class="av" [class.missed]="missed(c)"><mat-icon aria-hidden="true">{{ callIcon(c) }}</mat-icon></span>
              <span class="txt">
                <span class="t1"><b>{{ otherName(c) }}</b><span class="when">{{ c.started_at | ago }}</span></span>
                <span class="t2" [class.bad]="missed(c)">{{ callLine(c) }}</span>
              </span>
            </button>
          } @empty { <p class="empty">No calls yet.</p> }
        } @else {
          @for (c of cases(); track c.id) {
            <button type="button" class="conv r-focus" [class.on]="c.id === openId()" [class.unread]="c.unread > 0" (click)="open(c.id)">
              <span class="av case"><mat-icon aria-hidden="true">report</mat-icon></span>
              <span class="txt">
                <span class="t1"><b>{{ title(c) }}</b>@if (c.last) { <span class="when">{{ c.last.at | ago }}</span> }</span>
                <span class="t2">{{ c.last ? (c.last.mine ? 'You: ' : (c.last.sender ? c.last.sender + ': ' : '')) + preview(c) : sub(c) }}</span>
              </span>
              @if (c.unread) { <span class="badge" [attr.aria-label]="c.unread + ' unread'">{{ c.unread > 99 ? '99+' : c.unread }}</span> }
            </button>
          } @empty { <p class="empty">@if (q()) { Nothing matches "{{ q() }}". } @else { No case chats yet. }</p> }
        }
      </div>
    </aside>

    <section class="conv-pane" aria-label="Conversation">
      @if (picking()) {
        <div class="pick">
          <div class="ph"><h2>New message</h2><button mat-button (click)="picking.set(false)">Cancel</button></div>
          <label class="search big"><mat-icon aria-hidden="true">person_search</mat-icon>
            <input [ngModel]="pq" (ngModelChange)="pq = $event; findPeople()" placeholder="Name, phone or area" aria-label="Who to message" /></label>
          <div class="people">
            @for (p of found(); track p.id) {
              <button type="button" class="conv r-focus" (click)="openPerson(p.id)">
                <span class="av direct"><mat-icon aria-hidden="true">person</mat-icon></span>
                <span class="txt"><b>{{ p.full_name }}</b><span class="t2">{{ roleName(p.role) }} · {{ p.area_code }}</span></span>
                <mat-icon aria-hidden="true">chevron_right</mat-icon>
              </button>
            } @empty { <p class="empty">{{ pq.trim().length < 2 ? 'Type at least two letters.' : searching() ? 'Searching…' : 'Nobody found.' }}</p> }
          </div>
        </div>
      } @else if (current(); as c) {
        <div class="ch">
          <span class="av" [class]="c.kind"><mat-icon aria-hidden="true">{{ icon(c) }}</mat-icon></span>
          <div class="grow">
            <h2>{{ person()?.full_name ?? title(c) }}</h2>
            <p class="t2">@if (person(); as p) { {{ roleName(p.role) }} · {{ p.area_code }} · @if (p.last_seen) { app seen {{ p.last_seen | ago }} } @else { app not used yet } } @else { {{ sub(c) }} }</p>
          </div>
          @if (person(); as p) { @if (!openRequest()) { <button mat-flat-button (click)="callFor(p.id, p.full_name)"><mat-icon>call</mat-icon> Call</button> } }
          @if (c.kind === 'case' && c.case_id) { <a mat-stroked-button [routerLink]="['/room/case', c.case_id]"><mat-icon>open_in_new</mat-icon> Open case</a> }
        </div>

        @if (openRequest(); as r) {
          <div class="banner" [class.late]="late(r)" role="status">
            <mat-icon aria-hidden="true">{{ r.status === 'calling' ? 'phone_in_talk' : 'phone_callback' }}</mat-icon>
            <div class="grow">
              <b>@if (r.status === 'calling') { Calling about their request } @else { Asked to be called · {{ waitText(r) }} }</b>
              <span>{{ reason(r.reason) }}{{ r.attempts ? ' · ' + r.attempts + (r.attempts === 1 ? ' try' : ' tries') : '' }}{{ r.status === 'escalated' ? ' · passed up to the room' : '' }}</span>
            </div>
            @if (r.voice_note_path) { <button mat-stroked-button (click)="playVoice(r.id)"><mat-icon>play_arrow</mat-icon> Voice note</button> }
            @if (r.status === 'calling') {
              <button mat-stroked-button (click)="finish(r, true)"><mat-icon>check</mat-icon> Sorted</button>
              <button mat-stroked-button (click)="finish(r, false)"><mat-icon>phone_missed</mat-icon> No answer</button>
              <button mat-stroked-button (click)="toCase(r)"><mat-icon>report</mat-icon> Open a case</button>
            } @else {
              <button mat-flat-button (click)="callFor(r.requester_id, r.requester.full_name, r)"><mat-icon>call</mat-icon> Call now</button>
            }
          </div>
        }

        <div class="msgs" #scroller>
          @for (l of lines(); track l.key; let i = $index) {
            @if (dayBreak(i)) { <div class="day"><span>{{ day(l.at) }}</span></div> }
            @switch (l.t) {
              @case ('msg') {
                <div class="msg" [class.mine]="l.m.sender_id === api.me()?.id" [class.sys]="l.m.kind === 'system'">
                  @if (l.m.sender_id !== api.me()?.id && c.kind !== 'direct' && l.m.kind !== 'system') { <span class="who">{{ l.m.sender_name ?? 'Someone' }}</span> }
                  @if (l.m.media_path) { <app-media-thumb [items]="media()" [index]="mediaIndex(l.m.id)" [size]="220" [height]="165" /> }
                  @if (l.m.body) { <span class="body">{{ l.m.body }}</span> }
                  <span class="at">{{ time(l.at) }}</span>
                </div>
              }
              @case ('call') {
                <div class="event" [class.bad]="missed(l.c)">
                  <mat-icon aria-hidden="true">{{ callIcon(l.c) }}</mat-icon>
                  <span><b>{{ pcallTitle(l.c) }}</b> · {{ pcallLine(l.c) }}</span>
                  <span class="at">{{ time(l.at) }}</span>
                  @if (l.c.case_id) { <a [routerLink]="['/room/case', l.c.case_id]">case</a> }
                </div>
              }
              @case ('req') {
                <div class="event req">
                  <mat-icon aria-hidden="true">phone_callback</mat-icon>
                  <span><b>Asked to be called</b> · {{ reason(l.r.reason) }}{{ l.r.channel === 'sms' ? ' · by SMS' : '' }} · {{ reqOutcome(l.r) }}</span>
                  @if (l.r.has_voice_note) { <button mat-button (click)="playVoice(l.r.id)"><mat-icon>play_arrow</mat-icon> Voice note</button> }
                  <span class="at">{{ time(l.at) }}</span>
                  @if (l.r.case_id) { <a [routerLink]="['/room/case', l.r.case_id]">case</a> }
                </div>
              }
            }
          } @empty { <p class="empty center">No messages or calls yet. Say hello.</p> }
        </div>
        <form class="send" (submit)="$event.preventDefault(); send()">
          <input #file type="file" accept="image/*" hidden (change)="attach($event)" />
          <button mat-icon-button type="button" (click)="file.click()" matTooltip="Send a photo" aria-label="Send a photo" [disabled]="sending()"><mat-icon>add_photo_alternate</mat-icon></button>
          <textarea [(ngModel)]="draft" name="draft" rows="1" placeholder="Write a message" aria-label="Message" (keydown.enter)="enter($any($event))"></textarea>
          <button mat-flat-button type="submit" [disabled]="!draft.trim() || sending()">Send</button>
        </form>
      } @else {
        <div class="none"><mat-icon aria-hidden="true">forum</mat-icon>
          @if (inbox.requests().length) { <p>{{ inbox.requests().length }} {{ inbox.requests().length === 1 ? 'person is' : 'people are' }} waiting for a call. Pick one on the left.</p> }
          @else { <p>Pick a conversation, or start a new message to someone in the field.</p> }
        </div>
      }
    </section>
  </div>`,
  styles: `
    :host { display: block; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); }
    h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .muted { color: var(--r-muted); font-weight: 500; text-transform: none; letter-spacing: 0; }
    .panes { display: grid; grid-template-columns: 380px minmax(0, 1fr); height: calc(100vh - 210px); min-height: 520px; overflow: hidden; }
    .list { border-right: 1px solid var(--r-line); display: flex; flex-direction: column; min-height: 0; }
    .tools { padding: 12px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--r-line-soft); }
    .search { display: flex; align-items: center; gap: 6px; border: 1px solid var(--r-line); border-radius: 9px; padding: 0 10px; background: var(--r-ground); color: var(--r-muted); }
    .search:focus-within { outline: 2px solid var(--r-accent); outline-offset: 1px; }
    .search input { flex: 1; border: 0; background: none; padding: 9px 0; font: inherit; font-size: 14px; outline: none; color: var(--r-ink); }
    .search.big { margin: 0 18px; }
    .tabs { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--r-line); }
    .tab { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 4px 9px; border: 0; background: none; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--r-muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .tab mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .tab:hover { color: var(--r-ink); background: var(--r-ground); }
    .tab.on { color: var(--r-accent); border-bottom-color: var(--r-accent); }
    .tab .n { position: absolute; top: 5px; left: calc(50% + 6px); background: var(--r-accent); color: #fff; border-radius: 9px; padding: 0 5px; font-size: 10.5px; font-weight: 700; line-height: 16px; }
    .tab .n.hot { background: #b42318; }
    .teams { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; padding: 10px 14px 12px; border-bottom: 1px solid var(--r-line-soft); }
    .team { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 9px 10px; border: 1px solid var(--r-line); border-radius: 10px; background: #fff; font: inherit; text-align: left; cursor: pointer; color: var(--r-ink); min-width: 0; }
    .team:hover { border-color: #9aa6b6; } .team.on { border-color: var(--r-accent); box-shadow: 0 0 0 1px var(--r-accent); background: var(--r-accent-soft); }
    .tname { display: flex; align-items: center; gap: 5px; font-weight: 700; font-size: 13px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tname mat-icon { font-size: 16px; width: 16px; height: 16px; color: var(--r-accent); flex: none; }
    .tlevel { font-size: 11.5px; color: var(--r-muted); }
    .team .badge { position: absolute; top: 6px; right: 6px; }
    .team.unread .tname { color: var(--r-ink); }
    .hotnote { color: #b42318; text-transform: none; letter-spacing: 0; }
    .reqline { color: #b42318; font-weight: 600; }
    .rows { overflow-y: auto; flex: 1; }
    .sect { display: flex; align-items: center; gap: 6px; padding: 10px 14px 6px; font-size: 11.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--r-muted); background: #fafbfc; border-bottom: 1px solid var(--r-line-soft); }
    .sect mat-icon { font-size: 16px; width: 16px; height: 16px; color: #b42318; }
    .conv { position: relative; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 11px; padding: 11px 14px; border: 0; border-bottom: 1px solid var(--r-line-soft); background: none; text-align: left; font: inherit; cursor: pointer; color: var(--r-ink); }
    .conv:hover { background: var(--r-ground); } .conv:disabled { cursor: default; }
    .conv.on { background: var(--r-accent-soft); box-shadow: inset 3px 0 0 var(--r-accent); }
    .conv.req { background: #fff8f7; } .conv.req .hit { border-radius: 0; } .conv.req.on { background: #fdecea; box-shadow: inset 3px 0 0 #b42318; }
    .hit { position: absolute; inset: 0; border: 0; background: none; cursor: pointer; }
    .callbtn { position: relative; flex: none; width: 36px; height: 36px; border-radius: 50%; border: 0; background: var(--r-accent); color: #fff; display: grid; place-items: center; cursor: pointer; }
    .callbtn:hover { background: var(--r-accent-strong); } .callbtn mat-icon { font-size: 19px; width: 19px; height: 19px; }
    .av { flex: none; width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: #eef1f4; color: var(--r-ink-2); }
    .av mat-icon { font-size: 20px; width: 20px; height: 20px; }
    .av.direct { background: #e3ecf7; color: #1f4e8c; } .av.case { background: #fdeee4; color: #b4541a; } .av.ward, .av.lga, .av.state { background: #e6f4f2; color: var(--r-accent); }
    .av.req, .av.missed { background: #fdecea; color: #b42318; }
    .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .t1 { display: flex; justify-content: space-between; gap: 8px; } .t1 b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .when { font-size: 11.5px; color: var(--r-muted); flex: none; }
    .due { font-size: 11.5px; font-weight: 700; color: var(--r-ink-2); flex: none; } .late .due { color: #b42318; }
    .t2 { margin: 0; font-size: 12.5px; color: var(--r-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t2.bad { color: #b42318; }
    .conv.unread .t2 { color: var(--r-ink); font-weight: 600; }
    .badge { flex: none; background: var(--r-accent); color: #fff; font-size: 11px; font-weight: 700; border-radius: 10px; padding: 1px 7px; }
    .empty { padding: 20px; color: var(--r-muted); font-size: 13.5px; } .center { text-align: center; }
    .conv-pane { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
    .ch { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--r-line); } .grow { flex: 1; min-width: 0; }
    .banner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 18px; background: #fff7ed; border-bottom: 1px solid #fed7aa; color: #7a3306; }
    .banner.late { background: #fdecea; border-color: #f5c2bd; color: #7a1d14; }
    .banner .grow { display: flex; flex-direction: column; } .banner .grow span { font-size: 12.5px; }
    .msgs { flex: 1; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; background: #fafbfc; }
    .day { text-align: center; margin: 8px 0; } .day span { font-size: 11.5px; font-weight: 600; color: var(--r-muted); background: #eef1f4; border-radius: 10px; padding: 2px 10px; }
    .msg { align-self: flex-start; max-width: 68%; background: #fff; border: 1px solid var(--r-line); border-radius: 12px 12px 12px 4px; padding: 7px 10px; display: flex; flex-direction: column; gap: 4px; }
    .msg.mine { align-self: flex-end; background: #dff3ef; border-color: #c4e6df; border-radius: 12px 12px 4px 12px; }
    .msg.sys { align-self: center; background: none; border: 0; color: var(--r-muted); font-size: 12.5px; }
    .who { font-size: 12px; font-weight: 700; color: #1f4e8c; } .body { white-space: pre-wrap; word-break: break-word; font-size: 14px; }
    .at { font-size: 11px; color: var(--r-muted); } .msg .at { align-self: flex-end; }
    .event { align-self: center; display: flex; align-items: center; gap: 8px; max-width: 90%; background: #fff; border: 1px solid var(--r-line); border-radius: 18px; padding: 5px 12px; font-size: 12.5px; color: var(--r-ink-2); }
    .event mat-icon { font-size: 17px; width: 17px; height: 17px; color: var(--r-accent); flex: none; }
    .event.bad mat-icon { color: #b42318; } .event.req mat-icon { color: #b54708; }
    .send { display: flex; align-items: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--r-line); }
    .send textarea { flex: 1; resize: none; max-height: 120px; border: 1px solid var(--r-line); border-radius: 10px; padding: 9px 12px; font: inherit; font-size: 14px; }
    .send textarea:focus { outline: 2px solid var(--r-accent); outline-offset: 1px; }
    .none { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--r-muted); text-align: center; padding: 24px; }
    .none mat-icon { font-size: 44px; width: 44px; height: 44px; color: #c5ccd6; }
    .pick { display: flex; flex-direction: column; min-height: 0; flex: 1; } .pick .ph { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; }
    .people { overflow-y: auto; margin-top: 10px; border-top: 1px solid var(--r-line-soft); }
    @media (max-width: 900px) { .panes { grid-template-columns: 1fr; height: auto; } .list { border-right: 0; max-height: 380px; } }
  `,
})
export class MessagesPage implements OnDestroy {
  api = inject(Api);
  inbox = inject(Inbox);
  calls = inject(Calls);
  private ui = inject(Ui);
  private router = inject(Router);
  private viewer = inject(MediaViewer);
  /** ?c= opens a conversation; ?f= picks the filter (the old Callback requests link lands on requests) */
  c = input<string | undefined>(undefined);
  f = input<string | undefined>(undefined);

  readonly filters: { k: Filter; label: string; icon: string }[] = [
    { k: 'chats', label: 'Chats', icon: 'chat' }, { k: 'case', label: 'Cases', icon: 'report' }, { k: 'calls', label: 'Calls', icon: 'call_log' }];
  /** The tab, remembered on this computer */
  filter = signal<Filter>(readTab() ?? 'chats');
  q = signal('');
  openId = signal<string | null>(null);
  msgs = signal<Msg[]>([]);
  person = signal<Person | null>(null);
  pcalls = signal<PCall[]>([]);
  preqs = signal<PRequest[]>([]);
  draft = '';
  sending = signal(false);
  picking = signal(false);
  pq = '';
  found = signal<Person[]>([]);
  searching = signal(false);
  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private stopFollow: (() => void) | null = null;
  private stopLive: () => void;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private tick = signal(Date.now());
  private clock = setInterval(() => this.tick.set(Date.now()), 30_000);

  current = computed(() => this.inbox.list().find((c) => c.id === this.openId()) ?? null);
  personId = computed(() => this.person()?.id ?? null);
  /** The open person's request that still needs a call (from the live list) */
  openRequest = computed<CallRequest | null>(() => {
    const id = this.personId();
    return id ? this.inbox.requests().find((r) => r.requester_id === id) ?? null : null;
  });
  private match(s: string) { const q = this.q().trim().toLowerCase(); return !q || s.toLowerCase().includes(q); }
  /** Area team chats, smallest area first (ward, LGA, state): usually just a few, pinned on top of Chats */
  teams = computed(() => {
    const order: Record<string, number> = { ward: 0, lga: 1, state: 2 };
    return this.inbox.list().filter((c) => ['ward', 'lga', 'state'].includes(c.kind) && this.match(`${convTitle(c)} ${convSub(c)}`))
      .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  });
  /** People: anyone waiting for a call first (oldest first), then direct chats by latest message */
  people = computed<PersonRow[]>(() => {
    const me = this.api.me()?.id;
    const reqs = new Map(this.inbox.requests().map((r) => [r.requester_id, r]));
    const rows: PersonRow[] = this.inbox.list().filter((c) => c.kind === 'direct').map((c) => {
      const pid = c.member_a === me ? c.member_b : c.member_a;
      const req = pid ? reqs.get(pid) ?? null : null;
      if (pid) reqs.delete(pid);
      return { key: 'c' + c.id, personId: pid, name: c.label.person ?? 'Someone', conv: c, req };
    });
    for (const r of reqs.values()) rows.push({ key: 'r' + r.id, personId: r.requester_id, name: r.requester.full_name, conv: null, req: r });
    const at = (p: PersonRow) => p.conv?.last?.at ?? p.conv?.created_at ?? '';
    return rows.filter((p) => this.match(`${p.name} ${p.req ? this.reason(p.req.reason) + ' ' + p.req.requester.area_code : ''} ${p.conv?.last?.body ?? ''}`))
      .sort((a, b) => (a.req && b.req ? a.req.created_at.localeCompare(b.req.created_at) : a.req ? -1 : b.req ? 1 : at(b).localeCompare(at(a))));
  });
  waitingCount = computed(() => this.inbox.requests().length);
  cases = computed(() => this.inbox.list().filter((c) => c.kind === 'case' && this.match(`${convTitle(c)} ${convSub(c)} ${c.last?.body ?? ''}`)));
  searchHint = computed(() => ({ chats: 'Search people and teams', case: 'Search case chats', calls: 'Search calls' })[this.filter()]);
  callsShown = computed(() => this.inbox.callLog().filter((c) => this.match(`${this.otherName(c)} ${c.reason ?? ''}`)));
  media = computed<(MediaItem & { id: string })[]>(() => this.msgs().filter((m) => m.media_path).map((m) => ({
    id: m.id, ref: { kind: 'message', id: m.id }, type: mediaType(m.kind === 'photo' ? m.media_path : m.kind),
    caption: `${m.sender_id === this.api.me()?.id ? 'You' : m.sender_name ?? 'Someone'}${m.body ? ' · ' + m.body : ''}`,
  })));
  /** Messages, calls and requests in one timeline, oldest first */
  lines = computed<Line[]>(() => [
    ...this.msgs().map((m) => ({ t: 'msg' as const, m, at: m.created_at, key: 'm' + m.id })),
    ...this.pcalls().map((c) => ({ t: 'call' as const, c, at: c.started_at, key: 'c' + c.id })),
    ...this.preqs().map((r) => ({ t: 'req' as const, r, at: r.created_at, key: 'r' + r.id })),
  ].sort((a, b) => a.at.localeCompare(b.at)));

  constructor() {
    this.inbox.start();
    effect(() => { const id = this.c(); if (id && id !== this.openId()) void this.open(id); });
    // ?f= from links (the old Callback requests page lands on requests; calls opens the call log)
    effect(() => {
      const f = this.f();
      if (f === 'requests' || f === 'chats') this.filter.set('chats');
      else if (f === 'calls' || f === 'case') this.filter.set(f);
    });
    this.stopLive = this.api.onChange((ch: any) => {
      if (ch.t === 'messages' && ch.channel_id && ch.channel_id === this.openId()) void this.loadMsgs();
      if ((ch.t === 'calls' || ch.t === 'callback_requests') && this.personId()) this.soonReload();
    }, ['messages', 'calls', 'callback_requests']);
  }
  ngOnDestroy() { this.stopFollow?.(); this.stopLive(); clearInterval(this.clock); }
  private soonReload() { this.reloadTimer ??= setTimeout(() => { this.reloadTimer = null; void this.loadMsgs(); }, 1000); }

  // ---- words -------------------------------------------------------------------------------------------
  title = convTitle; sub = convSub; icon = convIcon;
  reason(code: string) { return REQUEST_REASON[code] ?? 'Something else'; }
  roleName(r: string) { return ROLE[r] ?? r; }
  /** Chats: people waiting for a call plus unread people and team messages; Cases: unread case messages */
  countOf(f: Filter) {
    if (f === 'calls') return 0;
    const kinds = f === 'chats' ? ['direct', 'ward', 'lga', 'state'] : ['case'];
    return this.inbox.list().filter((c) => kinds.includes(c.kind)).reduce((n, c) => n + c.unread, 0) + (f === 'chats' ? this.inbox.requests().length : 0);
  }
  teamName(c: Conversation) { return c.label.place ?? c.area_code ?? 'Team'; }
  teamLevel(c: Conversation) { return ({ ward: 'Ward', lga: 'LGA', state: 'State' } as Record<string, string>)[c.kind] ?? ''; }
  isOpen(p: PersonRow) { return p.conv ? p.conv.id === this.openId() : !!p.personId && p.personId === this.personId(); }
  openRow(p: PersonRow) { if (p.conv) void this.open(p.conv.id); else if (p.personId) void this.openPerson(p.personId); }
  preview(c: Conversation) { const l = c.last!; return l.body || ({ photo: 'Photo', video: 'Video', voice: 'Voice note' } as Record<string, string>)[l.kind] || 'Message'; }
  late(r: CallRequest) { this.tick(); return r.status !== 'calling' && new Date(r.due_at).getTime() < Date.now(); }
  waitText(r: CallRequest) {
    this.tick();
    const mins = Math.max(0, Math.round((Date.now() - new Date(r.created_at).getTime()) / 60_000));
    return r.status === 'calling' ? 'being called' : mins < 1 ? 'just now' : mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.floor(mins / 1440)} d`;
  }
  dur(s: number | null) { return s ? (s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`) : ''; }
  missed(c: { status: string }) { return ['no_answer', 'failed', 'busy'].includes(c.status); }
  private via(route: string) { return ({ inapp: 'app call', bridged: 'Rumfa call', webrtc_pstn: 'internet call', gsm_direct: 'phone' } as Record<string, string>)[route] ?? 'call'; }
  private outcome(c: { status: string; duration_s: number | null }) {
    return ({ no_answer: 'no answer', failed: 'didn\'t connect', busy: 'busy', ringing: 'ringing', initiated: 'started' } as Record<string, string>)[c.status]
      ?? (c.duration_s ? this.dur(c.duration_s) : 'answered');
  }
  // call log rows, from my point of view
  otherOf(c: CallLog) { const me = this.api.me()?.id; return c.caller_id === me ? c.callee_id : c.callee_id === me ? c.caller_id : (c.callee_id ?? c.caller_id); }
  otherName(c: CallLog) {
    if (c.contact_id) return `${c.contact_agency ?? 'Contact'} · ${c.contact_title ?? ''}`.trim();
    const me = this.api.me()?.id;
    if (c.caller_id === me) return c.callee_name ?? 'Unknown';
    if (c.callee_id === me) return c.caller_name ?? 'Unknown';
    return `${c.caller_name ?? '?'} → ${c.callee_name ?? '?'}`;
  }
  callIcon(c: { status: string; caller_id: string | null }) {
    if (this.missed(c)) return 'phone_missed';
    return c.caller_id === this.api.me()?.id ? 'call_made' : 'call_received';
  }
  callLine(c: CallLog) { return [this.outcome(c), this.via(c.route), c.reason].filter(Boolean).join(' · '); }
  // calls inside a person's timeline
  pcallTitle(c: PCall) {
    const me = this.api.me()?.id, p = this.personId();
    if (c.caller_id === me) return 'You called';
    if (c.callee_id === me) return 'Called you';
    if (c.callee_id === p) return `${c.caller_name ?? 'Someone'} called`;
    return `Called ${c.callee_name ?? 'someone'}`;
  }
  pcallLine(c: PCall) { return [this.outcome(c), this.via(c.route), c.reason].filter(Boolean).join(' · '); }
  reqOutcome(r: PRequest) {
    const by = r.assigned_name ? ` (${r.assigned_name})` : '';
    return ({ waiting: 'waiting', calling: 'being called' + by, no_answer: 'no answer yet' + by, escalated: 'passed up', done: 'sorted' + by + (r.outcome ? ': ' + r.outcome : ''),
      closed: r.outcome ?? 'closed', cancelled: 'cancelled by them', case_opened: 'case opened' } as Record<string, string>)[r.status] ?? r.status;
  }
  mediaIndex(id: string) { return Math.max(0, this.media().findIndex((x) => x.id === id)); }
  time(t: string) { return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  day(t: string) {
    const d = new Date(t), today = new Date(), y = new Date(); y.setDate(y.getDate() - 1);
    return d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  dayBreak(i: number) { const l = this.lines(); return i === 0 || new Date(l[i].at).toDateString() !== new Date(l[i - 1].at).toDateString(); }

  // ---- navigation --------------------------------------------------------------------------------------
  setFilter(f: Filter) {
    this.filter.set(f);
    try { localStorage.setItem('rumfa.messages.tab', f); } catch { /* private mode */ }
    void this.router.navigate([], { queryParams: { f: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }
  async open(id: string) {
    this.picking.set(false);
    if (this.openId() !== id) { this.msgs.set([]); this.pcalls.set([]); this.preqs.set([]); this.person.set(null); this.draft = ''; }
    this.openId.set(id);
    this.stopFollow?.(); this.stopFollow = this.api.follow({ channel: id });
    void this.router.navigate([], { queryParams: { c: id }, queryParamsHandling: 'merge', replaceUrl: true });
    this.inbox.read(id);
    await this.loadMsgs();
    if (!this.current()) await this.inbox.load();   // a conversation just started elsewhere
  }
  /** A person's direct conversation (made on first use) */
  async openPerson(personId: string) {
    const me = this.api.me()?.id ?? '';
    try {
      const existing = this.inbox.list().find((c) => c.kind === 'direct' && [c.member_a, c.member_b].includes(personId) && [c.member_a, c.member_b].includes(me));
      const id = existing?.id ?? (await this.api.post<{ channelId: string }>('/channels/direct', { otherId: personId })).channelId;
      if (!existing) await this.inbox.load();
      await this.open(id);
    } catch (e) { this.ui.error(e); }
  }
  openCall(c: CallLog) { const p = this.otherOf(c); if (p && !c.contact_id) void this.openPerson(p); }

  async loadMsgs() {
    const id = this.openId(); if (!id) return;
    try {
      const r = await this.api.get<{ messages: Msg[]; person: Person | null; calls: PCall[]; requests: PRequest[] }>(`/channels/${id}`);
      if (this.openId() !== id) return;
      this.msgs.set(r.messages); this.person.set(r.person ?? null); this.pcalls.set(r.calls ?? []); this.preqs.set(r.requests ?? []);
      this.inbox.read(id);
      setTimeout(() => { const el = this.scroller()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; });
    } catch (e) { this.ui.error(e); }
  }

  // ---- calls and requests -------------------------------------------------------------------------------
  /** Call someone; if they're waiting for a call, the request is marked as being called (one more try) */
  async callFor(personId: string, name: string, r?: CallRequest | null) {
    if (this.personId() !== personId) await this.openPerson(personId);
    const placed = await this.calls.call('volunteer', personId, name, r?.case_id ?? undefined, r ? 'callback' : 'from messages');
    // Only a call that went out counts as a try on their request (then Sorted / No answer / Open a case)
    if (placed && r && r.status !== 'calling') {
      await this.ui.run(async () => { await this.api.post(`/callbacks/${r.id}/start`); return true; });
      this.inbox.soon();
    }
    setTimeout(() => void this.loadMsgs(), 1500);
  }
  async finish(r: CallRequest, answered: boolean) {
    let outcome: string | undefined;
    if (answered) {
      const o = await this.ui.prompt('Sorted on the call', 'What was agreed? (optional)', { multiline: true, okLabel: 'Save' });
      if (o === null) return;
      outcome = o.trim() || 'Sorted on the call';
    }
    const ok = await this.ui.run(async () => { await this.api.post(`/callbacks/${r.id}/complete`, { answered, outcome }); return true; },
      answered ? 'Saved. The request is closed.' : 'Saved. They get an SMS, and the request comes back for another try.');
    if (ok) { this.inbox.soon(); await this.loadMsgs(); }
  }
  async toCase(r: CallRequest) {
    const cat = await this.ui.choose('Open a case', 'What is happening at their polling unit?',
      INCIDENT_CATEGORIES.filter((c) => c.code !== 'sos').map((c) => ({ label: c.label, value: c.code })));
    if (!cat) return;
    const note = await this.ui.prompt('Open a case', 'What did they tell you?', { multiline: true, okLabel: 'Open case' });
    if (!note) return;
    const res = await this.ui.run(() => this.api.post<{ caseId: string }>(`/callbacks/${r.id}/convert`, { category: cat, note }), 'Case opened');
    if (res?.caseId) { this.inbox.soon(); await this.loadMsgs(); }
  }
  playVoice(id: string) { this.viewer.open([{ ref: { kind: 'callback', id }, type: 'audio', caption: 'Voice note with the call request' }]); }

  // ---- sending -----------------------------------------------------------------------------------------
  enter(e: KeyboardEvent) { if (e.shiftKey) return; e.preventDefault(); void this.send(); }
  async send(mediaPath?: string) {
    const id = this.openId(), body = this.draft.trim();
    if (!id || (!body && !mediaPath)) return;
    this.sending.set(true);
    try {
      await this.api.post(`/channels/${id}/messages`, { body: mediaPath ? undefined : body, mediaPath, kind: mediaPath ? 'photo' : 'text', clientId: crypto.randomUUID() });
      if (!mediaPath) this.draft = '';
      await this.loadMsgs(); this.inbox.soon();
    } catch (e) { this.ui.error(e); } finally { this.sending.set(false); }
  }
  async attach(ev: Event) {
    const input = ev.target as HTMLInputElement, f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { this.ui.error(new Error('That photo is over 10 MB')); return; }
    const ext = (f.name.split('.').pop() ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
    this.sending.set(true);
    try { const path = await this.api.upload('chat', f, ext); this.sending.set(false); await this.send(path); }
    catch (e) { this.sending.set(false); this.ui.error(e); }
  }

  startNew() { this.picking.set(true); this.pq = ''; this.found.set([]); }
  findPeople() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const q = this.pq.trim();
    if (q.length < 2) { this.found.set([]); this.searching.set(false); return; }
    this.searching.set(true);
    this.searchTimer = setTimeout(async () => {
      try {
        const r = (await this.api.get<Person[]>('/people', { q, status: 'active' })).filter((p) => p.id !== this.api.me()?.id).slice(0, 30);
        if (this.pq.trim() === q) this.found.set(r);
      } catch (e) { this.ui.error(e); }
      finally { if (this.pq.trim() === q) this.searching.set(false); }
    }, 250);
  }
}
