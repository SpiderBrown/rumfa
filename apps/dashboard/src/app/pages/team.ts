import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { GroupCall, type GroupPerson } from '../core/group-call';
import { WavRecorder } from '../core/wav-recorder';
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
        @if (canGroupCall()) {
          <button mat-stroked-button (click)="openVoice()"><mat-icon>record_voice_over</mat-icon> Voice message</button>
          <button mat-stroked-button (click)="openGroup()"><mat-icon>groups</mat-icon> Group call</button>
        }
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



    <!-- Voice message: record once; everyone chosen gets a phone call that plays it (tried again if out of network) -->
    @if (voicing()) {
      <section class="r-card announce" aria-label="Voice message">
        <div class="a-head"><h2>Voice message to {{ groupAreaName() }}</h2>
          <button mat-icon-button (click)="closeVoice()" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <p class="muted sm">Record up to a minute. Each person gets a phone call that plays it, then hangs up. Anyone out of network is called again every 10 minutes, up to 4 times in 3 hours.</p>
        <div class="rec">
          @if (recording()) {
            <button mat-flat-button class="stop" (click)="stopRec()"><mat-icon>stop</mat-icon> Stop · {{ recSecs() }}s</button>
            <span class="pulse" aria-hidden="true"></span><span class="sm">Recording… speak now</span>
          } @else if (clip(); as c) {
            <audio [src]="c.url" controls></audio><span class="muted sm">{{ c.seconds }} s</span>
            <button mat-button (click)="startRec()"><mat-icon>mic</mat-icon> Record again</button>
          } @else {
            <button mat-flat-button (click)="startRec()"><mat-icon>mic</mat-icon> Start recording</button>
          }
        </div>
        <div class="g-roles">
          <span class="sm b">Who</span>
          @for (r of groupRoles; track r.id) {
            <label class="chk"><input type="checkbox" [checked]="gRoles().includes(r.id)" (change)="toggleGroupRole(r.id)" /> {{ r.label }}</label>
          }
        </div>
        <div class="a-foot">
          <span class="muted sm">@if (vPreview(); as pv) { {{ pv.more ? 'Too many people: choose a smaller area or fewer roles.' : pv.count + (pv.count === 1 ? ' person' : ' people') + ' will get the call' + (pv.names.length ? ': ' + pv.names.join(', ') + (pv.count > pv.names.length ? ' and ' + (pv.count - pv.names.length) + ' more' : '') : '.') }}
            @if (!pv.canCall) { <br><b>Calls go out once Africa's Talking voice is set up for Rumfa.</b> } } @else { Counting… }</span>
          <button mat-flat-button (click)="sendVoice()" [disabled]="!clip() || recording() || vSending() || !vPreview()?.count || vPreview()?.more"><mat-icon>send</mat-icon> Send to {{ vPreview()?.count ?? '…' }}</button>
        </div>
        @if (voiceList().length) {
          <div class="vlist">
            <p class="sm b">Recent voice messages</p>
            @for (m of voiceList(); track m.id) {
              <div class="vrow">
                <span class="grow"><b>{{ m.title }}</b> <span class="muted xs">· {{ m.created_at | ago }} · {{ m.sender }}</span></span>
                <span class="xs">{{ heard(m) }} of {{ total(m) }} heard{{ m.status === 'sending' && trying(m) ? ' · ' + trying(m) + ' still trying' : '' }}</span>
                @if (m.status === 'sending') { <button mat-button (click)="cancelVoice(m.id)">Stop</button> } @else { <span class="muted xs">{{ m.status === 'cancelled' ? 'Stopped' : 'Done' }}</span> }
              </div>
            }
          </div>
        }
      </section>
    }

    <!-- Group call: everyone of the chosen roles in an area, in the app first; phones only if you say so -->
    @if (grouping() || group.state()) {
      <section class="r-card announce" aria-label="Group call">
        @if (group.state(); as g) {
          <div class="a-head"><h2>{{ g.title }} · {{ group.joined().length }} of {{ g.people.length }} joined</h2>
            <button mat-flat-button (click)="group.end(); grouping.set(false)"><mat-icon>call_end</mat-icon> End call</button></div>
          <div class="gp">
            @for (p of g.people; track p.id) {
              <span class="gpp" [class]="'gpp ' + legClass(p)"><b>{{ p.full_name }}</b> · {{ legText(p) }}</span>
            }
          </div>
          <div class="a-foot">
            <span class="muted sm">People answer in the app. {{ g.canPhone ? 'Anyone who doesn\'t can be phoned in; you\'ll be asked first.' : 'Phoning people in isn\'t set up yet, so those who miss it need a call back.' }}</span>
            <span class="row-btns">
              <button mat-stroked-button (click)="group.toggleMute()"><mat-icon>{{ group.muted() ? 'mic' : 'mic_off' }}</mat-icon> {{ group.muted() ? 'Unmute' : 'Mute' }}</button>
              @if (group.missed().length && g.canPhone) { <button mat-stroked-button (click)="group.phoneMissed()"><mat-icon>call</mat-icon> Phone {{ group.missed().length }} who missed it</button> }
            </span>
          </div>
        } @else {
          <div class="a-head"><h2>Group call in {{ groupAreaName() }}</h2>
            <button mat-icon-button (click)="grouping.set(false)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
          <div class="g-roles">
            <span class="sm b">Who</span>
            @for (r of groupRoles; track r.id) {
              <label class="chk"><input type="checkbox" [checked]="gRoles().includes(r.id)" (change)="toggleGroupRole(r.id)" /> {{ r.label }}</label>
            }
            @if (child()) { <span class="muted sm">· only {{ childLabel() }} (picked below; click it again for all of {{ stack().at(-1)?.name }})</span> }
          </div>
          <div class="a-foot">
            <span class="muted sm">@if (gPreview(); as pv) { {{ pv.more ? 'More than ' + pv.people.length + ' people: choose a smaller area or fewer roles.' : pv.people.length + (pv.people.length === 1 ? ' person' : ' people') + ' will be rung in the app' + (pv.people.length ? ': ' + previewNames(pv.people) : '.') }} } @else { Counting… }</span>
            <button mat-flat-button (click)="startGroup()" [disabled]="!gPreview()?.people?.length || gPreview()?.more || starting()"><mat-icon>call</mat-icon> Start group call</button>
          </div>
        }
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
              <button class="k-main r-focus"  (click)="pickChild(k.code)" [attr.aria-pressed]="child() === k.code">
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
    .rec { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 44px; }
    .rec audio { height: 36px; } .stop { --mdc-filled-button-container-color: var(--r-urgent); }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--r-urgent); animation: pl 1s infinite; }
    @keyframes pl { 50% { opacity: .2; } }
    .vlist { border-top: 1px solid var(--r-line-soft); padding-top: 8px; display: flex; flex-direction: column; gap: 4px; }
    .vlist p { margin: 0 0 4px; } .vrow { display: flex; align-items: center; gap: 10px; font-size: 13.5px; } .grow { flex: 1; min-width: 0; }
    .g-roles { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; }
    .row-btns { display: flex; gap: 8px; }
    .gp { display: flex; flex-wrap: wrap; gap: 6px; }
    .gpp { font-size: 12.5px; border-radius: 999px; padding: 3px 10px; background: var(--r-low-bg); color: var(--r-ink-2); }
    .gpp.in { background: #e3f4ea; color: #146c3a; } .gpp.ring { background: var(--r-medium-bg); color: var(--r-medium); }
    .gpp.miss { background: var(--r-high-bg); color: #7a2e0b; }
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
  group = inject(GroupCall);
  readonly groupRoles = [{ id: 'coordinator', label: 'Coordinators' }, { id: 'agent', label: 'Agents' }, { id: 'volunteer', label: 'Volunteers' }];
  grouping = signal(false);
  starting = signal(false);
  gRoles = signal<string[]>(['coordinator']);
  gPreview = signal<{ people: { full_name: string }[]; more: boolean } | null>(null);
  canGroupCall = computed(() => ['coordinator', 'supervisor', 'admin'].includes(this.api.me()?.role ?? ''));
  /** The area a group call goes to: the sub-area picked below, or the one shown */
  groupArea = computed(() => this.child() ?? this.stack().at(-1)?.code ?? this.t()?.area ?? '');
  groupAreaName = computed(() => this.child() ? this.childLabel() : this.stack().at(-1)?.name ?? 'your area');
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
  go(code: string, name: string) { this.stack.update((s) => [...s, { code, name }]); this.child.set(null); this.t.set(null); void this.load(); if (this.grouping()) void this.previewGroup(); if (this.voicing()) void this.previewVoice(); }
  up() { this.stack.update((s) => s.slice(0, -1)); this.child.set(null); void this.load(); if (this.grouping()) void this.previewGroup(); if (this.voicing()) void this.previewVoice(); }

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

  // ---- Voice message ----
  voicing = signal(false);
  recording = signal(false);
  recSecs = signal(0);
  vSending = signal(false);
  clip = signal<{ blob: Blob; url: string; seconds: number } | null>(null);
  vPreview = signal<{ count: number; more: boolean; names: string[]; canCall: boolean } | null>(null);
  voiceList = signal<{ id: string; title: string; status: string; created_at: string; sender: string; counts: Record<string, number> | null }[]>([]);
  private rec: WavRecorder | null = null;
  private recTimer: ReturnType<typeof setInterval> | null = null;
  openVoice() { this.voicing.set(true); this.grouping.set(false); this.announcing.set(false); void this.previewVoice(); void this.loadVoice(); }
  closeVoice() { if (this.recording()) this.rec?.cancel(); this.recording.set(false); this.voicing.set(false); }
  async previewVoice() {
    this.vPreview.set(null);
    if (!this.gRoles().length || !this.groupArea()) { this.vPreview.set({ count: 0, more: false, names: [], canCall: true }); return; }
    const want = JSON.stringify([this.groupArea(), this.gRoles()]);
    const r = await this.api.post<{ count: number; more: boolean; names: string[]; canCall: boolean }>('/announcements/voice/preview', { area: this.groupArea(), roles: this.gRoles() }).catch((e) => { this.ui.error(e); return null; });
    if (r && want === JSON.stringify([this.groupArea(), this.gRoles()])) this.vPreview.set(r);
  }
  async loadVoice() { this.voiceList.set(await this.api.get<any[]>('/announcements/voice').catch(() => [])); }
  async startRec() {
    this.rec = new WavRecorder();
    try { await this.rec.start(); } catch (e) { this.ui.error(e); return; }
    this.recording.set(true); this.recSecs.set(0);
    this.recTimer = setInterval(() => { const s = Math.floor(this.rec?.seconds ?? 0); this.recSecs.set(s); if (s >= 60) void this.stopRec(); }, 250);
  }
  async stopRec() {
    if (!this.rec || !this.recording()) return;
    if (this.recTimer) clearInterval(this.recTimer);
    this.recording.set(false);
    const r = await this.rec.stop();
    if (r.seconds < 1) { this.ui.toast('Too short. Hold on and speak, then press Stop.'); return; }
    const old = this.clip(); if (old) URL.revokeObjectURL(old.url);
    this.clip.set({ blob: r.blob, url: URL.createObjectURL(r.blob), seconds: r.seconds });
  }
  async sendVoice() {
    const c = this.clip(), pv = this.vPreview(); if (!c || !pv) return;
    if (!(await this.ui.confirm(`Call ${pv.count} ${pv.count === 1 ? 'person' : 'people'}?`, `Each gets a phone call that plays your ${c.seconds}-second message. Each call uses paid minutes.`, 'Send'))) return;
    this.vSending.set(true);
    const roles = this.groupRoles.filter((r) => this.gRoles().includes(r.id)).map((r) => r.label.toLowerCase());
    const ok = await this.ui.run(async () => {
      const path = await this.api.upload('announcement', c.blob, 'wav');
      return this.api.post('/announcements/voice', { area: this.groupArea(), roles: this.gRoles(), audioPath: path, durationS: c.seconds,
        title: `To ${roles.join(' and ')} in ${this.groupAreaName()}` });
    }, `Calling ${pv.count} ${pv.count === 1 ? 'person' : 'people'} with your message`);
    this.vSending.set(false);
    if (ok) { URL.revokeObjectURL(c.url); this.clip.set(null); await this.loadVoice(); }
  }
  async cancelVoice(id: string) { await this.ui.run(() => this.api.post(`/announcements/voice/${id}/cancel`), 'Stopped. Nobody else will be called.'); await this.loadVoice(); }
  heard(m: { counts: Record<string, number> | null }) { return m.counts?.['heard'] ?? 0; }
  total(m: { counts: Record<string, number> | null }) { return Object.values(m.counts ?? {}).reduce((a, b) => a + b, 0); }
  trying(m: { counts: Record<string, number> | null }) { const c = m.counts ?? {}; return (c['waiting'] ?? 0) + (c['calling'] ?? 0) + (c['no_answer'] ?? 0) + (c['busy'] ?? 0) + (c['failed'] ?? 0); }

  pickChild(code: string) { this.child.set(this.child() === code ? null : code); if (this.grouping()) void this.previewGroup(); if (this.voicing()) void this.previewVoice(); }
  openGroup() { this.grouping.set(true); this.voicing.set(false); this.announcing.set(false); void this.previewGroup(); }
  toggleGroupRole(r: string) {
    this.gRoles.update((x) => x.includes(r) ? x.filter((y) => y !== r) : [...x, r]);
    if (this.grouping()) void this.previewGroup();
    if (this.voicing()) void this.previewVoice();
  }
  async previewGroup() {
    this.gPreview.set(null);
    if (!this.gRoles().length || !this.groupArea()) { this.gPreview.set({ people: [], more: false }); return; }
    const want = JSON.stringify([this.groupArea(), this.gRoles()]);
    const r = await this.api.post<{ people: { full_name: string }[]; more: boolean }>('/calls/group/preview', { area: this.groupArea(), roles: this.gRoles() }).catch((e) => { this.ui.error(e); return null; });
    if (r && want === JSON.stringify([this.groupArea(), this.gRoles()])) this.gPreview.set(r);
  }
  previewNames(p: { full_name: string }[]) { return p.slice(0, 4).map((x) => x.full_name).join(', ') + (p.length > 4 ? ` and ${p.length - 4} more` : ''); }
  async startGroup() {
    const roles = this.groupRoles.filter((r) => this.gRoles().includes(r.id)).map((r) => r.label.toLowerCase());
    const title = `${roles.join(' and ').replace(/^./, (c) => c.toUpperCase())} in ${this.groupAreaName()}`;
    this.starting.set(true);
    await this.group.start(this.groupArea(), this.gRoles(), title);
    this.starting.set(false);
  }
  legText(p: GroupPerson) {
    if (p.app === 'answered') return 'in the app';
    if (p.phone === 'answered') return 'on the phone';
    if (p.phone === 'ringing') return 'phone ringing';
    if (p.app === 'ringing') return 'ringing';
    if (p.app === 'busy') return 'on another call';
    if (p.app === 'completed' || p.phone === 'completed') return 'left';
    return 'no answer';
  }
  legClass(p: GroupPerson) {
    const t = this.legText(p);
    return t === 'in the app' || t === 'on the phone' ? 'in' : t.includes('ringing') ? 'ring' : t === 'left' ? '' : 'miss';
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
