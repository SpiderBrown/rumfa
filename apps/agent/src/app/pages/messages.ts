import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { IonBadge, IonContent, IonFab, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonNote, IonRefresher,
  IonRefresherContent, ViewWillEnter } from '@ionic/angular';
import { Api } from '../core/api';
import { Checkin } from '../core/checkin';
import { CheckinFlow } from '../core/checkin-flow';
import { AppBar } from '../core/app-bar';
import { Calls } from '../core/calls';
import { Ui } from '../core/ui';

interface Coordinator { id: string; full_name: string; level: string; area_code: string }
import { I18n } from '../core/i18n';
import { categoryIcon } from '../core/categories';
import { CALLBACK_REASONS } from '@rumfa/shared';
import { AgoPipe } from '../core/clock';
import { type Channel, channelPreview, channelSubtitle, channelTime, channelTitle } from '../core/channel-label';

const LEVEL_ORDER: Record<string, number> = { ward: 0, lga: 1, state: 2 };

/**
 * Conversations: my area teams (ward, then LGA, then state), then cases and direct chats, newest first.
 * Each shows the name people know, where or who it is (code last), the last message, and how many are unread.
 */
@Component({
  selector: 'page-messages',
  imports: [NgTemplateOutlet, RouterLink, AppBar, AgoPipe, IonBadge, IonContent, IonFab, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonNote,
    IonRefresher, IonRefresherContent],
  template: `
  <app-bar [title]="t('Chats')" [sos]="api.atUnit()" />
  <ion-content>
    <ion-refresher slot="fixed" (ionRefresh)="refresh($event)"><ion-refresher-content /></ion-refresher>
    @if (coordinator(); as c) {
      <!-- The person agents reach most: pinned, with the three ways to reach them as labelled buttons -->
      <div class="coord">
        <div class="ctop">
          <div class="avatar direct">{{ initialsOf(c.full_name) }}</div>
          <div class="cw"><span class="cl">{{ t('My coordinator') }}</span><b>{{ c.full_name }}</b>
            <span class="sub">{{ t(levelName(c.level)) }} · {{ c.area_code }}</span></div>
        </div>
        <div class="cacts">
          <button (click)="message(c)"><ion-icon name="chatbubble" /><span>{{ t('Message') }}</span></button>
          @if (calls.modes().length) { <button class="primary" (click)="call(c)"><ion-icon name="call" /><span>{{ t('Call') }}</span></button> }
          <button routerLink="/callback" [class.open]="!!callback()"><ion-icon name="phone-portrait" /><span>{{ t('Call me back') }}</span></button>
        </div>
        @if (callback(); as r) { <div class="hintline open" routerLink="/callback">{{ callbackText(r.status) }}</div> }
        @else { <div class="hintline">{{ t('No airtime or data? Tap Call me back and they will ring you.') }}</div> }
      </div>
    } @else if (canAskCall()) {
      <button class="callme" routerLink="/callback">
        <ion-icon name="phone-portrait" />
        <span><b>{{ t('Ask my coordinator to call me') }}</b>
          {{ callback() ? callbackText(callback()!.status) : t('No airtime or data? They will ring you.') }}</span>
        <ion-icon name="chevron-forward" class="go" />
      </button>
    }
    <!-- Coordinators: people who asked to be called, at the top. Tap to open the chat with them, or call straight away -->
    @if (requests().length) {
      <p class="section-title">{{ t('Asked to be called') }} <span class="count">{{ requests().length }}</span></p>
      <div class="card flat reqs">
        @for (r of requests(); track r.id) {
          <div class="row-item req">
            <button class="av sm" (click)="openPerson(r.requester?.id)">{{ initialsOf(r.requester?.full_name ?? '?') }}</button>
            <button class="rb" (click)="chatWith(r)">
              <b>{{ r.requester?.full_name }}</b>
              <small>{{ reason(r.reason) }} · {{ r.requester?.area_code }} · {{ r.created_at | ago }}@if (r.status === 'no_answer') { · {{ t('no answer last time') }} }</small>
              @if (r.note) { <small class="note">“{{ r.note }}”</small> }
            </button>
            @if (r.status === 'calling') {
              <div class="two"><button class="ok" (click)="doneReq(r, true)">{{ t('Talked') }}</button><button class="no" (click)="doneReq(r, false)">{{ t('No answer') }}</button></div>
            } @else {
              <button class="dial" (click)="callReq(r)" [attr.aria-label]="t('Call')"><ion-icon name="call" /></button>
            }
          </div>
        }
      </div>
    }
    <ion-list>
      @if (area().length) { <ion-list-header>{{ t('Teams') }}</ion-list-header> }
      @for (c of area(); track c.id) { <ng-container *ngTemplateOutlet="row; context: { $implicit: c }" /> }
      @if (others().length) { <ion-list-header>{{ t('Cases and direct') }}</ion-list-header> }
      @for (c of others(); track c.id) { <ng-container *ngTemplateOutlet="row; context: { $implicit: c }" /> }
      @if (loaded() && !area().length && !others().length) { <p class="empty">{{ t('No conversations yet.') }}</p> }
    </ion-list>

    <ng-template #row let-c>
      <ion-item [routerLink]="['/chat', c.id]" detail="false" lines="full" [class.unread]="c.unread">
        <div slot="start" class="avatar" [class]="c.kind">
          @switch (c.kind) {
            @case ('case') { <ion-icon [name]="icon(c)" /> }
            @case ('direct') { <span>{{ initials(c) }}</span> }
            @default { <ion-icon name="people" /> }
          }
        </div>
        <ion-label>
          <h2>{{ title(c) }}
            @if (c.kind === 'case') { <span class="chip" [class.closed]="c.label?.caseStatus === 'closed'">{{ c.label?.caseStatus === 'closed' ? t('Closed') : t('Open') }}</span> }
          </h2>
          <p class="sub">{{ subtitle(c) }}</p>
          <p class="prev">{{ preview(c) }}</p>
        </ion-label>
        <div slot="end" class="end">
          <ion-note>{{ when(c) }}</ion-note>
          @if (c.kind === 'direct' && api.isCoordinator() && calls.modes().length) {
            <button class="dial sm" (click)="$event.stopPropagation(); $event.preventDefault(); callChat(c)" [attr.aria-label]="t('Call')"><ion-icon name="call" /></button>
          }
          @if (c.unread) { <ion-badge color="primary">{{ c.unread >= 100 ? '99+' : c.unread }}</ion-badge> }
        </div>
      </ion-item>
    </ng-template>

    <!-- The same Report button as on Today, so SOS is never the only way to tell the room about a problem -->
    @if (api.atUnit()) {
      <ion-fab slot="fixed" vertical="bottom" horizontal="end">
        <button class="report" (click)="report()" [attr.aria-label]="t('Report a problem')"><ion-icon name="warning" /><span>{{ t('Report') }}</span></button>
      </ion-fab>
    }
  </ion-content>`,
  styles: `
    .coord { margin: 12px 12px 6px; padding: 14px; border-radius: 20px; background: #fff; border: 1px solid var(--r-line); box-shadow: 0 2px 10px rgba(15,23,42,.05); }
    .section-title { margin: 16px 16px 8px; display: flex; align-items: center; gap: 6px; }
    .count { background: var(--r-urgent); color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 12px; letter-spacing: 0; }
    .reqs { margin: 0 12px 6px; }
    .req { gap: 10px; } .av.sm { width: 40px; height: 40px; border: 0; font: inherit; font-weight: 800; font-size: 14px; }
    .rb { flex: 1; min-width: 0; border: 0; background: none; text-align: left; font: inherit; padding: 0; color: var(--r-ink); }
    .rb b { display: block; } .rb small { display: block; color: var(--r-muted); font-size: 13px; } .rb .note { color: var(--r-ink-2); font-style: italic; }
    .dial { width: 44px; height: 44px; border-radius: 50%; border: 0; background: #16a34a; color: #fff; display: grid; place-items: center; font-size: 20px; flex: none; }
    .dial.sm { width: 32px; height: 32px; font-size: 16px; }
    .two { display: flex; flex-direction: column; gap: 4px; } .two button { border: 0; border-radius: 10px; padding: 6px 10px; font: inherit; font-size: 12px; font-weight: 800; }
    .two .ok { background: #16a34a; color: #fff; } .two .no { background: #eef1f4; color: var(--r-ink); }
    .ctop { display: flex; align-items: center; gap: 12px; }
    .cw { flex: 1; display: flex; flex-direction: column; min-width: 0; } .cw b { font-size: 16px; } .cl { font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .5px; color: var(--ion-color-primary); } .cw .sub { font-size: 12px; color: var(--ion-color-medium); }
    .cacts { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 8px; margin-top: 12px; }
    .cacts button { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 4px; border: 0; border-radius: 12px;
      background: var(--r-accent-soft); color: var(--r-accent); font: inherit; font-size: 13px; font-weight: 700; }
    .cacts button ion-icon { font-size: 22px; } .cacts button.open { outline: 2px solid var(--ion-color-primary); }
    .hintline.open { color: var(--ion-color-primary); font-weight: 600; }
    .report { display: flex; align-items: center; gap: 8px; height: 54px; padding: 0 22px 0 18px; border: 0; border-radius: 27px; background: #ea580c;
      color: #fff; font: inherit; font-weight: 700; font-size: 16px; box-shadow: 0 4px 14px rgba(234,88,12,.4); }
    .report:active { background: #c2410c; transform: scale(.97); } .report ion-icon { font-size: 24px; }
    ion-list { padding-bottom: 80px; }
    .callme { display: flex; align-items: center; gap: 12px; width: calc(100% - 24px); margin: 12px 12px 6px; padding: 14px; border: 1px solid #d5eadb;
      border-radius: 16px; background: #f1f8f3; color: var(--ion-text-color); font: inherit; text-align: left; }
    .callme span { flex: 1; display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
    .callme > ion-icon:first-child { font-size: 28px; color: var(--r-accent); } .callme .go { font-size: 20px; opacity: .5; } .cacts button.primary { background: var(--r-accent); color: #fff; }
    .hintline { margin-top: 8px; font-size: 12px; color: var(--ion-color-medium); text-align: center; }
    .avatar { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; flex: none; margin-right: 12px;
      background: #e7f1ea; color: var(--ion-color-primary); font-weight: 700; }
    .avatar ion-icon { font-size: 22px; } .avatar.case { background: #fdeee4; color: #c2410c; } .avatar.direct { background: #e6eefb; color: #1d4ed8; }
    h2 { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .sub { font-size: 12px; color: var(--ion-color-medium); }
    .prev { font-size: 14px; color: var(--ion-color-step-600, #555); }
    .unread .prev { color: var(--ion-text-color); font-weight: 600; }
    .end { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; align-self: flex-start; padding-top: 12px; }
    .end ion-note { font-size: 12px; } .unread ion-note { color: var(--ion-color-primary); font-weight: 600; }
    .chip { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 8px; background: #fde7d9; color: #9a3412; }
    .chip.closed { background: #e5e7eb; color: #4b5563; }
    .empty { padding: 24px 16px; color: var(--ion-color-medium); }
  `,
})
export default class MessagesPage implements OnDestroy, ViewWillEnter {
  api = inject(Api);
  calls = inject(Calls);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  private ci = inject(Checkin);
  private flow = inject(CheckinFlow);
  coordinator = signal<Coordinator | null>(null);
  /** An open "call me" request, shown on the coordinator card */
  callback = signal<{ id: string; status: string } | null>(null);
  /** State coordinators have nobody above them to ask */
  canAskCall = () => !(this.api.isCoordinator() && this.api.me()?.level === 'state');
  area = signal<Channel[]>([]);
  private all = signal<Channel[]>([]);
  loaded = signal(false);
  others = computed(() => this.all().filter((c) => c.kind === 'case' || c.kind === 'direct').slice(0, 50));
  private unfollow: (() => void)[] = [];
  private stopLive = this.api.onChange(() => this.soon(), ['messages']);
  private stopCallback = this.api.onChange(() => void this.loadCallback(), ['callback_requests']);
  private pending: ReturnType<typeof setTimeout> | null = null;

