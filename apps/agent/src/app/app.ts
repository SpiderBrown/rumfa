import { Component, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonApp, IonButton, IonIcon, IonRouterOutlet, AlertController } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Api } from './core/api';
import { I18n } from './core/i18n';
import { Calls } from './core/calls';

@Component({
  selector: 'app-root',
  imports: [IonApp, IonButton, IonIcon, IonRouterOutlet],
  template: `<ion-app><ion-router-outlet />
  @if (calls.active(); as a) {
    <div class="callbar" [class.ring]="a.phase === 'incoming'" role="status">
      <ion-icon name="call" />
      <span class="who">
        @switch (a.phase) {
          @case ('incoming') { {{ t('Incoming call') }}: <b>{{ a.label }}</b> }
          @case ('calling') { {{ t('Calling') }} <b>{{ a.label }}</b>… }
          @default { {{ t('On a call with') }} <b>{{ a.label }}</b> }
        }
      </span>
      @if (a.phase === 'incoming') {
        <ion-button color="success" (click)="calls.answer()">{{ t('Answer') }}</ion-button>
        <ion-button color="danger" (click)="calls.hangup()">{{ t('Decline') }}</ion-button>
      } @else {
        @if (a.kind === 'app' && a.phase === 'connected') {
          <ion-button fill="outline" color="light" (click)="calls.toggleMute()">{{ a.muted ? t('Unmute') : t('Mute') }}</ion-button>
        }
        <ion-button color="danger" (click)="calls.hangup()">{{ t('Hang up') }}</ion-button>
      }
    </div>
  }
  </ion-app>`,
  styles: `.callbar { position: fixed; left: 8px; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom)); z-index: 30000;
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border-radius: 14px;
      background: #1b5e20; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
    .callbar.ring { background: #0d47a1; } .who { flex: 1; min-width: 140px; }`,
})
export class App {
  private api = inject(Api);
  private router = inject(Router);
  private alert = inject(AlertController);
  private i18n = inject(I18n);
  calls = inject(Calls);
  t = (s: string) => this.i18n.t(s);
  private stopCalls?: () => void;
  private stopLive?: () => void;

  constructor() {
    // When signed in: register for push, and listen for live-view requests
    effect(() => {
      const me = this.api.me();
      if (!me || !this.api.session()) return;
      void this.registerPush();
      // Live-view requests addressed to me arrive on my own live-update room
      this.stopLive?.();
      this.stopLive = this.api.onChange((c) => {
        if (c.op === 'insert' && c.status === 'requested' && c.id) void this.askLiveView(c.id);
      }, ['live_view_requests']);
      // App calls: ringing, answered and ended, for calls I am in
      this.stopCalls?.();
      this.stopCalls = this.api.onChange((c) => this.calls.onCallChange(c), ['calls']);
      void this.calls.checkIncoming();
    });
  }

  private async registerPush() {
    if (!Capacitor.isNativePlatform()) return;
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.addListener('registration', (t) => void this.api.post('/me/device-tokens', { token: t.value, platform: Capacitor.getPlatform() }).catch(() => undefined));
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const d = a.notification.data ?? {};
      if (d.template === 'app_call' && d.call_id) void this.calls.incoming(d.call_id);
      else if (d.template === 'live_view_request') void this.router.navigate(['/live', d.request_id]);
      else if (d.template === 'callback_request') void this.router.navigateByUrl('/coord/callbacks');
      else if (d.template === 'new_message' && d.channel_id) void this.router.navigate(['/chat', d.channel_id]);
      else if (d.case_id) void this.router.navigateByUrl('/messages');
    });
    await PushNotifications.register();
  }

  private async askLiveView(id: string) {
    const a = await this.alert.create({
      header: this.i18n.t('Live view request'),
      message: this.i18n.t('The situation room asks to see your polling unit through your camera.'),
      buttons: [
        { text: this.i18n.t('No'), role: 'cancel', handler: () => void this.api.post(`/live-view/${id}/answer`, { accept: false }).catch(() => undefined) },
        { text: this.i18n.t('Yes'), handler: () => void this.router.navigate(['/live', id]) },
      ],
    });
    await a.present();
  }
}
