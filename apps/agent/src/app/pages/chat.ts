import { Component, OnDestroy, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonTitle, IonToolbar } from '@ionic/angular';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Supa } from '../core/supa';
import { Outbox } from '../core/outbox';
import { takePhoto } from '../core/photo';

/** A chat thread. Messages typed offline are queued and sent when there is signal. */
@Component({
  selector: 'page-chat',
  imports: [FormsModule, IonBackButton, IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonInput, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/messages" /></ion-buttons>
    <ion-title>{{ name() }}</ion-title></ion-toolbar></ion-header>
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
  styles: `.msg { background: var(--ion-color-light); border-radius: 12px; padding: 8px 12px; margin: 6px 0; max-width: 82%; }
    .msg.mine { margin-left: auto; background: #d7efe0; } .queued { opacity: .6; } .who { font-size: 12px; font-weight: 600; }
    .when { font-size: 11px; color: var(--ion-color-medium); text-align: right; }`,
})
export default class ChatPage implements OnDestroy {
  id = input.required<string>();
  private supa = inject(Supa);
  private outbox = inject(Outbox);
  me = this.supa.me()!.id;
  name = signal('');
  messages = signal<any[]>([]);
  names = signal<Record<string, string>>({});
  queued = () => this.outbox.pending().filter((i) => i.kind === 'message' && i.payload['channel'] === this.id());
  draft = '';
  private rt?: RealtimeChannel;

  constructor() {
    effect(() => {
      const id = this.id();
      void this.load(id);
      this.rt?.unsubscribe();
      this.rt = this.supa.client.channel(`chat-${id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${id}` },
          (p) => this.messages.set([...this.messages(), p.new]))
        .subscribe();
    });
  }
  ngOnDestroy() { this.rt?.unsubscribe(); }

  async load(id: string) {
    const [{ data: ch }, { data: msgs }] = await Promise.all([
      this.supa.client.from('channels').select('name').eq('id', id).maybeSingle(),
      this.supa.client.from('messages').select('*').eq('channel_id', id).order('created_at').limit(200),
    ]);
    this.name.set(ch?.name ?? '');
    this.messages.set(msgs ?? []);
    const ids = [...new Set((msgs ?? []).map((m) => m.sender_id).filter(Boolean))];
    if (ids.length) {
      const { data } = await this.supa.client.from('volunteers').select('id, full_name').in('id', ids);
      this.names.set(Object.fromEntries((data ?? []).map((v) => [v.id, v.full_name])));
    }
  }

  time(t: string) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  async send() {
    const body = this.draft.trim();
    if (!body) return;
    this.draft = '';
    await this.outbox.add('message', { channel: this.id(), body }, 'Message');
  }

  async photo() {
    const p = await takePhoto();
    if (p) await this.outbox.add('message', { channel: this.id(), kind: 'photo', body: null }, 'Photo message', p.blob);
  }
}