  /** Coordinators: call requests waiting for them (merged in from the old Requests tab) */
  requests = signal<any[]>([]);
  private stopReq = this.api.onChange(() => void this.loadRequests(), ['callback_requests']);

  constructor() { void this.load(); void this.loadCoordinator(); void this.loadCallback(); void this.loadRequests(); }

  async loadRequests() {
    if (!this.api.isCoordinator()) return;
    const r = await this.api.get<any[]>('/callbacks', { mine: true, status: 'waiting,calling,no_answer' }).catch(() => null);
    if (r) this.requests.set(r);
  }
  reason(c: string) { return this.t(CALLBACK_REASONS.find((r) => r.code === c)?.label ?? c); }
  openPerson(id?: string) { if (id) void this.router.navigate(['/person', id]); }
  /** Opens the chat with the person who asked (their history is there) */
  async chatWith(r: any) {
    if (!r.requester?.id) return;
    try { await this.router.navigate(['/chat', await this.directWith({ id: r.requester.id } as Coordinator)], { queryParams: { request: r.id } }); }
    catch (e) { await this.ui.error(e); }
  }
  /** Rings the coordinator's phone first, then connects the agent (normal phone lines); no internet: dial directly */
  async callReq(r: any) {
    try {
      const res = await this.api.post<{ bridged: boolean; dialDirect?: string }>(`/callbacks/${r.id}/call`);
      if (res.bridged) await this.ui.toast('Your phone will ring now. Answer it and we connect the agent.');
      else if (res.dialDirect) window.location.href = `tel:${res.dialDirect}`;
    } catch { window.location.href = `tel:${r.requester?.phone}`; }
    await this.loadRequests();
  }
  async doneReq(r: any, answered: boolean) {
    await this.api.post(`/callbacks/${r.id}/complete`, { answered, outcome: answered ? 'Talked' : undefined }).catch((e) => this.ui.error(e));
    await this.loadRequests();
  }
  async callChat(c: Channel) {
    const people = await this.api.get<any[]>(`/channels/${c.id}/people`).catch(async (e) => { await this.ui.error(e); return null; });
    if (people) await this.calls.fromChat(c.id, people);
  }
  /** Coming back from a chat: its unread count is now 0 */
  ionViewWillEnter() { if (this.loaded()) { void this.load(); void this.loadCallback(); void this.loadRequests(); } }
  ngOnDestroy() { this.stopLive(); this.stopCallback(); this.stopReq(); this.unfollow.forEach((f) => f()); if (this.pending) clearTimeout(this.pending); }

