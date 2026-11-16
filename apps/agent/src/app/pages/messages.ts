import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { IonBadge, IonContent, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonNote, IonRefresher,
  IonRefresherContent, ViewWillEnter } from '@ionic/angular';
import { Api } from '../core/api';
import { AppBar } from '../core/app-bar';
import { Calls } from '../core/calls';
import { Ui } from '../core/ui';

interface Coordinator { id: string; full_name: string; level: string; area_code: string }
import { I18n } from '../core/i18n';
import { categoryIcon } from '../core/categories';
import { type Channel, channelPreview, channelSubtitle, channelTime, channelTitle } from '../core/channel-label';

const LEVEL_ORDER: Record<string, number> = { ward: 0, lga: 1, state: 2 };

/**
 * Conversations: my area teams (ward, then LGA, then state), then cases and direct chats, newest first.
 * Each shows the name people know, where or who it is (code last), the last message, and how many are unread.
 */
@Component({
  selector: 'page-messages',
  imports: [NgTemplateOutlet, RouterLink, AppBar, IonBadge, IonContent, IonIcon, IonItem, IonLabel, IonList, IonListHeader, IonNote,
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
          <button routerLink="/callback"><ion-icon name="phone-portrait" /><span>{{ t('Call me back') }}</span></button>
        </div>
        <div class="hintline">{{ t('No airtime or data? Tap Call me back and they will ring you.') }}</div>
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
          @if (c.unread) { <ion-badge color="primary">{{ c.unread >= 100 ? '99+' : c.unread }}</ion-badge> }
        </div>
      </ion-item>
    </ng-template>
  </ion-content>`,
  styles: `
    .coord { margin: 12px 12px 6px; padding: 12px; border-radius: 16px; background: #f1f8f3; border: 1px solid #d5eadb; }
    .ctop { display: flex; align-items: center; gap: 12px; }
    .cw { flex: 1; display: flex; flex-direction: column; min-width: 0; } .cw b { font-size: 16px; } .cl { font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .5px; color: var(--ion-color-primary); } .cw .sub { font-size: 12px; color: var(--ion-color-medium); }
    .cacts { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 8px; margin-top: 12px; }
    .cacts button { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 4px; border: 0; border-radius: 12px;
      background: #fff; color: var(--ion-color-primary); font: inherit; font-size: 13px; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    .cacts button ion-icon { font-size: 22px; } .cacts button.primary { background: var(--ion-color-primary); color: #fff; }
    .hintline { margin-top: 8px; font-size: 12px; color: var(--ion-color-medium); text-align: center; }
    .avatar { width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center; flex: none; margin-right: 12px;
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
  coordinator = signal<Coordinator | null>(null);
  area = signal<Channel[]>([]);
  private all = signal<Channel[]>([]);
  loaded = signal(false);
  others = computed(() => this.all().filter((c) => c.kind === 'case' || c.kind === 'direct').slice(0, 50));
  private unfollow: (() => void)[] = [];
  private stopLive = this.api.onChange(() => this.soon(), ['messages']);
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor() { void this.load(); void this.loadCoordinator(); }
  /** Coming back from a chat: its unread count is now 0 */
  ionViewWillEnter() { if (this.loaded()) void this.load(); }
  ngOnDestroy() { this.stopLive(); this.unfollow.forEach((f) => f()); if (this.pending) clearTimeout(this.pending); }

  private soon() { if (!this.pending) this.pending = setTimeout(() => { this.pending = null; void this.load(); }, 1500); }

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
  initialsOf(name: string) { return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }

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
  initials(c: Channel) { return (c.label?.person ?? '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
}
