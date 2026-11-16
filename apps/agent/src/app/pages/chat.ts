import { Component, OnDestroy, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { channelSubtitle, channelTitle } from '../core/channel-label';
import { I18n } from '../core/i18n';
import { Outbox } from '../core/outbox';
import { takePhoto } from '../core/photo';
import { Ui } from '../core/ui';
import { Calls, type Callee } from '../core/calls';

/** A chat thread. Messages typed offline are queued and sent when there is signal. */
@Component({
  selector: 'page-chat',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/messages" /></ion-buttons>
    <ion-title><div class="t">{{ name() }}</div>@if (sub()) { <div class="st">{{ sub() }}</div> }</ion-title>
    @if (calls.modes().length) {
      <ion-buttons slot="end"><ion-button (click)="call()" aria-label="Call"><ion-icon slot="icon-only" name="call" /></ion-button></ion-buttons>
    }
  </ion-toolbar>
  </ion-header>
  <ion-content class="ion-padding">
    @for (m of messages(); track m.id) {
      <div class="msg" [class.mine]="m.sender_id === me">
        @if (m.sender_id !== me) { <div class="who">{{ names()[m.sender_id] ?? '' }}</div> }
        @if (m.body) { {{ m.body }} } @if (m.media_path) { <i>[{{ m.kind }}]</i> }
        <div class="when">{{ time(m.created_at) }}</div>
      </div>
    }
    @for (q of queued(); track q.id) { <div class="msg mine queued">{{ q.payload['body'] }}<div class="when">waiting to send</div></div> }
  </ion-content>
  <ion-footer><ion-toolbar>
    <ion-buttons slot="start"><ion-button (click)="photo()"><ion-icon slot="icon-only" name="camera" /></ion-button></ion-buttons>
    <ion-input [(ngModel)]="draft" placeholder="Message" (keyup.enter)="send()" aria-label="Message" />
    <ion-buttons slot="end"><ion-button (click)="send()" [disabled]="!draft.trim()"><ion-icon slot="icon-only" name="send" /></ion-button></ion-buttons>
  </ion-toolbar></ion-footer>`,
  styles: `.t { font-size: 17px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; }
    .st { font-size: 12px; font-weight: 400; opacity: .85; overflow: hidden; text-overflow: ellipsis; }
    .msg { background: var(--ion-color-light); border-radius: 12px; padding: 8px 12px; margin: 6px 0; max-width: 82%; }
    .msg.mine { margin-left: auto; background: #d7efe0; } .queued { opacity: .6; } .who { font-size: 12px; font-weight: 600; }
    .when { font-size: 11px; color: var(--ion-color-medium); text-align: right; }`,
})
export default class ChatPage implements OnDestroy {
  id = input.required<string>();
  private api = inject(Api);
  private outbox = inject(Outbox);
  private ui = inject(Ui);
  calls = inject(Calls);
  me = this.api.me()!.id;
  name = signal('');
  sub = signal('');
  private t = inject(I18n).t;
  messages = signal<any[]>([]);
  names = signal<Record<string, string>>({});
  queued = () => this.outbox.pending().filter((i) => i.kind === 'message' && i.payload['channel'] === this.id());
  draft = '';
  private stopLive: () => void = () => undefined;
  private unfollow: () => void = () => undefined;

  constructor() {
    effect(() => {
      const id = this.id();
      void this.load(id);
      this.stopLive(); this.unfollow();
      this.unfollow = this.api.follow({ channel: id });
      this.stopLive = this.api.onChange((c) => { if (c.channel_id === id) void this.load(id); }, ['messages']);
    });
  }
  ngOnDestroy() { this.stopLive(); this.unfollow(); }

  async load(id: string) {
    const d = await this.api.get<{ channel: any; messages: any[] }>(`/channels/${id}`).catch(() => null);
    if (!d) return;
    // Same naming as the conversation list: the place, problem or person first, code last
    this.name.set(channelTitle(d.channel, this.t));
    this.sub.set(channelSubtitle(d.channel, this.t));
    this.messages.set(d.messages);
    this.names.set(Object.fromEntries(d.messages.filter((m) => m.sender_id).map((m) => [m.sender_id, m.sender_name ?? ''])));
  }

  time(t: string) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  async send() {
    const body = this.draft.trim();
    if (!body) return;
    this.draft = '';
    await this.outbox.add('message', { channel: this.id(), body }, 'Message');
  }

  /** Phone someone in this chat: the other person in a direct chat, or pick from the people who wrote here. */
  async call() {
    if (!this.outbox.online()) { await this.ui.error('No internet. Call them from your contacts.'); return; }
    const people = await this.api.get<Callee[]>(`/channels/${this.id()}/people`).catch(async (e) => { await this.ui.error(e); return null; });
    if (people) await this.calls.fromChat(this.id(), people);
  }

  async photo() {
    const p = await takePhoto();
    if (p) await this.outbox.add('message', { channel: this.id(), kind: 'photo', body: null }, 'Photo message', p.blob);
  }
}