  private soon() { if (!this.pending) this.pending = setTimeout(() => { this.pending = null; void this.load(); }, 1500); }

  async report() {
    if (this.ci.required()) {
      if (!(await this.ui.confirm('Check in first', 'Check in at your polling unit before you start. It tells the situation room you are in place.', 'Check in now', 'Cancel'))) return;
      if (!(await this.flow.run())) return;
    }
    await this.router.navigateByUrl('/report');
  }
  async loadCallback() {
    if (!this.canAskCall()) return;
    const r = await this.api.get<any>('/callbacks/mine').catch(() => undefined);
    if (r !== undefined) this.callback.set(r && r.id ? r : null);
  }
  callbackText(s: string) {
    return ({ waiting: this.t('Call requested: your coordinator will call you'), escalated: this.t('Call requested: the situation room will call you'),
      calling: this.t('Calling you now…'), no_answer: this.t('We could not reach you; we will try again soon') } as Record<string, string>)[s] ?? this.t('Call requested');
  }
  async loadCoordinator() {
    if (this.api.isCoordinator() && this.api.me()?.level === 'state') return;
    const c = await this.api.get<Coordinator | null>('/me/coordinator').catch(() => undefined);
    if (c !== undefined) this.coordinator.set(c && c.id ? c : null);
  }

  private async directWith(c: Coordinator) { return (await this.api.post<{ channelId: string }>('/channels/direct', { otherId: c.id })).channelId; }
  async message(c: Coordinator) {
    try { await this.router.navigate(['/chat', await this.directWith(c)]); } catch (e) { await this.ui.error(e); }
  }
  async call(c: Coordinator) {
    try { await this.calls.fromChat(await this.directWith(c), [{ id: c.id, full_name: c.full_name, role: 'coordinator' }]); } catch (e) { await this.ui.error(e); }
  }
  levelName(l: string) { return ({ ward: 'Ward coordinator', lga: 'LGA coordinator', state: 'State coordinator' } as Record<string, string>)[l] ?? 'Coordinator'; }
  initialsOf(name: string) { return name.replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }

  async load() {
    const [a, all] = await Promise.all([this.api.get<Channel[]>('/channels/area').catch(() => null), this.api.get<Channel[]>('/channels').catch(() => null)]);
    if (a) this.area.set(a.sort((x, y) => (LEVEL_ORDER[x.kind] ?? 9) - (LEVEL_ORDER[y.kind] ?? 9)));
    if (all) this.all.set(all);
    this.loaded.set(true);
    // Hear about new messages in every conversation listed (the server only sends a chat's messages to its followers)
    this.unfollow.forEach((f) => f());
    this.unfollow = [...this.area(), ...this.others()].map((c) => this.api.follow({ channel: c.id }));
  }

  async refresh(ev: CustomEvent) { await this.load(); (ev.target as any).complete(); }

  title(c: Channel) { return channelTitle(c, this.t); }
  subtitle(c: Channel) { return channelSubtitle(c, this.t); }
  preview(c: Channel) { return channelPreview(c, this.t); }
  when(c: Channel) { return channelTime(c.last?.at, this.t); }
  icon(c: Channel) { return categoryIcon(c.label?.categoryCode); }
  initials(c: Channel) { return (c.label?.person ?? '?').replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
}
